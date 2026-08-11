// Xvfb readiness: a leftover socket file must not count as a live display.

import net from 'node:net';
import fsp from 'node:fs/promises';
import {
  isDisplayAlive,
  parseDisplayNumber
} from './cloakDisplay.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(parseDisplayNumber(':99') === 99, ':99');
assert(parseDisplayNumber('localhost:10.0') === 10, 'host:n.screen');
assert(parseDisplayNumber('') == null, 'empty');

assert((await isDisplayAlive(4242, { timeoutMs: 200 })) === false, 'missing display is dead');

const displayNumber = 4242;
const realSock = `/tmp/.X11-unix/X${displayNumber}`;
await fsp.mkdir('/tmp/.X11-unix', { recursive: true }).catch(() => {});
await fsp.rm(realSock, { force: true }).catch(() => {});

const server = net.createServer((c) => c.end());
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(realSock, resolve);
});

try {
  assert(
    (await isDisplayAlive(displayNumber, { timeoutMs: 500 })) === true,
    'listening display is alive'
  );
  server.close();
  await new Promise((resolve) => server.once('close', resolve));
  await fsp.rm(realSock, { force: true }).catch(() => {});
  assert(
    (await isDisplayAlive(displayNumber, { timeoutMs: 200 })) === false,
    'closed display is dead'
  );
} finally {
  server.close();
  await fsp.rm(realSock, { force: true }).catch(() => {});
}

console.log('cloakDisplay: all assertions passed');
