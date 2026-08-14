#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-extract-caller.mjs
// The IGL dataset (SIM-PLAN 9.25 stage 3): one row per freeze or recall.
//
//   { picture, decision, tapeId, call, pWin_belief, pWin_true, fightEv,
//     recalled, won, attrib }
//
// Two sources, and the plan is explicit that you want both:
//
//   --from self-play (default)  Play matches and drain each round's sealed
//     caller log. Both outcomes appear, because both sides play every round.
//
//   --from library              One freeze row per mined tape. Fast, free, and
//     BIASED: sim-mine-playbook.mjs stores winning round-sides only ("losing
//     sides are context, never tape"), so every row reads won=1. 9.25 stage 1
//     names this failure directly — "both outcomes train the head or every
//     execute looks like 100%" — so library rows refuse to be a whole dataset
//     unless you pass --allow-winners-only and mean it.
//
//   --from demos                The real corpus, both outcomes. Walks the
//     .aim4replay packages and tags EVERY round-side with roundTagsFor, which
//     classifies both ends of a round rather than the winner's — "measuring a
//     call means measuring it from both ends, how often did our A Fake work
//     and how often did we hold theirs". That is the fix for the library's
//     bias without waiting for self-play: the losing side of a round is a real
//     call that really lost, which is the half stage 1 cannot learn without.
//
//   --from both                Library rows for coverage, self-play rows for
//     the losses. The usual answer when there is no corpus to hand.
//
// Rows are emitted at the moments 9.25 stage 1 names — "situation at freeze /
// contact / man-count change" — not at 8 Hz. A caller decides a handful of
// times a round and the dataset has to look like that or the head learns the
// shape of a tick loop instead of the shape of a decision.
//
// Honesty (5.4, 18.6b): a row's picture goes through prw.js's allowlist, so
// no coordinates are written here, ever. `pWin_true` is god-view and is
// TRAINING-ONLY, filled after the round from the sealed truth, exactly as
// 9.5's potentials are.
//
// Grading (9.25 stage 3): holdout is by MATCH, stratified by
// (map, side, call, econ), never by round. `splitMatches` does it and writes
// the assignment into the meta so a trainer cannot quietly re-split.
//
// Output is JSONL under the sim directory (12.1: never anywhere users see):
// line 1 is the meta record, every other line one row.
//
// Usage:
//   node scripts/sim-extract-caller.mjs
//   node scripts/sim-extract-caller.mjs --map INF --matches 8 --rounds 24 --seed 40
//   node scripts/sim-extract-caller.mjs --from library --allow-winners-only
//   node scripts/sim-extract-caller.mjs --from both --value-head --out /tmp/igl.jsonl
//   node scripts/sim-extract-caller.mjs --from demos --map CCH --demos ~/Dev/demos/cache-149
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { indexPlaybook, decisionFor } from '../shared/sim/playbook.js';
import { PRW_LOG_VERSION } from '../shared/sim/prw.js';
import { IGL_EVENT, IGL_LOG_VERSION, splitMatches, stratumOf, trainableRows } from '../shared/sim/iglLog.js';
import { ROUND_SECONDS, BOMB_SECONDS } from '../shared/sim/constants.js';
import { isSynthetic } from '../shared/sim/firewall.js';
import { decodeReplayPackage } from '../src/replays/shared/replayPackage.js';
import { decodeTickz } from '../server/replays/tickCodec.js';
import { TickTrack } from '../src/replays/tickStore.js';
import { roundTagsFor } from '../src/replays/analytics/roundTags.js';
import { classifyContactRel } from '../shared/sim/caller.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const MAP = String(flag('map', 'INF')).toUpperCase();
const FROM = String(flag('from', 'self-play'));
const MATCHES = Number(flag('matches', 8));
const ROUNDS = Number(flag('rounds', 24));
const SEED = Number(flag('seed', 40));
const HOLDOUT = Number(flag('holdout', 0.2));
const VALUE_HEAD = has('value-head');
const ALLOW_WINNERS_ONLY = has('allow-winners-only');
const DEMO_DIR = flag('demos', 'D:/Dev/trainingdemos');
const DEMO_LIMIT = Number(flag('limit', 0)) || 0;
const OUT = flag(
  'out',
  path.join(REPLAY_ROOT, 'sim', 'datasets', `igl-${MAP.toLowerCase()}-s${SEED}x${MATCHES}.jsonl`)
);

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * The machine-readable half of the progress line, for the lab's job panel.
 * Named after the output so an IGL extract and a player extract running at the
 * same time do not overwrite each other's ETA.
 */
const PROGRESS_PATH = path.join(
  path.dirname(OUT),
  `${path.basename(OUT, '.jsonl')}.progress.json`
);
async function writeProgress(body) {
  const tmp = `${PROGRESS_PATH}.tmp`;
  try {
    await fs.mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(body, null, 2));
    await fs.rename(tmp, PROGRESS_PATH);
  } catch {
    /* progress is never worth failing a run over */
  }
}

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

/**
 * The picture a mined tape started in. A freeze is the one moment where the
 * belief is not a belief: five alive, full clock, nothing planted, nobody
 * anywhere yet. That is what makes library freeze rows usable at all — no
 * god-view is being smuggled in, because at t=0 there is nothing to smuggle.
 */
function freezePictureOf(entry) {
  return {
    side: entry.side,
    alive: 5,
    enemyAlive: 5,
    clock: 0,
    secondsLeft: ROUND_SECONDS,
    bombSecondsLeft: BOMB_SECONDS,
    planted: false,
    hasKit: entry.side === 'CT',
    contactRel: null,
    siteExpectedTarget: 0,
    siteExpectedOther: 0,
    packAtTarget: 0,
    teamBroken: false
  };
}

/** One row per mined tape: what the winners called, from where. */
function libraryRows(bake) {
  const index = indexPlaybook(bake.entries || bake);
  const out = [];
  for (const side of ['T', 'CT']) {
    for (const entry of index.bySide?.[side] || []) {
      out.push({
        v: IGL_LOG_VERSION,
        map: entry.map || MAP,
        side,
        round: null,
        tick: 0,
        event: IGL_EVENT.FREEZE,
        econ: entry.econ ?? null,
        gen: 0,
        source: 'library',
        matchId: `lib:${entry.demo || entry.id}`,
        situation: null,
        picture: freezePictureOf(entry),
        decision: decisionFor(entry),
        tapeId: entry.id,
        call: entry.call || null,
        candidates: null,
        pWin_belief: null,
        pWin_true: null,
        residual: null,
        fightEv: null,
        margin: null,
        recalled: false,
        posture: null,
        motive: 'library: winning round-side',
        // The bake holds winners only. This is not a measurement.
        won: true,
        attrib: null
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// --from demos: the real corpus, both outcomes
// ---------------------------------------------------------------------------

/**
 * Primary weapons as the demo's loadout spells them. Used only to tell a
 * pistol round from a thin buy, which the equipment thresholds alone cannot:
 * five players with armour and a P250 clear $5,000 without owning a gun.
 */
const PRIMARY_NAME =
  /^(AK-47|AWP|AUG|FAMAS|Galil AR|G3SG1|M4A1-S|M4A4|M249|MAC-10|MAG-7|MP5-SD|MP7|MP9|Negev|Nova|P90|PP-Bizon|SCAR-20|SG 553|Sawed-Off|SSG 08|UMP-45|XM1014)$/i;

/**
 * The 0–5 econ bucket for a side, from what it actually walked out with.
 *
 * Thresholds are `econBucketOf`'s, which are `server/demoparser/economy.js`'s.
 * Kept as a separate reading rather than an import because that function takes
 * live sim bodies and this takes a demo's stats block; the numbers are the
 * thing that has to match, and they do.
 *
 * @returns {number|null} 0 pistol, 1 eco, 2 half, 3 force, 4 full, 5 full+AWP
 */
function econBucketFromStats(players, stats = {}) {
  if (!players?.length) return null;
  let equip = 0;
  let hasAwp = false;
  let hasPrimary = false;
  for (const p of players) {
    const s = stats[p.id] || {};
    equip += Number(s.equipValue) || 0;
    for (const item of s.loadout || []) {
      if (/^AWP$/i.test(item)) hasAwp = true;
      if (PRIMARY_NAME.test(item)) hasPrimary = true;
    }
  }
  if (!hasPrimary) return 0;
  if (hasAwp && equip >= 18000) return 5;
  if (equip >= 18000) return 4;
  if (equip < 5000) return 1;
  if (equip >= 10000) return 3;
  return 2;
}

/**
 * One round of one demo, as caller rows for BOTH sides.
 *
 * The picture carries only what a caller could actually know at that moment:
 * bodies (the scoreboard shows both), the clock, the bomb, and where the last
 * fight happened relative to this side's own spawn→objective axis. The
 * belief-model fields (`siteExpectedTarget`, `packAtTarget`, `teamBroken`) are
 * OMITTED rather than zeroed — a demo has no belief in it, and writing zeros
 * would teach the head that "nobody is anywhere" is a real reading of a round
 * that in play never produces one.
 */
function demoRows({ meta, track, angles, network, map, demoId }) {
  const tickRate = meta.tickRate || 64;
  const t0 = meta.freezeEndTick ?? meta.startTick ?? 0;
  const endTick = meta.endTick ?? t0;
  if (!(endTick > t0)) return [];

  const side1 = meta.team1Side === 'CT' ? 'CT' : 'T';
  const sideOfTeam = { 1: side1, 2: side1 === 'CT' ? 'T' : 'CT' };
  const winSide = meta.winnerSide || sideOfTeam[meta.winner === 2 ? 2 : 1];
  if (winSide !== 'T' && winSide !== 'CT') return [];

  const players = meta.players || [];
  const bySide = { T: [], CT: [] };
  for (const p of players) {
    const s = sideOfTeam[p.team];
    if (s) bySide[s].push(p);
  }
  if (bySide.T.length !== 5 || bySide.CT.length !== 5) return [];

  // Both ends of the round get a call. This is the whole reason this mode
  // exists: the losing side ran a real call that really lost.
  let tags = { t: [], ct: [] };
  try {
    tags = roundTagsFor({ meta, track, network, utilities: [], mapCode: map });
  } catch {
    /* untagged rounds are defaults, on both sides */
  }

  const deathTick = new Map();
  for (const k of meta.events?.kills || []) {
    if (!deathTick.has(k.victim)) deathTick.set(k.victim, k.tick);
  }

  const plantEvent = (meta.events?.bomb || []).find((b) => b.type === 'planted' || b.type === 'plant');
  const plantTick = Number.isFinite(meta.plantTick)
    ? meta.plantTick
    : Number.isFinite(plantEvent?.tick)
      ? plantEvent.tick
      : null;
  // The axis both sides are judged against: where the round was going. With no
  // plant it is the map centre, exactly as the playbook miner does it.
  const goal =
    plantEvent && Number.isFinite(plantEvent.x) ? { x: plantEvent.x, y: plantEvent.y } : { x: 0, y: 0 };

  const spawnStates = [];
  track.sampleAll(t0, spawnStates);
  const spawnOf = {};
  for (const side of ['T', 'CT']) {
    let cx = 0;
    let cy = 0;
    for (const p of bySide[side]) {
      cx += spawnStates[p.slot]?.x || 0;
      cy += spawnStates[p.slot]?.y || 0;
    }
    spawnOf[side] = { x: cx / 5, y: cy / 5 };
  }

  // 9.25 stage 1's moments, and only those: freeze, contact, man-count change.
  const kills = (meta.events?.kills || [])
    .filter((k) => Number.isFinite(k.tick) && k.tick > t0 && k.tick <= endTick)
    .sort((a, b) => a.tick - b.tick);
  const moments = [{ tick: t0, event: IGL_EVENT.FREEZE, kind: 'freeze', kill: null }];
  for (const k of kills) moments.push({ tick: k.tick, event: IGL_EVENT.RECALL, kind: 'kill', kill: k });
  if (Number.isFinite(plantTick) && plantTick > t0 && plantTick <= endTick) {
    moments.push({ tick: plantTick, event: IGL_EVENT.RECALL, kind: 'plant', kill: null });
  }
  moments.sort((a, b) => a.tick - b.tick || (a.kind === 'freeze' ? -1 : 0));

  const relAt = (tick, kill, side) => {
    if (!kill) return null;
    const victim = players.find((p) => p.id === kill.victim);
    if (!victim) return null;
    const vs = track.sample(victim.slot, tick, {});
    if (!Number.isFinite(vs?.x) || !Number.isFinite(vs?.y)) return null;
    return classifyContactRel({ x: vs.x, y: vs.y, spawn: spawnOf[side], goal });
  };

  const out = [];
  for (const side of ['T', 'CT']) {
    const enemy = side === 'T' ? 'CT' : 'T';
    const list = side === 'CT' ? tags.ct : tags.t;
    const call = list?.length ? list[0].k : 'default';
    const econ = econBucketFromStats(bySide[side], meta.stats);
    const won = side === winSide;

    // `decisionFor`'s reading of what this side's round turned out to be,
    // built per side rather than for the winner alone.
    const firstKillOfSide = kills.find(
      (k) => bySide[side].some((p) => p.id === k.attacker) || bySide[side].some((p) => p.id === k.victim)
    );
    const firstContact = firstKillOfSide
      ? {
          t: (firstKillOfSide.tick - t0) / tickRate,
          rel: relAt(firstKillOfSide.tick, firstKillOfSide, side)
        }
      : null;
    const decision = decisionFor({
      plant: Number.isFinite(plantTick) ? { t: (plantTick - t0) / tickRate } : null,
      firstContact
    });

    let rel = null;
    for (const m of moments) {
      if (m.kind === 'kill') rel = relAt(m.tick, m.kill, side) || rel;
      const alive = bySide[side].filter((p) => (deathTick.get(p.id) ?? Infinity) > m.tick).length;
      const enemyAlive = bySide[enemy].filter((p) => (deathTick.get(p.id) ?? Infinity) > m.tick).length;
      // A wipe is not a decision. Pricing it would teach the head the shape of
      // the scoreboard at the moment the round stopped, which it already knows.
      if (alive === 0 || enemyAlive === 0) continue;

      const clock = (m.tick - t0) / tickRate;
      const isPlanted = Number.isFinite(plantTick) && m.tick >= plantTick;
      out.push({
        v: IGL_LOG_VERSION,
        map,
        side,
        round: meta.round ?? null,
        tick: m.tick,
        event: m.event,
        econ,
        gen: 0,
        source: 'demos',
        // The holdout unit is the demo, which is the match. A round-level
        // split leaks: rounds of one match share econ, score and opponent.
        matchId: `demo:${demoId}`,
        situation: null,
        picture: {
          side,
          alive,
          enemyAlive,
          clock: Math.round(clock * 10) / 10,
          secondsLeft: Math.max(0, Math.round((ROUND_SECONDS - clock) * 10) / 10),
          bombSecondsLeft: isPlanted
            ? Math.max(0, Math.round((BOMB_SECONDS - (m.tick - plantTick) / tickRate) * 10) / 10)
            : BOMB_SECONDS,
          planted: isPlanted,
          // A demo does not record who carried the kit. CT sides in this
          // corpus overwhelmingly had one; the alternative reading (nobody
          // ever does) is further from the truth than this one.
          hasKit: side === 'CT',
          contactRel: rel
        },
        decision,
        tapeId: `${demoId}:${meta.round ?? 0}`,
        call,
        candidates: null,
        pWin_belief: null,
        pWin_true: null,
        residual: null,
        fightEv: null,
        margin: null,
        recalled: m.event === IGL_EVENT.RECALL,
        posture: null,
        motive: `demo: ${side} ${call}`,
        won,
        attrib: null
      });
    }
  }
  return out;
}

/** Walk the packages and tag every round-side. */
async function demoSourceRows({ network }) {
  let all;
  try {
    all = (await fs.readdir(DEMO_DIR)).filter((f) => f.endsWith('.aim4replay'));
  } catch (err) {
    console.error(`cannot read ${DEMO_DIR}: ${err.message}`);
    process.exit(1);
  }
  all.sort();
  if (DEMO_LIMIT) all = all.slice(0, DEMO_LIMIT);
  console.log(`${all.length} packages in ${DEMO_DIR}`);

  const out = [];
  let rounds = 0;
  let skipped = 0;
  let done = 0;
  const startedAt = Date.now();
  for (const file of all) {
    const demoId = path.basename(file, '.aim4replay');
    try {
      const { files } = decodeReplayPackage(await fs.readFile(path.join(DEMO_DIR, file)));
      const stems = new Set();
      for (const name of files.keys()) {
        const m = /^rounds\/(.+?)\.(tickz|json\.zst)$/.exec(name);
        if (m) stems.add(m[1]);
      }
      for (const stem of stems) {
        const metaRaw = files.get(`rounds/${stem}.json.zst`);
        const tickRaw = files.get(`rounds/${stem}.tickz`);
        if (!metaRaw || !tickRaw) continue;
        const meta = JSON.parse(zlib.zstdDecompressSync(Buffer.from(metaRaw)).toString('utf8'));
        // 12.1: nothing the sim produced may re-enter a training set.
        if (isSynthetic(meta)) continue;
        if (String(meta.map || '').toUpperCase() !== MAP) continue;
        const track = new TickTrack(decodeTickz(Buffer.from(tickRaw)));
        const rows = demoRows({ meta, track, network, map: MAP, demoId });
        if (rows.length) rounds += 1;
        else skipped += 1;
        out.push(...rows);
      }
    } catch {
      skipped += 1;
    }
    done += 1;
    if (done % 25 === 0 || done === all.length) {
      // A pass over 3122 packages is a coffee-length job, so it says how long
      // it has left rather than only how far it has come.
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / Math.max(0.001, elapsed);
      const eta = rate > 0 ? (all.length - done) / rate : 0;
      process.stdout.write(
        `\r  ${String(done).padStart(5)}/${all.length}  ` +
          `${((done / all.length) * 100).toFixed(1).padStart(5)}%  ` +
          `${out.length.toLocaleString()} rows  ${rate.toFixed(1)}/s  ` +
          `ETA ${fmtDuration(eta)}   `
      );
      await writeProgress({
        phase: 'extract-caller',
        map: MAP,
        done,
        total: all.length,
        percent: Math.round((done / all.length) * 1000) / 10,
        rows: out.length,
        rounds,
        skipped,
        perSecond: Math.round(rate * 10) / 10,
        etaSeconds: Math.round(eta),
        elapsedSeconds: Math.round(elapsed),
        updatedAt: new Date().toISOString()
      });
    }
  }
  process.stdout.write('\n');
  console.log(`  ${rounds} round-sides tagged, ${skipped} rounds unusable`);
  return out;
}

/** Play matches and take the sealed rows off each round. */
function selfPlayRows({ graph, angles }) {
  const out = [];
  for (let m = 0; m < MATCHES; m += 1) {
    const matchId = `sp:${MAP}:${SEED + m}`;
    playVersusMatch({
      graph,
      angles,
      map: MAP,
      controllerA: desireController({ angles, matchId, valueHead: VALUE_HEAD }),
      controllerB: desireController({ angles, matchId, valueHead: VALUE_HEAD }),
      seed: SEED + m,
      maxRounds: ROUNDS,
      onRound: (round) => {
        for (const team of ['A', 'B']) {
          for (const row of round.igl?.[team] || []) {
            out.push({ ...row, source: 'self-play', matchId, round: round.round });
          }
        }
      }
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return out;
}

async function main() {
  const wantLibrary = FROM === 'library' || FROM === 'both';
  const wantSelfPlay = FROM === 'self-play' || FROM === 'both';
  const wantDemos = FROM === 'demos';

  let rows = [];
  if (wantDemos) {
    let network = null;
    try {
      network = JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'zones', `${MAP}.json`), 'utf8'));
    } catch {
      console.error(`no zone network for ${MAP}; every round would tag as default`);
      process.exit(1);
    }
    rows = rows.concat(await demoSourceRows({ network }));
  }
  if (wantLibrary) {
    const bake = await load('playbook', MAP);
    rows = rows.concat(libraryRows(bake));
  }
  if (wantSelfPlay) {
    const graph = navGraphFromBake(await load('navcache', MAP));
    const angles = loadAngles(await load('angles', MAP));
    rows = rows.concat(selfPlayRows({ graph, angles }));
  }

  if (!rows.length) {
    console.error(`no rows for --from ${FROM}`);
    process.exit(1);
  }

  const losses = rows.filter((r) => r.won === false).length;
  if (!losses && !ALLOW_WINNERS_ONLY) {
    console.error(
      'every row in this set is a win, which is what a winners-only library looks like.\n' +
        '9.25 stage 1: "both outcomes train the head or every execute looks like 100%".\n' +
        'Use --from demos (the corpus tags both ends of every round), or --from both,\n' +
        'or pass --allow-winners-only if you are deliberately building a coverage set.'
    );
    process.exit(1);
  }

  const { train, val, holdout, strata } = splitMatches(rows, { fraction: HOLDOUT, salt: `igl:${MAP}` });
  const trainable = trainableRows(rows).length;
  const byAttrib = rows.reduce((a, r) => {
    const k = r.attrib || 'none';
    a[k] = (a[k] || 0) + 1;
    return a;
  }, {});

  const meta = {
    type: 'meta',
    v: 1,
    kind: 'igl',
    iglVersion: IGL_LOG_VERSION,
    prwVersion: PRW_LOG_VERSION,
    teacher: wantDemos ? 'demos' : 'desire-4.3b',
    valueHead: VALUE_HEAD,
    map: MAP,
    seed: SEED,
    from: FROM,
    matches: wantDemos ? new Set(rows.map((r) => r.matchId)).size : MATCHES,
    rounds: rows.length,
    wins: rows.filter((r) => r.won === true).length,
    losses,
    attrib: byAttrib,
    // The split travels WITH the data. A trainer that re-splits by row will
    // report a number no unseen match reproduces (9.3's lesson, 9.25's rule).
    holdout: { fraction: HOLDOUT, by: 'match', stratifiedBy: ['map', 'side', 'call', 'econ'], strata, matches: [...holdout] },
    train: train.length,
    val: val.length
  };

  const lines = [JSON.stringify(meta)];
  for (const r of rows) {
    lines.push(JSON.stringify({ ...r, split: holdout.has(r.matchId) ? 'val' : 'train' }));
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join('\n'));

  console.log(`${rows.length} IGL rows (${meta.wins}W / ${meta.losses}L) -> ${OUT}`);
  console.log(`  train ${train.length}  val ${val.length}  over ${strata} strata`);
  console.log(`  trainable (attrib call or unlabelled) ${trainable}; ${JSON.stringify(byAttrib)}`);
  const freeze = rows.filter((r) => r.event === IGL_EVENT.FREEZE).length;
  console.log(`  ${freeze} freezes, ${rows.length - freeze} recalls`);

  // What the head will actually be asked to tell apart, and how often each
  // call won. A call that only ever appears on one side of the result is a
  // call the value head cannot learn anything from.
  const byCall = new Map();
  for (const r of rows) {
    const k = `${r.side} ${r.call || 'default'}`;
    const c = byCall.get(k) || { n: 0, w: 0 };
    c.n += 1;
    if (r.won === true) c.w += 1;
    byCall.set(k, c);
  }
  console.log(`  ${byCall.size} distinct (side, call) pairs:`);
  for (const [k, c] of [...byCall.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${k.padEnd(26)} ${String(c.n).padStart(6)} rows  ${((c.w / c.n) * 100).toFixed(1)}% won`);
  }
  if (rows.length && wantSelfPlay) {
    const perRound = (rows.length / Math.max(1, MATCHES * ROUNDS * 2)).toFixed(1);
    console.log(`  ${perRound} rows per round-side (9.25 expects a handful, never 8 Hz)`);
  }
  const thin = new Map();
  for (const r of rows) thin.set(stratumOf(r), (thin.get(stratumOf(r)) || 0) + 1);
  const singles = [...thin.values()].filter((n) => n < 4).length;
  if (singles) console.log(`  ${singles} strata under 4 rows: the holdout there is decorative`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
