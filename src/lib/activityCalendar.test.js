// ---------------------------------------------------------------------------
// lib/activityCalendar.test.js
//   node --test src/lib/activityCalendar.test.js
//
// The grid: whole weeks, aligned rows, honest shading, and the two sources
// kept apart. A calendar that quietly drops a day or merges demo time into
// trainer time is worse than no calendar, because it still looks right.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEVELS,
  WEEKDAYS,
  addToDay,
  buildCalendar,
  cellTitle,
  dayKey,
  dayStart,
  formatDuration,
  levelFor,
  levelThresholds
} from './activityCalendar.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('a day key is the local calendar day', () => {
  assert.equal(dayKey(at(2026, 3, 7)), '2026-03-07');
  assert.equal(dayKey(at(2026, 12, 31, 23)), '2026-12-31');
  assert.equal(dayKey(NaN), null);
  assert.equal(dayStart('2026-03-07'), at(2026, 3, 7, 0));
});

test('the two sources accumulate separately', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 7), { demoSeconds: 600, demoMatches: 1 });
  addToDay(days, at(2026, 3, 7, 20), { trainSeconds: 300, trainRuns: 5 });
  const d = days.get('2026-03-07');
  assert.deepEqual(d, { demoSeconds: 600, demoMatches: 1, trainSeconds: 300, trainRuns: 5 });
});

test('junk contributions do not corrupt a bucket', () => {
  const days = new Map();
  addToDay(days, NaN, { demoSeconds: 600 });
  assert.equal(days.size, 0, 'an undated contribution lands nowhere');
  addToDay(days, at(2026, 3, 7), { demoSeconds: 'soup', trainRuns: 2 });
  assert.deepEqual(days.get('2026-03-07'), {
    demoSeconds: 0,
    demoMatches: 0,
    trainSeconds: 0,
    trainRuns: 2
  });
});

// ---- shading -----------------------------------------------------------------

test('empty days never darken the scale', () => {
  // Thresholds come from active days only. Counting the zeros would drag every
  // real session into the top band on a mostly idle calendar.
  const withZeros = levelThresholds([0, 0, 0, 0, 10, 20, 30, 40]);
  const without = levelThresholds([10, 20, 30, 40]);
  assert.deepEqual(withZeros, without);
});

test('a day with nothing is level zero, and any activity is at least one', () => {
  const t = levelThresholds([100, 200, 300, 400]);
  assert.equal(levelFor(0, t), 0);
  assert.equal(levelFor(-5, t), 0);
  assert.equal(levelFor(1, t), 1, 'one second of activity still shows');
  assert.equal(levelFor(99999, t), LEVELS, 'and the scale tops out');
});

test('shading spreads across the bands rather than bunching', () => {
  const values = Array.from({ length: 40 }, (_, i) => (i + 1) * 60);
  const t = levelThresholds(values);
  const seen = new Set(values.map((v) => levelFor(v, t)));
  assert.ok(seen.size >= 3, `expected several bands, saw ${[...seen].join(',')}`);
});

test('one huge session does not flatten every ordinary day', () => {
  // Quantiles, not a max-relative scale: the outlier takes the top band and
  // leaves the rest spread out.
  const values = [...Array(20).fill(600), 100000];
  const t = levelThresholds(values);
  assert.equal(levelFor(100000, t), LEVELS);
  assert.ok(levelFor(600, t) >= 1, 'ordinary days stay visible');
});

test('an all-identical history still produces usable levels', () => {
  const t = levelThresholds(Array(30).fill(600));
  assert.ok(levelFor(600, t) >= 1, 'and does not vanish');
  assert.deepEqual(levelThresholds([]), [], 'no activity, no thresholds');
});

// ---- the grid ----------------------------------------------------------------

test('every column is a whole week and rows are Monday first', () => {
  const cal = buildCalendar({ days: new Map(), window: 90, today: at(2026, 3, 7) });
  assert.equal(WEEKDAYS[0], 'Mon');
  for (const week of cal.weeks.slice(0, -1)) {
    assert.equal(week.length, 7, 'a full column');
  }
  assert.equal(cal.weeks[0][0].date.getDay(), 1, 'the grid opens on a Monday');
});

test('the window ends today and covers the days asked for', () => {
  const today = at(2026, 3, 7);
  const cal = buildCalendar({ days: new Map(), window: 90, today });
  const cells = cal.weeks.flat();
  assert.equal(dayKey(cells[cells.length - 1].date.getTime()), dayKey(today), 'last cell is today');
  assert.ok(cells.length >= 90, `covers the window, got ${cells.length}`);
  assert.ok(cells.length <= 96, 'and does not overshoot by more than the Monday alignment');
});

test('no day is duplicated or skipped', () => {
  const cal = buildCalendar({ days: new Map(), window: 90, today: at(2026, 3, 7) });
  const keys = cal.weeks.flat().map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicates');
  for (let i = 1; i < keys.length; i++) {
    const gap = dayStart(keys[i]) - dayStart(keys[i - 1]);
    assert.ok(gap > 0 && gap <= 25 * 3600 * 1000, `consecutive days at ${keys[i]}`);
  }
});

test('a calendar spanning a DST change keeps one cell per day', () => {
  // Europe springs forward late March; the window below crosses it. Building
  // cells by adding 24h in ms would slide and eventually drop a day.
  const cal = buildCalendar({ days: new Map(), window: 90, today: at(2026, 5, 1) });
  const keys = cal.weeks.flat().map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('totals and shading read the metric they were asked for', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { demoSeconds: 3600, demoMatches: 2 });
  addToDay(days, at(2026, 3, 6), { trainSeconds: 1800, trainRuns: 12 });
  const today = at(2026, 3, 7);

  const total = buildCalendar({ days, window: 30, today });
  assert.equal(total.totals.demoSeconds, 3600);
  assert.equal(total.totals.trainSeconds, 1800);
  assert.equal(total.totals.demoMatches, 2);
  assert.equal(total.totals.trainRuns, 12);
  assert.equal(total.totals.activeDays, 2);

  const demoOnly = buildCalendar({ days, window: 30, today, metric: 'demo' });
  const trainDay = demoOnly.weeks.flat().find((c) => c.key === '2026-03-06');
  assert.equal(trainDay.level, 0, 'a trainer-only day is blank on the demo metric');
  const demoDay = demoOnly.weeks.flat().find((c) => c.key === '2026-03-05');
  assert.ok(demoDay.level >= 1, 'and the demo day shows');
});

test('month labels appear once, in order, over the right columns', () => {
  const cal = buildCalendar({ days: new Map(), window: 90, today: at(2026, 3, 7) });
  const labels = cal.months.map((m) => m.label);
  assert.equal(new Set(labels).size, labels.length, 'no month labelled twice');
  const cols = cal.months.map((m) => m.column);
  assert.deepEqual(cols, [...cols].sort((a, b) => a - b), 'left to right');
  for (const m of cal.months) {
    assert.equal(cal.weeks[m.column][0].date.getMonth(), MONTH_INDEX[m.label]);
  }
});

const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

// ---- copy --------------------------------------------------------------------

test('durations read the way a person would say them', () => {
  assert.equal(formatDuration(0), 'none');
  assert.equal(formatDuration(-10), 'none');
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(35 * 60), '35 min');
  assert.equal(formatDuration(3600), '1 h');
  assert.equal(formatDuration(2 * 3600 + 40 * 60), '2 h 40 min');
});

test('a cell title never merges the two sources', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { demoSeconds: 3600, demoMatches: 2, trainSeconds: 600, trainRuns: 4 });
  const cal = buildCalendar({ days, window: 30, today: at(2026, 3, 7) });
  const cell = cal.weeks.flat().find((c) => c.key === '2026-03-05');
  const title = cellTitle(cell);
  assert.match(title, /in demos/);
  assert.match(title, /in the trainer/);
  assert.match(title, /2 matches/);
  assert.match(title, /4 runs/);

  const empty = cal.weeks.flat().find((c) => c.value === 0);
  assert.match(cellTitle(empty), /no activity/);
});

test('no copy in the calendar uses an em dash', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { demoSeconds: 60, demoMatches: 1 });
  const cal = buildCalendar({ days, window: 30, today: at(2026, 3, 7) });
  for (const cell of cal.weeks.flat()) {
    assert.ok(!cellTitle(cell).includes('—'));
  }
});

test('a single-source calendar never quotes the other source', () => {
  // The reason the two grids exist: a demo square that mentioned trainer
  // minutes would put the reader back to guessing which half a shade meant.
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { demoSeconds: 3600, demoMatches: 2, trainSeconds: 600, trainRuns: 4 });
  const cal = buildCalendar({ days, window: 30, today: at(2026, 3, 7) });
  const cell = cal.weeks.flat().find((c) => c.key === '2026-03-05');

  const demo = cellTitle(cell, 'demo');
  assert.match(demo, /2 matches/);
  assert.ok(!demo.includes('trainer'), 'the demo grid stays about demos');

  const train = cellTitle(cell, 'train');
  assert.match(train, /4 runs/);
  assert.ok(!train.includes('in demos'), 'and the trainer grid about the trainer');
});

test('a day active only in the other source reads as empty here', () => {
  const days = new Map();
  addToDay(days, at(2026, 3, 5), { trainSeconds: 600, trainRuns: 4 });
  const cal = buildCalendar({ days, window: 30, today: at(2026, 3, 7), metric: 'demo' });
  const cell = cal.weeks.flat().find((c) => c.key === '2026-03-05');
  assert.equal(cell.level, 0, 'no demo activity, no shade');
  assert.match(cellTitle(cell, 'demo'), /no activity/, 'and the title agrees with the shade');
});
