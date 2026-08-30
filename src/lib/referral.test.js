// ---------------------------------------------------------------------------
// src/lib/referral.test.js
//   node --test src/lib/referral.test.js
//
// Remembering an affiliate link across the days between the click and the
// payment. Two of the rules here are promises to real people and are worth
// pinning: first touch wins, and a click stops counting after the window.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

// A localStorage and a window, because this module is browser code and the
// alternative is not testing the part that actually holds the value.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.window = {
  location: { href: 'https://aim4.io/', search: '', origin: 'https://aim4.io' },
  history: { replaceState: () => {} }
};

const { REFERRAL_DAYS, captureReferral, clearReferral, storedReferral } = await import(
  './referral.js'
);

const KEY = 'aim4.referral';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  store.clear();
  globalThis.window.location.href = 'https://aim4.io/';
});

test('a ref parameter is remembered', () => {
  assert.equal(captureReferral('?ref=DANNY'), 'DANNY');
  assert.equal(storedReferral(), 'DANNY');
});

test('a code is normalised on the way in', () => {
  captureReferral('?ref=my-code');
  assert.equal(storedReferral(), 'MY-CODE');
});

test('first touch wins', () => {
  // The rule that matters to affiliates: a second creator's link cannot take
  // a customer who arrived through the first. It also has to agree with the
  // server, where the unique constraint means the first write is the one that
  // sticks, so overwriting here would only create a disagreement.
  captureReferral('?ref=FIRST');
  captureReferral('?ref=SECOND');
  assert.equal(storedReferral(), 'FIRST');
});

test('a visit with no ref leaves an existing one alone', () => {
  captureReferral('?ref=DANNY');
  assert.equal(captureReferral(''), 'DANNY');
  assert.equal(captureReferral('?utm_source=x'), 'DANNY');
  assert.equal(storedReferral(), 'DANNY');
});

test('a click stops counting after the window', () => {
  const old = Date.now() - (REFERRAL_DAYS + 1) * DAY_MS;
  store.set(KEY, JSON.stringify({ code: 'STALE', at: old }));
  assert.equal(storedReferral(), null, 'past the window it is not used');
  assert.equal(store.has(KEY), false, 'and it is cleaned up rather than left to rot');
});

test('a click just inside the window still counts', () => {
  const recent = Date.now() - (REFERRAL_DAYS - 1) * DAY_MS;
  store.set(KEY, JSON.stringify({ code: 'FRESH', at: recent }));
  assert.equal(storedReferral(), 'FRESH');
});

test('junk in storage is not a crash', () => {
  store.set(KEY, 'not json');
  assert.equal(storedReferral(), null);
  store.set(KEY, JSON.stringify({ nope: true }));
  assert.equal(storedReferral(), null);
});

test('an empty or unusable ref is ignored', () => {
  assert.equal(captureReferral('?ref='), null);
  assert.equal(captureReferral('?ref=!!!'), null, 'nothing survives normalisation');
  assert.equal(storedReferral(), null);
});

test('clearing forgets it', () => {
  captureReferral('?ref=DANNY');
  clearReferral();
  assert.equal(storedReferral(), null);
});

test('the ref is stripped from the address bar', () => {
  // Otherwise it survives into every link someone copies off that page, and a
  // visitor ends up unknowingly spreading another person's referral code.
  let replaced = null;
  globalThis.window.location.href = 'https://aim4.io/tools?ref=DANNY&keep=1';
  globalThis.window.history.replaceState = (_s, _t, url) => {
    replaced = url;
  };
  captureReferral('?ref=DANNY&keep=1');
  assert.equal(replaced, '/tools?keep=1', 'ref goes, everything else stays');
});
