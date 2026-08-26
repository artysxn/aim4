// Run: node server/replays/lineupNames.test.js
//
// Four of five players is the same team. These are the cases that rule has to
// get right on upload — and the ones where it has to keep its hands off.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-lineups-'));
process.env.AIM4_REPLAY_DIR = ROOT;

const { buildLineupIndex, libraryNamesFor, resolveLineupNames, applyLibraryTeamNames } =
  await import('./lineupNames.js');
const { shortIdFor } = await import('../../src/replays/shared/roundId.js');

/** Roster half: five players named after their ids, with steam ids. */
const side = (ids, team) =>
  ids.map((id, i) => ({
    id,
    name: `n-${id}`,
    steamId: `7656119${id}`,
    team,
    slot: team === 1 ? i : 5 + i
  }));

let seq = 0;
/** A library record. `nameA`/`nameB` default to the parser's own fallback. */
function record({ a, b, nameA, nameB, at = 0 }) {
  seq += 1;
  return {
    id: `d${seq}`,
    status: 'ready',
    uploadedAt: at || seq,
    team1: { id: shortIdFor(nameA ?? `n-${a[0]}`), name: nameA ?? `n-${a[0]}` },
    team2: { id: shortIdFor(nameB ?? `n-${b[0]}`), name: nameB ?? `n-${b[0]}` },
    players: [...side(a, 1), ...side(b, 2)]
  };
}

// Three characters: buildRoundId stores player ids at a fixed width.
const P = (n, start = 0) =>
  Array.from({ length: n }, (_, i) => `p${String(start + i).padStart(2, '0')}`);
const CORE = P(5); // p00..p04
const OPP = P(5, 10); // p10..p14

// ---- the index only lends names it actually has ----------------------------

const parserNamed = record({ a: CORE, b: OPP }); // both sides named after a player
assert.equal(
  buildLineupIndex([parserNamed]).length,
  0,
  'a side named after its own player has no name to lend'
);

assert.equal(
  buildLineupIndex([record({ a: CORE, b: OPP, nameA: 'Team 1', nameB: 'Team 2' })]).length,
  0,
  'Team 1 / Team 2 are not names'
);

const named = record({ a: CORE, b: OPP, nameA: 'The Golden Horde', nameB: 'M0kasyny' });
assert.equal(buildLineupIndex([named]).length, 2, 'two real names, two lineups');
assert.equal(
  buildLineupIndex([named], { skipDemoId: named.id }).length,
  0,
  'the demo being ingested never matches itself'
);

// ---- four of five ----------------------------------------------------------

const library = buildLineupIndex([named]);

// Same core, one stand-in, and an opponent the library has never seen.
const fresh = [...side([...P(4), 'p99'], 1), ...side(P(5, 20), 2)];
let hits = resolveLineupNames(fresh, library);
assert.equal(hits[1].name, 'The Golden Horde', 'four of five carries the name');
assert.equal(hits[1].shared, 4);
assert.equal(hits[2], null, 'a lineup nobody has seen stays unnamed');

// Three is not four.
hits = resolveLineupNames([...side([...P(3), 'p98', 'p99'], 1), ...side(P(5, 20), 2)], library);
assert.equal(hits[1], null, 'three shared players is not the same team');

// The whole roster, on the other side of the map from last time.
hits = resolveLineupNames([...side(P(5, 20), 1), ...side(CORE, 2)], library);
assert.equal(hits[2].name, 'The Golden Horde', 'sides are matched by roster, not by number');
assert.equal(hits[2].shared, 5);

// ---- what the name is allowed to overwrite --------------------------------

const roster = [...side([...P(4), 'p99'], 1), ...side(P(5, 20), 2)];

let resolved = libraryNamesFor(roster, { name: 'n-p00' }, { name: 'n-p20' }, library);
assert.equal(resolved.team1.name, 'The Golden Horde', 'a parser-invented label is replaced');
assert.equal(resolved.team1.id, shortIdFor('The Golden Horde'), 'and the short id follows it');
assert.equal(resolved.team2, null);

resolved = libraryNamesFor(roster, { name: 'SHARKS' }, { name: 'n-p20' }, library);
assert.equal(
  resolved.team1,
  null,
  'a side the demo actually named keeps its name, however many players it shares'
);

// A four-man overlap with the lineup on the WRONG side must not name a team
// after its own opponent.
const mirror = [...side(P(5, 20), 1), ...side([...P(4), 'p99'], 2)];
resolved = libraryNamesFor(mirror, { name: 'The Golden Horde' }, { name: 'n-p99' }, library);
assert.equal(resolved.team2, null, 'never name a side after the team it is playing');

// One name cannot land on both sides at once.
const bothWays = [...side([...P(4), 'p99'], 1), ...side([...P(4), 'p98'], 2)];
resolved = libraryNamesFor(bothWays, { name: 'n-p00' }, { name: 'n-p01' }, library);
assert.equal(resolved.team1, null, 'an ambiguous double match names nobody');
assert.equal(resolved.team2, null);

// ---- most shared wins, then the most recent name --------------------------

const twoOrgs = buildLineupIndex([
  record({ a: CORE, b: OPP, nameA: 'SHARKS', at: 100 }),
  record({ a: CORE, b: OPP, nameA: 'DENDELE', at: 200 })
]);
hits = resolveLineupNames([...side(CORE, 1), ...side(P(5, 30), 2)], twoOrgs);
assert.equal(hits[1].name, 'DENDELE', 'a full roster move is a rename: the current name wins');

const partial = buildLineupIndex([
  record({ a: CORE, b: OPP, nameA: 'Four Of Five', at: 300 }),
  record({ a: [...P(4), 'p99'], b: OPP, nameA: 'All Five', at: 100 })
]);
hits = resolveLineupNames([...side([...P(4), 'p99'], 1), ...side(P(5, 30), 2)], partial);
assert.equal(hits[1].name, 'All Five', 'five shared beats four shared, whatever the dates');

// ---- through the store, the way ingest calls it ---------------------------

const demosDir = path.join(ROOT, 'local', 'demos');
await fsp.mkdir(demosDir, { recursive: true });
const stored = record({ a: CORE, b: OPP, nameA: 'Infurity', nameB: 'EAC', at: 500 });
await fsp.writeFile(path.join(demosDir, `${stored.id}.json`), JSON.stringify(stored));
// A demo still parsing has no roster and must not be indexed as one.
await fsp.writeFile(
  path.join(demosDir, 'pending.json'),
  JSON.stringify({ id: 'pending', status: 'parsing', players: [] })
);

const demo = {
  team1: { id: shortIdFor('n-p00'), name: 'n-p00' },
  team2: { id: shortIdFor('n-p10'), name: 'n-p10' },
  rounds: [{ players: [...side([...P(4), 'p99'], 1), ...side([...P(4, 10), 'p98'], 2)] }]
};
const applied = await applyLibraryTeamNames('local', demo, { demoId: 'new-demo' });
assert.deepEqual(
  applied.applied.map((h) => `${h.side}:${h.name}:${h.shared}`),
  ['1:Infurity:4', '2:EAC:4'],
  'both sides named from the library'
);
assert.equal(demo.team1.name, 'Infurity');
assert.equal(demo.team1.id, shortIdFor('Infurity'), 'round ids will be built from the new name');
assert.equal(demo.team2.name, 'EAC');

// An empty library is not an error, it is just quiet.
const untouched = { team1: { name: 'n-p00' }, team2: { name: 'n-p10' }, rounds: demo.rounds };
assert.deepEqual(
  (await applyLibraryTeamNames('nosuchlibrary', untouched, {})).applied,
  [],
  'a library with no named lineup renames nothing'
);
assert.equal(untouched.team1.name, 'n-p00');

// ---- a locally-parsed package: names move, baked round ids do not ---------

const { applyLibraryTeamNamesToRecord } = await import('./lineupNames.js');
const enc = new TextEncoder();
const dec = new TextDecoder();
const imported = {
  id: 'importedpackage01',
  status: 'ready',
  team1: { id: 'ZZZ', name: 'n-p00' },
  team2: { id: 'YYY', name: 'n-p20' },
  players: [...side([...P(4), 'p99'], 1), ...side(P(5, 20), 2)]
};
const files = new Map([
  ['manifest.json', enc.encode(JSON.stringify(imported))],
  [
    'rounds/ZZZ-YYY-100-INF-01~importedpackage01.json',
    enc.encode(JSON.stringify({ id: 'r1', team1: imported.team1, team2: imported.team2 }))
  ]
]);
await applyLibraryTeamNamesToRecord('local', imported, files);
assert.equal(imported.team1.name, 'Infurity', 'the manifest takes the library name');
assert.equal(imported.team1.id, 'ZZZ', 'the short id stays as the package baked it');
const stampedMeta = JSON.parse(dec.decode(files.get('rounds/ZZZ-YYY-100-INF-01~importedpackage01.json')));
assert.equal(stampedMeta.team1.name, 'Infurity', 'and so does the round meta beside it');
assert.equal(
  JSON.parse(dec.decode(files.get('manifest.json'))).team1.name,
  'Infurity',
  'the packaged manifest is rewritten too'
);

// ---- and through ingest, where the round ids are built from the name -------
//
// The point of naming at ingest rather than afterwards: shortIdFor(team name)
// is baked into every round FILENAME, and that is what the round filters read.

const { HEADER_BYTES, TICK_BYTES, PLAYER_SLOTS, writeHeader, writeRecord } = await import(
  '../../src/replays/shared/tickFormat.js'
);
const { ingestDemo } = await import('./ingest.js');

function makeTicks(rows) {
  const buf = Buffer.alloc(HEADER_BYTES + rows * TICK_BYTES);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  writeHeader(view, { tickCount: rows, firstTick: 0, stride: 1, tickRate: 64, playerCount: PLAYER_SLOTS });
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      writeRecord(view, r, s, {
        x: s * 100, y: r, z: 64, yaw: 0, pitch: 0,
        health: 100, armor: 100, weapon: 1, flags: 1, flash: 0, side: s < 5 ? 2 : 3
      });
    }
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const ingested = await ingestDemo(
  'local',
  'aaaabbbbccccdddd',
  {
    map: 'INF',
    tickRate: 64,
    // What the parser hands over: each side labelled after its first player.
    team1: { id: shortIdFor('n-p00'), name: 'n-p00' },
    team2: { id: shortIdFor('n-p20'), name: 'n-p20' },
    parser: { name: 'test', version: '0', revision: 1 },
    rounds: [
      {
        round: 1,
        winner: 1,
        winnerSide: 'T',
        team1Side: 'T',
        team2Side: 'CT',
        econ1: 0,
        econ2: 0,
        startTick: 0,
        freezeEndTick: 100,
        plantTick: null,
        endTick: 900,
        officialEndTick: 1000,
        players: [...side([...P(4), 'p99'], 1), ...side(P(5, 20), 2)],
        weapons: ['none', 'ak47'],
        ticks: makeTicks(64),
        events: { kills: [], shots: [], grenades: [], bomb: [] },
        stats: {}
      }
    ]
  },
  { filename: 'someuploadedfile.dem' }
);

assert.equal(ingested.team1.name, 'Infurity', 'the library named the side it recognised');
assert.equal(ingested.team2.name, 'n-p20', 'and left the one it has never seen alone');
assert.ok(
  ingested.rounds[0].file.startsWith(`${shortIdFor('Infurity')}-`),
  `the round filename carries the copied name's id, got ${ingested.rounds[0].file}`
);

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('lineupNames.test.js OK');
