import assert from 'node:assert/strict';
import {
  DEFAULT_FALLBACK_PROXY,
  normalizeProxyUrl,
  proxyUrlFromEntry,
  parseProxyLines,
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
assert.deepEqual(parseProxyLines('130.17.12.137:3128'), ['http://130.17.12.137:3128']);
assert.equal(normalizeProxyUrl('130.17.12.137:3128'), DEFAULT_FALLBACK_PROXY);
assert.equal(redactProxy('http://user:pass@10.0.0.1:8080'), '10.0.0.1:8080');

console.log('proxyPool.test.js OK');
