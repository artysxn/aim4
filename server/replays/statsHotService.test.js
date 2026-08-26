// Incremental appends must be indistinguishable from a rebuild.
import assert from 'node:assert/strict';
import { aggregateHot } from './statsHotAggregate.js';
import { getHotStore, invalidateHotStore, hotStoreStatus } from './statsHotService.js';

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

console.log('statsHotService.test.js: appends, growth, trimming and requireWarm all pass');
