// Run: node server/replays/statsDominance.test.js
//
// The Database's dominance columns: a lost round reads 0 and counts, the rounds
// won average on their own, a round with no reading counts for nothing, and the
// two aggregate paths agree. Then the patch that fills in demos indexed before
// the column existed: it reads only the coarse pass and touches nothing else.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregatePlayers, aggregateTeams, PLAYER_SLOTS } from '../../src/replays/shared/statsMath.js';
import { roundDominance, SCAN_STRIDE } from '../../src/replays/similar/roundSimilarity.js';
import { COLUMN_GROUPS, projectEntry, resolveColumns } from '../../src/replays/shared/statsColumns.js';
import { aggregateHot, aggregateTeamsHot } from './statsHotAggregate.js';
import { createPacker, packStore } from './statsHotStore.js';
import { loadSnapshot, saveSnapshot } from './statsHotSnapshot.js';
import { loadStoredEntry, refreshLibraryFields, STATS_FIELD_GROUPS } from './statsIndex.js';

const ids1 = [...'abcde'];
const ids2 = [...'vwxyz'];
const players = [...ids1.map((id, slot) => ({ id, name: `p${id}`, team: 1, slot })), ...ids2.map((id, i) => ({ id, name: `p${id}`, team: 2, slot: i + 5 }))];
const line = () => new Array(PLAYER_SLOTS).fill(0);

/** A round: the winner's seat and its dominance, null for a round with no reading. */
const round = (id, n, w, dom, { s1 = 'T' } = {}) => ({
  f: `${id}-${n}`,
  d: id,
  m: 'ANC',
  n,
  w,
  s1,
  s2: s1 === 'T' ? 'CT' : 'T',
  e1: 4,
  e2: 4,
  ok: '',
  od: '',
  kt: [],
  ph: {},
  p: Object.fromEntries(players.map((p) => [p.id, line()])),
  ...(dom === undefined ? {} : { dom })
});
const entry = (id, rounds) => ({
  id,
  v: 19,
  key: `19|${id}`,
  map: 'ANC',
  mapName: 'Ancient',
  t1: 'AAA',
  t2: 'BBB',
  name1: 'Alpha',
  name2: 'Bravo',
  winner: 1,
  uploadedAt: 1,
  players,
  rounds,
  positions: false,
  pz: 0
});

const e1 = entry('d1', [round('d1', 1, 1, 90), round('d1', 2, 1, 70), round('d1', 3, 2, 50), round('d1', 4, 2, null), round('d1', 5, 1, undefined)]);
const entries = [e1];
const rows = entries.flatMap((e) => e.rounds);
const playerMap = new Map(players.map((p) => [`d1:${p.id}`, { name: p.name, team: p.team }]));
const demoMap = new Map(entries.map((e) => [e.id, e]));
const store = packStore(entries);

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} against ${b}`);

// ---- the numbers, on both paths ----
for (const [path_, playersOf, teamsOf] of [
  ['raw', (f) => aggregatePlayers(rows, playerMap, f, demoMap), (f) => aggregateTeams(rows, playerMap, demoMap, f)],
  ['hot', (f) => aggregateHot(store, f), (f) => aggregateTeamsHot(store, f)]
]) {
  const p = playersOf({});
  const alpha = p.find((x) => x.id === 'a');
  const bravo = p.find((x) => x.id === 'v');
  // Alpha won 90 and 70 and lost a 50: (90 + 70 + 0) / 3. The two rounds with no reading count for nothing.
  near(alpha.avgDominance, 160 / 3, `${path_}: player, every round`);
  near(alpha.avgWonDominance, 80, `${path_}: player, rounds won`);
  assert.equal(alpha.domRounds, 3, `${path_}: rounds with a reading`);
  assert.equal(alpha.domWonRounds, 2);
  near(bravo.avgDominance, 50 / 3, `${path_}: the other side`);
  near(bravo.avgWonDominance, 50, `${path_}: the other side, rounds won`);

  const t = teamsOf({});
  const teamA = t.find((x) => x.name === 'Alpha');
  const teamB = t.find((x) => x.name === 'Bravo');
  near(teamA.avgDominance, 160 / 3, `${path_}: team, every round`);
  near(teamA.avgWonDominance, 80, `${path_}: team, rounds won`);
  near(teamB.avgWonDominance, 50, `${path_}: the other team`);
  assert.equal(teamA.domRounds, 3);

  // Filtered to the rounds won, the two columns are the same number.
  const won = playersOf({ result: 'won' }).find((x) => x.id === 'a');
  near(won.avgDominance, 80, `${path_}: won only`);
  near(won.avgWonDominance, 80, `${path_}: won only`);
  // Filtered to the rounds lost: 0 every round, and no won rounds to average.
  const lost = playersOf({ result: 'lost' }).find((x) => x.id === 'a');
  assert.equal(lost.avgDominance, 0, `${path_}: lost only`);
  assert.equal(lost.avgWonDominance, null, `${path_}: lost only, nothing won`);
}

// ---- no reading at all: blank, not zero ----
{
  const bare = entry('d2', [round('d2', 1, 1, undefined), round('d2', 2, 2, null)]);
  const map = new Map(players.map((p) => [`d2:${p.id}`, { name: p.name, team: p.team }]));
  const raw = aggregatePlayers(bare.rounds, map, {}, new Map([[bare.id, bare]])).find((x) => x.id === 'a');
  assert.equal(raw.avgDominance, null, 'a demo the patch has not reached is blank');
  assert.equal(raw.avgWonDominance, null);
  const hot = aggregateHot(packStore([bare]), {}).find((x) => x.id === 'a');
  assert.equal(hot.avgDominance, null);
  assert.equal(hot.avgWonDominance, null);
}

// ---- the wire contract carries it ----
{
  assert.deepEqual(COLUMN_GROUPS.dominance.rows, ['dom']);
  const row = projectEntry(e1, resolveColumns(['dominance'])).rounds[0];
  assert.equal(row.dom, 90, 'asked for: sent');
  assert.equal(projectEntry(e1, resolveColumns('identity')).rounds[0].dom, undefined, 'not asked for: not sent');
  for (const preset of ['rating', 'team', 'teamRating']) assert.ok(resolveColumns(preset).rowKeys.has('dom'), `${preset} reads the per-match table's columns`);
}

// ---- a saved store keeps the column, and a heal can adopt it ----
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-dom-'));
  const file = path.join(dir, 'hot.bin');
  await saveSnapshot(file, store, ['d1']);
  const loaded = await loadSnapshot(file);
  assert.ok(loaded, 'the snapshot loads');
  assert.deepEqual([...loaded.store.rDom], [...store.rDom]);
  near(aggregateHot(loaded.store, {}).find((x) => x.id === 'a').avgWonDominance, 80, 'read back');
  const healed = createPacker(loaded.store.nRounds + 2, loaded.store);
  healed.add(entry('d3', [round('d3', 1, 1, 100), round('d3', 2, 2, 40)]));
  const after = healed.finish();
  // Team Alpha: 90, 70 and 100 won, 50 and 40 lost.
  near(aggregateTeamsHot(after, {}).find((x) => x.name === 'Alpha').avgDominance, 260 / 5, 'appended to');
  // A file written before the column has a different layout, and is not read.
  const raw = await fsp.readFile(file);
  const len = raw.readUInt32LE(4);
  const header = JSON.parse(raw.toString('utf8', 8, 8 + len));
  delete header.layout.dominance;
  const text = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(8);
  prefix.write('A4S1', 0, 'ascii');
  prefix.writeUInt32LE(text.length, 4);
  await fsp.writeFile(file, Buffer.concat([prefix, text, raw.subarray(8 + len)]));
  assert.equal(await loadSnapshot(file), null, 'an older snapshot is ignored');
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---- the patch, on real rounds ----
assert.ok(STATS_FIELD_GROUPS.some((g) => g.id === 'dominance'), 'the admin tool offers it');
const samples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sampledemos');
if (fs.existsSync(samples) && fs.readdirSync(samples).some((f) => f.endsWith('.aim4replay'))) {
  const { listSampleRoundNames, getSampleRoundMeta, getSampleRoundTicks } = await import('./sampleDemos.js');
  const names = (await listSampleRoundNames()).slice(0, 6);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-dom-'));
  const strides = new Set();
  const io = {
    userDir: () => dir,
    readRoundMeta: async (_u, f) => (f === 'gone' ? null : getSampleRoundMeta(f)),
    readRoundTicks: async (_u, f, stride) => {
      strides.add(stride);
      return getSampleRoundTicks(f, stride);
    }
  };
  const record = { id: 'real', status: 'ready', parsedAt: 5, uploadedAt: 6, roundCount: names.length + 1, team1: { name: 'One' }, team2: { name: 'Two' } };
  const stored = {
    id: 'real',
    v: 19,
    key: `19|5|6|${names.length + 1}|One|Two`,
    map: 'ANC',
    players,
    rounds: [...names, 'gone'].map((f, i) => ({ f, d: 'real', m: 'ANC', n: i + 1, w: 1, p: {}, sentinel: i, prw1: 0.25 }))
  };
  await fsp.mkdir(path.join(dir, 'stats'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'stats', 'real.json'), JSON.stringify(stored));

  const report = await refreshLibraryFields(io, 'u', [record], { fields: ['dominance'] });
  assert.equal(report.updated, 1);
  assert.equal(report.built, 0, 'patched, not rebuilt');
  assert.deepEqual([...strides], [SCAN_STRIDE], 'the coarse pass and nothing else: no full tick decode');
  const patched = await loadStoredEntry(io, 'u', 'real');
  for (const [i, f] of names.entries()) {
    const read = roundDominance(await getSampleRoundMeta(f), await getSampleRoundTicks(f, SCAN_STRIDE));
    const row = patched.rounds[i];
    assert.equal(row.dom, read[read.winner], `${f}: the number the Demo Manager filter shows`);
    assert.ok(row.dom >= 0 && row.dom <= 100);
    assert.equal(row.sentinel, i, 'other fields stay');
    assert.equal(row.prw1, 0.25, 'other columns are not rewritten');
  }
  assert.equal(patched.rounds.at(-1).dom, undefined, 'a round that cannot be read gets no reading');
  // Ran again it gives the same numbers: the admin tool can be rerun safely.
  const first = patched.rounds.map((r) => r.dom);
  await refreshLibraryFields(io, 'u', [record], { fields: ['dominance'] });
  assert.deepEqual((await loadStoredEntry(io, 'u', 'real')).rounds.map((r) => r.dom), first);
  await fsp.rm(dir, { recursive: true, force: true });
} else {
  console.log('  sampledemos/ missing: the patch on real rounds skipped');
}

console.log('statsDominance.test.js ok');
