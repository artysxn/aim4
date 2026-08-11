import assert from 'node:assert/strict';
import {
  createProgressSpeedMonitor,
  filterPoolForPick,
  proxyUrlFromEntry,
  parseProxyLines,
  rankBestProxies,
  redactProxy
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

// Log-style samples: 29s 200MB, 30s 205MB, 31s 211MB → ~5.5 MB/s
{
  const mon = createProgressSpeedMonitor({ minMbps: 20, minSamples: 2, minElapsedMs: 1000 });
  const mb = (n) => n * 1024 * 1024;
  assert.equal(mon.sample({ phase: 'browser', received: mb(200), elapsedMs: 29_000 }), null);
  assert.equal(mon.sample({ phase: 'browser', received: mb(205), elapsedMs: 30_000 }), null);
  const verdict = mon.sample({ phase: 'browser', received: mb(211), elapsedMs: 31_000 });
  assert.ok(verdict);
  assert.equal(verdict.tooSlow, true);
  assert.ok(Math.abs(verdict.mbps - 5.5) < 0.05, `expected ~5.5 got ${verdict.mbps}`);
}

{
  const mon = createProgressSpeedMonitor({ minMbps: 20, minSamples: 2, minElapsedMs: 1000 });
  const mb = (n) => n * 1024 * 1024;
  mon.sample({ phase: 'browser', received: mb(40), elapsedMs: 1_000 });
  mon.sample({ phase: 'browser', received: mb(65), elapsedMs: 2_000 });
  const verdict = mon.sample({ phase: 'browser', received: mb(90), elapsedMs: 3_000 });
  assert.ok(verdict);
  assert.equal(verdict.tooSlow, false);
  assert.ok(verdict.mbps >= 20);
}

{
  const pool = ['a', 'b', 'c', 'd'];
  assert.deepEqual(
    filterPoolForPick(pool, {
      used: new Set(),
      gray: new Set(['b']),
      tested: new Set(['a']),
      best: ['a'],
      rotationOnly: false
    }),
    ['c', 'd']
  );
  assert.deepEqual(
    filterPoolForPick(pool, {
      used: new Set(['c', 'd']),
      gray: new Set(['b']),
      tested: new Set(['a']),
      best: [],
      rotationOnly: false
    }),
    ['a']
  );
  // Nothing better left: return to gray list.
  assert.deepEqual(
    filterPoolForPick(pool, {
      used: new Set(['a', 'c', 'd']),
      gray: new Set(['b']),
      tested: new Set(['a']),
      best: [],
      rotationOnly: false
    }),
    ['b']
  );
  assert.deepEqual(
    filterPoolForPick(pool, {
      used: new Set(),
      gray: new Set(),
      tested: new Set(pool),
      best: ['d', 'c'],
      rotationOnly: true
    }),
    ['d', 'c']
  );
}

{
  const ranked = rankBestProxies(
    [
      { url: 'http://slow:1', confirmed: true, mbps: 8, tested: true },
      { url: 'http://fast:1', confirmed: true, mbps: 55, tested: true },
      { url: 'http://mid:1', confirmed: true, mbps: 30, tested: true }
    ],
    { limit: 2, confirmedOnly: true }
  );
  assert.deepEqual(
    ranked.map((e) => e.url),
    ['http://fast:1', 'http://mid:1']
  );
}

console.log('proxyPool.test.js OK');
