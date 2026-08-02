// Run: node server/entitlements/quota.test.js
//
// The window arithmetic, tested without a database. These are the boundaries
// where a quota either leaks a free extra use or refuses one the user has paid
// for, and both are the kind of bug that only shows up in support tickets.

import {
  WINDOW_SECONDS,
  remaining,
  resetsAt,
  windowIsOpen
} from './quota.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---- boundaries -------------------------------------------------------------

{
  const start = Date.parse('2026-08-02T14:22:10Z');
  assert(windowIsOpen(start, start), 'the window is open at the instant it opens');
  assert(windowIsOpen(start, start + DAY - 1), 'open one millisecond before it closes');
  assert(!windowIsOpen(start, start + DAY), 'closed exactly at 24h, not a millisecond later');
  assert(!windowIsOpen(start, start + DAY + 1), 'stays closed after');
  assert(!windowIsOpen(null, start), 'no window is not an open window');
  console.log('  the window closes exactly 24h after it opened');
}

{
  const start = Date.parse('2026-08-02T14:22:10Z');
  assert(
    resetsAt(start).toISOString() === '2026-08-03T14:22:10.000Z',
    `reset time should roll from first use, got ${resetsAt(start)?.toISOString()}`
  );
  assert(resetsAt(null) === null, 'no window means no reset time');
  console.log('  the reset time rolls from first use');
}

// ---- daylight saving --------------------------------------------------------

{
  // 01:30 UTC on the night Europe springs forward. Calendar arithmetic ("add
  // one day") would produce a 23 or 25 hour window here depending on the local
  // zone; absolute milliseconds cannot.
  const start = Date.parse('2026-03-29T01:30:00Z');
  const reset = resetsAt(start);
  assert(reset.getTime() - start === DAY, 'a DST night is still exactly 24h');
  assert(windowIsOpen(start, start + DAY - 1000), 'still open 23h59m in');
  assert(!windowIsOpen(start, start + DAY + 1000), 'closed 24h01m in');
  console.log('  a window spanning a DST change is still exactly 24h');
}

{
  // Same for the autumn transition, where the local day is 25 hours long.
  const start = Date.parse('2026-10-25T01:30:00Z');
  assert(resetsAt(start).getTime() - start === DAY, 'an autumn DST night is 24h too');
  console.log('  the autumn DST transition does not extend a window');
}

// ---- clock skew -------------------------------------------------------------

{
  // A row written by a machine whose clock runs ahead. Treating a future
  // window_start as "closed" would hand out a fresh allowance on every request
  // until the clocks agreed, which is a free unlimited tier for as long as the
  // skew lasts.
  const now = Date.parse('2026-08-02T12:00:00Z');
  const start = now + HOUR;
  assert(windowIsOpen(start, now), 'a future window_start counts as open, not as expired');
  assert(remaining(3, 3, start, now) === 0, 'and its usage still counts');
  console.log('  a window_start in the future is treated as open, not as expired');
}

// ---- remaining --------------------------------------------------------------

{
  const now = Date.parse('2026-08-02T12:00:00Z');
  const open = now - HOUR;
  const closed = now - 25 * HOUR;

  assert(remaining(3, 0, open, now) === 3, 'nothing used means the full allowance');
  assert(remaining(3, 1, open, now) === 2, 'one used leaves two');
  assert(remaining(3, 3, open, now) === 0, 'spent means zero');
  assert(remaining(3, 9, open, now) === 0, 'never negative, even if a row overshot');
  assert(remaining(3, 3, closed, now) === 3, 'a closed window is a full allowance again');
  assert(remaining(-1, 500, open, now) === -1, 'unlimited stays unlimited');
  assert(remaining(0, 0, open, now) === 0, 'a zero limit has nothing to give');
  console.log('  remaining handles spent, overshot, closed and unlimited windows');
}

{
  assert(WINDOW_SECONDS === 86400, 'the default window is 24h');
  // A custom window is honoured end to end, which is what makes switching to a
  // fixed daily reset a configuration change rather than a rewrite.
  const start = Date.parse('2026-08-02T12:00:00Z');
  assert(windowIsOpen(start, start + 30 * 1000, 60), 'a 60s window is open at 30s');
  assert(!windowIsOpen(start, start + 61 * 1000, 60), 'and closed at 61s');
  console.log('  the window length is configurable end to end');
}

console.log('quota: all assertions passed');
