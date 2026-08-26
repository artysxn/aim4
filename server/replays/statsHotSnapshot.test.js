// A loaded snapshot must be indistinguishable from the build it saved —
// including the append path afterwards, which is what the hydrated packer is
// for. And a file that lies about itself must cost nothing but a rebuild.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateHot, aggregateTeamsHot, attachRolesHot } from './statsHotAggregate.js';
import { createPacker, packStore } from './statsHotStore.js';
import { loadSnapshot, saveSnapshot } from './statsHotSnapshot.js';

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
    roles: { v: 6, maps: { [map.toUpperCase()]: { T: { [pids[0]]: { label: 'AWPer' } }, CT: {} } } },
    positions: false, pz: 0 };
}

const ENTRIES = [];
for (let i = 0; i < 24; i++) ENTRIES.push(entryFor(i));
const FILTERS = [{}, { maps: ['de_nuke'] }, { side: 'CT' }, { result: 'won' }, { econ: 4 },
  { dateFrom: '2026-01-05', dateTo: '2026-01-20' }];

const sameRows = (a, b, what) => {
  assert.equal(b.length, a.length, `${what}: row count`);
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].id, a[i].id, `${what}: order`);
    for (const k of Object.keys(a[i])) {
      const x = a[i][k], y = b[i][k];
      if (typeof x === 'number' && Number.isFinite(x)) {
        assert.ok(Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-12), `${what}: ${a[i].id}.${k}`);
      }
    }
  }
};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-snap-'));
const file = path.join(tmp, 'hot.a4s');

// --- save → load parity ------------------------------------------------------
const built = packStore(ENTRIES.slice(0, 20));
const ids = ENTRIES.slice(0, 20).map((e) => `${e.id}:1:1`);
const written = await saveSnapshot(file, built, ids);
const stat = await fsp.stat(file);
assert.equal(stat.size, written, 'reported size is the file size');

const snap = await loadSnapshot(file);
assert.ok(snap, 'the file loads');
assert.deepEqual(snap.ids, ids, 'record keys round-trip');
assert.equal(snap.store.nRounds, built.nRounds, 'round count round-trips');
for (const filter of FILTERS) {
  sameRows(aggregateHot(built, filter), aggregateHot(snap.store, filter), JSON.stringify(filter));
}
{
  const pb = aggregateHot(built, {});
  const ps = aggregateHot(snap.store, {});
  sameRows(aggregateTeamsHot(built, {}, pb), aggregateTeamsHot(snap.store, {}, ps), 'teams');
  assert.deepEqual(
    attachRolesHot(snap.store, {}, null, ps).map((p) => [p.id, p.roles || null]),
    attachRolesHot(built, {}, null, pb).map((p) => [p.id, p.roles || null]),
    'roles survive via the demos table'
  );
}
assert.deepEqual([...snap.store.maps.values], [...built.maps.values], 'interner order preserved');

// --- appending onto a loaded snapshot == packing everything at once ----------
{
  const packer = createPacker(1, snap.store);
  assert.equal(packer.rounds, built.nRounds, 'hydrated packer starts where the store ended');
  for (const e of ENTRIES.slice(20)) packer.add(e);
  const appended = packer.finish();
  const full = packStore(ENTRIES);
  assert.equal(appended.nRounds, full.nRounds, 'appended rounds all landed');
  for (const filter of FILTERS) {
    sameRows(aggregateHot(full, filter), aggregateHot(appended, filter), `append ${JSON.stringify(filter)}`);
  }
}

// --- a bad file is null, never a throw ---------------------------------------
assert.equal(await loadSnapshot(path.join(tmp, 'absent.a4s')), null, 'absent file');
{
  const torn = path.join(tmp, 'torn.a4s');
  await fsp.writeFile(torn, (await fsp.readFile(file)).subarray(0, Math.floor(stat.size / 2)));
  assert.equal(await loadSnapshot(torn), null, 'torn file');
  const junk = path.join(tmp, 'junk.a4s');
  await fsp.writeFile(junk, Buffer.from('not a snapshot at all'));
  assert.equal(await loadSnapshot(junk), null, 'junk file');
  // A layout change must invalidate the file even when the frame is intact.
  const whole = await fsp.readFile(file);
  const headerLen = whole.readUInt32LE(4);
  const header = JSON.parse(whole.toString('utf8', 8, 8 + headerLen));
  header.layout.r3 = 'not|the|same|fields';
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  // Only same-length headers can be spliced in place; pad to match.
  const padded = Buffer.concat([hb, Buffer.alloc(Math.max(0, headerLen - hb.length), 0x20)]);
  if (padded.length === headerLen) {
    const drifted = path.join(tmp, 'drift.a4s');
    padded.copy(whole, 8);
    await fsp.writeFile(drifted, whole);
    assert.equal(await loadSnapshot(drifted), null, 'layout drift discards the file');
  }
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log('statsHotSnapshot.test.js: round-trip, appends after load, and bad-file rejection all pass');
