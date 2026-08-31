// ---------------------------------------------------------------------------
// replays/shared/aimCalibration.js
// What a number means, relative to everybody else who plays.
//
// Every aim statistic used to be scored against a hand-picked pair of anchors
// ("88% closeness is a 1.00", "0.42 accuracy is the best score"). Those were
// guesses made before there was a library to measure, and the library has since
// disagreed with all of them: real crosshair placement came in at 13°, against
// an anchor whose BEST was 15°, so every competent player scored 100 and the
// column stopped separating anybody. Half the outcome scores on the page were
// a flat 100 and the motion ratings were bunched near the floor.
//
// So the anchors are no longer picked. Each statistic is described by three
// numbers taken from the population itself:
//
//   bad   the 3rd percentile of that statistic      scores 0.10 / 0
//   mid   the average                               scores 1.00 / 50
//   good  the 97th percentile                       scores 2.00 / 100
//
// and a value is placed on the line between them. Three points rather than two
// because these distributions are not symmetric: reaction time has a long slow
// tail and almost no fast one, so a single centre-and-spread would put the
// average in the wrong place on one side or the other. Two independent slopes
// meeting at the average cost one extra number and remove that whole class of
// error.
//
// The 3rd and 97th percentiles are ±1.88σ on a normal distribution, which is
// where the "bell curve" in the specification comes from: the anchors are the
// tails, the average is the peak, and the scale between them is even.
// Percentiles rather than a computed σ on purpose, because one parsed demo with
// a broken tick buffer can move a standard deviation and cannot move a
// percentile.
// ---------------------------------------------------------------------------

/** The tails. 3% either end, so 94% of players land between the anchors. */
export const BELL_LOW_Q = 0.03;
export const BELL_HIGH_Q = 0.97;

/**
 * What the anchors score.
 *
 * The bottom is 0.10 rather than 0 so the scale keeps somewhere to put a player
 * who is genuinely below the 3rd percentile. A floor of exactly zero would make
 * "bottom 3%" and "worst measurable" the same reading.
 */
export const BELL_RATING = Object.freeze({ bad: 0.1, mid: 1, good: 2 });
/** The same three points on the 0-100 outcome scale. */
export const BELL_SCORE = Object.freeze({ bad: 0, mid: 50, good: 100 });

/**
 * Where a value sits between the anchors, as 0 (bad) → 0.5 (average) → 1 (good).
 *
 * Direction is carried by the anchors rather than by a flag: for a
 * lower-is-better statistic `good` is simply the smaller number, and the sign
 * of (good − mid) is what tells the two apart. That removes the failure where
 * an anchor set and its invert flag disagree.
 *
 * Returns null when the anchors cannot describe a scale, rather than a middling
 * 0.5 — an unusable anchor set must not read as an average player.
 *
 * @param {number} value
 * @param {{bad: number, mid: number, good: number}} anchors
 * @returns {number|null} 0..1, or null
 */
export function unitPosition(value, anchors) {
  const v = Number(value);
  if (!Number.isFinite(v) || !anchors) return null;
  const { bad, mid, good } = anchors;
  if (![bad, mid, good].every(Number.isFinite)) return null;

  const goodSpan = good - mid;
  const badSpan = mid - bad;
  // Both sides have to have width and point the same way, or the three points
  // are not a monotonic scale and nothing sensible can be read off them.
  if (goodSpan === 0 || badSpan === 0) return null;
  if (Math.sign(goodSpan) !== Math.sign(badSpan)) return null;

  const above = (v - mid) / goodSpan;
  // Positive `above` means better than average, whichever direction better is.
  const u = above >= 0 ? 0.5 + 0.5 * above : 0.5 - 0.5 * ((mid - v) / badSpan);
  return Math.max(0, Math.min(1, u));
}

/** Unit position → the 0.00-2.00 motion rating. Average is 1.00. */
export function ratingFromUnit(u) {
  if (!Number.isFinite(u)) return null;
  const { bad, mid, good } = BELL_RATING;
  return u >= 0.5 ? mid + (u - 0.5) * 2 * (good - mid) : mid - (0.5 - u) * 2 * (mid - bad);
}

/** Unit position → the 0-100 outcome score. Average is 50. */
export function scoreFromUnit(u) {
  if (!Number.isFinite(u)) return null;
  const { bad, mid, good } = BELL_SCORE;
  return u >= 0.5 ? mid + (u - 0.5) * 2 * (good - mid) : mid - (0.5 - u) * 2 * (mid - bad);
}

/** Convenience: raw value straight to a 0.00-2.00 rating. */
export function ratingFor(value, anchors) {
  const u = unitPosition(value, anchors);
  return u == null ? null : ratingFromUnit(u);
}

/** Convenience: raw value straight to a 0-100 score. */
export function scoreFor(value, anchors) {
  const u = unitPosition(value, anchors);
  return u == null ? null : scoreFromUnit(u);
}

// ---------------------------------------------------------------------------
// Deriving the anchors from a population
// ---------------------------------------------------------------------------

/** Linear-interpolated quantile of a SORTED array. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * How many players a statistic needs before its anchors are believable.
 *
 * A 3rd percentile taken from thirty players is one player's bad night, and it
 * would then define the bottom of the scale for everybody.
 */
export const MIN_POPULATION = 60;

/**
 * Three anchors for one statistic, from every observed value of it.
 *
 * `higherIsBetter` decides which tail is `good`; it is the only place direction
 * is named, and everything downstream reads it off the anchors instead.
 *
 * The centre is the MEDIAN, not the arithmetic mean. "Average" in the
 * specification means the typical player, and these distributions are skewed
 * enough (reaction time, adjustments per kill) that the mean sits noticeably
 * above the middle of the pack. Using the mean would score more than half the
 * library below 1.00 and make the scale read as an insult.
 *
 * @param {number[]} values every player's value for this statistic
 * @param {boolean} higherIsBetter
 * @returns {{bad: number, mid: number, good: number, n: number}|null}
 */
export function anchorsFrom(values, higherIsBetter) {
  const sorted = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length < MIN_POPULATION) return null;

  const lo = quantile(sorted, BELL_LOW_Q);
  const mid = quantile(sorted, 0.5);
  const hi = quantile(sorted, BELL_HIGH_Q);
  const good = higherIsBetter ? hi : lo;
  const bad = higherIsBetter ? lo : hi;

  // A statistic where the tails have collapsed onto the middle cannot be
  // scored: every player would be exactly average, or a rounding error away
  // from the top. Better to keep the previous anchors than to publish these.
  if (!(Math.abs(good - mid) > 0) || !(Math.abs(mid - bad) > 0)) return null;

  return { bad: round4(bad), mid: round4(mid), good: round4(good), n: sorted.length };
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * Anchors for a whole set of statistics at once.
 *
 * @param {Array<Record<string, number|null>>} population one entry per player
 * @param {Record<string, boolean>} directions key → higherIsBetter
 * @param {Record<string, object>} [fallback] anchors to keep where there is
 *   not enough population to replace them
 * @returns {{anchors: Record<string, object>, skipped: string[], n: number}}
 */
export function calibrate(population, directions, fallback = {}) {
  const rows = population || [];
  const anchors = {};
  const skipped = [];
  for (const [key, higherIsBetter] of Object.entries(directions || {})) {
    const found = anchorsFrom(
      rows.map((p) => p?.[key]),
      higherIsBetter
    );
    if (found) {
      anchors[key] = found;
    } else {
      // Kept rather than dropped: a statistic with too little population still
      // has to score, and the previous anchors are a better guess than none.
      if (fallback[key]) anchors[key] = fallback[key];
      skipped.push(key);
    }
  }
  return { anchors, skipped, n: rows.length };
}
