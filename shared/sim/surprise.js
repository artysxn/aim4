// ---------------------------------------------------------------------------
// shared/sim/surprise.js
// Texture gates: KS against a baseline, and the two-sided surprise band.
//
// SIM-PLAN 9.8.3 (human-likeness KS) and 9.8.6 (surprise band). Too tidy
// fails; too chaotic fails. The band is about TEXTURE, not about which calls
// a generation prefers: off-angle rate, smoke-cross rate, dry-entry rate,
// first-contact-spot entropy, pfw of fights taken.
//
// When the demo library is not on this host the caller passes a sim-derived
// baseline (the BC anchor's own histogram from the same harness) and the
// report says so. A missing library is not a pass.
//
// Pure. Histograms in, numbers out.
// ---------------------------------------------------------------------------

/** KS critical value at n,n for a rough 5% two-sample check. `[calibrate]` */
export const KS_ALPHA = 1.36;

/**
 * Two-sample Kolmogorov-Smirnov statistic on two empirical samples.
 * Returns D in [0, 1] and a pass/fail against the asymptotic 5% line.
 */
export function ksDistance(a = [], b = []) {
  const x = a.filter(Number.isFinite).slice().sort((p, q) => p - q);
  const y = b.filter(Number.isFinite).slice().sort((p, q) => p - q);
  if (!x.length || !y.length) return { d: 1, pass: false, n: 0, m: 0, reason: 'empty sample' };
  const all = [...new Set([...x, ...y])].sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  for (const v of all) {
    while (i < x.length && x[i] <= v) i += 1;
    while (j < y.length && y[j] <= v) j += 1;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const crit = KS_ALPHA * Math.sqrt((x.length + y.length) / (x.length * y.length));
  return {
    d,
    crit,
    pass: d <= crit,
    n: x.length,
    m: y.length,
    reason: d <= crit ? `KS D=${d.toFixed(3)} <= ${crit.toFixed(3)}` : `KS D=${d.toFixed(3)} > ${crit.toFixed(3)}`
  };
}

/**
 * Shannon entropy of a categorical count map, in bits.
 */
export function entropy(counts = {}) {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  if (!n) return 0;
  let h = 0;
  for (const v of Object.values(counts)) {
    if (v <= 0) continue;
    const p = v / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Is `rate` inside [lo, hi]? Two-sided: both a bot that never smokes and a
 * bot that only smokes fail. Missing bounds mean "print, do not gate".
 */
export function insideBand(rate, lo, hi, label) {
  if (!Number.isFinite(rate)) return { pass: false, reason: `${label}: no rate` };
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { pass: true, skipped: true, rate, reason: `${label}: ${rate.toFixed(3)} (no library band)` };
  }
  const ok = rate >= lo && rate <= hi;
  return {
    pass: ok,
    rate,
    lo,
    hi,
    reason: ok
      ? `${label}: ${rate.toFixed(3)} in [${lo}, ${hi}]`
      : `${label}: ${rate.toFixed(3)} outside [${lo}, ${hi}]`
  };
}

/**
 * Build the surprise-band report from observed rates and optional library
 * bands. Each key is a rate in [0, 1] unless noted.
 *
 * @param {object} observed  {offAngle, smokeCross, mollyCross, dryEntry, contactEntropy, meanPfw}
 * @param {object} [bands]   same keys to {lo, hi}
 */
export function surpriseBand(observed = {}, bands = null) {
  const keys = ['offAngle', 'smokeCross', 'mollyCross', 'dryEntry', 'contactEntropy', 'meanPfw'];
  const rows = {};
  let pass = true;
  let gated = 0;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(observed, k)) continue;
    const band = bands?.[k];
    const row = insideBand(observed[k], band?.lo, band?.hi, k);
    rows[k] = row;
    if (!row.skipped) {
      gated += 1;
      if (!row.pass) pass = false;
    }
  }
  return {
    pass: gated === 0 ? true : pass,
    ungated: gated === 0,
    rows,
    reason: gated === 0 ? 'library band: not available on this host' : pass ? 'inside band' : 'outside band'
  };
}

/**
 * Histogram a numeric sample into `bins` equal-width buckets over [lo, hi].
 */
export function histogram(sample, { lo, hi, bins = 16 } = {}) {
  const counts = new Array(bins).fill(0);
  const span = hi - lo || 1;
  for (const v of sample) {
    if (!Number.isFinite(v)) continue;
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / span) * bins)));
    counts[i] += 1;
  }
  return counts;
}
