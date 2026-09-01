// Run: node server/replays/identityGate.test.js
//
// The demo-upload identity rule, as a table. Registration by username is
// cheap on purpose; this gate is what keeps cheap from meaning anonymous
// writes into the shared library.

import { demoUploadIdentity } from './identity.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const cases = [
  // who                                                              may upload
  [{ signedIn: false }, false, 'signed out'],
  [{ signedIn: true, provider: 'google', providers: ['google'] }, true, 'google account'],
  [{ signedIn: true, provider: 'email', providers: ['email'] }, false, 'bare username account'],
  [{ signedIn: true, provider: 'email', providers: ['email', 'google'] }, true, 'username account that linked google'],
  [{ signedIn: true, provider: 'email', providers: ['email'], steamId: '76561198000000001' }, true, 'username account that linked steam'],
  [{ signedIn: true, provider: 'email', providers: [], admin: true }, true, 'admins are never locked out'],
  [{ signedIn: true, provider: 'email' }, false, 'missing providers list reads as unlinked, not as linked'],
  [{ signedIn: true, provider: 'email', providers: ['email'], steamId: '' }, false, 'empty steam id is no steam id'],
  [{ signedIn: true, provider: 'email', providers: ['email'], uploadAnchored: true }, true, 'hand-vouched account (0021)'],
  [{ signedIn: true, provider: 'email', providers: ['email'], uploadAnchored: false }, false, 'the flag off is the same as no flag'],
  // The flag is read as a boolean, not as truthiness of whatever the row held:
  // profiles.upload_anchored is not null, but a failed read returns undefined
  // and that must not read as vouched.
  [{ signedIn: true, provider: 'email', providers: ['email'], uploadAnchored: undefined }, false, 'an unread flag is not a set flag'],
  [{ signedIn: false, uploadAnchored: true }, false, 'the flag never substitutes for signing in']
];

for (const [me, expected, label] of cases) {
  const got = demoUploadIdentity(me);
  assert(got.ok === expected, `${label}: expected ${expected}, got ${got.ok}`);
  if (!expected && me.signedIn) {
    assert(/google or steam/i.test(got.error), `${label}: the refusal names the fix`);
  }
}

console.log('identityGate: all assertions passed');
