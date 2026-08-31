// ---------------------------------------------------------------------------
// lib/leaderboardPaging.test.js
//   node --test src/lib/leaderboardPaging.test.js
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampPage,
  pageCount,
  pageOf,
  pageSlice,
  pageWithUser,
  safeSize
} from './leaderboardPaging.js';

const board = (n) => Array.from({ length: n }, (_, i) => ({ user_id: `u${i}` }));

test('a board of any size has at least one page', () => {
  assert.equal(pageCount(0, 50), 1, 'an empty board is still page one of one');
  assert.equal(pageCount(1, 50), 1);
  assert.equal(pageCount(50, 50), 1, 'exactly full is one page, not two');
  assert.equal(pageCount(51, 50), 2);
  assert.equal(pageCount(500, 50), 10);
});

test('a row lands on the page that holds it', () => {
  assert.equal(pageOf(0, 50), 0);
  assert.equal(pageOf(49, 50), 0, 'the last row of page one');
  assert.equal(pageOf(50, 50), 1, 'the first row of page two');
  assert.equal(pageOf(499, 50), 9);
});

test('a page number cannot leave the board', () => {
  assert.equal(clampPage(-3, 500, 50), 0);
  assert.equal(clampPage(99, 500, 50), 9, 'past the end lands on the last page');
  assert.equal(clampPage(2, 0, 50), 0, 'an empty board has only page one');
  assert.equal(clampPage(NaN, 500, 50), 0);
});

test('the board opens on the page the player is on', () => {
  const list = board(500);
  assert.equal(pageWithUser(list, 'u0', 50), 0, 'top of the board');
  assert.equal(pageWithUser(list, 'u137', 50), 2);
  assert.equal(pageWithUser(list, 'u499', 50), 9, 'bottom of the board');
});

test('a visitor who is not on the board gets the top of it', () => {
  const list = board(500);
  assert.equal(pageWithUser(list, 'nobody', 50), 0);
  assert.equal(pageWithUser(list, null, 50), 0, 'signed out');
  assert.equal(pageWithUser(null, 'u1', 50), 0, 'no board yet');
});

test('a page slice knows where it started, so the numbers keep counting', () => {
  const list = board(120);
  const first = pageSlice(list, 0, 50);
  assert.equal(first.from, 0);
  assert.equal(first.rows.length, 50);
  assert.equal(first.rows[0].user_id, 'u0');

  const third = pageSlice(list, 2, 50);
  assert.equal(third.from, 100, 'row 1 of page 3 is #101 on the board');
  assert.equal(third.rows.length, 20, 'the last page is short, not padded');
  assert.equal(third.rows[0].user_id, 'u100');

  // Asking past the end gives the last page rather than nothing.
  assert.deepEqual(pageSlice(list, 99, 50).rows, third.rows);
});

test('a nonsense page size cannot divide by zero or hang', () => {
  assert.equal(safeSize(0), 1);
  assert.equal(safeSize(-10), 1);
  assert.equal(safeSize(NaN), 1);
  assert.equal(pageCount(10, 0), 10, 'one row a page');
  assert.equal(pageOf(5, 0), 5);
});

console.log('leaderboardPaging.test.js: page maths, clamping and jump-to-me all pass');
