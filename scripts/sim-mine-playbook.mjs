#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-mine-playbook.mjs
// The playbook: every winning round in the library, as a runnable tape.
//
// The knowledge tables (sim-mine-knowledge.mjs) answer what a POSITION is.
// The playbook answers what a ROUND is: which five contracts were manned,
// where each of them walked and when, what they threw, from where, at what
// clock, and where the bomb went down. The hivemind caller samples one of
// these at round start and the bots copy it role by role until the round
// stops matching, which is the operator's design in one sentence: bots copy
// what winners actually did, and improvise only when the copy breaks.
//
// One entry per WINNING round-side. Losing sides are context, never tape.
//
// Entry shape (one JSON line each, per-map files):
//   { id, map, side, call, econ, econEnemy, plant: {site, t}|null,
//     firstContact: {t, rel: 'front'|'site'|'behind'}|null,
//     roles: [ { contract, steamId, awp,
//                waypoints: [[t, anchor], ...],
//                utility: [{t, type, from, at, fx, fy, ax, ay, flight}] } ] }
//
// Waypoints are anchor changes at 2 Hz, not poses: the operator's spec is
// "where to end up and what the core idea is", not pixel tracing. Utility
// keeps exact world coordinates so a copied lineup lands where the pro's
// grenade landed, not at an anchor centroid.
//
//   node scripts/sim-mine-playbook.mjs --limit 40 --maps ANC
//   node scripts/sim-mine-playbook.mjs               # the whole corpus
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { decodeReplayPackage } from '../src/replays/shared/replayPackage.js';
import { decodeTickz } from '../server/replays/tickCodec.js';
import { TickTrack } from '../src/replays/tickStore.js';
import { roundTagsFor } from '../src/replays/analytics/roundTags.js';
import { loadBake } from '../server/sim/bakes.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { PLAYBOOK_VERSION } from '../shared/sim/playbook.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DIR = flag('dir', 'D:/Dev/trainingdemos');
const OUT = flag('out', path.join(REPLAY_ROOT, 'sim', 'playbook'));
const ONLY_MAPS = String(flag('maps', '') || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const LIMIT = Number(flag('limit', 0)) || 0;
const BATCH = Number(flag('batch', 0)) || 0;
const CHECKPOINT_EVERY = Number(flag('checkpoint', 50));
const REBUILD = has('rebuild');

/** Waypoint sampling cadence. Anchor changes are what get recorded. */
const WAYPOINT_HZ = 2;
/** Seconds after live before a position counts as the settled contract. */
const SETUP_SECONDS = 12;
/** Cap per role so a knife-run round cannot produce a hundred waypoints. */
const MAX_WAYPOINTS = 48;

const round1 = (x) => Math.round(x * 10) / 10;

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

const mapCache = new Map();
async function mapState(map) {
  if (mapCache.has(map)) return mapCache.get(map);
  let state = null;
  try {
    const nav = await loadBake('navcache', map);
    const ang = await loadBake('angles', map);
    if (!nav || !ang) throw new Error('no bake');
    let network = null;
    try {
      network = JSON.parse(await fsp.readFile(path.join(REPLAY_ROOT, 'zones', `${map}.json`), 'utf8'));
    } catch {
      network = null;
    }
    state = { graph: navGraphFromBake(nav.bake), angles: loadAngles(ang.bake), network };
  } catch {
    state = null;
  }
  mapCache.set(map, state);
  return state;
}

/**
 * Mine one round into a playbook entry, or null when it cannot teach.
 */
function mineEntry({ meta, track, state, map, demoId }) {
  const tickRate = meta.tickRate || 64;
  const t0 = meta.freezeEndTick ?? meta.startTick ?? 0;
  const endTick = Math.min(meta.endTick ?? t0, t0 + 115 * tickRate);
  if (!(endTick > t0)) return null;

  const side1 = meta.team1Side === 'CT' ? 'CT' : 'T';
  const sideOfTeam = { 1: side1, 2: side1 === 'CT' ? 'T' : 'CT' };
  const winnerTeam = meta.winner === 2 ? 2 : 1;
  const winSide = meta.winnerSide || sideOfTeam[winnerTeam];
  const winners = (meta.players || []).filter((p) => p.team === winnerTeam);
  if (winners.length !== 5) return null;

  let call = 'default';
  if (state.network) {
    try {
      const tags = roundTagsFor({ meta, track, network: state.network, utilities: [], mapCode: map });
      const list = winSide === 'CT' ? tags.ct : tags.t;
      if (list?.length) call = list[0].k;
    } catch {
      /* untagged is a default round */
    }
  }

  const step = Math.max(1, Math.round(tickRate / WAYPOINT_HZ));
  const states = [];

  // Death ticks for liveness, from the public feed.
  const deathTick = new Map();
  for (const k of meta.events?.kills || []) {
    if (!deathTick.has(k.victim)) deathTick.set(k.victim, k.tick);
  }

  // The team's spawn centroid and the eventual objective, for the
  // front/site/behind classification of the first contact.
  track.sampleAll(t0, states);
  let cx = 0;
  let cy = 0;
  for (const p of winners) {
    cx += states[p.slot]?.x || 0;
    cy += states[p.slot]?.y || 0;
  }
  cx /= 5;
  cy /= 5;

  const planted = (meta.events?.bomb || []).find((b) => b.type === 'planted');
  const plantAnchor = planted && Number.isFinite(planted.x)
    ? state.angles.nearestAnchor(planted.x, planted.y)
    : null;
  const plant = planted
    ? { site: plantAnchor?.id || planted.site || null, t: round1((planted.tick - t0) / tickRate) }
    : null;

  // Reference axis: spawn centroid toward the plant (or the map centre when
  // the round never planted). "Behind" is ground past our spawn, away from
  // where the round was going.
  const goal = planted && Number.isFinite(planted.x)
    ? { x: planted.x, y: planted.y }
    : { x: 0, y: 0 };
  const axx = goal.x - cx;
  const axy = goal.y - cy;
  const axLen = Math.hypot(axx, axy) || 1;

  let firstContact = null;
  const firstKill = (meta.events?.kills || [])[0];
  if (firstKill) {
    const victim = (meta.players || []).find((p) => p.id === firstKill.victim);
    if (victim) {
      const vs = track.sample(victim.slot, firstKill.tick, {});
      const proj = ((vs.x - cx) * axx + (vs.y - cy) * axy) / axLen;
      const distToGoal = Math.hypot(vs.x - goal.x, vs.y - goal.y);
      const rel = distToGoal < 1200 ? 'site' : proj < -250 ? 'behind' : 'front';
      firstContact = { t: round1((firstKill.tick - t0) / tickRate), rel };
    }
  }

  // Per-role tape.
  const roles = [];
  for (const p of winners) {
    const died = deathTick.get(p.id) ?? Infinity;
    const waypoints = [];
    const occ = new Map();
    const settled = new Map();
    let lastAnchor = null;
    for (let tick = t0; tick <= Math.min(endTick, died); tick += step) {
      track.sample(p.slot, tick, states[0] = states[0] || {});
      const st = track.sample(p.slot, tick, {});
      if (!st.alive) break;
      const a = state.angles.nearestAnchor(st.x, st.y);
      if (!a) continue;
      const t = (tick - t0) / tickRate;
      occ.set(a.id, (occ.get(a.id) || 0) + 1);
      if (t >= SETUP_SECONDS) settled.set(a.id, (settled.get(a.id) || 0) + 1);
      if (a.id !== lastAnchor && waypoints.length < MAX_WAYPOINTS) {
        waypoints.push([round1(t), a.id]);
        lastAnchor = a.id;
      }
    }
    if (waypoints.length === 0) continue;

    const source = settled.size ? settled : occ;
    let contract = null;
    let best = 0;
    for (const [anchor, n] of source) {
      if (n > best) {
        best = n;
        contract = anchor;
      }
    }

    const stat = meta.stats?.[p.id] || {};
    const loadout = (stat.loadout || []).join(' ');
    const awp = /awp/i.test(loadout);

    const utility = [];
    for (const g of meta.events?.grenades || []) {
      if (g.player !== p.id) continue;
      const throwTick = Number(g.throwTick);
      if (!Number.isFinite(throwTick) || !g.at) continue;
      const from = g.from ? state.angles.nearestAnchor(g.from.x, g.from.y) : null;
      const at = state.angles.nearestAnchor(g.at.x, g.at.y);
      const det = Number(g.detonateTick);
      utility.push({
        t: round1((throwTick - t0) / tickRate),
        type: g.type,
        from: from?.id || null,
        at: at?.id || null,
        fx: Math.round(g.from?.x ?? 0),
        fy: Math.round(g.from?.y ?? 0),
        ax: Math.round(g.at.x),
        ay: Math.round(g.at.y),
        flight: Number.isFinite(det) ? round1(Math.max(0.1, (det - throwTick) / tickRate)) : 1.5
      });
    }

    roles.push({ contract, steamId: p.steamId || p.id, awp, waypoints, utility });
  }
  if (roles.length < 4) return null;

  const econOwn = winnerTeam === 1 ? meta.econ1 : meta.econ2;
  const econEnemy = winnerTeam === 1 ? meta.econ2 : meta.econ1;

  return {
    id: `${demoId}:${meta.round ?? 0}`,
    map,
    side: winSide,
    call,
    econ: econOwn ?? null,
    econEnemy: econEnemy ?? null,
    plant,
    firstContact,
    roles
  };
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const indexFile = path.join(OUT, 'index.json');
  let index = { v: PLAYBOOK_VERSION, demos: [] };
  if (!REBUILD) {
    try {
      const prev = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
      if (prev.v === PLAYBOOK_VERSION) index = prev;
    } catch {
      /* first run */
    }
  } else {
    for (const f of await fsp.readdir(OUT).catch(() => [])) {
      if (f.endsWith('.jsonl')) await fsp.rm(path.join(OUT, f));
    }
  }
  const seen = new Set(index.demos);

  let all;
  try {
    all = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.aim4replay'));
  } catch (err) {
    console.error(`cannot read ${DIR}: ${err.message}`);
    process.exit(1);
  }
  all.sort();

  let todo = all.filter((f) => !seen.has(path.basename(f, '.aim4replay')));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  if (BATCH) todo = todo.slice(0, BATCH);

  console.log(`corpus ${all.length} demos, already mined ${seen.size}, this run ${todo.length}`);
  if (!todo.length) {
    console.log('nothing to do. --rebuild to start over.');
    return;
  }

  const startedAt = Date.now();
  let done = 0;
  let entries = 0;
  let failed = 0;
  const perMap = new Map();
  const streams = new Map();
  const streamFor = (map) => {
    let s = streams.get(map);
    if (!s) {
      s = fs.createWriteStream(path.join(OUT, `${map}.jsonl`), { flags: 'a' });
      streams.set(map, s);
    }
    return s;
  };

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nstopping after this demo. progress is kept; re-run to continue.');
  });

  const progressFile = path.join(OUT, 'progress.json');
  const writeProgress = () => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(0.001, elapsed);
    writeAtomic(
      progressFile,
      JSON.stringify(
        {
          phase: 'mine-playbook',
          done,
          total: todo.length,
          percent: Math.round((done / Math.max(1, todo.length)) * 1000) / 10,
          entries,
          failed,
          byMap: Object.fromEntries(perMap),
          demosPerSecond: Math.round(rate * 100) / 100,
          etaSeconds: Math.round(rate > 0 ? (todo.length - done) / rate : 0),
          heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  };

  for (const file of todo) {
    if (stopping) break;
    const demoId = path.basename(file, '.aim4replay');
    let mapSeen = null;
    try {
      const { files } = decodeReplayPackage(await fsp.readFile(path.join(DIR, file)));
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
        const code = String(meta.map || '').toUpperCase();
        if (!code) continue;
        mapSeen = code;
        if (ONLY_MAPS.length && !ONLY_MAPS.includes(code)) break;
        const state = await mapState(code);
        if (!state) continue;
        const track = new TickTrack(decodeTickz(Buffer.from(tickRaw)));
        const entry = mineEntry({ meta, track, state, map: code, demoId });
        if (entry) {
          streamFor(code).write(JSON.stringify(entry) + '\n');
          entries += 1;
          perMap.set(code, (perMap.get(code) || 0) + 1);
        }
      }
      index.demos.push(demoId);
    } catch (err) {
      failed += 1;
    }
    done += 1;
    if (done % 25 === 0 || done === todo.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / Math.max(0.001, elapsed);
      console.log(
        `[${String(done).padStart(5)}/${todo.length}] ` +
          `${((done / todo.length) * 100).toFixed(1).padStart(5)}%  ` +
          `${entries.toLocaleString()} entries  ${rate.toFixed(1)}/s  ` +
          `ETA ${fmtDuration((todo.length - done) / Math.max(0.01, rate))}  ` +
          `heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB`
      );
      writeProgress();
    }
    if (done % CHECKPOINT_EVERY === 0) {
      writeAtomic(indexFile, JSON.stringify(index));
    }
  }

  for (const s of streams.values()) s.end();
  writeAtomic(indexFile, JSON.stringify(index));
  writeProgress();

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n${entries.toLocaleString()} playbook entries from ${done} demos in ${fmtDuration(elapsed)}`);
  for (const [m, n] of [...perMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m}  ${n.toLocaleString()} rounds`);
  }
  const remaining = all.length - (seen.size + done);
  if (remaining > 0) {
    console.log(`${remaining} demos left. Re-run to continue.`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
