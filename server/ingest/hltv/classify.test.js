import assert from 'node:assert/strict';
import {
  MissingDemoError,
  classifyDownloadedBytes,
  isMissingDownloadError,
  looksLikeMissingPage,
  sniffMagic
} from './classify.js';

assert.equal(sniffMagic(Buffer.from('Rar!\x1a\x07')).kind, 'rar');
assert.equal(sniffMagic(Buffer.from('PK\x03\x04')).kind, 'zip');
assert.equal(sniffMagic(Buffer.from('<!DOCTYPE html><title>Page not found</title>')).kind, 'html');

assert.ok(looksLikeMissingPage('<title>Page not found</title><h1>404</h1>'));
assert.ok(
  looksLikeMissingPage(
    `<html><title>404</title><p>The requested URL doesn't exist anymore</p></html>`
  )
);

const missing = classifyDownloadedBytes(
  Buffer.from('<html><title>Page not found</title></html>')
);
assert.equal(missing.kind, 'missing');

const archive = classifyDownloadedBytes(Buffer.from('Rar!\x1a\x07\x00\x00'));
assert.equal(archive.kind, 'archive');

assert.ok(isMissingDownloadError(new MissingDemoError(1)));
assert.ok(isMissingDownloadError(new Error('HTTP 404 without a download')));

console.log('classify.test.js OK');
