// ---------------------------------------------------------------------------
// shared/sim/beliefCal.js
// Belief calibration: when the filter says P(k on A) = 0.2, is that true
// two times in ten?
//
// SIM-PLAN 19.2 / 19.12 / 9.8.8. Gate 9.8.8 asked for KL against the truth.
// The joint filter's more important number is calibration: a generation that
// wins while believing nonsense is winning by exploiting the engine, and KL
// alone will not catch a filter that is sharp and systematically wrong.
//
// Reliability diagrams and a Brier score per `countDist`, plus a dedicated
// number for the `pEmpty(site)` call, because that is the read a round gets
// bet on. Nothing here reads engine truth on its own: the caller hands in
// (predicted distribution, true count) pairs collected wherever the honesty
// seam already lives (5.4).
//
// Pure. No I/O, no rng. The same pairs always produce the same scores.
// ---------------------------------------------------------------------------

/** Bins for the reliability diagram. Ten is the usual ECE width. `[calibrate]` */
export const ECE_BINS = 10;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * Brier score of a count distribution against a true integer count 0..5.
 * Lower is better; a Dirac on the truth is 0; a uniform over 0..5 is ~0.69.
 *
 * @param {number[]} dist  length 6, sums to 1
 * @param {number} truth   integer 0..5
 */
export function brierCount(dist, truth) {
  const t = Math.max(0, Math.min(5, Math.round(Number(truth) || 0)));
  let s = 0;
  for (let k = 0; k <= 5; k += 1) {
    const p = clamp01(dist?.[k] ?? 0);
    const y = k === t ? 1 : 0;
    s += (p - y) * (p - y);
  }
  return s;
}

/** Brier of a single probability against a binary outcome. */
export function brierBinary(p, happened) {
  const y = happened ? 1 : 0;
  const q = clamp01(p);
  return (q - y) * (q - y);
}

/**
 * Expected calibration error for a binary probability.
 * Reliability diagram: bin by predicted p, compare to empirical frequency.
 *
 * @param {Array<{p:number, y:boolean|number}>} rows
 * @param {number} [bins]
 */
export function eceBinary(rows, bins = ECE_BINS) {
  if (!rows?.length) return { ece: 0, bins: [], n: 0 };
  const nBins = Math.max(1, bins | 0);
  const acc = Array.from({ length: nBins }, () => ({ n: 0, pSum: 0, ySum: 0 }));
  for (const r of rows) {
    const p = clamp01(r.p);
    const y = r.y ? 1 : 0;
    const i = Math.min(nBins - 1, Math.floor(p * nBins));
    acc[i].n += 1;
    acc[i].pSum += p;
    acc[i].ySum += y;
  }
  let ece = 0;
  const n = rows.length;
  const outBins = acc.map((b, i) => {
    const pHat = b.n ? b.pSum / b.n : (i + 0.5) / nBins;
    const freq = b.n ? b.ySum / b.n : 0;
    if (b.n) ece += (b.n / n) * Math.abs(pHat - freq);
    return { lo: i / nBins, hi: (i + 1) / nBins, n: b.n, pHat, freq };
  });
  return { ece, bins: outBins, n };
}

/**
 * Summarize a stream of (countDist, trueCount) observations for one zone.
 *
 * @param {Array<{dist:number[], truth:number, pEmpty?:number}>} rows
 */
export function calibrateCount(rows = []) {
  if (!rows.length) {
    return { n: 0, brier: 0, pEmptyBrier: 0, pEmptyEce: 0, reliability: [] };
  }
  let brier = 0;
  const emptyRows = [];
  for (const r of rows) {
    brier += brierCount(r.dist, r.truth);
    const pEmpty = r.pEmpty ?? r.dist?.[0] ?? 0;
    emptyRows.push({ p: pEmpty, y: (r.truth | 0) === 0 });
  }
  const empty = eceBinary(emptyRows);
  return {
    n: rows.length,
    brier: brier / rows.length,
    pEmptyBrier: emptyRows.reduce((s, r) => s + brierBinary(r.p, r.y), 0) / rows.length,
    pEmptyEce: empty.ece,
    reliability: empty.bins
  };
}

/**
 * Does this calibrated filter beat a flow-prior baseline on Brier?
 * The gate is a stated margin, not a vibe. `[calibrate the margin]`
 */
export const BRIER_MARGIN = 0.02;

export function beatsBaseline(candidate, baseline, margin = BRIER_MARGIN) {
  if (!candidate?.n || !baseline?.n) return { pass: false, reason: 'no samples' };
  const delta = baseline.brier - candidate.brier;
  return {
    pass: delta >= margin,
    delta,
    reason: delta >= margin
      ? `Brier ${candidate.brier.toFixed(3)} beats prior ${baseline.brier.toFixed(3)} by ${delta.toFixed(3)}`
      : `Brier ${candidate.brier.toFixed(3)} vs prior ${baseline.brier.toFixed(3)} (need ${margin})`
  };
}
