import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OWNER_STALE_MS,
  findLiveOwner,
  ownerIsFresh,
  readOwners,
  removeOwner,
  writeOwnerHeartbeat
} from './ownerLease.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-ingest-owner-'));
const cfg = { stateDir: root };

try {
  const remote = await writeOwnerHeartbeat(cfg, {
    token: 'remote-token',
    pid: 77,
    host: 'other-container'
  });
  assert.equal(ownerIsFresh(remote, { host: 'this-container', now: Date.now() }), true);
  assert.equal((await findLiveOwner(cfg, { host: 'this-container' })).token, 'remote-token');

  // PID 77 being meaningless in this namespace must not invalidate a fresh
  // owner from another container.
  assert.equal(
    ownerIsFresh(remote, {
      host: 'this-container',
      localAlive: () => false,
      now: Date.now()
    }),
    true
  );

  const local = { ...remote, host: 'this-container' };
  assert.equal(ownerIsFresh(local, { host: 'this-container', localAlive: () => false }), false);
  assert.equal(ownerIsFresh(local, { host: 'this-container', localAlive: () => true }), true);

  assert.equal(
    ownerIsFresh(remote, {
      host: 'this-container',
      now: Date.now() + OWNER_STALE_MS + 1
    }),
    false
  );

  await removeOwner(cfg, 'remote-token');
  assert.deepEqual(await readOwners(cfg), []);
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('ownerLease.test.js OK');
