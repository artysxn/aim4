// Run: node src/replays/eye/roundQuery.test.js
//
// aim4 eye's round query language against hand-made rounds.

import assert from 'node:assert/strict';
import { QueryError, elapsedOfClock, runRoundQuery, zoneIndex, zoneNames } from './roundQuery.js';

const network = {
  positions: [
    { id: 'p1', name: 'Silo', pieces: [{}] },
    { id: 'p2', name: 'Hut', pieces: [{}] },
    { id: 'p3', name: 'Heaven', pieces: [{}] },
    { id: 'p4', name: 'Secret', pieces: [{}] }
  ],
  zones: [{ id: 'z1', name: 'Outside', positionIds: ['p1', 'p4'] }],
  areas: [{ id: 'a1', name: 'T_YARD', zoneIds: ['z1'] }]
};

/** A round: side, buys, where ours/theirs stood (elapsed -> positions), and what happened. */
function round(file, { side = 'T', own = 4, opp = 4, ours = {}, theirs = {}, site = null, won = false, plant = false, nades = [], kills = [], entry = null }) {
  const series = [];
  for (let e = 0; e <= 60; e++) {
    series.push({
      elapsed: e,
      pts: (ours[e] || []).map((pos, i) => ({ id: `o${i}`, pos })),
      opp: (theirs[e] || []).map((pos, i) => ({ id: `t${i}`, pos }))
    });
  }
  return {
    file,
    side,
    ownEcon: own,
    oppEcon: opp,
    hasTicks: true,
    series,
    won,
    plantTick: plant ? 1 : null,
    plantSite: site ? site.toLowerCase() : null,
    hitSite: site ? site.toLowerCase() : null,
    // entry: [elapsed, site] -> the shape antistratScan's siteEntry returns (clock = seconds left).
    siteEntry: () => (entry ? { tick: 0, clock: 115 - entry[0], site: entry[1] } : null),
    nades,
    enemyNades: [],
    kills,
    firstKill: kills[0] || null,
    sampleAt: () => null
  };
}

// 1+ in Silo at 1:40 (elapsed 15) in r1 and r2, at 1:10 (elapsed 45) in r3.
const rounds = [
  round('r1', { ours: { 15: ['Silo', 'Hut'] }, site: 'B', won: true, plant: true }),
  round('r2', { ours: { 15: ['Silo'] }, site: 'A' }),
  round('r3', { ours: { 45: ['Silo'] }, site: 'B', won: true }),
  round('r4', { site: 'B', nades: [{ type: 'smokegrenade', throwAt: 10, zone: 'Heaven', label: 'Heaven' }] }),
  round('r5', { side: 'CT', theirs: { 20: ['Secret', 'Secret'] } }),
  round('r6', { own: 3, ours: { 15: ['Silo'] }, site: 'A' })
];

assert.equal(elapsedOfClock('1:55', 0), 0);
assert.equal(elapsedOfClock('1:20', 0), 35);
assert.equal(elapsedOfClock(undefined, 7), 7);
assert.throws(() => elapsedOfClock('soon', 0), QueryError);

// The question from the brief: 1+ in Silo before 1:20, grouped by where it went.
const silo = runRoundQuery(rounds, network, {
  side: 'T',
  buy: 'full',
  where: [{ players_in: { zone: 'Silo', who: 'team', min: 1, from: '1:55', to: '1:20' } }],
  group_by: 'site'
});
assert.equal(silo.considered, 4, 'full-buy T rounds only');
assert.equal(silo.matched, 2, 'r3 is in Silo too late, r6 is a force buy');
assert.deepEqual(
  silo.groups.map((g) => [g.key, g.rounds, g.won]),
  [
    ['A', 1, 0],
    ['B', 1, 1]
  ]
);
assert.deepEqual(silo.files.sort(), ['r1', 'r2']);

// A zone that groups positions, an area of zones, and "not".
assert.equal(runRoundQuery(rounds, network, { side: 'T', where: [{ players_in: { zone: 'outside' } }] }).matched, 4);
assert.equal(runRoundQuery(rounds, network, { side: 'T', where: [{ players_in: { zone: 'T_YARD' } }] }).matched, 4);
assert.equal(runRoundQuery(rounds, network, { side: 'T', buy: 'full', where: [{ not: { players_in: { zone: 'Silo' } } }] }).matched, 1);

// Two of them at once, the other team, utility.
assert.equal(runRoundQuery(rounds, network, { side: 'CT', where: [{ players_in: { zone: 'Secret', who: 'opponent', min: 2 } }] }).matched, 1);
assert.equal(runRoundQuery(rounds, network, { where: [{ utility: { type: 'smoke', zone: 'Heaven', to: '1:40' } }] }).matched, 1);
assert.equal(runRoundQuery(rounds, network, { where: [{ utility: { type: 'smoke', zone: 'Heaven', to: '1:50' } }] }).matched, 0, 'thrown after 1:50');

// Outcomes as conditions.
assert.equal(runRoundQuery(rounds, network, { side: 'T', where: [{ site: 'B' }, { won: true }] }).matched, 2);
assert.equal(runRoundQuery(rounds, network, { where: [{ plant: true }] }).matched, 1);

// What small models write: the wrapper left off, "player" for the team.
assert.equal(runRoundQuery(rounds, network, { side: 'T', buy: 'full', where: [{ zone: 'Silo', who: 'player', to: '1:20' }] }).matched, 2);

// Unknown callouts are reported, bad shapes are errors the model can read.
assert.deepEqual(runRoundQuery(rounds, network, { where: [{ players_in: { zone: 'Silloo' } }] }).unknownZones, ['Silloo']);
assert.throws(() => runRoundQuery(rounds, network, { group_by: 'vibes' }), QueryError);
assert.throws(() => runRoundQuery(rounds, network, { buy: 'rich' }), QueryError);
assert.throws(() => runRoundQuery(rounds, network, { where: [{ teleport: {} }] }), QueryError);

assert.equal(zoneIndex(network).get('outside').positions.size, 2);
assert.deepEqual(zoneNames(network).positions, ['Heaven', 'Hut', 'Secret', 'Silo']);

// "bought" is the pace section's pool: the force-buy round r6 counts, the full-buy-only pool skips it.
const bought = runRoundQuery(rounds, network, { side: 'T', buy: 'bought' });
assert.equal(bought.considered, 5);
assert.equal(runRoundQuery(rounds, network, { side: 'T', buy: 'full' }).considered, 4);
assert.match(bought.counted, /T side, their buy bought, opponent buy any/);
assert.deepEqual(runRoundQuery(rounds, network, { side: 'T', buy: 'bought', group_by: 'buy' }).groups.map((g) => g.key), ['full', 'force']);

// "A lurk within 15 s of the B entry": the window follows each round's own entry.
const lurks = [
  round('e1', { site: 'B', entry: [40, 'b'], ours: { 30: ['Silo'] } }), // 10 s before the entry: in
  round('e2', { site: 'B', entry: [40, 'b'], ours: { 20: ['Silo'] } }), // 20 s before: out
  round('e3', { site: 'B', entry: [40, 'b'], ours: { 52: ['Silo'] } }), // 12 s after: in
  round('e4', { site: 'B', ours: { 30: ['Silo'] } }), // never got onto a site: out
  round('e5', { site: 'A', entry: [40, 'a'], ours: { 38: ['Silo'] } }) // an A entry: out with entry_site B
];
const lurk = { players_in: { zone: 'Silo', who: 'team', min: 1, around: 'entry', before: 15, after: 15 } };
assert.deepEqual(runRoundQuery(lurks, network, { side: 'T', where: [lurk] }).files, ['e1', 'e3', 'e5']);
assert.deepEqual(runRoundQuery(lurks, network, { side: 'T', where: [{ players_in: { ...lurk.players_in, entry_site: 'B' } }] }).files, ['e1', 'e3']);
assert.throws(() => runRoundQuery(lurks, network, { where: [{ players_in: { zone: 'Silo', around: 'plant' } }] }), QueryError);

console.log('roundQuery.test.js ok');
