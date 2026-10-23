// Copied and saved links leave the desktop app with aim4.io, not localhost.
import assert from 'node:assert/strict';
import { PUBLIC_ORIGIN, withPublicLinks } from './publicOrigin.js';

assert.equal(withPublicLinks('http://localhost:3784/demos?round=abc'), `${PUBLIC_ORIGIN}/demos?round=abc`);
assert.equal(withPublicLinks('see http://127.0.0.1:3784/i/xyz and http://localhost:3784'), `see ${PUBLIC_ORIGIN}/i/xyz and ${PUBLIC_ORIGIN}`);
assert.equal(withPublicLinks('"http://[::1]:3784/d/q"'), `"${PUBLIC_ORIGIN}/d/q"`);
// Not a local origin: left alone, including hosts that only start with "localhost".
assert.equal(withPublicLinks('https://aim4.io/x http://localhost.example.com/y'), 'https://aim4.io/x http://localhost.example.com/y');
assert.equal(withPublicLinks(''), '');

console.log('publicOrigin.test.js ok');
