// Run: node server/replays/importPackage.test.js
//
// The upload queue tells "skip this file" from "the connection is dead" by the
// status on the refusal (isDuplicateRefusal in src/site/replaysView.js). A
// package whose id was already stored used to throw a bare Error, which the
// route answered as a 400, and one re-uploaded file cancelled the rest of the
// drop.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeReplayPackage } from '../../src/replays/shared/replayPackage.js';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-import-pkg-'));
process.env.AIM4_REPLAY_DIR = ROOT;

// ROOT is read at module load, so the env has to be set before the imports.
const store = await import('./demoStore.js');
const { importReplayPackage } = await import('./importPackage.js');

const USER = 'local';
const DEMO_ID = 'feedbead12345678';

await store.writeRecord(USER, {
  id: DEMO_ID,
  status: 'ready',
  map: 'CCH',
  mapName: 'Cache',
  team1: { name: 'Alpha' },
  team2: { name: 'Bravo' },
  score: { team1: 13, team2: 7 },
  rounds: []
});

const pack = (id) =>
  encodeReplayPackage([
    ['manifest.json', new TextEncoder().encode(JSON.stringify({ id, rounds: [] }))]
  ]);

await assert.rejects(
  importReplayPackage(USER, pack(DEMO_ID), { filename: 'again.aim4replay' }),
  (err) => {
    assert.equal(err.status, 409, 'a stored id is a duplicate refusal, not a 400');
    assert.equal(err.duplicate, true);
    assert.equal(err.message, 'again.aim4replay already exists (Alpha vs Bravo (Cache, 13:7)).');
    return true;
  }
);

// A package this library has not seen is not caught by the same check.
await assert.rejects(importReplayPackage(USER, pack('cafef00d12345678')), (err) => {
  assert.equal(err.message, 'Package has no rounds.');
  assert.equal(err.duplicate, undefined);
  return true;
});

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('importPackage.test: ok');
