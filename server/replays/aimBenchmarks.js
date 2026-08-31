// ---------------------------------------------------------------------------
// server/replays/aimBenchmarks.js
// What an average player actually looks like, measured from the library.
//
// The aim scale is anchored on three points per statistic: the 3rd percentile,
// the median, and the 97th (see src/replays/shared/aimCalibration.js). This is
// where those numbers come from.
//
// It is a CHEAP operation and deliberately so. Every demo has already been
// parsed and indexed, and the hot store already holds every player's counters
// packed in memory; this aggregates them once with no filter and takes six
// quantiles per statistic. Nothing is reparsed, no round file is reopened, and
// on a four-thousand-demo library it is one pass over an array that the
// Database aggregates on every keystroke anyway. That is why there is no
// button: a job that costs about as much as one page load does not need a
// person to decide when to run it.
//
// The result is cached against the hot store's identity, so it is computed
// once per library build and then read.
// ---------------------------------------------------------------------------

import {
  AIM_BENCH,
  AIM_MIN_SAMPLE,
  AIM_V2_MIN_SAMPLE,
  calibrateBenchmarks
} from '../../src/replays/shared/aimMetrics.js';
import { aggregateHot } from './statsHotAggregate.js';

/**
 * Rounds a player needs before any of their numbers count toward the scale.
 *
 * On top of the per-statistic sample gates below, not instead of them. A player
 * with one round can clear the first-bullet gate on a single lucky burst, and a
 * scale built from thousands of such players would describe a population that
 * does not exist.
 */
export const MIN_ROUNDS = 30;

/** Sample floor per statistic, the same gates the rating itself scores on. */
const MIN_SAMPLE = Object.freeze({ ...AIM_MIN_SAMPLE, ...AIM_V2_MIN_SAMPLE });

/**
 * One player's contribution to the population.
 *
 * A statistic is included only where that player has enough of it to be scored
 * on. This is the difference between measuring the library and measuring its
 * noise: `aimRaw` carries a value whenever the denominator was above zero, so
 * a player with three flicks has a precision number, and three flicks worth of
 * precision has no business helping to define what the 3rd percentile is.
 */
export function contribution(row) {
  if (!row || (row.rounds || 0) < MIN_ROUNDS) return null;
  const raw = row.aimRaw || {};
  const sample = row.aimSample || {};
  const out = {};
  let any = false;
  for (const key of Object.keys(AIM_BENCH)) {
    const value = raw[key];
    if (!Number.isFinite(value)) continue;
    if ((sample[key] || 0) < (MIN_SAMPLE[key] || 0)) continue;
    out[key] = value;
    any = true;
  }
  return any ? out : null;
}

/**
 * Measure the benchmarks from every player in one library.
 *
 * @param {object} store  a hot store
 * @returns {{anchors: object, skipped: string[], n: number, players: number}}
 */
export function benchmarksFromStore(store) {
  // No filter and no visibility mask: the scale is a property of the whole
  // library, not of whatever the current viewer can see. Two people looking at
  // the same demo must read the same rating, which cannot happen if the
  // population depends on who is asking.
  const rows = aggregateHot(store, {}, null) || [];
  const population = [];
  for (const row of rows) {
    const c = contribution(row);
    if (c) population.push(c);
  }
  const result = calibrateBenchmarks(population);
  return { ...result, players: rows.length };
}

// ---- cache ------------------------------------------------------------------

/** @type {Map<string, {store: object, value: object}>} */
const cache = new Map();

/**
 * Benchmarks for this store, computed once per build.
 *
 * Keyed on the store OBJECT, not on the library name: a rebuilt store is a new
 * object and gets new benchmarks, which is exactly the invalidation wanted. A
 * rescan that changes what the numbers are therefore changes the scale as soon
 * as the store carrying it is swapped in.
 */
export function benchmarksFor(user, store) {
  if (!store) return { anchors: AIM_BENCH, skipped: [], n: 0, players: 0 };
  const key = String(user || '');
  const hit = cache.get(key);
  if (hit && hit.store === store) return hit.value;

  const started = Date.now();
  const value = benchmarksFromStore(store);
  cache.set(key, { store, value });
  console.log(
    `[aim] benchmarks measured from ${value.n} players of ${value.players} ` +
      `in ${Date.now() - started} ms` +
      (value.skipped.length ? `, kept defaults for ${value.skipped.join(', ')}` : '')
  );
  return value;
}

/** Drop the cached scale, so the next request measures it again. */
export function forgetBenchmarks(user = null) {
  if (user == null) cache.clear();
  else cache.delete(String(user));
}
