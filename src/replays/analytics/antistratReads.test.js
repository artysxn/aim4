// Run: node src/replays/analytics/antistratReads.test.js
//
// The per-round reads the antistrat summary is built on, against hand-made
// rounds: which utility counts as a tell, boosts, and aggressive moves.

import assert from 'node:assert/strict';
import {
  aggressiveMovesOf,
  boostsOf,
  coreShowOf,
  fiveOnFive,
  lurkPlaysOf,
  quietBetween,
  reactionsOf,
  restOfMapAt,
  teamAfter,
  tellUtility
} from './antistratReads.js';

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

// ---- a small world: A site at x <= -2000, B site at x >= 2000 -------------

const TR = 64;
const PIECES = {
  a: [{ ring: [[-3000, -500], [-2000, -500], [-2000, 500], [-3000, 500]] }],
  b: [{ ring: [[2000, -500], [3000, -500], [3000, 500], [2000, 500]] }]
};
/**
 * A round over `seconds` one-second samples. `at(id, elapsed)` places each of
 * ours ({x, y, pos}) or returns null once dead.
 */
function world({ side = 'T', ids, at, seconds = 70, damage = [], nades = [], kills = [], enemyNades = [], entryAt = null, plantSite = null }) {
  const series = [];
  for (let e = 0; e <= seconds; e++) {
    const pts = ids.map((id) => (at(id, e) ? { id, z: 0, pos: '', ...at(id, e) } : null)).filter(Boolean);
    series.push({ tick: e * TR, elapsed: e, pts, opp: [] });
  }
  const r = {
    side,
    t0: 0,
    tickRate: TR,
    series,
    damage: damage.map((d) => ({ tick: d.elapsed * TR, attackerOurs: true, victimOurs: false, ...d })),
    nades: nades.map((n) => ({ type: 'flashbang', label: '', zone: '', fromZone: '', at: n.throwAt + 2, ...n })),
    kills: kills.map((t) => ({ clock: ROUND - t, victim: 'x' })),
    enemyNades,
    plantSite,
    plantClock: null,
    sitePieces: PIECES,
    siteNear: (x, y, pad = 250) => (x <= -2000 + pad ? 'a' : x >= 2000 - pad ? 'b' : null),
    siteEntry: () => (entryAt === null ? null : { clock: ROUND - entryAt, site: 'b', tick: entryAt * TR })
  };
  r.sampleAt = (tick) => r.series[Math.max(0, Math.min(r.series.length - 1, Math.round(tick / TR)))] || null;
  return r;
}
const MAP = 'TEST';

// ---- 5v5 and quiet ----------------------------------------------------------

{
  const five = ['a', 'b', 'c', 'd', 'e'];
  const r = world({ side: 'CT', ids: five, at: (id) => ({ x: five.indexOf(id) * 100, y: 0 }), kills: [45], damage: [{ elapsed: 33 }] });
  r.series.forEach((s) => (s.opp = five.map((id) => ({ id: `o${id}`, x: 0, y: 0 }))));
  assert.equal(fiveOnFive(r, 40), true, 'nobody dead by 1:15');
  assert.equal(fiveOnFive(r, 45), false, 'the kill at 45s ends the 5v5');
  assert.equal(quietBetween(r, 30, 40), false, 'a hit at 33s breaks the quiet');
  assert.equal(quietBetween(r, 34, 40), true);
}

// ---- the core showing itself ------------------------------------------------

{
  // t1 duels alone in mid at 20s; at 30s on A, t2 fights next to him and t3
  // stands with him. t4 holds B, t5 walks from mid to A after it.
  const ids = ['t1', 't2', 't3', 't4', 't5'];
  const at = (id, e) => {
    if (id === 't4') return { x: 2500, y: 0, pos: 'B Site' };
    if (id === 't5') return e < 33 ? { x: 500, y: 0, pos: 'Mid' } : { x: -1900, y: 0, pos: 'A Main' };
    if (e < 25) return { t1: { x: 0, y: 0 }, t2: { x: 0, y: 1500 }, t3: { x: 0, y: -1500 } }[id];
    return { t1: { x: -1800, y: 0, pos: 'A Main' }, t2: { x: -1700, y: 300 }, t3: { x: -1600, y: -300 } }[id];
  };
  const r = world({
    ids,
    at,
    damage: [
      { elapsed: 20, attacker: 't1', victim: 'c1', ax: 0, ay: 0, vx: 0, vy: 900 },
      { elapsed: 30, attacker: 't1', victim: 'c1', ax: -1800, ay: 0, vx: -2600, vy: 0 },
      { elapsed: 32, attacker: 'c2', victim: 't2', attackerOurs: false, victimOurs: true, ax: -2600, ay: 300, vx: -1700, vy: 300 }
    ]
  });
  const show = coreShowOf(r, MAP, null);
  assert.equal(show?.elapsed, 30, 'a duel alone is not the core; a duel with a teammate fighting beside him is');
  assert.equal(show.area, 'A');
  assert.deepEqual([...show.ids].sort(), ['t1', 't2', 't3']);
  const rest = Object.fromEntries(restOfMapAt(r, show, MAP, null).map((p) => [p.id, p]));
  assert.equal(rest.t4.area, 'B');
  assert.equal(rest.t4.does, 'hold');
  assert.equal(rest.t5.area, 'mid');
  assert.equal(rest.t5.does, 'leave', 'walking over to the core is leaving his ground');
  assert.equal(rest.t5.to, 'A');

  // Utility for him counts as support; out of spawn in the first 3s it does not.
  const flashFor = (throwAt) =>
    world({
      ids: ['t1', 't2', 't3'],
      at: (id) => ({ t1: { x: -1800, y: 0 }, t2: { x: 0, y: 1500 }, t3: { x: -1700, y: -200 } })[id],
      damage: [{ elapsed: 30, attacker: 't1', victim: 'c1', ax: -1800, ay: 0, vx: -2600, vy: 0 }],
      nades: [{ player: 't2', throwAt, at: throwAt === 2 ? 28 : throwAt + 1, x: -1850, y: 100, fx: 0, fy: 1500 }]
    });
  assert.equal(coreShowOf(flashFor(29), MAP, null)?.ids.length, 3, 'a flash landing on him counts its thrower in');
  assert.equal(coreShowOf(flashFor(2), MAP, null), null, 'a spawn flash supports nobody');
}

// ---- lurks --------------------------------------------------------------------

{
  // The team hits B at 40s. L sits alone on the A side from 15s.
  const team = (id, e) => ({ x: 1500 + (e >= 38 ? 700 : 0), y: { a: 0, b: 200, c: -200, d: 400 }[id] });
  const lurk = (path) =>
    world({ ids: ['L', 'a', 'b', 'c', 'd'], at: (id, e) => (id === 'L' ? path(e) : team(id, e)), entryAt: 40, plantSite: 'b' });
  const plays = (path) => lurkPlaysOf(lurk(path), MAP, null);

  const pushed = plays((e) => (e < 30 ? { x: -1500, y: 0 } : { x: -2500, y: 0, pos: 'A Site' }));
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].does, 'push');
  assert.equal(pushed[0].when, 'before', 'onto the A site at 30s, ten seconds before the team hits B');
  assert.equal(pushed[0].where, 'A Site');

  const rotated = plays((e) => (e < 39 ? { x: -1500, y: 0 } : { x: 1800, y: 0 }));
  assert.equal(rotated[0].does, 'rotate');
  assert.equal(rotated[0].at, 38, 'left the last time he was seen on his ground');
  assert.equal(rotated[0].arrive, 39);

  assert.equal(plays(() => ({ x: -1500, y: 0 }))[0].does, 'stay');
  assert.equal(
    plays((e) => (e < 22 ? { x: -1500, y: 0 } : { x: 1600, y: 600 })).length,
    0,
    'seven seconds alone is not a lurk'
  );
}

// ---- CT utility as an answer ------------------------------------------------

{
  const r = world({
    side: 'CT',
    ids: ['a', 'b', 'c'],
    at: (id, e) => ({ a: { x: -2500, y: 0 }, b: { x: e < 42 ? 0 : -2400, y: 0 }, c: { x: e < 42 ? 100 : -2400, y: 200 } })[id],
    kills: [37],
    nades: [
      { type: 'smokegrenade', player: 'a', throwAt: 40, x: -2500, y: 0, fx: -2500, fy: 0, zone: 'A' },
      { type: 'smokegrenade', player: 'a', throwAt: 60, x: 0, y: 0, fx: 100, fy: 0 },
      { type: 'molotov', player: 'b', throwAt: 50, x: 0, y: 0, fx: 0, fy: 0 }
    ],
    enemyNades: [
      { type: 'flashbang', at: 48, x: 500, y: 0 },
      { type: 'smokegrenade', at: 49, x: 5000, y: 0 }
    ]
  });
  const [first, quiet, molo] = reactionsOf(r);
  assert.equal(first.reactive, true);
  assert.equal(first.deaths.length, 1, 'a death three seconds before the throw, anywhere on the map');
  assert.equal(quiet.reactive, false, 'nothing in the four seconds before it');
  assert.deepEqual(molo.util.map((e) => e.type), ['flashbang'], 'only the T utility near it counts');
  assert.equal(teamAfter(r, 40, -2500, 0, 'A', MAP, null), 'in', 'two more on A six seconds after the smoke');
}

console.log('antistratReads.test.js ok');
