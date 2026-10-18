// Run: node src/replays/eye/roundStory.test.js
//
// One round told from positions: moves (a step through a doorway is not a move),
// both teams' shape every 10 seconds, utility with where it landed, kills with
// where they happened, and the pace against the team's own similar rounds.
// The round below is the one the user described from The Golden Horde vs
// ynkesu: a passive 1-3-1 that waits, a solo push from the CT side dying in A
// main at 1:35, then a late mid retake into B.

import assert from 'node:assert/strict';
import { clockText, comparePace, findExecute, placeIndex, roundStory } from './roundStory.js';

const network = {
  positions: [
    { id: 1, name: 'T spawn' },
    { id: 2, name: 'A main' },
    { id: 3, name: 'Mid' },
    { id: 4, name: 'B main' },
    { id: 5, name: 'B site' },
    { id: 6, name: 'Garage' },
    { id: 7, name: 'Vents' }
  ],
  zones: [
    { id: 'z1', name: 'A main', positionIds: [2] },
    { id: 'z2', name: 'Mid', positionIds: [3, 6] },
    { id: 'z3', name: 'B halls', positionIds: [4] },
    { id: 'z4', name: 'B site', positionIds: [5, 7] }
  ],
  areas: [{ name: 'B', zoneIds: ['z3', 'z4'] }]
};

assert.equal(clockText(115), '1:55');
assert.equal(clockText(60), '1:00');
const idx = placeIndex(network);
assert.deepEqual(idx.get('Garage'), { zone: 'Mid', area: 'Mid' });
assert.deepEqual(idx.get('Vents'), { zone: 'B site', area: 'B' });
assert.deepEqual(idx.get('T spawn'), { zone: 'T spawn', area: 'T spawn' });

const names = new Map([
  ['art', 'artysan'], ['for', 'forzaN'], ['reg', 'regoshka'], ['dij', 'dijarom'], ['lyo', 'Lyoli'],
  ['hen', 'Henma'], ['kee', 'keeisen'], ['sai', 'Saiman_Strit'], ['h1w', 'h1wh'], ['ynk', 'ynkesu']
]);

/** A roundFeatures-like record. `at(e)` gives each player's position at elapsed second e. */
function round({ side = 'T', own = 4, opp = 1, ours, theirs, nades = [], enemyNades = [], kills = [], plant = null, won = true, entry = null }) {
  const series = [];
  for (let e = 0; e <= 60; e++) {
    series.push({
      elapsed: e,
      pts: Object.entries(ours(e)).filter(([, p]) => p).map(([id, pos]) => ({ id, pos })),
      opp: Object.entries(theirs(e)).filter(([, p]) => p).map(([id, pos]) => ({ id, pos }))
    });
  }
  return {
    side,
    ownEcon: own,
    oppEcon: opp,
    won,
    hasTicks: true,
    series,
    nades,
    enemyNades,
    kills,
    firstKill: kills[0] || null,
    plantClock: plant ? plant.clock : null,
    plantSite: plant ? plant.site : null,
    hitSite: plant ? plant.site : null,
    t0: 0,
    tickRate: 1,
    siteEntry: () => entry,
    sampleAt: () => series[0],
    towardCount: () => 0
  };
}

// The Golden Horde, T, full against an eco: a 1-3-1 that holds until a mid retake at 1:00.
const passive = round({
  ours: (e) => ({
    art: e < 5 ? 'T spawn' : e < 55 ? 'Mid' : 'Garage',
    for: e < 5 ? 'T spawn' : 'A main',
    reg: e < 5 ? 'T spawn' : 'B main',
    dij: e < 5 ? 'T spawn' : 'Mid',
    // A one-second step into Mid at 20 is not a move.
    lyo: e < 5 ? 'T spawn' : e === 20 ? 'Mid' : 'B main'
  }),
  theirs: (e) => ({ hen: e < 20 ? 'B site' : e < 22 ? 'A main' : null, kee: 'B site', sai: 'B site', h1w: 'B site', ynk: 'B site' }),
  nades: [
    { type: 'smokegrenade', throwAt: 8, clock: 107, player: 'reg', label: 'B lurk', zone: 'B main' },
    { type: 'molotov', throwAt: 55, clock: 60, player: 'art', label: '', zone: 'Vents' }
  ],
  enemyNades: [{ type: 'flashbang', throwAt: 19, player: 'hen', label: 'A main', zone: 'A main' }],
  kills: [{ clock: 95, attacker: 'for', victim: 'hen', attackerZone: 'A main', victimZone: 'A main', weapon: 'ak47' }],
  entry: { clock: 55, site: 'b' }
});
// The same team's other T full-buy rounds against ecos, all quicker onto a site.
const quick = (n) => round({ ours: () => ({ art: 'B site', for: 'B site', reg: 'B site', dij: 'B site', lyo: 'B site' }), theirs: () => ({ hen: 'B site' }), entry: { clock: 90 - n, site: 'b' }, kills: [{ clock: 100, attacker: 'art', victim: 'hen', attackerZone: 'B site', victimZone: 'B site', weapon: 'ak47' }] });
const pool = [passive, quick(0), quick(2), quick(4), round({ own: 4, opp: 4, ours: () => ({}), theirs: () => ({}) })];

const story = roundStory(passive, { names, network, ours: 'The Golden Horde', theirs: 'ynkesu', pool });
assert.equal(story.sides, 'The Golden Horde T, ynkesu CT');
assert.equal(story.buys, 'The Golden Horde full buy, ynkesu eco');
assert.equal(story.result, 'The Golden Horde won');

const ev = story.events.join('\n');
// Moves, held two seconds, named by callout (the painted position), one line per team per second.
assert.match(ev, /1:50 The Golden Horde \(T\): artysan → Mid; forzaN → A main; regoshka → B main; dijarom → Mid; Lyoli → B main/);
assert.doesNotMatch(ev, /Lyoli → Mid/, 'a one-second step is not a move');
assert.match(ev, /1:00 The Golden Horde \(T\): artysan → Garage/, 'a callout change inside one zone is a move');
assert.match(ev, /1:35 ynkesu \(CT\): Henma → A main/);
// Utility with where it landed; a grenade with no named spot falls back to its zone.
assert.match(ev, /1:47 The Golden Horde \(T\): regoshka smoke → B lurk/);
assert.match(ev, /1:00 The Golden Horde \(T\): artysan molotov → Vents/);
assert.match(ev, /1:36 ynkesu \(CT\): Henma flash → A main/);
// Kills with where both stood.
assert.match(ev, /1:35 KILL forzaN \(A main\) killed Henma \(A main\), ak47/);
// In time order.
const times = story.events.map((l) => l.split(' ')[0]).map((t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]));
assert.deepEqual(times, [...times].sort((a, b) => b - a));

// Formations every 10 seconds, by zone; small groups are named, so a lone player shows.
assert.equal(story.formations[0].startsWith('1:55 The Golden Horde: T spawn 5'), true);
const at150 = story.formations.find((f) => f.startsWith('1:45'));
assert.match(at150, /The Golden Horde: Mid 2 \(artysan, dijarom\), B halls 2 \(regoshka, Lyoli\), A main 1 \(forzaN\)/);
assert.match(at150, /ynkesu: B site 5/, 'the defenders stacked B');

// Pace: against the same team's T full-buys vs ecos (3 of them; the full-vs-full round is left out).
assert.match(story.pace.compared_with, /^3 other T rounds .* \(full vs eco\)$/);
assert.equal(story.pace.this_round.first_on_a_site, '0:55');
assert.equal(story.pace.usual.first_on_a_site, '1:28');
assert.match(story.pace.reading, /onto a site later than 3 of 3/);
assert.match(story.pace.reading, /first kill later than 3 of 3/);

// A window keeps the events and formations inside it.
const late = roundStory(passive, { names, network, ours: 'The Golden Horde', theirs: 'ynkesu', pool, window: [50, 60] });
assert.ok(late.events.every((l) => /^(1:0[0-5]|0:5\d)/.test(l)), late.events.join(' | '));
assert.ok(late.formations.every((f) => /^(1:05|0:55)/.test(f)));

// Without others like it, the pace says so and reads nothing.
const alone = comparePace(passive, [passive]);
assert.match(alone.compared_with, /^0 other/);
assert.equal(alone.usual, undefined);

// The execute: the densest burst of utility from 2+ players, not the early map control.
const g = (t, player) => ({ t, player });
// 1:46 car smoke alone; 1:06-0:55 the A execute (the round in the 17 Oct export).
const ex = findExecute([g(9, 'nic'), g(49, 'kei'), g(52, 'tmb'), g(54, 'kun'), g(54, 'nic'), g(55, 'kei'), g(56, 'kun'), g(56, 'nic'), g(56, 'tmb'), g(59, 'kun'), g(60, 'tmb')]);
assert.deepEqual(ex, { start: 52, end: 60, count: 9, throwers: 4 }, 'the 9-grenade burst; its first grenade is not lost to a later window');
// Equal bursts: the later one is the execute (map control comes first).
assert.equal(findExecute([g(10, 'a'), g(11, 'b'), g(12, 'a'), g(80, 'a'), g(81, 'b'), g(82, 'c')]).start, 80);
// One player's utility, or under 3 grenades, is no execute.
assert.equal(findExecute([g(10, 'a'), g(11, 'a'), g(12, 'a')]), null);
assert.equal(findExecute([g(10, 'a'), g(11, 'b')]), null);

console.log('roundStory.test.js ok');
