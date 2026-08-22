// Run: node src/replays/analytics/patternSearch.test.js
//
// The Pattern Finder's "anyone" search — no subjects picked, a shape drawn on
// the map — and how much of the map it actually looks at.
//
// A drawn shape is answered per player per phase (`shapePassesWindow` takes a
// playerId), so anyone-mode expands to "every player on the map" before it
// matches. That expansion ran through `playerIdsFromFilter`, which enforces
// the sidebar's five-subject cap — so the expansion was immediately truncated
// to five, and the five were whichever the first demo listed first.
//
// The result was a search that read as working: it ran, it reported progress,
// it returned rounds. It just could only ever return rounds those five players
// were in. On a 7,000-round Dust2 library, "kill from this box" came back with
// 13 rounds and nothing anywhere said that 6,900 of them were never opened.
//
// The other half of this file is the cost of doing it properly: the fix
// multiplies the round files a search touches by two orders of magnitude, and
// the packs are fetched in batches so their tick buffers are not all resident
// at once.

import assert from 'node:assert/strict';
import { aggregateAnalyticsAsync, playerIdsFromFilter } from './analyticsMath.js';
import { filterWindowsByShapes, releaseTicks, TICK_CACHE_BYTES } from './shapeFilters.js';
import {
  HEADER_BYTES,
  PLAYER_SLOTS,
  TICK_BYTES,
  writeHeader,
  writeRecord
} from '../shared/tickFormat.js';

const TICK_RATE = 64;
const KILL_TICK = 5 * TICK_RATE;      // 5 s in: comfortably inside `early`
const STRIDE = 64;
const TICK_COUNT = 116;

/** The drawn selection, in map units. */
const BOX = { type: 'rect', x: 100, y: 100, w: 200, h: 200 };
const INSIDE = { x: 200, y: 200 };
const OUTSIDE = { x: -900, y: -900 };

const DEMOS = 12;
const ROUNDS_PER_DEMO = 3;
const PLAYERS = 10;

const pid = (demo, i) => `d${demo}p${i}`;
const fileOf = (demo, round) => `f${demo}-${round}`;

/** A tick buffer where slot 0 stands in the box and everyone else does not. */
function ticksWithSlotZeroInBox() {
  const buf = new ArrayBuffer(HEADER_BYTES + TICK_COUNT * TICK_BYTES);
  const view = new DataView(buf);
  writeHeader(view, {
    version: 1,
    tickRate: TICK_RATE,
    firstTick: 0,
    stride: STRIDE,
    tickCount: TICK_COUNT,
    slots: PLAYER_SLOTS
  });
  for (let row = 0; row < TICK_COUNT; row++) {
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      const at = slot === 0 ? INSIDE : OUTSIDE;
      writeRecord(view, row, slot, {
        x: at.x, y: at.y, z: 0, yaw: 0, pitch: 0,
        health: 100, armor: 0, weapon: 0, flags: 1, flash: 0, side: slot < 5 ? 2 : 3
      });
    }
  }
  return buf;
}

/** Every round: player 0 of that demo kills player 5 from inside the box. */
function metaFor(demo) {
  return {
    tickRate: TICK_RATE,
    startTick: 0,
    freezeEndTick: 0,
    endTick: 115 * TICK_RATE,
    team1Side: 'T',
    team2Side: 'CT',
    players: Array.from({ length: PLAYERS }, (_, i) => ({
      id: pid(demo, i),
      slot: i,
      team: i < 5 ? 1 : 2
    })),
    events: {
      kills: [{ tick: KILL_TICK, attacker: pid(demo, 0), victim: pid(demo, 5), weapon: 'ak47' }],
      grenades: []
    }
  };
}

function library() {
  const demos = [];
  for (let d = 0; d < DEMOS; d++) {
    const players = Array.from({ length: PLAYERS }, (_, i) => ({
      id: pid(d, i),
      name: pid(d, i),
      team: i < 5 ? 1 : 2
    }));
    const rounds = [];
    for (let r = 1; r <= ROUNDS_PER_DEMO; r++) {
      const ph = {};
      const p = {};
      for (const pl of players) {
        ph[pl.id] = { early: { p: new Array(12).fill(0) } };
        p[pl.id] = new Array(12).fill(0);
      }
      rounds.push({
        f: fileOf(d, r), d: `d${d}`, m: 'DUST2', n: r, w: 1,
        s1: 'T', s2: 'CT', e1: 4, e2: 4, ph, p
      });
    }
    demos.push({ id: `d${d}`, map: 'DUST2', players, rounds });
  }
  return { demos };
}

const TOTAL_ROUNDS = DEMOS * ROUNDS_PER_DEMO;

function network() {
  const n = { meta: 0, ticks: 0 };
  n.fetchMeta = async (file) => {
    n.meta += 1;
    return metaFor(Number(String(file).slice(1).split('-')[0]));
  };
  n.fetchTicks = async () => {
    n.ticks += 1;
    return ticksWithSlotZeroInBox();
  };
  return n;
}

const shape = () => [{ id: 's1', feature: 'kill_from', geometry: BOX, enabled: true }];
const filter = () => ({
  map: 'DUST2',
  playerIds: [],
  shapes: shape(),
  shapeMatch: 'all',
  econ: null,
  oppEcon: null
});

// ---- the whole map is searched, not the first five players -------------------
{
  const net = network();
  const agg = await aggregateAnalyticsAsync(library(), filter(), new Map(), {
    fetchMeta: net.fetchMeta,
    fetchTicks: net.fetchTicks
  });
  assert.equal(
    agg.files.length,
    TOTAL_ROUNDS,
    `every round with a kill from the box matched, not just the first demo's ` +
      `(${agg.files.length} of ${TOTAL_ROUNDS})`
  );
  // The give-away for the old behaviour: the matched rounds all came from one
  // demo, because the five surviving ids were that demo's.
  const demosHit = new Set(agg.files.map((f) => f.split('-')[0]));
  assert.equal(demosHit.size, DEMOS, `rounds came from all ${DEMOS} demos, not one`);
  assert.equal(net.meta, TOTAL_ROUNDS, 'one meta read per round file');
}

// ---- the cap still applies to subjects a person picked ----------------------
{
  const ids = Array.from({ length: 9 }, (_, i) => `p${i}`);
  assert.equal(playerIdsFromFilter({ playerIds: ids }).length, 5, 'sidebar cap holds');
  assert.equal(
    playerIdsFromFilter({ playerIds: ids, scanAllPlayers: true }).length,
    9,
    'and does not apply to the anyone-mode expansion'
  );
}

// ---- a shape that matches nobody matches nothing ----------------------------
{
  const net = network();
  const far = [{ id: 's1', feature: 'kill_from', geometry: { type: 'rect', x: 5000, y: 5000, w: 10, h: 10 }, enabled: true }];
  const agg = await aggregateAnalyticsAsync(
    library(),
    { ...filter(), shapes: far },
    new Map(),
    { fetchMeta: net.fetchMeta, fetchTicks: net.fetchTicks }
  );
  assert.equal(agg.files.length, 0, 'an empty box is empty, not "everything"');
}

// ---- batching does not change the answer, and bounds resident ticks ---------
{
  const windows = [];
  for (let d = 0; d < DEMOS; d++) {
    for (let r = 1; r <= ROUNDS_PER_DEMO; r++) {
      for (let i = 0; i < PLAYERS; i++) {
        windows.push({ file: fileOf(d, r), phase: 'early', playerId: pid(d, i), demoId: `d${d}`, round: r });
      }
    }
  }
  const net = network();
  const cache = new Map();
  let peakBytes = 0;
  const seen = [];
  const out = await filterWindowsByShapes(windows, shape(), cache, 'all', null, {
    chunk: 4,
    tickBudget: 4 * 20_000,
    fetchMeta: net.fetchMeta,
    fetchTicks: async (...a) => {
      let held = 0;
      for (const p of cache.values()) held += p?.ticks?.byteLength || 0;
      peakBytes = Math.max(peakBytes, held);
      return net.fetchTicks(...a);
    },
    onProgress: (p) => seen.push(p)
  });

  // One window per round survives: the attacker's. The other nine players were
  // in the same round and outside the box.
  assert.equal(out.length, TOTAL_ROUNDS, 'one passing window per round');
  assert.deepEqual(
    out.map((w) => w.playerId),
    out.map((w) => pid(Number(w.demoId.slice(1)), 0)),
    'and it is the attacker, in window order'
  );
  assert.ok(
    peakBytes <= 5 * 20_000,
    `resident tick bytes stayed near the budget (peak ${peakBytes})`
  );
  // Progress is over the whole search, not restarted per batch.
  assert.equal(seen.at(-1).total, TOTAL_ROUNDS, 'the total is every file');
  assert.equal(seen.at(-1).done, TOTAL_ROUNDS, 'and it finishes on it');
  let last = -1;
  for (const p of seen) {
    assert.ok(p.done >= last, `progress never goes backwards (${p.done} after ${last})`);
    assert.equal(p.total, TOTAL_ROUNDS, 'and the total never moves');
    last = p.done;
  }
}

// ---- a released pack is re-read, not treated as a hit ------------------------
{
  const net = network();
  const cache = new Map();
  const windows = Array.from({ length: 6 }, (_, r) => ({
    file: fileOf(0, 1), phase: 'early', playerId: pid(0, r), demoId: 'd0', round: 1
  }));
  const opts = { chunk: 8, fetchMeta: net.fetchMeta, fetchTicks: net.fetchTicks };
  await filterWindowsByShapes(windows, shape(), cache, 'all', null, opts);
  const afterFirst = { ...net };
  releaseTicks(cache, 0);
  assert.equal(cache.get(fileOf(0, 1)).ticks, null, 'ticks dropped');
  assert.ok(cache.get(fileOf(0, 1)).meta, 'meta kept — it is the small half');

  const out = await filterWindowsByShapes(windows, shape(), cache, 'all', null, opts);
  assert.equal(out.length, 1, 'the search still answers correctly after a release');
  assert.equal(net.ticks, afterFirst.ticks + 1, 'ticks were re-read');
  assert.equal(net.meta, afterFirst.meta, 'and meta was not, because it was still held');
}

assert.ok(TICK_CACHE_BYTES > 0, 'there is a budget at all');

console.log('patternSearch.test.js: ok');
