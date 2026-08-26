// The roster catalogue: scoping without opening a stats index.
import assert from 'node:assert/strict';
import { buildRoster, getRoster, invalidateRoster, scopeRoster } from './rosterCatalogue.js';
import {
  demosForMap,
  demosForPlayer,
  demosForTeam,
  rosterMaps,
  rosterTeamPlayers
} from '../../src/replays/shared/rosterQuery.js';

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

// A manifest with a roster but no map — statsIndex falls back to the rounds
// for this, so anything that scopes by map has to as well.
records.push({
  id: 'd', uploadedAt: 700, team1: { id: 't5', name: 'FaZe' }, team2: { id: 't6', name: 'NAVI' },
  players: [{ id: 'p1', name: 'donk', team: 1 }]
});

let reads = 0;
const readEntry = async (_user, id) => {
  reads += 1;
  if (id === 'c') return { players: [{ id: 'p3', name: 'ZywOo', team: 1 }], map: 'de_inferno' };
  if (id === 'd') return { map: '', rounds: [{ m: 'de_nuke' }] };
  return null;
};

const cat = await buildRoster({}, 'u', records, { readEntry });

// Only records missing a roster or a map cost a read.
assert.equal(reads, 2, 'records carrying both a roster and a map must not open an index');

// --- map scoping ------------------------------------------------------------
// Pattern Finder fetches one map's demos, so a demo whose map cannot be
// resolved must never be silently excluded from that set.
assert.deepEqual(rosterMaps(cat).sort(), ['de_inferno', 'de_mirage', 'de_nuke']);
assert.deepEqual(demosForMap(cat, 'de_nuke'), ['d', 'a'], 'backfilled map is found');
// Backfilled from its rounds, so it resolves to its real map rather than
// riding along under every one.
assert.deepEqual(demosForMap(cat, 'de_mirage'), ['b'], 'a backfilled demo is not a wildcard');
assert.deepEqual(demosForMap(cat, ''), []);
{
  // A demo the catalogue could not resolve a map for appears under every map,
  // so the round-level filter gets the chance to judge it.
  const blind = { v: 1, players: [], demos: [{ id: 'x', m: '', u: 1, t1: '', t2: '', n1: '', n2: '', p: [] }] };
  assert.deepEqual(demosForMap(blind, 'de_nuke'), ['x']);
  assert.deepEqual(demosForMap(blind, 'de_dust2'), ['x']);
}

// Newest first, and only the matches the player is in.
assert.deepEqual(demosForPlayer(cat, 'p1'), ['d', 'b', 'a']);
assert.deepEqual(demosForPlayer(cat, 'p3'), ['b', 'c'], 'backfilled roster counts');
assert.deepEqual(demosForPlayer(cat, 'nobody'), []);

// Teams match on short id or display name, on either side of the match.
assert.deepEqual(demosForTeam(cat, 'MASQ'), ['b', 'a']);
assert.deepEqual(demosForTeam(cat, 't1'), ['b', 'a']);

// Side-aware: donk played for MASQ in both, ZywOo never did.
assert.deepEqual(rosterTeamPlayers(cat, 'MASQ').map((p) => p.name), ['donk']);

// Interning: one entry per player, with an appearance count.
assert.equal(cat.players.length, 3);
assert.equal(cat.players.find((p) => p.i === 'p1').c, 3);

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
assert.equal(grown.demos.length, 5);

// --- one build serves every concurrent caller --------------------------------
// Every scoped page (Database, Performance, the team page) asks for this before
// it asks for anything else, so a cold catalogue is requested several times in
// the same second. Each of those used to walk the library separately, doing the
// backfill reads over and over to produce identical answers.
{
  invalidateRoster(null);
  reads = 0;
  const [x, y, z] = await Promise.all([
    getRoster({}, 'u', records, { readEntry }),
    getRoster({}, 'u', records, { readEntry }),
    getRoster({}, 'u', records, { readEntry })
  ]);
  assert.equal(x, y, 'concurrent callers share one catalogue');
  assert.equal(y, z, 'all of them, not just the first two');
  assert.equal(reads, 2, 'the backfill reads happen once, not once per caller');
}

// --- visibility scoping -----------------------------------------------------
// The catalogue is built over the whole library and narrowed per caller, so a
// narrowed copy must not name a demo — or a player — the caller cannot open.
{
  const visible = new Set(['b']);          // only the Vitality vs MASQ match
  const scoped = scopeRoster(cat, visible);
  assert.deepEqual(scoped.demos.map((d) => d.id), ['b']);
  assert.equal(scoped.total, 1);

  const names = scoped.players.map((p) => p.n).sort();
  assert.deepEqual(names, ['ZywOo', 'donk'], 'only players seated in visible demos');
  assert.ok(!names.includes('zont1x'), 'a player seen only in a hidden demo is dropped');

  // Seat indices must still resolve against the trimmed player list.
  for (const d of scoped.demos) {
    for (let i = 0; i < d.p.length; i += 2) {
      assert.ok(scoped.players[d.p[i]], `seat index ${d.p[i]} must resolve after remapping`);
      assert.ok([1, 2].includes(d.p[i + 1]), 'team survives remapping');
    }
  }

  // Queries over the narrowed catalogue agree with it.
  assert.deepEqual(demosForPlayer(scoped, 'p1'), ['b']);
  assert.deepEqual(demosForPlayer(scoped, 'p2'), [], 'hidden player has no demos');

  // Appearance counts are recomputed, not carried over from the full library.
  assert.equal(scoped.players.find((p) => p.n === 'donk').c, 1);
  assert.equal(cat.players.find((p) => p.i === 'p1').c, 3, 'the full catalogue is untouched');

  // No mask means no copying.
  assert.equal(scopeRoster(cat, null), cat);
  // An empty mask yields an empty catalogue, not the whole library.
  const none = scopeRoster(cat, new Set());
  assert.deepEqual(none.demos, []);
  assert.deepEqual(none.players, []);
}

console.log('rosterCatalogue.test.js: all assertions passed');
