// ---------------------------------------------------------------------------
// replays/shared/aimCalibration.test.js
//   node --test src/replays/shared/aimCalibration.test.js
//
// The three anchors and what they score. This is the file that decides whether
// a rating means anything: get it wrong in the generous direction and every
// competent player reads 100, which is exactly the failure it was written to
// replace.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BELL_HIGH_Q,
  BELL_LOW_Q,
  MIN_POPULATION,
  anchorsFrom,
  calibrate,
  quantile,
  ratingFor,
  ratingFromUnit,
  scoreFor,
  scoreFromUnit,
  unitPosition
} from './aimCalibration.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- the three anchors score exactly what they promise -----------------------

test('the anchors land on 0.10, 1.00 and 2.00', () => {
  const a = { bad: 10, mid: 30, good: 50 };
  assert.ok(near(ratingFor(10, a), 0.1), 'the 3rd percentile is 0.10');
  assert.ok(near(ratingFor(30, a), 1), 'the average is 1.00');
  assert.ok(near(ratingFor(50, a), 2), 'the 97th percentile is 2.00');
});

test('the same anchors land on 0, 50 and 100 as a score', () => {
  const a = { bad: 10, mid: 30, good: 50 };
  assert.ok(near(scoreFor(10, a), 0));
  assert.ok(near(scoreFor(30, a), 50));
  assert.ok(near(scoreFor(50, a), 100));
});

test('a lower-is-better statistic reads the same way', () => {
  // Reaction time: faster is better, so `good` is the smaller number and no
  // invert flag exists to get out of step with it.
  const reaction = { bad: 380, mid: 265, good: 180 };
  assert.ok(near(ratingFor(180, reaction), 2), 'fast is 2.00');
  assert.ok(near(ratingFor(265, reaction), 1), 'typical is 1.00');
  assert.ok(near(ratingFor(380, reaction), 0.1), 'slow is 0.10');
  assert.ok(ratingFor(220, reaction) > 1, 'better than average scores above 1');
  assert.ok(ratingFor(300, reaction) < 1, 'worse than average scores below 1');
});

test('the two sides have their own slopes', () => {
  // The reason there are three anchors and not two: this distribution has a
  // long bad tail and a short good one. Ten units better than average is worth
  // much more than ten units worse costs.
  const skewed = { bad: 0, mid: 80, good: 100 };
  const better = ratingFor(90, skewed);
  const worse = ratingFor(70, skewed);
  assert.ok(near(better, 1.5), '10 above average is halfway to the top');
  assert.ok(worse > 0.85, `10 below average is a small loss, got ${worse}`);
});

test('past the anchors the scale stops rather than running away', () => {
  const a = { bad: 10, mid: 30, good: 50 };
  assert.ok(near(ratingFor(9999, a), 2), 'clamped at the top');
  assert.ok(near(ratingFor(-9999, a), 0.1), 'clamped at the bottom');
  assert.equal(scoreFor(9999, a), 100);
  assert.equal(scoreFor(-9999, a), 0);
});

test('an unusable anchor set scores nothing rather than average', () => {
  // Reading as 0.5 would quietly rate every player as exactly typical.
  assert.equal(unitPosition(5, { bad: 10, mid: 10, good: 50 }), null, 'no width below');
  assert.equal(unitPosition(5, { bad: 10, mid: 30, good: 30 }), null, 'no width above');
  assert.equal(unitPosition(5, { bad: 10, mid: 30, good: 20 }), null, 'not monotonic');
  assert.equal(unitPosition(NaN, { bad: 10, mid: 30, good: 50 }), null);
  assert.equal(unitPosition(5, null), null);
  assert.equal(ratingFromUnit(null), null);
  assert.equal(scoreFromUnit(undefined), null);
});

// ---- deriving anchors from a population -------------------------------------

test('anchors come off the 3rd, 50th and 97th percentiles', () => {
  // 0..99, so the quantiles are readable by eye.
  const values = Array.from({ length: 100 }, (_, i) => i);
  const a = anchorsFrom(values, true);
  assert.ok(near(a.bad, quantile(values, BELL_LOW_Q)), 'bad is the low tail');
  assert.ok(near(a.good, quantile(values, BELL_HIGH_Q)), 'good is the high tail');
  assert.ok(near(a.mid, 49.5), 'mid is the median');
  assert.equal(a.n, 100);
});

test('direction decides which tail is good', () => {
  const values = Array.from({ length: 100 }, (_, i) => i);
  const higher = anchorsFrom(values, true);
  const lower = anchorsFrom(values, false);
  assert.ok(higher.good > higher.bad);
  assert.ok(lower.good < lower.bad, 'lower-is-better flips the tails');
  assert.equal(higher.mid, lower.mid, 'the middle does not move');
});

test('the centre is the median, not the mean', () => {
  // A long right tail: ninety players spread 0-89, ten outliers at 1000. The
  // median is 49.5 and the mean is 140. Anchoring on the mean would score most
  // of the library below average, which is a scale that reads as an insult
  // rather than as a measurement.
  const values = [...Array.from({ length: 90 }, (_, i) => i), ...Array(10).fill(1000)];
  const mean = values.reduce((n, v) => n + v, 0) / values.length;
  const a = anchorsFrom(values, true);
  assert.ok(near(a.mid, 49.5), `the typical player is the middle of the pack, got ${a.mid}`);
  assert.ok(mean > 130, 'and the mean really is far away from it');
});

test('too small a population does not get to define the scale', () => {
  const small = Array.from({ length: MIN_POPULATION - 1 }, (_, i) => i);
  assert.equal(anchorsFrom(small, true), null);
  const enough = Array.from({ length: MIN_POPULATION }, (_, i) => i);
  assert.ok(anchorsFrom(enough, true), 'and at the threshold it does');
});

test('a collapsed distribution is refused', () => {
  // Everybody identical: there is no scale to build, and pretending otherwise
  // would put the whole library at one extreme on a rounding error.
  const flat = Array(200).fill(42);
  assert.equal(anchorsFrom(flat, true), null);
});

test('nulls and junk are ignored, not counted', () => {
  const values = [
    ...Array.from({ length: 100 }, (_, i) => i),
    ...Array(50).fill(null),
    ...Array(50).fill(NaN)
  ];
  const a = anchorsFrom(values, true);
  assert.equal(a.n, 100, 'only the real values are population');
});

// ---- calibrating a whole set ------------------------------------------------

test('calibrate keeps the old anchors where there is not enough population', () => {
  const population = Array.from({ length: 100 }, (_, i) => ({
    good: i,
    thin: i < 5 ? i : null
  }));
  const fallback = { thin: { bad: 1, mid: 2, good: 3 } };
  const out = calibrate(population, { good: true, thin: true }, fallback);
  assert.ok(out.anchors.good.n === 100, 'the well-sampled one is recalibrated');
  assert.deepEqual(out.anchors.thin, fallback.thin, 'the thin one keeps its old anchors');
  assert.deepEqual(out.skipped, ['thin']);
  assert.equal(out.n, 100);
});

test('a real-shaped population puts the middle player at 1.00', () => {
  // The property that matters after all of this: whatever the distribution,
  // the median player scores 1.00 and half the library is above them.
  const values = Array.from({ length: 500 }, (_, i) => Math.sqrt(i) * 3 + 40);
  const a = anchorsFrom(values, true);
  const ratings = values.map((v) => ratingFor(v, a));
  const above = ratings.filter((r) => r > 1).length;
  const below = ratings.filter((r) => r < 1).length;
  assert.ok(Math.abs(above - below) <= 2, `split evenly, got ${above} above / ${below} below`);
  const top = ratings.filter((r) => r >= 2).length;
  assert.ok(top >= 10 && top <= 25, `about 3% reach 2.00, got ${top} of 500`);
});
