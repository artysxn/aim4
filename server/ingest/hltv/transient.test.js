import assert from 'node:assert/strict';
import { isTransientDownloadError } from './transient.js';

assert.equal(isTransientDownloadError(new Error('page.goto: Timeout 120000ms exceeded.')), true);
assert.equal(isTransientDownloadError(new Error('CloakBrowser received a Cloudflare challenge page')), true);
assert.equal(isTransientDownloadError(new Error('No browser download started within 120s')), true);
assert.equal(isTransientDownloadError(Object.assign(new Error('x'), { blocked: true })), true);
assert.equal(isTransientDownloadError(Object.assign(new Error('gone'), { missing: true })), false);
assert.equal(isTransientDownloadError(new Error('Downloaded file is not an archive (html)')), false);
assert.equal(
  isTransientDownloadError(new Error('browserType.launchPersistentContext: spawn ETXTBSY')),
  true
);
assert.equal(
  isTransientDownloadError(
    new Error('CloakBrowser profile is already in use by process 55')
  ),
  true
);
assert.equal(
  isTransientDownloadError(
    new Error('Opening in existing browser session. This usually means that the profile is already in use')
  ),
  true
);
assert.equal(
  isTransientDownloadError(
    new Error('Looks like you launched a headed browser without having a XServer running.')
  ),
  true
);
console.log('transient.test.js OK');
