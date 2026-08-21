// The roster catalogue: scoping without opening a stats index.
import assert from 'node:assert/strict';
import { buildRoster, getRoster, invalidateRoster } from './rosterCatalogue.js';
import { demosForPlayer, demosForTeam, rosterTeamPlayers } from '../../src/replays/shared/rosterQuery.js';

const records = [
  {
    id: 'a', map: 'de_nuke', uploadedAt: 300,
    team1: { id: 't1', name: 'MASQ' }, team2: { id: 't2', name: 'State' },
    players: [{ id: 'p1', name: 'donk', team: 1 }, { id: 'p2', name: 'zont1x', team: 2 }]
  },
  {
    id: 'b', map: 'de_mirage', uploadedAt: 500,
    team1: { id: 't3', name: 'Vitality' }, team2: { id: 't1', name: 'MASQ' },
    players: [{ id: 'p1', name: 'donk', team: 2 }, { id: 'p3', name: 'ZywOo', team: 1 }]
  },
  // Older manifest with no roster: must be backfilled from its stats index.
  { id: 'c', map: 'de_inferno', uploadedAt: 100, team1: { id: 't3', name: 'Vitality' }, team2: { id: 't4', name: 'G2' } }
];

let reads = 0;
const readEntry = async (_user, id) => {
  reads += 1;
  return id === 'c' ? { players: [{ id: 'p3', name: 'ZywOo', team: 1 }] } : null;
};

const cat = await buildRoster({}, 'u', records, { readEntry });

// Only the record missing a roster costs a read.
assert.equal(reads, 1, 'records that already carry a roster must not open an index');

// Newest first, and only the matches the player is in.
assert.deepEqual(demosForPlayer(cat, 'p1'), ['b', 'a']);
assert.deepEqual(demosForPlayer(cat, 'p3'), ['b', 'c'], 'backfilled roster counts');
assert.deepEqual(demosForPlayer(cat, 'nobody'), []);

// Teams match on short id or display name, on either side of the match.
assert.deepEqual(demosForTeam(cat, 'MASQ'), ['b', 'a']);
assert.deepEqual(demosForTeam(cat, 't1'), ['b', 'a']);

// Side-aware: donk played for MASQ in both, ZywOo never did.
assert.deepEqual(rosterTeamPlayers(cat, 'MASQ').map((p) => p.name), ['donk']);

// Interning: one entry per player, with an appearance count.
assert.equal(cat.players.length, 3);
assert.equal(cat.players.find((p) => p.i === 'p1').c, 2);

// Compactness is the point — it must stay far below a stats payload.
const bytesPerDemo = JSON.stringify(cat).length / cat.demos.length;
assert.ok(bytesPerDemo < 300, `catalogue must stay small, got ${bytesPerDemo.toFixed(0)} B/demo`);

// Cache keys off the record set, so an upload invalidates it.
invalidateRoster(null);
const first = await getRoster({}, 'u', records, { readEntry });
const second = await getRoster({}, 'u', records, { readEntry });
assert.equal(first, second, 'same record set is served from cache');
const grown = await getRoster({}, 'u', [...records, { id: 'd', uploadedAt: 900, players: [] }], { readEntry });
assert.notEqual(grown, first, 'a new demo rebuilds the catalogue');
assert.equal(grown.demos.length, 4);

console.log('rosterCatalogue.test.js: all assertions passed');
