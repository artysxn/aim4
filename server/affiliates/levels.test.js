// ---------------------------------------------------------------------------
// server/affiliates/levels.test.js
//   node --test server/affiliates/levels.test.js
//
// The ladder decides what a person is paid, so the tests are about the edges
// of it: which side of a threshold pays what, that either route promotes, and
// that the thing being counted is customers rather than payments.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_LEVEL, LEVELS, TOP_LEVEL, levelFor, nextLevel, rateFor } from './levels.js';

test('the ladder is three rungs at 10, 15 and 20 percent', () => {
  assert.deepEqual(LEVELS.map((l) => l.rate), [10, 15, 20]);
  assert.deepEqual(LEVELS.map((l) => l.level), [1, 2, 3]);
  assert.equal(BASE_LEVEL.rate, 10);
  assert.equal(TOP_LEVEL.rate, 20);
});

test('a new affiliate starts at the bottom, not at nothing', () => {
  assert.equal(rateFor({}), 10);
  assert.equal(rateFor({ earned: 0, customers: 0 }), 10);
  // Junk in does not fall through to a higher rate.
  assert.equal(rateFor({ earned: NaN, customers: undefined }), 10);
  assert.equal(rateFor(), 10);
});

test('either route promotes, and the thresholds are exact', () => {
  // Money route.
  assert.equal(rateFor({ earned: 19999 }), 10, 'a cent short of Level 2');
  assert.equal(rateFor({ earned: 20000 }), 15, 'exactly on it');
  assert.equal(rateFor({ earned: 149999 }), 15, 'a cent short of Level 3');
  assert.equal(rateFor({ earned: 150000 }), 20, 'exactly on it');
  // Customer route, with no money at all recorded.
  assert.equal(rateFor({ customers: 19 }), 10);
  assert.equal(rateFor({ customers: 20 }), 15);
  assert.equal(rateFor({ customers: 99 }), 15);
  assert.equal(rateFor({ customers: 100 }), 20);
});

test('the two routes describe different people and neither is punished', () => {
  // Few expensive subscriptions: over on money, nowhere near on heads.
  assert.equal(rateFor({ earned: 160000, customers: 12 }), 20);
  // Many cheap ones: nowhere near on money, over on heads.
  assert.equal(rateFor({ earned: 4000, customers: 140 }), 20);
});

test('the level never goes down as figures grow', () => {
  let last = 0;
  for (let earned = 0; earned <= 200000; earned += 5000) {
    const lvl = levelFor({ earned }).level;
    assert.ok(lvl >= last, `level fell at ${earned}`);
    last = lvl;
  }
});

test('what is left to the next rung is reported both ways', () => {
  const next = nextLevel({ earned: 5000, customers: 3 });
  assert.equal(next.level, 2);
  assert.equal(next.earnedToGo, 15000);
  assert.equal(next.customersToGo, 17);
  // Whichever route is closer, both are on offer.
  const nearHeads = nextLevel({ earned: 100, customers: 19 });
  assert.equal(nearHeads.customersToGo, 1);
  assert.equal(nearHeads.earnedToGo, 19900);
  assert.equal(nextLevel({ customers: 100 }), null, 'nothing above the top');
});

test('a rung already passed is not still to go', () => {
  const next = nextLevel({ earned: 30000, customers: 0 });
  assert.equal(next.level, 3, 'past Level 2, so Level 3 is next');
  assert.equal(next.earnedToGo, 120000);
  assert.equal(next.customersToGo, 100);
});

console.log('levels.test.js: rungs, thresholds, both routes and the next-rung readout all pass');
