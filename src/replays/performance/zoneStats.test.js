// Run: node src/replays/performance/zoneStats.test.js
//
// Performance > Zones, off a hand-built round: where each event lands
// (roundZoneEvents), and what a position's numbers are once a round is split
// between the places a player fought in (zoneTotals).

import assert from 'node:assert/strict';
import { FLAG_ALIVE, totalBytes, writeHeader, writeRecord } from '../shared/tickFormat.js';
import { roundZoneEvents, ZONE_EVENT_FLAGS } from '../shared/roundZoneEvents.js';
import { zoneColor, zoneRegions, zoneTotals, ZONE_MIN_ROUNDS } from './zoneStats.js';

const RATE = 64;
const STRIDE = 100;
const FREEZE = 1000;

/**
 * A thinned tick buffer: `paths[slot](tick)` gives { x, y, alive } per row.
 */
function ticks(paths, rows = 80) {
  const buf = new ArrayBuffer(totalBytes(rows));
  const view = new DataView(buf);
  writeHeader(view, { tickCount: rows, firstTick: 0, stride: STRIDE, tickRate: RATE, playerCount: paths.length });
  for (let row = 0; row < rows; row++) {
    paths.forEach((path, slot) => {
      const s = path(row * STRIDE);
      writeRecord(view, row, slot, { x: s.x, y: s.y, z: 0, flags: s.alive ? FLAG_ALIVE : 0, side: slot < 2 ? 'T' : 'CT' });
    });
  }
  return buf;
}

// Two Ts (a, b) and two CTs (c, d). `a` walks from x=0 to x=1000 over the
// first 10 rows; everyone else stands still until they die.
// b dies on a sampled row, so that row already shows b dead.
const DEATH = { b: 3000, c: 2050, d: 3050 };
const still = (x, y, id) => (tick) => ({ x, y, alive: !(DEATH[id] && tick >= DEATH[id]) });
const buffer = ticks([
  (tick) => ({ x: Math.min(1000, tick / 1), y: 0, alive: true }),
  still(0, 500, 'b'),
  still(2000, 0, 'c'),
  still(2000, 500, 'd')
]);

const meta = {
  tickRate: RATE,
  freezeEndTick: FREEZE,
  endTick: FREEZE + 60 * RATE,
  team1Side: 'T',
  team2Side: 'CT',
  players: [
    { id: 'a', team: 1, slot: 0 },
    { id: 'b', team: 1, slot: 1 },
    { id: 'c', team: 2, slot: 2 },
    { id: 'd', team: 2, slot: 3 }
  ],
  events: {
    kills: [
      // Opening: a kills c from the middle of a's walk (row 20.5 of 0..1000).
      { tick: 2050, attacker: 'a', victim: 'c', assister: 'b', headshot: true },
      // d kills b, and a trades it inside five seconds.
      { tick: 3000, attacker: 'd', victim: 'b' },
      { tick: 3050, attacker: 'a', victim: 'd' }
    ],
    damage: [
      { tick: 2040, attacker: 'a', victim: 'c', hp: 140 },
      { tick: 2990, attacker: 'd', victim: 'b', hp: 100 },
      { tick: 3040, attacker: 'a', victim: 'd', hp: 100 },
      // Friendly fire is not damage dealt.
      { tick: 3100, attacker: 'a', victim: 'b', hp: 10 }
    ]
  }
};

// ---- roundZoneEvents ---------------------------------------------------------

const rec = roundZoneEvents(meta, buffer);
const { OPENING, HEADSHOT, TRADED } = ZONE_EVENT_FLAGS;
const find = (kind, id) => rec.e.filter((e) => e[0] === kind && e[1] === id);

assert.equal(rec.r, RATE);
assert.equal(rec.b[0], FREEZE);
// Interpolated between rows 20 and 21: a is at x = 1000 by then (clamped walk).
const [aKill1, aKill2] = find('k', 'a');
assert.equal(aKill1[3], 1000);
assert.equal(aKill1[6], OPENING | HEADSHOT, 'the opening kill, a headshot');
assert.equal(aKill2[6], 0);
// A death sits where the victim last stood alive.
const [cDeath] = find('d', 'c');
assert.deepEqual(cDeath.slice(3, 5), [2000, 0]);
assert.equal(cDeath[6], OPENING);
assert.equal(find('d', 'b')[0][6], TRADED, 'b was traded by a');
assert.equal(find('d', 'd')[0][6], 0);
assert.equal(find('a', 'b').length, 1, 'the assist');
// Damage is health removed: 140 on a full-health player is 100.
assert.deepEqual(find('h', 'a').map((e) => e[6]), [100, 100], 'no friendly fire');
// a is the one alive at the end.
assert.deepEqual(rec.e.filter((e) => e[0] === 's').map((e) => e[1]), ['a']);
// Asking about one player keeps that player's events only.
assert.ok(roundZoneEvents(meta, buffer, ['c']).e.every((e) => e[1] === 'c'));
// No positions, no record.
assert.equal(roundZoneEvents(meta, null), null);

// ---- zoneTotals ----------------------------------------------------------------

const network = {
  positions: [
    { id: 'west', name: 'West', pieces: [{ type: 'rect', x: -100, y: -100, w: 700, h: 800 }] },
    { id: 'east', name: 'East', pieces: [{ type: 'rect', x: 600, y: -100, w: 1600, h: 800 }] }
  ],
  zones: [{ id: 'all', name: 'All', positionIds: ['west', 'east'] }]
};

const records = new Map([['r1', rec]]);
const one = zoneTotals({
  rounds: [{ file: 'r1', ids: ['a'], at: 1 }],
  records,
  network,
  mapCode: 'DD2'
});
// a's events are all in the east (x = 1000), so the whole round is there.
assert.equal(one.regions.size, 1);
const east = one.regions.get('east');
assert.equal(east.rounds, 1);
assert.equal(east.weight, 1);
assert.equal(east.kills, 2);
assert.equal(east.openKills, 1);
assert.equal(east.damage, 200);
assert.equal(east.kastPct, 100);
assert.ok(east.rating > 1.5, 'two kills, alive, a good round');

// b assisted from the west and died in the west; with a, the team round is
// counted once per region and each player keeps their own line.
const team = zoneTotals({
  rounds: [{ file: 'r1', ids: ['a', 'b'], at: 1 }],
  records,
  network,
  mapCode: 'DD2',
  perPlayer: true
});
assert.equal(team.regions.get('west').rounds, 1);
assert.equal(team.regions.get('west').players.get('b').deaths, 1);
assert.equal(team.regions.get('west').kastPct, 100, 'assist and traded');

// A player who fought in two places has the round split between them.
const moved = { r: RATE, b: rec.b, e: [['k', 'x', 2000, 0, 0, 0, 0], ['d', 'x', 3000, 1000, 0, 0, 0]] };
const split = zoneTotals({
  rounds: [{ file: 'm', ids: ['x'], at: 1 }],
  records: new Map([['m', moved]]),
  network,
  mapCode: 'DD2'
});
assert.equal(split.regions.get('west').weight, 0.5);
assert.equal(split.regions.get('east').weight, 0.5);
assert.equal(split.regions.get('west').rounds, 1);
assert.ok(split.regions.get('west').rating > split.regions.get('east').rating);

// The early phase drops the later death.
const early = zoneTotals({
  rounds: [{ file: 'm', ids: ['x'], at: 1 }],
  records: new Map([['m', { ...moved, b: [FREEZE, 2500, 4000, 6000] }]]),
  network,
  mapCode: 'DD2',
  phase: 'early'
});
assert.ok(!early.regions.has('east'));

// Zones read through their positions.
const zones = zoneTotals({
  rounds: [{ file: 'm', ids: ['x'], at: 1 }],
  records: new Map([['m', moved]]),
  network,
  mapCode: 'DD2',
  grain: 'zone'
});
assert.deepEqual([...zones.regions.keys()], ['all']);
assert.equal(zones.regions.get('all').weight, 1);
assert.equal(zoneRegions(network, 'zone')[0].pieces.length, 2);

assert.equal(zoneColor(0.5), '#e06666');
assert.equal(zoneColor(2.4), '#5ea3f2');
assert.equal(zoneColor(NaN), null);
assert.ok(ZONE_MIN_ROUNDS > 1);

console.log('zoneStats.test.js ok');
