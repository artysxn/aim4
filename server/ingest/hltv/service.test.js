import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireSpawnLease,
  releaseSpawnLease,
  waitForSpawnOwner
} from './service.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-ingest-service-'));
const cfg = { lockPath: path.join(root, 'ingest.lock') };
const lease = `${cfg.lockPath}.spawn`;

try {
  // Overlapping supervisor ticks must produce exactly one spawn owner.
  const claims = await Promise.all(
    Array.from({ length: 20 }, () => acquireSpawnLease(cfg))
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await acquireSpawnLease(cfg), false);

  await releaseSpawnLease(cfg);
  assert.equal(await acquireSpawnLease(cfg), true);
  await releaseSpawnLease(cfg);

  // A crashed API cannot leave the system locked forever.
  await fsp.mkdir(lease);
  const old = new Date(Date.now() - 31_000);
  await fsp.utimes(lease, old, old);
  assert.equal(await acquireSpawnLease(cfg), true);
  await releaseSpawnLease(cfg);

  // A losing supervisor adopts the live winner rather than spawning again.
  await fsp.mkdir(lease);
  await fsp.writeFile(cfg.lockPath, String(process.pid));
  assert.equal(await waitForSpawnOwner(cfg, 250), process.pid);
  await releaseSpawnLease(cfg);
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('service.test.js OK');
