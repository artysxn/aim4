import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteIngestDisk, listIngestDisk } from './disk.js';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-disk-'));
const workDir = path.join(tmp, 'work');
const stateDir = path.join(tmp, 'state');
const probeDir = path.join(stateDir, 'probe', 'run-1');
await fsp.mkdir(path.join(workDir, 'match-1'), { recursive: true });
await fsp.mkdir(probeDir, { recursive: true });
await fsp.writeFile(path.join(workDir, 'match-1', 'demo.rar'), Buffer.alloc(1200));
await fsp.writeFile(path.join(workDir, 'match-1', 'map.dem'), Buffer.alloc(800));
await fsp.writeFile(path.join(workDir, 'match-1', 'notes.txt'), 'ignore');
await fsp.writeFile(path.join(probeDir, 'map.aim4replay'), Buffer.alloc(400));

const cfg = { workDir, stateDir };
const listed = await listIngestDisk(cfg);
assert.equal(listed.files.length, 3, 'lists rar/dem/aim4replay only');
assert.ok(listed.usedBytes >= 2400, 'used bytes include work + probe');
assert.ok(listed.files.every((f) => f.id.includes(':')));

const bad = await deleteIngestDisk(cfg, ['work:../secret.rar', 'work:match-1/notes.txt']);
assert.equal(bad.deleted.length, 0, 'rejects traversal and non-interesting types');

const del = await deleteIngestDisk(cfg, ['work:match-1/demo.rar']);
assert.deepEqual(del.deleted, ['work:match-1/demo.rar']);
assert.equal(del.files.length, 2);

await fsp.rm(tmp, { recursive: true, force: true });
console.log('disk.test.js OK');
