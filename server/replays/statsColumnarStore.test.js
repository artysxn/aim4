// The sidecar must never outlive the JSON it was built from.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forgetColumnar, readColumnar, writeColumnar } from './statsColumnarStore.js';
import { resolveColumns } from '../../src/replays/shared/statsColumns.js';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'a4c-'));
const io = { userDir: () => ROOT };
fs.mkdirSync(path.join(ROOT, 'stats'), { recursive: true });
const jsonFile = path.join(ROOT, 'stats', 'd1.json');
const colFile = path.join(ROOT, 'stats', 'd1.a4c');

const mk = (tag) => ({
  id: 'd1', v: 19, key: '19|1|2|3|A|B', map: 'de_nuke', mapName: 'Nuke',
  t1: 'ta', t2: 'tb', name1: 'A', name2: 'B', winner: 1, uploadedAt: 1,
  players: [{ id: 'p1', name: 'n1', team: 1, slot: 0 }],
  rounds: [{
    f: 'r1', d: 'd1', m: 'de_nuke', n: 1, w: 1, s1: 'T', s2: 'CT', e1: 4, e2: 4,
    dur: 60, pt: null, p: { p1: [1, 0, 0, 90, 0, 0, 0, 0, 0, 1] }, ok: 'p1', od: 'p1',
    ph: { p1: [1, 2] }, rl: tag, sw: { p1: 1 }, kt: [], ev: [],
    am: { p1: { shots: 1 } }, du: { p1: { w: 1, p: 0.5, n: 1 } }, ut: { p1: { heThrown: 1 } }
  }],
  roles: { v: 6, maps: {} }, positions: false, pz: 0
});

const shapes = resolveColumns('shapes').groups;

// --- no sidecar yet ---------------------------------------------------------
fs.writeFileSync(jsonFile, JSON.stringify(mk('first')));
assert.equal(await readColumnar(io, 'u', 'd1', shapes), null, 'no sidecar -> caller uses JSON');

// --- write, then read -------------------------------------------------------
assert.equal(await writeColumnar(io, 'u', 'd1', mk('first')), true);
assert.ok(fs.existsSync(colFile), 'sidecar written');
let got = await readColumnar(io, 'u', 'd1', shapes);
assert.ok(got, 'fresh sidecar reads');
assert.equal(got.rounds[0].rl, 'first');
assert.equal(got.key, '19|1|2|3|A|B', 'key travels in the header for the record check');
assert.ok(!('am' in got.rounds[0]), 'unrequested columns are not decoded');

// --- the JSON changes underneath: the sidecar must decline ------------------
await new Promise((r) => setTimeout(r, 12));
fs.writeFileSync(jsonFile, JSON.stringify(mk('second')));
assert.equal(
  await readColumnar(io, 'u', 'd1', shapes),
  null,
  'a rewritten JSON invalidates the sidecar — this is what keeps it safe'
);

// --- refreshing brings it back in step --------------------------------------
await writeColumnar(io, 'u', 'd1', mk('second'));
got = await readColumnar(io, 'u', 'd1', shapes);
assert.equal(got.rounds[0].rl, 'second', 'refreshed sidecar serves the new content');

// --- a truncated / corrupt sidecar is declined, not misread -----------------
fs.writeFileSync(colFile, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8]));
assert.equal(await readColumnar(io, 'u', 'd1', shapes), null, 'corrupt sidecar falls through');
fs.writeFileSync(colFile, Buffer.alloc(0));
assert.equal(await readColumnar(io, 'u', 'd1', shapes), null, 'empty sidecar falls through');

// --- `require` guards on-demand columns -------------------------------------
await writeColumnar(io, 'u', 'd1', mk('third'));
assert.ok(await readColumnar(io, 'u', 'd1', shapes, { require: [] }));
assert.equal(
  await readColumnar(io, 'u', 'd1', shapes, { require: ['heldGun'] }),
  null,
  'a column the index never carried must not be served from the sidecar'
);

// --- a missing JSON means nothing to validate against ------------------------
fs.rmSync(jsonFile);
assert.equal(await readColumnar(io, 'u', 'd1', shapes), null, 'no source JSON -> no fast path');

// --- forget removes it -------------------------------------------------------
await forgetColumnar(io, 'u', 'd1');
assert.equal(fs.existsSync(colFile), false, 'sidecar deleted with the index');

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('statsColumnarStore.test.js: all assertions passed');
