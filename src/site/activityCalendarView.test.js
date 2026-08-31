// ---------------------------------------------------------------------------
// site/activityCalendarView.test.js
//   node --test src/site/activityCalendarView.test.js
//
// The copy on a hovered square, and the shape of the grid it sits in. Both
// halves of practice are kept apart all the way to the tooltip: a demo square
// that quoted trainer minutes would put the reader back to guessing which half
// a shade meant, which is the whole reason there are two grids.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { addToDay, buildCalendar } from '../lib/activityCalendar.js';
import { activityCalendarHtml, activityPairHtml, cellTipText } from './activityCalendarView.js';

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

/** A day with both halves on it, and the calendar it lands in. */
function fixture(metric = 'total') {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), {
    demoSeconds: 3600,
    demoMatches: 2,
    trainSeconds: 600,
    trainRuns: 4
  });
  const cal = buildCalendar({ days, window: 30, today: at(2026, 3, 7), metric });
  return { cal, cell: cal.weeks.flat().find((c) => c.key === '2026-03-05') };
}

// ---- the hover text ----------------------------------------------------------

test('a square names its day and then what was done on it', () => {
  const { cell } = fixture('train');
  const [when, ...lines] = cellTipText(cell, 'train').split('\n');
  assert.match(when, /Thu/, `the weekday leads: ${when}`);
  assert.match(when, /5/);
  assert.deepEqual(lines, ['4 runs · 10 min']);
});

test('the two halves are never added together', () => {
  const { cell } = fixture();
  const lines = cellTipText(cell, 'total').split('\n').slice(1);
  assert.equal(lines.length, 2, 'one line each, not one total');
  assert.match(lines[0], /^Training 4 runs/, 'and each line says which half it is');
  assert.match(lines[1], /^Demos 2 matches/);
});

test('a single-source square never quotes the other source', () => {
  // The reason the two grids exist at all.
  const { cell } = fixture();
  const demo = cellTipText(cell, 'demo');
  assert.match(demo, /2 matches/);
  assert.ok(!/run/.test(demo), `the demo grid stays about demos: ${demo}`);

  const train = cellTipText(cell, 'train');
  assert.match(train, /4 runs/);
  assert.ok(!/match/.test(train), `and the trainer grid about the trainer: ${train}`);
});

test('one of a thing reads as one of a thing', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { demoSeconds: 1800, demoMatches: 1, trainSeconds: 60, trainRuns: 1 });
  const cal = buildCalendar({ days, window: 30, today: at(2026, 3, 7) });
  const cell = cal.weeks.flat().find((c) => c.key === '2026-03-05');
  assert.match(cellTipText(cell, 'demo'), /1 match ·/);
  assert.match(cellTipText(cell, 'train'), /1 run ·/);
});

test('a day with nothing on it says so, and so does one active only elsewhere', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { trainSeconds: 600, trainRuns: 4 });
  const cal = buildCalendar({ days, window: 30, today: at(2026, 3, 7), metric: 'demo' });
  const cells = cal.weeks.flat();
  const trainOnly = cells.find((c) => c.key === '2026-03-05');
  assert.match(cellTipText(trainOnly, 'demo'), /No activity/, 'the text agrees with the shade');
  assert.equal(trainOnly.level, 0, 'and the shade is empty');
  const untouched = cells.find((c) => !c.totals);
  assert.match(cellTipText(untouched, 'demo'), /No activity/);
});

test('no hover text uses an em dash', () => {
  const { cal } = fixture();
  for (const cell of cal.weeks.flat()) {
    assert.ok(!cellTipText(cell, 'total').includes('—'));
  }
});

// ---- the grid ----------------------------------------------------------------

test('every column carries seven slots, short last week included', () => {
  // A column holding fewer than seven shares its full height with what it has,
  // and a square sized by its aspect ratio then grows out of its column.
  const { cal } = fixture();
  const html = activityCalendarHtml(cal, escapeHtml);
  // Cut each chunk at its closing tag: the tail of the last one would
  // otherwise run on into the legend, which has squares of its own.
  const columns = html
    .split('<div class="ac-week">')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('</div>')));
  assert.equal(columns.length, cal.weeks.length, 'one column a week');
  for (const col of columns) {
    assert.equal((col.match(/class="ac-day/g) || []).length, 7, 'seven slots');
  }
  const short = cal.weeks[cal.weeks.length - 1].length;
  assert.ok(short < 7, 'the fixture really does end mid week');
  assert.equal((html.match(/ac-blank/g) || []).length, 7 - short, 'padded by exactly the shortfall');
});

test('the grid tells the CSS how many columns it has', () => {
  // Week columns are fractions of the container, so the count has to travel
  // with the markup or the tracks cannot be laid out.
  const { cal } = fixture();
  const html = activityCalendarHtml(cal, escapeHtml);
  assert.ok(html.includes(`--ac-weeks: ${cal.weeks.length}`), 'the count rides on the box');
});

test('a blank slot carries no breakdown, because it is not a day', () => {
  const { cal } = fixture();
  const html = activityCalendarHtml(cal, escapeHtml);
  const blanks = html.split('ac-day ac-blank').slice(1);
  assert.equal(blanks.length, 1, 'one short day in this fixture');
  assert.ok(blanks.length, 'there are some');
  for (const b of blanks) {
    assert.ok(!b.slice(0, 60).includes('data-ac-tip'), 'and none of them is hoverable');
  }
});

test('every real square is hoverable', () => {
  const { cal } = fixture();
  const html = activityCalendarHtml(cal, escapeHtml);
  const real = cal.weeks.flat().length;
  assert.equal((html.match(/data-ac-tip=/g) || []).length, real);
});

test('the pair builds both halves over the same window', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { demoSeconds: 3600, demoMatches: 2, trainSeconds: 600, trainRuns: 4 });
  const html = activityPairHtml(
    days,
    (args) => buildCalendar({ window: 30, today: at(2026, 3, 7), ...args }),
    escapeHtml
  );
  assert.ok(html.includes('data-metric="train"'), 'mechanics');
  assert.ok(html.includes('data-metric="demo"'), 'and demos');
  assert.ok(html.includes('Last 30 days'), 'over one stated window');
  assert.ok(!html.includes('—'), 'and no em dash in any of it');
});

console.log('activityCalendarView.test.js: hover copy, seven slot columns and the pair all pass');
