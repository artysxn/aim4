import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  advanceCursor,
  cursorProgress,
  noteFrontierMiss,
  readCursor,
  writeCursor
} from './cursor.js';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-cursor-'));
const cfg = { stateDir: tmp, demoStart: 109575, demoHint: 110206 };

let cursor = await readCursor(cfg);
assert.equal(cursor.nextId, 109575);
assert.equal(cursor.highWaterId, 110206);

cursor = await advanceCursor(cfg, cursor, { success: true });
assert.equal(cursor.nextId, 109576);
assert.equal(cursor.lastSuccessId, 109575);

const progress = cursorProgress(cursor);
assert.ok(progress.left > 600, `expected catch-up left, got ${progress.left}`);

cursor = await noteFrontierMiss(cfg, { ...cursor, nextId: 110207, lastSuccessId: 110206 });
assert.equal(cursor.frontierKnown, true);
assert.equal(cursor.highWaterId, 110206);
assert.equal(cursorProgress(cursor).atFrontier, true);
assert.equal(cursorProgress(cursor).left, 0);

await writeCursor(cfg, cursor);
const again = await readCursor(cfg);
assert.equal(again.nextId, cursor.nextId);

await fsp.rm(tmp, { recursive: true, force: true });
console.log('cursor.test.js OK');
