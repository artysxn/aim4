// The Performance cards' comparison line, and the two ways it used to take the
// rest of the site with it: one unreadable index failing the whole walk, and
// the walk itself never letting go of the only thread.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { peerAverages, peerAveragesHot } from './peerAverages.js';
import { getHotStore, invalidateHotStore } from './statsHotService.js';

let seed = 11;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
// Uppercase codes, as production stores them: the walk uppercases its map
// keys before matching row.m verbatim, so lowercase fixtures would starve its
// per-map role accumulators in a way real data never does.
const MAPS = ['NUKE', 'MIRAGE', 'INFERNO'];

/** The shape statsIndex writes: enough of it for accumulatePlayers to read. */
function entryFor(i) {
  const pids = Array.from({ length: 10 }, (_, j) => `p${(i % 4) * 10 + j}`);
  const players = pids.map((id, j) => ({ id, name: `n${j}`, team: j < 5 ? 1 : 2, slot: j }));
  const map = MAPS[i % 3];
  const rounds = Array.from({ length: 6 }, (_, k) => {
    const p = {}, sw = {}, du = {}, am = {}, ut = {};
    for (const id of pids) {
      p[id] = [rnd(4), rnd(2), rnd(2), rnd(140), rnd(30), rnd(14), rnd(5), rnd(6), rnd(3), rnd(2)];
      sw[id] = rnd(400) / 10 - 20;
      du[id] = { w: (rnd(30) + 1) / 10, p: rnd(100) / 100, n: rnd(3), b: [[rnd(11) / 10, 1, 0.5, 1]] };
      am[id] = { engagements: rnd(6), shots: rnd(30), hits: rnd(12) };
      ut[id] = { heThrown: rnd(3), heDamage: rnd(80) };
    }
    return { f: `d${i}-r${k}`, d: `d${i}`, m: map, n: k + 1, w: (k % 2) + 1,
      s1: k < 3 ? 'T' : 'CT', s2: k < 3 ? 'CT' : 'T', e1: rnd(6), e2: rnd(6),
      ok: pids[rnd(10)], od: pids[rnd(10)], p, sw, du, am, ut,
      cok: [], cod: [], mv: {}, aw: {}, ph: {}, utt: {}, rl: null, dur: 60, pt: null,
      kt: [], ev: [], pos1: 0.5, pos2: 0.5, prw1: 0.5, prw2: 0.5, aca1: 0, ack1: 0, aca2: 0, ack2: 0 };
  });
  return { id: `d${i}`, v: 19, key: `19|${i}|${i}|${rounds.length}|A|B`, map, mapName: map,
    t1: `t${i % 4}`, t2: `t${(i + 1) % 4}`, name1: `Team ${i % 4}`, name2: `Team ${(i + 1) % 4}`,
    winner: (i % 2) + 1, uploadedAt: Date.UTC(2026, 0, 1 + (i % 27)), players, rounds,
    roles: {
      v: 6,
      maps: {
        [map]: {
          T: { [pids[0]]: { label: 'AWPer' }, [pids[1]]: { label: 'Lurker' } },
          CT: { [pids[5]]: { label: 'Anchor' } }
        }
      }
    },
    positions: false, pz: 0 };
}

const N = 24;
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-peers-'));
await fsp.mkdir(path.join(tmp, 'stats'), { recursive: true });
const records = [];
for (let i = 0; i < N; i++) {
  const e = entryFor(i);
  await fsp.writeFile(path.join(tmp, 'stats', `${e.id}.json`), JSON.stringify(e));
  records.push({ id: e.id, status: 'ready', parsedAt: i, roundCount: e.rounds.length });
}
const io = { userDir: () => tmp };

// --- the healthy library is the reference ------------------------------------
const clean = await peerAverages(io, 'local', records, {});
assert.ok(clean.sample > 0, 'players clear PEER_MIN_ROUNDS, so there is a comparison line');
const metricKeys = Object.keys(clean.metrics);
assert.ok(metricKeys.length > 0, 'every card metric got a mean');
assert.ok(
  metricKeys.some((k) => Number.isFinite(clean.metrics[k])),
  'the means are numbers, not a bag of nulls'
);
assert.ok(Object.keys(clean.mapSides).length > 0, 'per-map side winrates came out');

// --- one poisoned index costs that demo, not the request ---------------------
// A round shape no accumulator can read. This used to throw out of the walk,
// and since every caller for this key was parked on the same promise, the
// Performance page lost its comparison line for everyone at once — then the
// next request restarted the whole library scan to fail in exactly the
// same place.
{
  const badId = 'd-poison';
  await fsp.writeFile(
    path.join(tmp, 'stats', `${badId}.json`),
    JSON.stringify({ id: badId, key: '19|9|9|1|A|B', map: 'de_nuke', players: [], rounds: [null] })
  );
  const withBad = [...records, { id: badId, status: 'ready', parsedAt: 99, roundCount: 1 }];
  const out = await peerAverages(io, 'local', withBad, {});
  assert.equal(out.sample, clean.sample, 'the healthy demos still count, all of them');
  for (const k of metricKeys) {
    assert.equal(out.metrics[k], clean.metrics[k], `${k} is unchanged by the poisoned demo`);
  }
}

// --- a missing index is not an error either ----------------------------------
{
  const gone = [...records, { id: 'd-absent', status: 'ready', parsedAt: 98, roundCount: 4 }];
  const out = await peerAverages(io, 'local', gone, {});
  assert.equal(out.sample, clean.sample, 'a record with no index on disk is simply skipped');
}

// --- the walk releases the thread -------------------------------------------
// The loader answers from memory here, with no I/O to yield on — which is the
// production case whenever the index LRU is warm, and the one that starved the
// box. `await` on an already-resolved promise only drains microtasks, so
// without a real macrotask boundary in the loop the whole scan is one
// uninterruptible block and every other request waits behind the Performance
// page's six means. A timer armed before the call must get its turn DURING the
// walk, not after it.
{
  const fresh = records.slice(0, 16).map((r) => ({ ...r, parsedAt: r.parsedAt + 1000 }));
  const resident = new Map();
  for (const r of fresh) {
    resident.set(r.id, JSON.parse(await fsp.readFile(path.join(tmp, 'stats', `${r.id}.json`), 'utf8')));
  }
  let ranAt = -1;
  let seen = 0;
  // Armed BEFORE the call, so it sits at the front of the immediate queue and
  // runs at the walk's first real yield. With no yield it runs only once the
  // walk is over, and `seen` is the last demo.
  setImmediate(() => { ranAt = seen; });
  await peerAverages(io, 'local', fresh, {}, {
    // Resolved without touching the disk: exactly what loadStoredEntry does on
    // an LRU hit.
    readEntry: async (_u, id) => resident.get(id) || null,
    onProgress: (p) => { seen = p.done; }
  });
  assert.ok(ranAt >= 0, 'work armed before the walk got a turn while it ran');
  assert.ok(ranAt < fresh.length, `interleaved at demo ${ranAt} of ${fresh.length}, not after`);
}

// --- the hot path is the same answer, computed from the store ----------------
// Same output contract, different engine: aggregateHot's columns instead of a
// 4100-file walk. Any drift between the two is a bug in one of them, so every
// field is compared, not sampled.
{
  const close = (a, b, what) => {
    if (a === null || b === null) return assert.equal(b, a, what);
    assert.ok(Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-12), `${what}: ${a} vs ${b}`);
  };
  const samePeers = (walked, hot, what) => {
    assert.ok(hot, `${what}: store is warm, so the hot path answers`);
    assert.equal(hot.sample, walked.sample, `${what}: sample`);
    assert.deepEqual(Object.keys(hot.metrics).sort(), Object.keys(walked.metrics).sort());
    for (const k of Object.keys(walked.metrics)) close(walked.metrics[k], hot.metrics[k], `${what}: ${k}`);
    assert.deepEqual(Object.keys(hot.mapSides).sort(), Object.keys(walked.mapSides).sort(), `${what}: mapSides keys`);
    for (const m of Object.keys(walked.mapSides)) {
      close(walked.mapSides[m].T, hot.mapSides[m].T, `${what}: ${m} T`);
      close(walked.mapSides[m].CT, hot.mapSides[m].CT, `${what}: ${m} CT`);
    }
    assert.deepEqual(Object.keys(hot.roles).sort(), Object.keys(walked.roles).sort(), `${what}: role maps`);
    for (const m of Object.keys(walked.roles)) {
      for (const side of ['T', 'CT']) {
        assert.deepEqual(
          Object.keys(hot.roles[m][side]).sort(),
          Object.keys(walked.roles[m][side]).sort(),
          `${what}: ${m}/${side} positions`
        );
        for (const pos of Object.keys(walked.roles[m][side])) {
          close(walked.roles[m][side][pos].rating, hot.roles[m][side][pos].rating, `${what}: ${m}/${side}/${pos} rating`);
          close(walked.roles[m][side][pos].swing, hot.roles[m][side][pos].swing, `${what}: ${m}/${side}/${pos} swing`);
        }
      }
    }
  };

  const warm = await getHotStore(io, 'local', records);
  assert.ok(warm.nRounds > 0, 'store built for the parity check');

  const cases = [
    {},
    { map: MAPS[0] },
    { dateFrom: '2026-01-05', dateTo: '2026-01-18' },
    { map: MAPS[1], dateFrom: '2026-01-03' }
  ];
  for (const f of cases) {
    const walked = await peerAverages(io, 'local', records, f, { stamp: `w|${JSON.stringify(f)}` });
    const hot = await peerAveragesHot(io, 'local', records, f, {});
    samePeers(walked, hot, JSON.stringify(f));
  }

  // Visibility: a caller who may read half the library gets the same answer
  // either engine computes for that half.
  const sub = records.slice(0, 12);
  const subIds = new Set(sub.map((r) => r.id));
  const walkedSub = await peerAverages(io, 'local', sub, {}, { stamp: 'w|sub' });
  const hotSub = await peerAveragesHot(io, 'local', records, {}, { allowedIds: subIds });
  samePeers(walkedSub, hotSub, 'visibility subset');

  invalidateHotStore();
}

// --- the result is cached per record set -------------------------------------
{
  const again = await peerAverages(io, 'local', records, {});
  assert.equal(again, clean, 'same library, same filter: served from cache, not rewalked');
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log('peerAverages.test.js: means, poison containment, missing indexes, yielding and caching all pass');
