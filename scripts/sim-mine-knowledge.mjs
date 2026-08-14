#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-mine-knowledge.mjs
// K0 of SIM-PLAN 9.3b: what a bot KNOWS about a map, mined from real demos.
//
// The plan's claim is that most CS skill is fitted, mined or baked rather than
// learned, and that a network should not have to rediscover from gradients
// that Inferno T Banana arrives around 1:42. This script is where that
// knowledge comes from: 3,100 real demos in, per-position tables out.
//
// Three rules decide everything below, and the first two are the operator's:
//
//   ONLY WINNERS TEACH. A round is mined from the side that WON it. Averaging
//   winners and losers produces a bot that plays like the mean of a coin flip,
//   which is exactly the thing nobody wants to scrim against.
//
//   THE CALL IS A KEY, NOT A CONCLUSION. Every table is filed under the round
//   library's call, so "B rush" is something that can be COMMANDED at runtime
//   rather than coaxed out of a policy that learned one average round.
//
//   IT MUST SURVIVE 3,100 DEMOS ON A DESKTOP. 6.6 GB of packages will not fit
//   in memory and a run that dies at demo 2,900 must not lose 2,899. So the
//   loop is streamed, the samples are reservoirs, the bake is checkpointed
//   atomically, and every run resumes exactly where the last one stopped.
//
// Progress is a feature here, not decoration. A mine over a corpus this size
// is a long walk, so it prints a line per demo and writes progress.json beside
// the bake for the sim lab to poll: percent, rate, ETA, memory, failures.
//
//   node scripts/sim-mine-knowledge.mjs --limit 40 --maps INF
//   node scripts/sim-mine-knowledge.mjs --batch 250        # a chunk at a time
//   node scripts/sim-mine-knowledge.mjs                    # the whole corpus
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
import { KNOWLEDGE_VERSION, keyOf, summarize } from '../shared/sim/demoContracts.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DIR = flag('dir', 'D:/Dev/trainingdemos');
const OUT = flag('out', path.join(REPLAY_ROOT, 'sim', 'knowledge'));
const ONLY_MAPS = String(flag('maps', '') || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const LIMIT = Number(flag('limit', 0)) || 0;
const BATCH = Number(flag('batch', 0)) || 0;
const CHECKPOINT_EVERY = Number(flag('checkpoint', 50));
const REBUILD = has('rebuild');

/**
 * Values kept per distribution row. A mine over 65,000 rounds must cost the
 * same memory as one over 100, so rows hold a reservoir rather than every
 * sample; 2,000 is far more than p10/p50/p90 needs and still bounded.
 */
const RESERVOIR = 400;

/** Decision cadence for walking a round. 4 Hz, per 9.3b's stride rule. */
const SAMPLE_HZ = 4;
/** A body slower than this is holding rather than moving, units per second. */
const HOLD_SPEED = 40;
/**
 * Seconds after live before a player's position counts as their contract.
 * Long enough to be out of spawn and onto the ground they intend to hold,
 * short enough to catch a fast take. `[calibrate]`
 */
const SETUP_SECONDS = 12;

// ---------------------------------------------------------------------------
// Deterministic reservoir sampling. Seeded per row so two runs over the same
// demos produce the same tables; Math.random would make the bake unreproducible.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Reservoir {
  constructor(seedKey) {
    this.seen = 0;
    this.values = [];
    this.rand = mulberry32(hashString(seedKey));
  }

  push(v) {
    if (!Number.isFinite(v)) return;
    this.seen += 1;
    if (this.values.length < RESERVOIR) {
      this.values.push(v);
      return;
    }
    const j = Math.floor(this.rand() * this.seen);
    if (j < RESERVOIR) this.values[j] = v;
  }

  toJSON() {
    const d = summarize(this.values);
    return d ? { ...d, n: this.seen } : null;
  }
}

// ---------------------------------------------------------------------------
// The accumulator: one per (map, side, call, contract) key.

class Tables {
  constructor(key) {
    this.key = key;
    this.n = 0;
    this.arrival = new Map(); // anchor -> Reservoir(seconds)
    this.occupancy = new Map(); // anchor -> seconds held (total)
    this.holds = new Map(); // anchor -> {yawSin, yawCos, n}
    this.utility = new Map(); // `${type}|${from}|${at}` -> {n, clock: Reservoir}
    this.spacing = new Map(); // otherContract -> Reservoir(units)
    this.coOccupancy = new Map(); // otherContract -> count
    this.liveSeconds = 0;
  }

  arrivalFor(anchor) {
    let r = this.arrival.get(anchor);
    if (!r) {
      r = new Reservoir(`${this.key}|arr|${anchor}`);
      this.arrival.set(anchor, r);
    }
    return r;
  }

  spacingFor(other) {
    let r = this.spacing.get(other);
    if (!r) {
      r = new Reservoir(`${this.key}|spc|${other}`);
      this.spacing.set(other, r);
    }
    return r;
  }

  utilityFor(id) {
    let u = this.utility.get(id);
    if (!u) {
      u = { n: 0, clock: new Reservoir(`${this.key}|util|${id}`) };
      this.utility.set(id, u);
    }
    return u;
  }

  toJSON() {
    const occ = [...this.occupancy.entries()]
      .map(([anchor, seconds]) => {
        const h = this.holds.get(anchor);
        return {
          anchor,
          share: this.liveSeconds > 0 ? round4(seconds / this.liveSeconds) : 0,
          seconds: round4(seconds / Math.max(1, this.n)),
          // The mean facing while stationary there, as a circular mean: a bot
          // that remembers an angle has to remember which way it looked.
          yaw: h && h.n ? round4((Math.atan2(h.sin / h.n, h.cos / h.n) * 180) / Math.PI) : null,
          holdSamples: h ? h.n : 0
        };
      })
      .sort((a, b) => b.share - a.share)
      .slice(0, 24);

    const arrival = {};
    for (const [anchor, r] of this.arrival) {
      const d = r.toJSON();
      if (d) arrival[anchor] = d;
    }

    const utility = [...this.utility.entries()]
      .map(([id, u]) => {
        const [type, from, at] = id.split('|');
        return { type, from, at, n: u.n, share: round4(u.n / Math.max(1, this.n)), clock: u.clock.toJSON() };
      })
      .sort((a, b) => b.n - a.n)
      .slice(0, 40);

    const spacing = {};
    for (const [other, r] of this.spacing) {
      const d = r.toJSON();
      if (d) spacing[other] = d;
    }

    const coOccupancy = {};
    for (const [other, n] of this.coOccupancy) coOccupancy[other] = round4(n / Math.max(1, this.n));

    return { key: this.key, n: this.n, arrival, occupancy: occ, utility, spacing, coOccupancy };
  }
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Progress. Printed for a human, written as JSON for the lab.

class Progress {
  constructor(total, outDir) {
    this.total = total;
    this.outDir = outDir;
    this.done = 0;
    this.rounds = 0;
    this.mined = 0;
    this.failed = 0;
    this.reasons = new Map();
    this.byMap = new Map();
    this.startedAt = Date.now();
    this.lastWrite = 0;
    this.current = '';
  }

  fail(reason) {
    this.failed += 1;
    this.reasons.set(reason, (this.reasons.get(reason) || 0) + 1);
  }

  tick(demoId, map, rounds) {
    this.done += 1;
    this.rounds += rounds;
    this.current = demoId;
    if (map) this.byMap.set(map, (this.byMap.get(map) || 0) + 1);
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.done / Math.max(0.001, elapsed);
    const left = Math.max(0, this.total - this.done);
    const eta = rate > 0 ? left / rate : 0;
    const heap = process.memoryUsage().heapUsed / 1e6;
    const pct = ((this.done / Math.max(1, this.total)) * 100).toFixed(1);
    console.log(
      `[${String(this.done).padStart(5)}/${this.total}] ${pct.padStart(5)}%  ` +
        `${(map || '???').padEnd(4)} ${String(rounds).padStart(2)}r  ` +
        `${rate.toFixed(1)}/s  ETA ${fmtDuration(eta)}  heap ${heap.toFixed(0)}MB` +
        (this.failed ? `  skipped ${this.failed}` : '')
    );
    // Throttled so a fast map does not spend the run writing JSON.
    if (Date.now() - this.lastWrite > 2000) this.write();
  }

  write() {
    this.lastWrite = Date.now();
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.done / Math.max(0.001, elapsed);
    const body = {
      phase: 'mine-knowledge',
      done: this.done,
      total: this.total,
      percent: round4((this.done / Math.max(1, this.total)) * 100),
      rounds: this.rounds,
      minedTracks: this.mined,
      failed: this.failed,
      reasons: Object.fromEntries(this.reasons),
      byMap: Object.fromEntries(this.byMap),
      demosPerSecond: round4(rate),
      etaSeconds: Math.round(rate > 0 ? (this.total - this.done) / rate : 0),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
      current: this.current,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeAtomic(path.join(this.outDir, 'progress.json'), JSON.stringify(body, null, 2));
  }
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Per-map state, loaded lazily: a run filtered to Inferno must not pay for
// seven nav bakes and seven zone networks.

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
      network = JSON.parse(
        await fsp.readFile(path.join(REPLAY_ROOT, 'zones', `${map}.json`), 'utf8')
      );
    } catch {
      network = null; // tagging degrades to 'default', which we count
    }
    state = { graph: navGraphFromBake(nav.bake), angles: loadAngles(ang.bake), network };
  } catch {
    state = null;
  }
  mapCache.set(map, state);
  return state;
}

// ---------------------------------------------------------------------------

/** The bake being built for one map, plus the ids already folded into it. */
function emptyBake(map) {
  return { v: KNOWLEDGE_VERSION, map, rounds: 0, wonRounds: 0, demos: [], tables: {} };
}

async function loadBakeFile(map) {
  try {
    const raw = await fsp.readFile(path.join(OUT, `${map}.json`), 'utf8');
    const j = JSON.parse(raw);
    if (j.v === KNOWLEDGE_VERSION) return j;
  } catch {
    /* first run for this map */
  }
  return emptyBake(map);
}

/**
 * Mine one round into the accumulators.
 *
 * Everything here is read from the WINNING side's five players. The losing
 * side is not mined at all: it is the context they beat, not a model to copy.
 */
function mineRound({ meta, track, state, acc, map }) {
  const tickRate = meta.tickRate || 64;
  const t0 = meta.freezeEndTick ?? meta.startTick ?? 0;
  const endTick = meta.endTick ?? t0;
  if (!(endTick > t0)) return 0;

  const side1 = meta.team1Side === 'CT' ? 'CT' : 'T';
  const sideOfTeam = { 1: side1, 2: side1 === 'CT' ? 'T' : 'CT' };
  const winnerTeam = meta.winner === 2 ? 2 : 1;
  const winSide = meta.winnerSide || sideOfTeam[winnerTeam];

  // The call, from the round library, for the side that won it.
  let call = 'default';
  if (state.network) {
    try {
      const tags = roundTagsFor({ meta, track, network: state.network, utilities: [], mapCode: map });
      const list = winSide === 'CT' ? tags.ct : tags.t;
      if (list?.length) call = list[0].k;
    } catch {
      /* an untaggable round is a default round, not a failure */
    }
  }

  const winners = (meta.players || []).filter((p) => p.team === winnerTeam);
  if (!winners.length) return 0;

  const step = Math.max(1, Math.round(tickRate / SAMPLE_HZ));
  const dt = step / tickRate;
  const states = [];

  // First pass: per-player anchor timelines.
  const perPlayer = new Map();
  for (const p of winners) {
    perPlayer.set(p.slot, {
      contract: null,
      first: new Map(),
      occ: new Map(),
      settled: new Map(),
      holds: new Map(),
      alive: 0
    });
  }

  for (let tick = t0; tick <= endTick; tick += step) {
    track.sampleAll(tick, states);
    const seconds = (tick - t0) / tickRate;
    for (const p of winners) {
      const st = states[p.slot];
      if (!st?.alive) continue;
      const rec = perPlayer.get(p.slot);
      const a = state.angles.nearestAnchor(st.x, st.y);
      if (!a) continue;
      rec.alive += dt;
      if (!rec.first.has(a.id)) rec.first.set(a.id, seconds);
      rec.occ.set(a.id, (rec.occ.get(a.id) || 0) + dt);
      // Ground held after the walk out of spawn. The contract is read from
      // this and not from the whole round, because every player's first
      // anchor is their own spawn: keying on that produced a `t_spawn`
      // contract for all five and threw the position split away, which is
      // the one thing 9.3b says the unit of knowledge must be.
      if (seconds >= SETUP_SECONDS) {
        rec.settled.set(a.id, (rec.settled.get(a.id) || 0) + dt);
      }

      const prev = rec.lastPos;
      const speed = prev ? Math.hypot(st.x - prev.x, st.y - prev.y) / dt : 0;
      rec.lastPos = { x: st.x, y: st.y };
      if (speed < HOLD_SPEED) {
        let h = rec.holds.get(a.id);
        if (!h) {
          h = { sin: 0, cos: 0, n: 0 };
          rec.holds.set(a.id, h);
        }
        const rad = (st.yaw * Math.PI) / 180;
        h.sin += Math.sin(rad);
        h.cos += Math.cos(rad);
        h.n += 1;
      }
    }
  }

  // The contract: the ground each winner held longest once they were set up.
  // Falls back to their busiest anchor when a round ended before setup.
  for (const rec of perPlayer.values()) {
    const source = rec.settled.size ? rec.settled : rec.occ;
    let best = null;
    let bestSeconds = 0;
    for (const [anchor, seconds] of source) {
      if (seconds > bestSeconds) {
        bestSeconds = seconds;
        best = anchor;
      }
    }
    rec.contract = best;
  }

  // Second pass: fold each player into their (map, side, call, contract) key.
  let mined = 0;
  for (const p of winners) {
    const rec = perPlayer.get(p.slot);
    if (!rec?.contract || rec.alive < 2) continue;
    const key = keyOf({ map, side: winSide, call, contract: rec.contract });
    let t = acc.get(key);
    if (!t) {
      t = new Tables(key);
      acc.set(key, t);
    }
    t.n += 1;
    t.liveSeconds += rec.alive;
    for (const [anchor, seconds] of rec.first) t.arrivalFor(anchor).push(seconds);
    for (const [anchor, seconds] of rec.occ) t.occupancy.set(anchor, (t.occupancy.get(anchor) || 0) + seconds);
    for (const [anchor, h] of rec.holds) {
      let cur = t.holds.get(anchor);
      if (!cur) {
        cur = { sin: 0, cos: 0, n: 0 };
        t.holds.set(anchor, cur);
      }
      cur.sin += h.sin;
      cur.cos += h.cos;
      cur.n += h.n;
    }
    // Who else was up while this contract was held, and how far away.
    for (const q of winners) {
      if (q.slot === p.slot) continue;
      const other = perPlayer.get(q.slot);
      if (!other?.contract) continue;
      t.coOccupancy.set(other.contract, (t.coOccupancy.get(other.contract) || 0) + 1);
    }
    // Utility: what this player threw, from where, when.
    for (const g of meta.events?.grenades || []) {
      if (g.player !== p.id) continue;
      const throwTick = Number(g.throwTick);
      if (!Number.isFinite(throwTick)) continue;
      const from = g.from ? state.angles.nearestAnchor(g.from.x, g.from.y) : null;
      const at = g.at ? state.angles.nearestAnchor(g.at.x, g.at.y) : null;
      const u = t.utilityFor(`${g.type}|${from?.id || '?'}|${at?.id || '?'}`);
      u.n += 1;
      u.clock.push((throwTick - t0) / tickRate);
    }
    mined += 1;
  }
  return mined;
}

// ---------------------------------------------------------------------------

async function main() {
  await fsp.mkdir(OUT, { recursive: true });

  let all;
  try {
    all = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.aim4replay'));
  } catch (err) {
    console.error(`cannot read ${DIR}: ${err.message}`);
    process.exit(1);
  }
  all.sort();

  // Resume: everything already folded into a bake is skipped. This is what
  // makes `--batch 250` four times identical to one run of 1,000.
  const bakes = new Map();
  const seen = new Set();
  // demoId -> map code for every package ever opened. Without it a filtered
  // run re-decodes the same non-matching demos on every pass and never
  // advances, because a demo that produced no table is recorded nowhere.
  const indexFile = path.join(OUT, 'index.json');
  let scanned = {};
  if (!REBUILD) {
    try {
      scanned = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    } catch {
      scanned = {};
    }
  }
  if (!REBUILD) {
    for (const f of await fsp.readdir(OUT).catch(() => [])) {
      const m = /^([A-Z0-9]+)\.json$/.exec(f);
      if (!m) continue;
      const b = await loadBakeFile(m[1]);
      bakes.set(m[1], b);
      for (const id of b.demos) seen.add(id);
    }
  }

  let todo = all.filter((f) => {
    const id = path.basename(f, '.aim4replay');
    if (seen.has(id)) return false;
    // Known map, and this run does not want it: skip without opening 2 MB.
    const known = scanned[id];
    if (known && ONLY_MAPS.length && !ONLY_MAPS.includes(known)) return false;
    return true;
  });
  if (LIMIT) todo = todo.slice(0, LIMIT);
  if (BATCH) todo = todo.slice(0, BATCH);

  console.log(`corpus ${all.length} demos in ${DIR}`);
  console.log(`already mined ${seen.size}, this run ${todo.length}` + (ONLY_MAPS.length ? `, maps ${ONLY_MAPS.join(',')}` : ''));
  if (!todo.length) {
    console.log('nothing to do. --rebuild to start over.');
    return;
  }

  const progress = new Progress(todo.length, OUT);
  /** map -> Map(key -> Tables), rebuilt from the bake on demand. */
  const accs = new Map();

  const accFor = (map) => {
    let a = accs.get(map);
    if (!a) {
      a = new Map();
      accs.set(map, a);
    }
    return a;
  };

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nstopping after this demo. progress is kept; re-run to continue.');
  });

  const flush = async () => {
    for (const [map, acc] of accs) {
      const bake = bakes.get(map) || emptyBake(map);
      // Merge: a key already in the bake keeps its counts, because a mine is
      // incremental and the second batch must add to the first.
      for (const [key, t] of acc) bake.tables[key] = mergeTables(bake.tables[key], t.toJSON());
      bake.builtAt = new Date().toISOString();
      bakes.set(map, bake);
      writeAtomic(path.join(OUT, `${map}.json`), JSON.stringify(bake));
    }
    accs.clear();
    writeAtomic(indexFile, JSON.stringify(scanned));
    progress.write();
  };

  for (const file of todo) {
    if (stopping) break;
    const demoId = path.basename(file, '.aim4replay');
    let map = null;
    let mapSeen = null;
    let roundsHere = 0;
    try {
      const bytes = await fsp.readFile(path.join(DIR, file));
      const { files } = decodeReplayPackage(bytes);

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
        map = code;

        const track = new TickTrack(decodeTickz(Buffer.from(tickRaw)));
        const mined = mineRound({ meta, track, state, acc: accFor(code), map: code });
        progress.mined += mined;
        roundsHere += 1;
        const bake = bakes.get(code) || emptyBake(code);
        bake.rounds += 1;
        if (mined) bake.wonRounds += 1;
        bakes.set(code, bake);
      }

      for (const [, bake] of bakes) {
        if (!bake.demos.includes(demoId)) continue;
      }
      // File the demo id on every map it touched, so resume is exact.
      if (map) {
        const bake = bakes.get(map);
        if (bake && !bake.demos.includes(demoId)) bake.demos.push(demoId);
      }
      if (mapSeen) scanned[demoId] = mapSeen;
    } catch (err) {
      progress.fail(String(err.message || err).slice(0, 60));
    }
    progress.tick(demoId, map, roundsHere);
    if (progress.done % CHECKPOINT_EVERY === 0) await flush();
  }

  await flush();

  const elapsed = (Date.now() - progress.startedAt) / 1000;
  console.log(`\nmined ${progress.done} demos, ${progress.rounds} rounds, ${progress.mined} winning tracks in ${fmtDuration(elapsed)}`);
  if (progress.failed) {
    console.log(`skipped ${progress.failed}:`);
    for (const [reason, n] of progress.reasons) console.log(`  ${n}x ${reason}`);
  }
  for (const [map, bake] of bakes) {
    console.log(`  ${map}: ${Object.keys(bake.tables).length} tables, ${bake.rounds} rounds, ${bake.demos.length} demos -> ${path.join(OUT, `${map}.json`)}`);
  }
  const remaining = all.length - (seen.size + progress.done);
  if (remaining > 0) {
    const perDemo = elapsed / Math.max(1, progress.done);
    console.log(`\n${remaining} demos left, about ${fmtDuration(remaining * perDemo)} at this rate. Re-run to continue.`);
  }
}

/**
 * Fold a freshly mined table into whatever the bake already held.
 *
 * Counts add; distributions take the newer summary weighted by its own n,
 * which is an approximation and is documented as one: keeping every value
 * across 3,100 demos is exactly the memory blowup this design avoids.
 */
function mergeTables(oldT, newT) {
  if (!oldT) return newT;
  const out = { ...newT, n: (oldT.n || 0) + (newT.n || 0) };
  out.arrival = { ...oldT.arrival };
  for (const [anchor, d] of Object.entries(newT.arrival || {})) {
    const prev = out.arrival[anchor];
    out.arrival[anchor] = prev ? blendDist(prev, d) : d;
  }
  const occ = new Map();
  for (const row of [...(oldT.occupancy || []), ...(newT.occupancy || [])]) {
    const cur = occ.get(row.anchor);
    if (!cur) occ.set(row.anchor, { ...row });
    else {
      const total = cur.holdSamples + row.holdSamples || 1;
      cur.share = round4((cur.share + row.share) / 2);
      cur.seconds = round4((cur.seconds + row.seconds) / 2);
      cur.yaw = row.holdSamples > cur.holdSamples ? row.yaw : cur.yaw;
      cur.holdSamples = total;
    }
  }
  out.occupancy = [...occ.values()].sort((a, b) => b.share - a.share).slice(0, 24);
  const util = new Map();
  for (const row of [...(oldT.utility || []), ...(newT.utility || [])]) {
    const id = `${row.type}|${row.from}|${row.at}`;
    const cur = util.get(id);
    if (!cur) util.set(id, { ...row });
    else {
      cur.n += row.n;
      cur.clock = cur.clock && row.clock ? blendDist(cur.clock, row.clock) : cur.clock || row.clock;
    }
  }
  out.utility = [...util.values()].sort((a, b) => b.n - a.n).slice(0, 40);
  out.spacing = { ...oldT.spacing };
  for (const [other, d] of Object.entries(newT.spacing || {})) {
    const prev = out.spacing[other];
    out.spacing[other] = prev ? blendDist(prev, d) : d;
  }
  out.coOccupancy = { ...oldT.coOccupancy, ...newT.coOccupancy };
  return out;
}

function blendDist(a, b) {
  const n = (a.n || 0) + (b.n || 0);
  if (!n) return a;
  const w = (x, y) => round4(((x * (a.n || 0)) + (y * (b.n || 0))) / n);
  return {
    n,
    mean: w(a.mean, b.mean),
    sd: w(a.sd, b.sd),
    p10: w(a.p10, b.p10),
    p50: w(a.p50, b.p50),
    p90: w(a.p90, b.p90)
  };
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
