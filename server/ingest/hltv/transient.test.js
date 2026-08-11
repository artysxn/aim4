import assert from 'node:assert/strict';
import { isTransientDownloadError } from './transient.js';

assert.equal(isTransientDownloadError(new Error('page.goto: Timeout 30000ms exceeded.')), true);
assert.equal(isTransientDownloadError(new Error('CloakBrowser received a Cloudflare challenge page')), true);
assert.equal(isTransientDownloadError(new Error('No browser download started within 30s')), true);
assert.equal(isTransientDownloadError(Object.assign(new Error('x'), { blocked: true })), true);
assert.equal(isTransientDownloadError(Object.assign(new Error('gone'), { missing: true })), false);
assert.equal(isTransientDownloadError(new Error('Downloaded file is not an archive (html)')), false);
console.log('transient.test.js OK');
