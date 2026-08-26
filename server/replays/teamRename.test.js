// Run: node server/replays/teamRename.test.js
//
// A hand-rename, end to end against a real library on disk: the demo the admin
// named, every unnamed lineup sharing its core, and nothing else.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-rename-'));
process.env.AIM4_REPLAY_DIR = ROOT;

// ROOT is read at module load, so the env has to be set before the imports.
const store = await import('./demoStore.js');
const { applyTeamRename } = await import('./teamRescan.js');

const USER = 'local';
const io = { userDir: (u) => path.join(ROOT, u) };

const core = ['c1', 'c2', 'c3'];
const opp = ['o1', 'o2', 'o3', 'o4', 'o5'];
const roster = (a, b) => [
  ...a.map((id) => ({ id, name: `n-${id}`, team: 1 })),
  ...b.map((id) => ({ id, name: `n-${id}`, team: 2 }))
];

/** A ready demo record, written straight to the store. */
async function seed(id, { name1, name2, a, b }) {
  await store.writeRecord(USER, {
    id,
    status: 'ready',
    filename: `${id}.dem`,
    uploadedAt: Number(id.slice(1)) || 1,
    parsedAt: 1,
    map: 'INF',
    mapName: 'Inferno',
    roundCount: 1,
    rounds: [],
    team1: { id: `${id}a`, name: name1 },
    team2: { id: `${id}b`, name: name2 },
    players: roster(a, b)
  });
}

// d1 is the demo the admin renames. d2/d3 are the same core under invented
// labels; d4 shares only two; d5 carries a real name; d6 has the core on the
// other side of the scoreboard.
await seed('d1', { name1: 'n-c1', name2: 'Opp', a: [...core, 'x1', 'x2'], b: opp });
await seed('d2', { name1: 'n-c2', name2: 'Opp', a: [...core, 'x1', 'x9'], b: opp });
// Named after its own stand-in, which is exactly what the parser does when a
// side carries no clan tag (laihoe.js teamNameFor: players[0].clanName || name).
await seed('d3', { name1: 'n-y1', name2: 'Opp', a: [...core, 'y1', 'y2'], b: opp });
await seed('d4', { name1: 'n-z1', name2: 'Opp', a: ['c1', 'c2', 'z1', 'z2', 'z3'], b: opp });
await seed('d5', { name1: 'Real Name FC', name2: 'Opp', a: [...core, 'x1', 'x2'], b: opp });
await seed('d6', { name1: 'Opp', name2: 'n-c3', a: opp, b: [...core, 'w1', 'w2'] });
store.invalidateDemoList(USER);

const { record, alsoRenamed, capped } = await applyTeamRename(io, USER, 'd1', 'Sharks', 'Opp');
assert.equal(record?.team1?.name, 'Sharks', 'the seed demo is renamed');
assert.equal(capped, false, 'a handful of demos is not a runaway sweep');
assert.equal(alsoRenamed, 3, 'd2, d3 and d6 come with it');

const after = new Map((await store.listDemos(USER, { fresh: true })).map((r) => [r.id, r]));
assert.equal(after.get('d2').team1.name, 'Sharks', 'same core, invented label: renamed');
assert.equal(after.get('d3').team1.name, 'Sharks', 'two stand-ins is still the same core');
assert.equal(after.get('d6').team2.name, 'Sharks', 'the core is followed onto team 2');
assert.equal(after.get('d6').team1.name, 'Opp', 'the other side of that demo is untouched');
assert.equal(after.get('d4').team1.name, 'n-z1', 'two shared players is not a core');
assert.equal(after.get('d5').team1.name, 'Real Name FC', 'a real name is never overwritten');

// Re-saving the same names must not sweep anything: only a name that MOVED
// propagates, or every visit to the dialog would re-run the rename.
{
  const again = await applyTeamRename(io, USER, 'd1', 'Sharks', 'Opp');
  assert.equal(again.alsoRenamed, 0, 'an unchanged save touches nothing else');
}

// Renaming the opponent side now that its own label is a placeholder-free
// string: 'Opp' is a real name, so it owns itself and does not sweep.
{
  const res = await applyTeamRename(io, USER, 'd1', 'Sharks', 'Rivals');
  assert.equal(res.record.team2.name, 'Rivals', 'the seed still renames');
  assert.equal(
    (await store.listDemos(USER, { fresh: true })).find((r) => r.id === 'd2').team2.name,
    'Opp',
    'named opponents keep their own name'
  );
}

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('teamRename.test.js: propagation, restraint and idempotence all pass');
