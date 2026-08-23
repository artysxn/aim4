import assert from 'node:assert/strict';
import net from 'node:net';
import {
  DEFAULT_FALLBACK_PROXY,
  loadProxyPool,
  normalizeProxyUrl,
  probeProxyReachable,
  proxyUrlFromEntry,
  parseProxyLines,
  redactProxy,
  resolvePinnedProxy
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
assert.deepEqual(parseProxyLines('130.17.12.137:3128'), ['http://130.17.12.137:3128']);
assert.equal(normalizeProxyUrl('130.17.12.137:3128'), DEFAULT_FALLBACK_PROXY);
assert.equal(redactProxy('http://user:pass@10.0.0.1:8080'), '10.0.0.1:8080');

assert.deepEqual(
  resolvePinnedProxy({ cloakPinProxy: 'http://pin:1', cloakProxy: 'http://env:2' }),
  { url: 'http://pin:1', source: 'AIM4_CLOAK_PIN_PROXY' }
);
assert.deepEqual(resolvePinnedProxy({ cloakProxy: 'http://env:2' }), {
  url: 'http://env:2',
  source: 'AIM4_CLOAK_PROXY'
});
assert.deepEqual(resolvePinnedProxy({}), {
  url: DEFAULT_FALLBACK_PROXY,
  source: 'office-default'
});
assert.deepEqual(await loadProxyPool({ cloakProxyOnly: true, cloakProxy: 'http://env:9' }), [
  'http://env:9'
]);

const server = net.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
assert.equal(await probeProxyReachable(`http://127.0.0.1:${port}`), true);
await new Promise((resolve) => server.close(resolve));
assert.equal(await probeProxyReachable('http://127.0.0.1:1', 250), false);

console.log('proxyPool.test.js OK');
