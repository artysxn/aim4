// ---------------------------------------------------------------------------
// lib/coachHistory.test.js
//   node --test src/lib/coachHistory.test.js
//
// The coach's memory: what counts as a regression, what gets remembered, and
// that every mechanic the coach can flag actually has a note to show. A
// regression callout with no note behind it would be a nag without advice,
// which is worse than silence.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

const {
  REGRESSION_EPSILON,
  coachRegressions,
  coachRunsFor,
  coachSeries,
  mechanicRatings,
  recordCoachRun,
  regressionsIn
} = await import('./coachHistory.js');
const { COACH_NOTES, coachNoteFor, encouragementLine } = await import('./coachNotes.js');
const { MECHANIC_KEYS } = await import('./routines.js');

// ---- vocabulary --------------------------------------------------------------

test('trainer-keyed ratings translate to mechanic keys', () => {
  const r = mechanicRatings({
    precision_accuracy_percent: 0.9,
    flicks_hit_percent: 1.2,
    reaction_time_ms: 1.1,
    tension_percent: 0.7,
    tracking: 1.0,
    nonsense: NaN
  });
  assert.deepEqual(r, { precision: 0.9, flicks: 1.2, reaction: 1.1, tension: 0.7, tracking: 1.0 });
});

test('already-mechanic keys pass through unchanged', () => {
  assert.deepEqual(mechanicRatings({ precision: 1.5 }), { precision: 1.5 });
});

// ---- regressions -------------------------------------------------------------

const run = (r) => ({ at: 0, r });

test('a real drop on the last run is a regression, a tiny one is noise', () => {
  const runs = [run({ tracking: 1.0, tension: 1.0 }), run({ tracking: 0.8, tension: 0.98 })];
  const out = regressionsIn(runs);
  assert.equal(out.length, 1, 'only the real drop is flagged');
  assert.equal(out[0].mechanic, 'tracking');
  assert.equal(out[0].prev, 1.0);
  assert.equal(out[0].last, 0.8);
});

test('one run has nothing to regress from', () => {
  assert.deepEqual(regressionsIn([run({ tracking: 0.1 })]), []);
  assert.deepEqual(regressionsIn([]), []);
  assert.deepEqual(regressionsIn(null), []);
});

test('only the last two runs are compared, not the whole history', () => {
  // A recovery must read as a recovery: terrible three runs ago, better last
  // run than the one before, no nag.
  const runs = [run({ flicks: 1.5 }), run({ flicks: 0.5 }), run({ flicks: 0.9 })];
  assert.deepEqual(regressionsIn(runs), []);
});

test('targeted mechanics restrict what the coach comments on', () => {
  const runs = [run({ tracking: 1.0, speed: 1.0 }), run({ tracking: 0.7, speed: 0.7 })];
  const out = regressionsIn(runs, ['speed']);
  assert.equal(out.length, 1);
  assert.equal(out[0].mechanic, 'speed', 'the untargeted drop is not the routine\'s business');
});

test('biggest drop first, and unmeasured mechanics stay out of it', () => {
  const runs = [
    run({ tracking: 1.0, tension: 1.4, precision: 1.0 }),
    run({ tracking: 0.9, tension: 0.9 }) // precision unmeasured this run
  ];
  const out = regressionsIn(runs);
  assert.deepEqual(
    out.map((o) => o.mechanic),
    ['tension', 'tracking'],
    'sorted by size of the drop; precision (no measurement) is not a drop'
  );
  assert.ok(REGRESSION_EPSILON > 0 && REGRESSION_EPSILON < 0.1, 'epsilon stays a nudge');
});

// ---- storage -----------------------------------------------------------------

test('runs are remembered per mode, translated, and bounded', () => {
  store.clear();
  assert.equal(recordCoachRun('gridshot', { flicks_hit_percent: 1.1 }), 1);
  recordCoachRun('gridshot', { flicks_hit_percent: 0.9 });
  assert.equal(coachRunsFor('gridshot').length, 2);
  assert.equal(coachRunsFor('tracking').length, 0, 'modes do not share history');

  const reg = coachRegressions('gridshot');
  assert.equal(reg.length, 1);
  assert.equal(reg[0].mechanic, 'flicks');

  for (let i = 0; i < 40; i++) recordCoachRun('gridshot', { flicks: 1 });
  assert.ok(coachRunsFor('gridshot').length <= 20, 'history is bounded');
});

test('an empty or junk rating set records nothing', () => {
  store.clear();
  assert.equal(recordCoachRun('gridshot', {}), 0);
  assert.equal(recordCoachRun('gridshot', { flicks: NaN }), 0);
  assert.equal(recordCoachRun('', { flicks: 1 }), 0);
  assert.equal(coachRunsFor('gridshot').length, 0);
});

test('a series is that mechanic over recent runs, oldest first', () => {
  store.clear();
  for (const v of [0.5, 0.7, 0.6, 0.9]) recordCoachRun('gridshot', { tracking: v });
  assert.deepEqual(coachSeries('gridshot', 'tracking'), [0.5, 0.7, 0.6, 0.9]);
  assert.deepEqual(coachSeries('gridshot', 'speed'), [], 'unmeasured mechanic, empty series');
  assert.equal(coachSeries('gridshot', 'tracking', 2).length, 2, 'n bounds the tail');
});

test('corrupted storage is an empty history, not a crash', () => {
  store.set('aimtrainer:coachHistory', 'not json');
  assert.deepEqual(coachRunsFor('gridshot'), []);
  assert.equal(recordCoachRun('gridshot', { flicks: 1 }), 1, 'and recording recovers it');
});

// ---- the notes ---------------------------------------------------------------

test('every mechanic the coach can flag has a note behind it', () => {
  for (const key of MECHANIC_KEYS) {
    const note = coachNoteFor(key);
    assert.ok(note, `${key} has no coach note`);
    assert.ok(note.title, `${key} note has no title`);
    assert.ok(note.short?.length > 20, `${key} short tip is too thin to help`);
    assert.ok(Array.isArray(note.full) && note.full.length >= 2, `${key} full note is not expanded`);
  }
});

test('no note uses an em dash, per the site copy rules', () => {
  for (const [key, note] of Object.entries(COACH_NOTES)) {
    const text = [note.title, note.short, ...note.full].join(' ');
    assert.ok(!text.includes('—'), `${key} note contains an em dash`);
  }
  assert.ok(!encouragementLine(0).includes('—'));
});

test('encouragement rotates and never runs out', () => {
  const lines = new Set([0, 1, 2, 3, 4, 5].map(encouragementLine));
  assert.ok(lines.size >= 3, 'several distinct lines');
  assert.ok(encouragementLine(-7), 'negative seeds still answer');
  assert.ok(encouragementLine(NaN), 'junk seeds still answer');
});
