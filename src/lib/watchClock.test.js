// ---------------------------------------------------------------------------
// lib/watchClock.test.js
//   node --test src/lib/watchClock.test.js
//
// What the clock refuses to count is the whole point. Time in a background
// tab and time with nobody at the keyboard are what turn "watch time" into
// "time the tab was left open", and a calendar built on that measures nothing.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
// A window and document the clock can bind to, with no real events.
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const { IDLE_MS, accrue, createWatchClock, prune, watchDays } = await import('./watchClock.js');
const { dayKey } = await import('./activityCalendar.js');

/** A clock on a hand-cranked timeline, so nothing here waits on real seconds. */
function fakeClock(startMs) {
  let t = startMs;
  const clock = createWatchClock({ now: () => t });
  return {
    clock,
    advance(ms) {
      t += ms;
    },
    at: () => t
  };
}

beforeEach(() => {
  store.clear();
  globalThis.document.hidden = false;
});

// ---- accrual -----------------------------------------------------------------

test('seconds land on the day they happened', () => {
  const days = {};
  const at = new Date(2026, 2, 7, 12).getTime();
  accrue(days, at, 10);
  accrue(days, at, 5);
  assert.equal(days['2026-03-07'], 15);
});

test('a tick longer than a tick is capped, not banked', () => {
  // A slept machine or a throttled tab reports an enormous gap. Paying it out
  // would hand someone hours for closing a laptop.
  const days = {};
  accrue(days, Date.now(), 100000);
  assert.ok(days[dayKey(Date.now())] <= 15, 'capped to one tick');
});

test('nonsense contributions are ignored', () => {
  const days = {};
  accrue(days, Date.now(), -5);
  accrue(days, Date.now(), NaN);
  accrue(days, NaN, 10);
  assert.deepEqual(days, {});
});

test('old days are pruned so storage cannot grow forever', () => {
  const today = new Date(2026, 5, 1).getTime();
  const days = { '2026-05-30': 100, '2025-01-01': 100 };
  const out = prune(days, today);
  assert.ok(out['2026-05-30'], 'recent days survive');
  assert.equal(out['2025-01-01'], undefined, 'ancient ones do not');
});

// ---- the clock ---------------------------------------------------------------

test('an open viewer accrues time', () => {
  const f = fakeClock(new Date(2026, 2, 7, 12).getTime());
  f.clock.start('timeline');
  f.advance(10_000);
  f.clock.stop();
  assert.ok(f.clock.todaySeconds() >= 9, `got ${f.clock.todaySeconds()}`);
});

test('switching Timeline to Analyzer is one session, not two', () => {
  const f = fakeClock(new Date(2026, 2, 7, 12).getTime());
  f.clock.start('timeline');
  f.advance(5_000);
  f.clock.start('analyzer');
  f.advance(5_000);
  f.clock.stop();
  assert.ok(f.clock.running === false);
  assert.ok(f.clock.todaySeconds() >= 9, `continuous, got ${f.clock.todaySeconds()}`);
});

test('a closed viewer counts nothing', () => {
  const f = fakeClock(new Date(2026, 2, 7, 12).getTime());
  f.clock.start('timeline');
  f.advance(5_000);
  f.clock.stop();
  const banked = f.clock.todaySeconds();
  f.advance(600_000);
  assert.equal(f.clock.todaySeconds(), banked, 'time after closing is not watch time');
});

test('a background tab counts nothing', () => {
  const f = fakeClock(new Date(2026, 2, 7, 12).getTime());
  f.clock.start('timeline');
  globalThis.document.hidden = true;
  f.advance(10_000);
  f.clock.stop();
  assert.equal(f.clock.todaySeconds(), 0, 'hidden time is not watch time');
});

test('an idle viewer stops counting', () => {
  // Left open over lunch: the first stretch counts, the silence does not.
  const f = fakeClock(new Date(2026, 2, 7, 12).getTime());
  f.clock.start('timeline');
  f.advance(IDLE_MS + 60_000);
  f.clock.stop();
  assert.equal(f.clock.todaySeconds(), 0, 'nothing accrues past the idle window');
});

test('time survives a reload, because it is written down', () => {
  const start = new Date(2026, 2, 7, 12).getTime();
  const f = fakeClock(start);
  f.clock.start('timeline');
  f.advance(10_000);
  f.clock.stop();
  const banked = f.clock.todaySeconds();
  assert.ok(banked > 0);
  // A fresh clock reads the same storage.
  const again = createWatchClock({ now: () => start + 10_000 });
  assert.equal(again.todaySeconds(), banked);
  assert.equal(Number(watchDays()[dayKey(start)]), banked);
});

test('the flush callback sees the days as they accrue', () => {
  const start = new Date(2026, 2, 7, 12).getTime();
  let t = start;
  const seen = [];
  const clock = createWatchClock({ now: () => t, onFlush: (d) => seen.push({ ...d }) });
  clock.start('timeline');
  t += 10_000;
  clock.stop();
  assert.ok(seen.length >= 1, 'stopping flushes');
  assert.ok(Number(seen[seen.length - 1][dayKey(start)]) > 0);
});

test('stopping twice is harmless', () => {
  const f = fakeClock(Date.now());
  f.clock.start('timeline');
  f.advance(5_000);
  f.clock.stop();
  const banked = f.clock.todaySeconds();
  f.clock.stop();
  assert.equal(f.clock.todaySeconds(), banked);
});
