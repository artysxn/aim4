// The columnar container: same answers as the JSON it was packed from.
import assert from 'node:assert/strict';
import {
  assembleEntry,
  blockRange,
  decodeHeader,
  encodeColumnar
} from './statsColumnar.js';
import { COLUMN_GROUPS, projectEntry, resolveColumns } from './statsColumns.js';

const pids = ['p1', 'p2'];
const mkRound = (n) => ({
  f: `r${n}`, d: 'd1', m: 'de_nuke', n, w: (n % 2) + 1, s1: 'T', s2: 'CT',
  e1: 4, e2: 3, dur: 60 + n, pt: n % 2 ? null : 42.5,
  p: { p1: [n, 1, 0, 90, 5, 3, 1, 0, 0, 1], p2: [0, n, 1, 40, 9, 4, 0, 2, 1, 0] },
  ok: 'p1', od: 'p2',
  sw: { p1: n * 1.5, p2: -n }, kt: [{ t: 5, k: 'p1', v: 'p2', w: 'ak47' }], ev: [{ t: 6, a: 'p1', d: 30 }],
  am: { p1: { shots: 9, hits: 4 } }, ut: { p1: { heThrown: 1, heDamage: 40 } }, utt: { 1: 40 },
  du: { p1: { w: 1, p: 0.5, n: 1, b: [[0.1, 1, 0.5, 1]] } }, mv: { p1: { psdt: 300, dt: 900 } },
  aw: { p1: 12 }, ph: { p1: [1, 2, 3] }, rl: `exec-${n}`, cok: ['p1'], cod: ['p2'],
  pos1: 0.6, pos2: 0.4, prw1: 0.55, prw2: 0.45, aca1: 1, ack1: 0, aca2: 0, ack2: 1
});

const entry = {
  id: 'd1', v: 19, key: '19|1|2|3|A|B', map: 'de_nuke', mapName: 'Nuke',
  t1: 'ta', t2: 'tb', name1: 'A', name2: 'B', winner: 1, uploadedAt: 1700000000000,
  players: pids.map((id, i) => ({ id, name: `n${i}`, team: i + 1, slot: i })),
  rounds: [mkRound(1), mkRound(2), mkRound(3)],
  roles: { v: 6, maps: { de_nuke: { p1: { tactical: 'entry' } } } },
  positions: false, pz: 0
};

const bytes = encodeColumnar(entry, { stamp: 'abc' });
const decoded = decodeHeader(bytes);
assert.ok(decoded, 'header decodes');
assert.equal(decoded.header.stamp, 'abc');
assert.equal(decoded.header.nRounds, 3);

/** Read like the store does: only the named groups' blocks. */
function read(groups) {
  const text = new Map();
  const dec = new TextDecoder();
  for (const g of groups) {
    const r = blockRange(decoded.header, decoded.blockBase, g);
    if (!r) continue;
    text.set(g, dec.decode(bytes.subarray(r.start, r.start + r.length)));
  }
  return assembleEntry(decoded.header, text);
}

// --- every preset round-trips to exactly what projectEntry would produce ----
for (const preset of ['identity', 'shapes', 'patterns', 'team', 'rating', 'full']) {
  const contract = resolveColumns(preset);
  const viaJson = projectEntry(entry, contract);
  const viaColumnar = read(contract.groups);
  assert.deepEqual(
    viaColumnar,
    viaJson,
    `columnar read must equal the JSON projection for "${preset}"`
  );
}

// --- a narrow read touches only its own bytes -------------------------------
{
  const shapes = resolveColumns('shapes');
  let read1 = 0;
  for (const g of shapes.groups) {
    const r = blockRange(decoded.header, decoded.blockBase, g);
    if (r) read1 += r.length;
  }
  const all = resolveColumns(null).groups.reduce((n, g) => {
    const r = blockRange(decoded.header, decoded.blockBase, g);
    return n + (r ? r.length : 0);
  }, 0);
  assert.ok(read1 < all * 0.5, `shapes must read well under half the blocks (${read1} of ${all})`);
}

// --- `have` distinguishes "absent from the index" from "not requested" ------
{
  const thin = { ...entry, rounds: entry.rounds.map((r) => { const c = { ...r }; delete c.am; delete c.du; return c; }) };
  delete thin.roles;
  const h = decodeHeader(encodeColumnar(thin, { stamp: 'x' }));
  assert.ok(!h.header.have.includes('aim'), 'a column with no data is not claimed');
  assert.ok(!h.header.have.includes('duels'));
  assert.ok(!h.header.have.includes('roles'));
  assert.ok(h.header.have.includes('phase'), 'a populated column is claimed');
}

// --- corrupt / foreign bytes are declined, not misread ----------------------
assert.equal(decodeHeader(new Uint8Array([1, 2, 3])), null);
assert.equal(decodeHeader(new Uint8Array(64)), null, 'zeroed bytes are not a valid header');
{
  const wrongVersion = new Uint8Array(bytes);
  const enc = new TextEncoder().encode(JSON.stringify({ cv: 99, groups: {}, rows: [] }));
  const out = new Uint8Array(8 + enc.length);
  new DataView(out.buffer).setUint32(0, 0x41344331);
  new DataView(out.buffer).setUint32(4, enc.length);
  out.set(enc, 8);
  assert.equal(decodeHeader(out), null, 'a future container version is declined');
}

// --- every declared group is addressable ------------------------------------
for (const g of Object.keys(COLUMN_GROUPS)) {
  assert.ok(decoded.header.groups[g], `group "${g}" must have a directory entry`);
}

console.log('statsColumnar.test.js: all assertions passed');
