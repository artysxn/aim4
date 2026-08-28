// Incremental appends must be indistinguishable from a rebuild.
import assert from 'node:assert/strict';
import { aggregateHot, aggregateTeamsHot } from './statsHotAggregate.js';
import {
  getHotStore,
  invalidateHotStore,
  hotRefreshing,
  hotStoreStatus,
  patchHotStoreTeamNames,
  visibilityMask,
  warmHotStoreFromSnapshot
} from './statsHotService.js';

let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const MAPS = ['de_nuke', 'de_mirage', 'de_inferno'];

function entryFor(i) {
  const pids = Array.from({ length: 10 }, (_, j) => `p${(i % 4) * 10 + j}`);
  const players = pids.map((id, j) => ({ id, name: `n${j}`, team: j < 5 ? 1 : 2, slot: j }));
  const map = MAPS[i % 3];
  const rounds = Array.from({ length: 4 + rnd(5) }, (_, k) => {
    const p = {}, sw = {}, du = {}, am = {}, ut = {};
    for (const id of pids) {
      p[id] = [rnd(4), rnd(2), rnd(2), rnd(140), rnd(30), rnd(14), rnd(5), rnd(6), rnd(3), rnd(2)];
      sw[id] = rnd(400) / 10 - 20;
      du[id] = { w: (rnd(30) + 1) / 10, p: rnd(100) / 100, n: rnd(3), b: [[rnd(11) / 10, 1, 0.5, 1]] };
      am[id] = { engagements: rnd(6), shots: rnd(30), hits: rnd(12) };
      ut[id] = { heThrown: rnd(3), heDamage: rnd(80) };
    }
    return { f: `d${i}-r${k}`, d: `d${i}`, m: map, n: k + 1, w: (k % 2) + 1,
      s1: k < 2 ? 'T' : 'CT', s2: k < 2 ? 'CT' : 'T', e1: rnd(6), e2: rnd(6),
      ok: pids[rnd(10)], od: pids[rnd(10)], p, sw, du, am, ut,
      cok: [], cod: [], mv: {}, aw: {}, ph: {}, utt: {}, rl: null, dur: 60, pt: null,
      kt: [], ev: [], pos1: 0.5, pos2: 0.5, prw1: 0.5, prw2: 0.5, aca1: 0, ack1: 0, aca2: 0, ack2: 0 };
  });
  return { id: `d${i}`, v: 19, key: `19|${i}|${i}|${rounds.length}|A|B`, map, mapName: map,
    t1: `t${i % 4}`, t2: `t${(i + 1) % 4}`, name1: `Team ${i % 4}`, name2: `Team ${(i + 1) % 4}`,
    winner: (i % 2) + 1, uploadedAt: Date.UTC(2026, 0, 1 + (i % 27)), players, rounds,
    roles: { v: 6, maps: {} }, positions: false, pz: 0 };
}

const ENTRIES = new Map();
for (let i = 0; i < 30; i++) ENTRIES.set(`d${i}`, entryFor(i));
const recordFor = (id) => {
  const e = ENTRIES.get(id);
  return { id, status: 'ready', parsedAt: Number(e.key.split('|')[1]), roundCount: e.rounds.length };
};

let reads = 0;
const io = { userDir: () => '/nowhere' };
// loadStoredEntry is module-level in statsIndex; the service calls it directly,
// so this test drives the real path through an in-memory shim on the store dir.
const { default: Module } = await import('node:module');
const realLoad = (await import('./statsIndex.js')).loadStoredEntry;
assert.equal(typeof realLoad, 'function', 'loadStoredEntry is the seam the service uses');

// Rather than stub ESM, exercise packer semantics directly through the store.
import { createPacker, packStore } from './statsHotStore.js';

const ids = [...ENTRIES.keys()];
const FILTERS = [{}, { maps: ['de_nuke'] }, { side: 'CT' }, { result: 'won' }, { econ: 4 }];

/**
 * A healed store must aggregate exactly like a from-scratch pack of the same
 * library. Order-free (a heal appends where a rebuild interleaves) and through
 * visibilityMask, which is where dead demos stop counting in production.
 */
function assertSameAggregates(actual, expected, label) {
  const allow = visibilityMask(actual, null);
  for (const filter of FILTERS) {
    const got = aggregateHot(actual, filter, allow);
    const want = aggregateHot(expected, filter);
    assert.equal(got.length, want.length, `${label}: row count for ${JSON.stringify(filter)}`);
    const byId = new Map(got.map((row) => [row.id, row]));
    for (const w of want) {
      const g = byId.get(w.id);
      assert.ok(g, `${label}: ${w.id} present for ${JSON.stringify(filter)}`);
      for (const k of Object.keys(w)) {
        const x = w[k];
        if (typeof x === 'number' && Number.isFinite(x)) {
          assert.ok(
            Math.abs(x - g[k]) <= Math.max(1e-9, Math.abs(x) * 1e-12),
            `${label} ${JSON.stringify(filter)} ${w.name}.${k}: ${x} vs ${g[k]}`
          );
        }
      }
    }
  }
}

// --- appending in batches == packing everything at once ---------------------
{
  const full = packStore(ids.map((id) => ENTRIES.get(id)));
  const packer = createPacker(8);           // deliberately tiny, to force growth
  for (const id of ids.slice(0, 10)) packer.add(ENTRIES.get(id));
  let partial = packer.finish();
  assert.ok(partial.nRounds > 0);
  for (const id of ids.slice(10, 22)) packer.add(ENTRIES.get(id));
  packer.finish();
  for (const id of ids.slice(22)) packer.add(ENTRIES.get(id));
  const appended = packer.finish();

  assert.equal(appended.nRounds, full.nRounds, 'same round count');
  assert.equal(appended.demos.length, full.demos.length, 'same demo count');
  for (const filter of FILTERS) {
    const a = aggregateHot(full, filter);
    const b = aggregateHot(appended, filter);
    assert.equal(b.length, a.length, `row count for ${JSON.stringify(filter)}`);
    for (let i = 0; i < a.length; i++) {
      assert.equal(b[i].id, a[i].id, 'same order');
      for (const k of Object.keys(a[i])) {
        const x = a[i][k], y = b[i][k];
        if (typeof x === 'number' && Number.isFinite(x)) {
          assert.ok(Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-12),
            `${JSON.stringify(filter)} ${a[i].name}.${k}: ${x} vs ${y}`);
        }
      }
    }
  }
}

// --- growth past the capacity hint keeps earlier rows intact ----------------
{
  const packer = createPacker(1);
  const first = ENTRIES.get('d0');
  packer.add(first);
  const beforeRounds = packer.finish().nRounds;
  for (const id of ids.slice(1, 12)) packer.add(ENTRIES.get(id));
  const after = packer.finish();
  assert.ok(after.nRounds > beforeRounds, 'grew');
  // The first demo's rows must still read back correctly after reallocation.
  const only = aggregateHot(after, { files: first.rounds.map((r) => r.f) });
  const ref = aggregateHot(packStore([first]), {});
  assert.equal(only.length, ref.length, 'first demo survives growth');
  for (let i = 0; i < ref.length; i++) {
    assert.equal(only[i].id, ref[i].id);
    assert.equal(only[i].rounds, ref[i].rounds, 'round counts intact after realloc');
    assert.ok(Math.abs(only[i].rating - ref[i].rating) < 1e-9, 'rating intact after realloc');
  }
}

// --- an over-generous hint does not inflate the reported store --------------
{
  const packer = createPacker(100000);
  packer.add(ENTRIES.get('d0'));
  const s = packer.finish();
  assert.equal(s.nRounds, ENTRIES.get('d0').rounds.length, 'trimmed to what was filled');
  assert.equal(s.sPlayer.length, s.nRounds * s.seatsPerRound, 'seat columns trimmed too');
}

invalidateHotStore();
assert.deepEqual(hotStoreStatus().stores, [], 'invalidate clears');

// --- requireWarm: an HTTP request never waits on a cold build ----------------
// The contract that kept the site down twice: a cold /aggregate used to park
// every caller on the shared build promise. requireWarm answers null at once,
// the build runs detached, and only a WARM store is ever served.
{
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-hot-'));
  await fsp.mkdir(path.join(tmp, 'stats'), { recursive: true });
  for (const [id, e] of ENTRIES) {
    await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(e));
  }
  // One poisoned index: a round shape the packer cannot read. It must cost
  // this demo its rows, never the build — a throw here used to reject the
  // shared promise and take /aggregate down for the life of the process.
  const badId = 'd-poison';
  await fsp.writeFile(
    path.join(tmp, 'stats', `${badId}.json`),
    JSON.stringify({ id: badId, key: '19|9|9|1|A|B', map: 'de_nuke', players: [], rounds: [null] })
  );
  const io2 = { userDir: () => tmp };
  const records = [
    ...ids.map(recordFor),
    { id: badId, status: 'ready', parsedAt: 9, roundCount: 1 }
  ];

  const cold = await getHotStore(io2, 'local', records, { requireWarm: true });
  assert.equal(cold, null, 'cold + requireWarm answers null immediately, never the build promise');

  let warm = null;
  for (let i = 0; i < 400 && !warm; i++) {
    await new Promise((r) => setTimeout(r, 25));
    warm = await getHotStore(io2, 'local', records, { requireWarm: true });
  }
  assert.ok(warm, 'the detached build finishes and later calls serve warm');
  // The poisoned demo may keep its identity row (the packer registers the demo
  // before its rounds); what matters is that it contributed no round data and
  // everyone else's did.
  const goodRounds = ids.reduce((n, id) => n + ENTRIES.get(id).rounds.length, 0);
  assert.equal(warm.nRounds, goodRounds, 'every healthy round packed, none from the poisoned demo');
  assert.equal(hotStoreStatus().lastBuildFailure, null, 'a skipped entry is not a failed build');

  invalidateHotStore();
  await fsp.rm(tmp, { recursive: true, force: true });
}

// --- snapshot: a restart serves the store without re-reading a single index --
// The deploy-time contract: build once, write the file; the next process loads
// the file. The indexes are DELETED before the reload here, so a warm store
// can only have come from the snapshot — any fallback to a rebuild would
// produce an empty one and fail the round-count check.
{
  process.env.AIM4_HOT_SNAPSHOT_DELAY_MS = '0';
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-hotsnap-'));
  await fsp.mkdir(path.join(tmp, 'stats'), { recursive: true });
  const half = ids.slice(0, 20);
  for (const id of half) {
    await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(ENTRIES.get(id)));
  }
  const io3 = { userDir: () => tmp };
  const records = half.map(recordFor);

  const built = await getHotStore(io3, 'local', records);
  const snapFile = path.join(tmp, 'stats', '_hotstore.a4s');
  let snapped = false;
  for (let i = 0; i < 400 && !snapped; i++) {
    await new Promise((r) => setTimeout(r, 25));
    snapped = await fsp.stat(snapFile).then(() => true, () => false);
    // The write is atomic; give the rename a beat.
    if (snapped) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(snapped, 'a successful build writes the snapshot');

  // "Restart": drop the resident store AND the indexes it was built from.
  invalidateHotStore();
  for (const id of half) await fsp.rm(path.join(tmp, 'stats', `${id}.json`));

  const cold = await getHotStore(io3, 'local', records, { requireWarm: true });
  assert.equal(cold, null, 'the request path does not wait for the snapshot load either');
  let warm = null;
  for (let i = 0; i < 400 && !warm; i++) {
    await new Promise((r) => setTimeout(r, 25));
    warm = await getHotStore(io3, 'local', records, { requireWarm: true });
  }
  assert.ok(warm, 'the snapshot came up without a build');
  assert.equal(warm.nRounds, built.nRounds, 'every round is there, with no index left to read');
  const before = aggregateHot(built, {});
  const after = aggregateHot(warm, {});
  assert.equal(after.length, before.length, 'same players');
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].id, before[i].id);
    assert.ok(Math.abs(after[i].rating - before[i].rating) < 1e-9, 'ratings identical from disk');
  }

  // New demos append onto the loaded snapshot exactly as onto a live build.
  const extra = ids.slice(20, 24);
  for (const id of extra) {
    await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(ENTRIES.get(id)));
  }
  const grown = await getHotStore(io3, 'local', [...records, ...extra.map(recordFor)]);
  const expect = built.nRounds + extra.reduce((n, id) => n + ENTRIES.get(id).rounds.length, 0);
  assert.equal(grown.nRounds, expect, 'appends after a snapshot load land on the hydrated packer');

  // Boot warm: a LOAD, never a build. With the snapshot present and the
  // indexes gone, only the file can produce a store — and it does, before any
  // request has asked for one.
  invalidateHotStore();
  {
    const warmed = await warmHotStoreFromSnapshot(io3, 'local', records);
    assert.equal(warmed, true, 'boot warm loads the snapshot');
    const served = await getHotStore(io3, 'local', records, { requireWarm: true });
    assert.ok(served, 'the first request after boot is already warm');
    // With no snapshot on disk and no cache, boot warm does nothing quietly.
    invalidateHotStore();
    await fsp.rm(snapFile, { force: true });
    assert.equal(
      await warmHotStoreFromSnapshot(io3, 'local', records),
      false,
      'no file, no store, and crucially no build'
    );
    assert.deepEqual(hotStoreStatus().stores, [], 'nothing resident after a fileless warm');
    // Put the snapshot back for the phases below — indexes restored first, so
    // the file holds real rounds rather than the empty shells of a build that
    // had nothing to read.
    invalidateHotStore();
    for (const id of half) {
      await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(ENTRIES.get(id)));
    }
    const again = await getHotStore(io3, 'local', records);
    assert.ok(again, 'rebuild for the remaining phases');
    let waited = 0;
    while (waited < 10_000 && !(await fsp.stat(snapFile).then(() => true, () => false))) {
      await new Promise((r) => setTimeout(r, 25));
      waited += 25;
    }
  }

  // A snapshot the library has SHRUNK past is no longer discarded: it loads,
  // the demos that left go dead, and their rounds stop counting. The answer
  // must equal a from-scratch pack of the smaller library — and the dead
  // count is the proof it came from the healed file, not a rebuild.
  invalidateHotStore();
  const fewer = records.slice(0, 10);
  const rebuilt = await getHotStore(io3, 'local', fewer);
  assertSameAggregates(
    rebuilt,
    packStore(half.slice(0, 10).map((id) => ENTRIES.get(id))),
    'shrunken library'
  );
  assert.equal(hotStoreStatus().stores[0].dead, 10, 'the shrunk-away demos are dead, not rebuilt away');

  invalidateHotStore();
  delete process.env.AIM4_HOT_SNAPSHOT_DELAY_MS;
  await fsp.rm(tmp, { recursive: true, force: true });
}

// --- a rename never leaves the old names standing ----------------------------
// The packed columns carry the team names, so a store built before a rename
// keeps serving the old ones. The record key hashes the names precisely so a
// renamed demo reads as removed-plus-added: the resident store heals (old
// copy dead, renamed copy appended), and a snapshot written before the rename
// loads only to be healed the same way — a deploy can briefly serve the old
// name mid-heal, but never settle on it.
{
  process.env.AIM4_HOT_SNAPSHOT_DELAY_MS = '0';
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-hotrename-'));
  await fsp.mkdir(path.join(tmp, 'stats'), { recursive: true });
  const three = ids.slice(0, 3);
  for (const id of three) {
    await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(ENTRIES.get(id)));
  }
  const io4 = { userDir: () => tmp };
  const recWithNames = (id, n1) => ({ ...recordFor(id), team1: { name: n1 }, team2: { name: 'Other' } });
  const before = await getHotStore(io4, 'local', three.map((id) => recWithNames(id, 'OldName')));
  assert.ok(before.demos.length === 3);
  const snapFile = path.join(tmp, 'stats', '_hotstore.a4s');
  let snapped = false;
  for (let i = 0; i < 400 && !snapped; i++) {
    await new Promise((r) => setTimeout(r, 25));
    snapped = await fsp.stat(snapFile).then(() => true, () => false);
  }
  assert.ok(snapped, 'snapshot written for the pre-rename store');

  // Rename lands on the stats index (as patchIndexTeamNames would) and record.
  const renamedEntry = { ...ENTRIES.get(three[0]), name1: 'NewName' };
  await fsp.writeFile(path.join(tmp, 'stats', `${three[0]}.json`), JSON.stringify(renamedEntry));
  const renamedRecords = three.map((id, i) => recWithNames(id, i === 0 ? 'NewName' : 'OldName'));

  // Resident store: the changed key heals to the new name without a rebuild.
  const after = await getHotStore(io4, 'local', renamedRecords);
  assert.ok(
    after.demos.some((d) => !d.dead && d.name1 === 'NewName'),
    'a rename reaches the resident store without a restart'
  );

  // "Restart": the pre-rename snapshot may load, but must heal to the new
  // name rather than settling on the old one.
  invalidateHotStore();
  const cold = await getHotStore(io4, 'local', renamedRecords, { requireWarm: true });
  assert.equal(cold, null, 'cold answers null while deciding');
  let warm = null;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
    warm = await getHotStore(io4, 'local', renamedRecords, { requireWarm: true });
    if (warm?.demos.some((d) => !d.dead && d.name1 === 'NewName')) break;
  }
  assert.ok(
    warm?.demos.some((d) => !d.dead && d.name1 === 'NewName'),
    'the pre-rename snapshot cannot outlive the rename'
  );

  invalidateHotStore();
  delete process.env.AIM4_HOT_SNAPSHOT_DELAY_MS;
  await fsp.rm(tmp, { recursive: true, force: true });
}

// --- patching names in place costs no rebuild -------------------------------
// The counterpart to the test above: a rename that goes through the rename
// path patches the resident store instead of dropping it. Names are the one
// thing not in the packed columns, so rebuilding hundreds of MB of them to
// change two strings is pure waste — the admin renames a team and the Database
// must stay warm.
{
  process.env.AIM4_HOT_SNAPSHOT = 'off';
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-hotpatch-'));
  await fsp.mkdir(path.join(tmp, 'stats'), { recursive: true });
  const three = ids.slice(0, 3);
  for (const id of three) {
    await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(ENTRIES.get(id)));
  }
  const io5 = { userDir: () => tmp };
  const recWith = (id, n1, n2) => ({ ...recordFor(id), team1: { name: n1 }, team2: { name: n2 } });
  const before = three.map((id) => recWith(id, 'OldName', 'Other'));
  const built = await getHotStore(io5, 'local', before);

  const renamed = [recWith(three[0], 'NewName', 'Other')];
  assert.equal(patchHotStoreTeamNames(io5, 'local', renamed), 1, 'one demo patched');
  assert.equal(
    built.demos.find((d) => d.id === three[0]).name1,
    'NewName',
    'the resident store shows the new name immediately'
  );

  // The next request must serve the SAME store: patched ids mean no rebuild.
  const after = await getHotStore(io5, 'local', [renamed[0], ...before.slice(1)]);
  assert.equal(after, built, 'no rebuild: the very same store object is served');

  // A demo the store does not hold is reported as not patched, so the caller
  // knows to fall back to invalidating.
  assert.equal(
    patchHotStoreTeamNames(io5, 'local', [
      { id: 'not-in-this-store', parsedAt: 1, roundCount: 1, team1: { name: 'X' }, team2: { name: 'Y' } }
    ]),
    0,
    'unknown demos are not counted as patched'
  );

  invalidateHotStore();
  delete process.env.AIM4_HOT_SNAPSHOT;
  await fsp.rm(tmp, { recursive: true, force: true });
}

// --- a reparsed demo heals in place; the store never goes cold ---------------
// The ingest pipeline re-materializes existing demos a few at a time, and
// each one used to be `removed > 0` → cache.delete → a full library rebuild.
// Measured on prod (2026-08-27): the store was evicted every couple of
// minutes and was cold at almost every moment anyone opened the Database.
// Now the old copy is dead-marked, the new copy is appended, and every
// request in between is answered from the resident store — annotated, via
// hotRefreshing, as "this many demos behind".
{
  process.env.AIM4_HOT_SNAPSHOT_DELAY_MS = '0';
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadSnapshot } = await import('./statsHotSnapshot.js');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-hotheal-'));
  await fsp.mkdir(path.join(tmp, 'stats'), { recursive: true });
  const six = ids.slice(0, 6);
  for (const id of six) {
    await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(ENTRIES.get(id)));
  }
  const io6 = { userDir: () => tmp };
  const records = six.map(recordFor);
  const before = await getHotStore(io6, 'local', records);

  // "Reparse": same id, different rounds, a new parsedAt.
  const reparsed = { ...ENTRIES.get(six[0]), rounds: ENTRIES.get(six[0]).rounds.slice(1) };
  await fsp.writeFile(path.join(tmp, 'stats', `${six[0]}.json`), JSON.stringify(reparsed));
  const after = records.map((r, i) =>
    i === 0 ? { ...r, parsedAt: 999_999, roundCount: reparsed.rounds.length } : r
  );

  const served = await getHotStore(io6, 'local', after, { requireWarm: true });
  assert.equal(served, before, 'the request is answered from the resident store, stale, immediately');
  const note = hotRefreshing('local');
  assert.equal(note?.mode, 'append', 'the served answer is annotated as catching up');
  assert.equal(note?.total, 1, 'by exactly the one reparsed demo');

  let healed = null;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
    healed = await getHotStore(io6, 'local', after, { requireWarm: true });
    if (healed && healed !== before) break;
  }
  const freshEntries = [reparsed, ...six.slice(1).map((id) => ENTRIES.get(id))];
  assertSameAggregates(healed, packStore(freshEntries), 'reparse heal');
  assert.equal(hotRefreshing('local'), null, 'caught up, nothing to annotate');
  assert.equal(hotStoreStatus().stores[0].dead, 1, 'the superseded copy is dead, pending compaction');

  // Team rows read demo identity by id; the dead copy must not shadow it.
  {
    const allow = visibilityMask(healed, null);
    const gotTeams = aggregateTeamsHot(healed, {}, null, allow);
    const wantTeams = aggregateTeamsHot(packStore(freshEntries), {}, null, null);
    assert.equal(gotTeams.length, wantTeams.length, 'team rows survive a heal');
    const byKey = new Map(gotTeams.map((t) => [t.key, t]));
    for (const w of wantTeams) {
      assert.equal(byKey.get(w.key)?.rounds, w.rounds, `team ${w.key} rounds after heal`);
    }
  }

  // A deletion is the removal half of a heal on its own.
  const shorter = after.slice(0, 5);
  const stale = await getHotStore(io6, 'local', shorter, { requireWarm: true });
  assert.ok(stale, 'a deletion also serves stale rather than 503');
  let pruned = null;
  for (let i = 0; i < 400; i++) {
    pruned = await getHotStore(io6, 'local', shorter, { requireWarm: true });
    if (pruned && hotStoreStatus().stores[0]?.dead === 2) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assertSameAggregates(
    pruned,
    packStore([reparsed, ...six.slice(1, 5).map((id) => ENTRIES.get(id))]),
    'deletion heal'
  );

  // The dead-marks ride the snapshot: a "restart" comes back already healed.
  const snapFile = path.join(tmp, 'stats', '_hotstore.a4s');
  let snapHealed = false;
  for (let i = 0; i < 400 && !snapHealed; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const snap = await loadSnapshot(snapFile);
    snapHealed = Boolean(snap?.store.demos.some((d) => d.dead));
  }
  assert.ok(snapHealed, 'the dead-marks reach the file');
  invalidateHotStore();
  const reloaded = await getHotStore(io6, 'local', shorter);
  assertSameAggregates(
    reloaded,
    packStore([reparsed, ...six.slice(1, 5).map((id) => ENTRIES.get(id))]),
    'snapshot reload with dead demos'
  );

  invalidateHotStore();
  delete process.env.AIM4_HOT_SNAPSHOT_DELAY_MS;
  await fsp.rm(tmp, { recursive: true, force: true });
}

// --- past the heal limits the store STILL never goes cold --------------------
// Too much drift means a rebuild — but the rebuild runs detached while the
// resident store keeps answering, where it used to be cache.delete → 503s
// for everyone for the length of the build.
{
  process.env.AIM4_HOT_SNAPSHOT = 'off';
  process.env.AIM4_HOT_REMOVE_LIMIT = '0';
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-hotrebuild-'));
  await fsp.mkdir(path.join(tmp, 'stats'), { recursive: true });
  const five = ids.slice(0, 5);
  for (const id of five) {
    await fsp.writeFile(path.join(tmp, 'stats', `${id}.json`), JSON.stringify(ENTRIES.get(id)));
  }
  const io7 = { userDir: () => tmp };
  const records = five.map(recordFor);
  const before = await getHotStore(io7, 'local', records);

  // With the remove tolerance forced to zero, one deletion exceeds the heal.
  const fewer = records.slice(1);
  const served = await getHotStore(io7, 'local', fewer, { requireWarm: true });
  assert.equal(served, before, 'past the heal limit the stale store is served, not a 503');

  let rebuilt = null;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
    rebuilt = await getHotStore(io7, 'local', fewer, { requireWarm: true });
    if (rebuilt && rebuilt.demos.length === 4) break;
  }
  assert.equal(rebuilt?.demos.length, 4, 'the detached rebuild swaps in');
  assertSameAggregates(
    rebuilt,
    packStore(five.slice(1).map((id) => ENTRIES.get(id))),
    'detached rebuild'
  );
  assert.equal(hotStoreStatus().stores[0].dead, 0, 'a rebuild compacts the dead away');

  invalidateHotStore();
  delete process.env.AIM4_HOT_SNAPSHOT;
  delete process.env.AIM4_HOT_REMOVE_LIMIT;
  await fsp.rm(tmp, { recursive: true, force: true });
}

console.log('statsHotService.test.js: appends, growth, trimming, requireWarm, snapshots, renames, name patching, heals and stale-serving all pass');
