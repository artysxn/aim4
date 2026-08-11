import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearCloakProfileLocks } from './cloakSessions.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-cloak-sess-'));
const session = path.join(root, 'hltv');
await fsp.mkdir(session, { recursive: true });
await fsp.writeFile(path.join(session, 'SingletonLock'), 'x');
await fsp.writeFile(path.join(session, 'SingletonCookie'), 'x');
await fsp.writeFile(path.join(session, 'keep-me'), 'ok');

const cleared = await clearCloakProfileLocks(root);
assert.equal(cleared, 2);
assert.equal(
  await fsp.access(path.join(session, 'SingletonLock')).then(() => true, () => false),
  false
);
assert.equal(
  await fsp.access(path.join(session, 'keep-me')).then(() => true, () => false),
  true
);

await fsp.rm(root, { recursive: true, force: true });
console.log('cloakSessions.test.js OK');
