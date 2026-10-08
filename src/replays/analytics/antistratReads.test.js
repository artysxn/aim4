// Run: node src/replays/analytics/antistratReads.test.js
//
// The per-round reads the antistrat summary is built on, against hand-made
// rounds: which utility counts as a tell, boosts, and aggressive moves.

import assert from 'node:assert/strict';
import { aggressiveMovesOf, boostsOf, tellUtility } from './antistratReads.js';

const ROUND = 115;
const clock = (elapsed) => ROUND - elapsed;

/** A round with just what tellUtility reads. */
function round({ side = 'T', entryAt = null, plantAt = null, killsAt = [], nades }) {
  return {
    side,
    plantClock: plantAt === null ? null : clock(plantAt),
    kills: killsAt.map((t) => ({ clock: clock(t) })),
    nades: nades.map((n) => ({ label: n.label, type: n.type || 'smokegrenade', region: n.region ?? null, throwAt: n.t, at: n.t + 2 })),
    siteEntry: () => (entryAt === null ? null : { clock: clock(entryAt), site: 'b', tick: 0 })
  };
}
const labels = (r) => tellUtility(r).map((n) => n.label);

// ---- rule 1: middle of the map counts until the round commits -------------

assert.deepEqual(
  labels(round({ entryAt: 60, nades: [{ label: 'Doors', t: 10 }, { label: 'Xbox', t: 61 }] })),
  ['Doors'],
  'mid utility before two step onto a site is a read; after it, it is the hit'
);
assert.deepEqual(
  labels(round({ plantAt: 50, nades: [{ label: 'Mid', t: 49 }, { label: 'Late mid', t: 51 }] })),
  ['Mid'],
  'and never after the plant'
);

// ---- rule 2: site utility, 15s before the plant and 5s before a kill ------

assert.deepEqual(
  labels(
    round({
      plantAt: 60,
      killsAt: [52],
      nades: [
        { label: 'B Doors', region: 'b', t: 40 }, // 20s before the plant, next kill 12s later
        { label: 'Backplat', region: 'b', t: 50 } // 10s before the plant: part of the execute
      ]
    })
  ),
  ['B Doors']
);
assert.deepEqual(
  labels(round({ killsAt: [43], nades: [{ label: 'Upper', region: 'b', t: 40 }] })),
  [],
  'a kill three seconds after it means it was fought through, not read'
);
assert.deepEqual(
  labels(round({ killsAt: [20, 48], nades: [{ label: 'Upper', region: 'b', t: 40 }] })),
  ['Upper'],
  'a kill before the throw is fine as long as the next one is 5s or more after'
);
assert.deepEqual(
  labels(round({ nades: [{ label: 'Short', region: 'a', t: 30 }] })),
  ['Short'],
  'no plant and no kill: nothing disqualifies it'
);

// ---- CT: what is up by 1:20 ------------------------------------------------

assert.deepEqual(
  labels(round({ side: 'CT', entryAt: 2, nades: [{ label: 'Long box', t: 5 }, { label: 'Mid', t: 40 }] })),
  ['Long box'],
  'CTs stand on a site from the start, so the cut is 1:20, not the entry'
);

// ---- boosts and aggressive moves -------------------------------------------

const sample = (elapsed, pts, opp = []) => ({ tick: elapsed * 64, elapsed, pts, opp });
const boosted = {
  series: [
    sample(10, [{ id: 'a', x: 0, y: 0, z: 0, pos: 'Xbox' }, { id: 'b', x: 10, y: 5, z: 64, pos: 'Xbox' }]),
    sample(11, [{ id: 'a', x: 0, y: 0, z: 0, pos: 'Xbox' }, { id: 'b', x: 10, y: 5, z: 64, pos: 'Xbox' }]),
    sample(12, [{ id: 'a', x: 0, y: 0, z: 0, pos: 'Xbox' }, { id: 'b', x: 400, y: 5, z: 0, pos: 'Mid' }])
  ]
};
const boosts = boostsOf(boosted);
assert.equal(boosts.length, 1, 'two samples on a head is one boost');
assert.equal(boosts[0].top, 'b');
assert.equal(boosts[0].bottom, 'a');
assert.equal(boosts[0].zone, 'Xbox');
assert.equal(boostsOf({ series: boosted.series.slice(1) }).length, 0, 'one sample is a jump, not a boost');

const moves = aggressiveMovesOf({
  series: [
    sample(5, [{ id: 'a', x: 0, y: 0, pos: 'T Spawn' }, { id: 'b', x: 100, y: 0, pos: 'T Spawn' }], [{ id: 'c', x: 3000, y: 0, pos: 'Long' }]),
    sample(15, [{ id: 'a', x: 3000, y: 0, pos: 'Long' }, { id: 'b', x: 100, y: 0, pos: 'T Spawn' }]),
    sample(16, [{ id: 'a', x: 3000, y: 0, pos: 'Long' }, { id: 'b', x: 2900, y: 0, pos: 'Long' }])
  ]
});
assert.deepEqual(
  moves.map((m) => [m.id, m.zone, m.elapsed]),
  [['a', 'Long', 15]],
  'alone onto ground the other team held is aggressive; following a teammate there is not'
);

console.log('antistratReads.test.js ok');
