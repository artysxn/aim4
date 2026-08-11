import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  blacklistProxy,
  bpsFromTransfer,
  clearProxyBlacklist,
  loadProxyPool,
  parseProxyLines,
  proxyStatus,
  proxyUrlFromEntry,
  readProxyBlacklist,
  recordWorkingProxy,
  redactProxy,
  sortBySpeed
} from './proxyPool.js';

assert.equal(proxyUrlFromEntry({ protocol: 'socks4', host: '1.1.1.1', port: 1080 }), '');
assert.equal(proxyUrlFromEntry({ protocol: 'http', host: '1.1.1.1', port: 8080 }), 'http://1.1.1.1:8080');
assert.equal(
  proxyUrlFromEntry({ protocol: 'socks5', host: '2.2.2.2', port: 1080 }),
  'socks5://2.2.2.2:1080'
);

assert.deepEqual(parseProxyLines('http://a:1\nsocks4://b:2\nsocks5://c:3\n# hi'), [
  'http://a:1',
  'socks5://c:3'
]);
assert.equal(redactProxy('http://user:pass@10.0.0.1:8080'), '10.0.0.1:8080');

// -- speed samples ----------------------------------------------------------

// 240 MB in 12s is 20 MB/s, the arithmetic the progress log shows by hand.
assert.equal(bpsFromTransfer({ bytes: 240 * 1024 * 1024, ms: 12_000 }), 20_971_520);
// Too small or too short to be a meaningful rate.
assert.equal(bpsFromTransfer({ bytes: 1024, ms: 12_000 }), 0);
assert.equal(bpsFromTransfer({ bytes: 240 * 1024 * 1024, ms: 100 }), 0);
assert.equal(bpsFromTransfer(null), 0);

assert.deepEqual(
  sortBySpeed([
    { url: 'http://slow:1', bps: 1000, lastOkAt: '2026-01-02' },
    { url: 'http://unknown:2', lastOkAt: '2026-01-03' },
    { url: 'http://fast:3', bps: 9000, lastOkAt: '2026-01-01' }
  ]).map((e) => e.url),
  ['http://fast:3', 'http://slow:1', 'http://unknown:2']
);

// -- pool ordering and the challenge bench ----------------------------------

const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-proxy-'));
const cfg = { stateDir };

await recordWorkingProxy(cfg, {
  url: 'http://slow:1',
  transfer: { bytes: 10 * 1024 * 1024, ms: 10_000 }
});
await recordWorkingProxy(cfg, {
  url: 'http://fast:2',
  transfer: { bytes: 200 * 1024 * 1024, ms: 10_000 }
});
assert.deepEqual(await loadProxyPool(cfg), ['http://fast:2', 'http://slow:1']);

// Smoothing: one good burst is not enough to overtake a proven exit, two are.
await recordWorkingProxy(cfg, {
  url: 'http://slow:1',
  transfer: { bytes: 400 * 1024 * 1024, ms: 10_000 }
});
assert.deepEqual(await loadProxyPool(cfg), ['http://fast:2', 'http://slow:1']);
await recordWorkingProxy(cfg, {
  url: 'http://slow:1',
  transfer: { bytes: 400 * 1024 * 1024, ms: 10_000 }
});
assert.deepEqual(await loadProxyPool(cfg), ['http://slow:1', 'http://fast:2']);

const benched = await blacklistProxy(cfg, 'http://slow:1', { reason: 'challenge' });
assert.equal(benched.reason, 'challenge');
assert.ok(Date.parse(benched.until) - Date.now() > 23 * 60 * 60 * 1000);
assert.deepEqual(await loadProxyPool(cfg), ['http://fast:2']);

const status = await proxyStatus(cfg);
assert.equal(status.blacklistCount, 1);
assert.equal(status.blacklist[0].host, 'slow:1');
assert.equal(status.workingCount, 1);
assert.ok(status.working[0].mbps > 0);

// Expired entries drop themselves on read.
await blacklistProxy(cfg, 'http://fast:2', { ms: -1000 });
assert.deepEqual(Object.keys(await readProxyBlacklist(cfg)), ['http://slow:1']);

await clearProxyBlacklist(cfg);
assert.deepEqual(await readProxyBlacklist(cfg), {});

await fsp.rm(stateDir, { recursive: true, force: true });

console.log('proxyPool.test.js OK');
