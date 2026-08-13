// ---------------------------------------------------------------------------
// shared/sim/scorecard.js
// Pro percentile scorecard math (SIM-PLAN 9.17, 9.18).
//
// Percentile, not raw value. Style metrics score by band membership. Axis
// score is the median of its metrics; overall is a soft minimum (20th
// percentile of the axes), never the mean. Four verdicts, never merged:
// Strength, Quality, Honesty, Robustness. Doctrine is a separate axis from
// strength and is never blended with it.
//
// Library baselines are optional. When they are missing the report says
// "not available" and still scores against the frozen references (bc0,
// desire, scripted).
// ---------------------------------------------------------------------------

export const AXES = Object.freeze([
  'mechanics',
  'duel',
  'utility',
  'teamwork',
  'macro',
  'information',
  'objective',
  'discipline',
  'doctrine'
]);

export const STRENGTH_AXES = Object.freeze(AXES.filter((a) => a !== 'doctrine'));

export function percentile(value, population) {
  const xs = (population || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const v = Number(value);
  let below = 0;
  for (const x of xs) if (x <= v) below += 1;
  return below / xs.length;
}

export function median(xs) {
  const s = (xs || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Soft minimum: the `q` quantile of the axis scores. Default 20th. */
export function softMin(xs, q = 0.2) {
  const s = (xs || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i];
}

/**
 * Style metrics: 1 inside [lo, hi], fall off with distance outside.
 */
export function bandScore(value, lo, hi) {
  if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (value >= lo && value <= hi) return 1;
  const d = value < lo ? lo - value : value - hi;
  const span = Math.max(1e-6, hi - lo);
  return Math.max(0, 1 - d / span);
}

export function axisScore(metricScores) {
  return median(metricScores);
}

/**
 * Place a candidate inside a baseline bag.
 *
 * @param {object} metrics  axis -> number (already a rate / mean)
 * @param {object} baselines  axis -> number[] population, or null
 */
export function scorecard(metrics, baselines = {}) {
  const axes = {};
  const missing = [];
  for (const axis of AXES) {
    const v = metrics[axis];
    const pop = baselines[axis];
    if (!pop || !pop.length) {
      missing.push(axis);
      axes[axis] = Number.isFinite(v) ? v : null;
      continue;
    }
    axes[axis] = percentile(v, pop);
  }
  const strength = STRENGTH_AXES.map((a) => axes[a]).filter((n) => Number.isFinite(n));
  const overall = softMin(strength, 0.2);
  return {
    axes,
    overall,
    doctrine: axes.doctrine,
    library: missing.length ? 'not available' : 'ok',
    missing
  };
}

/**
 * Correction term: score the frozen BC anchor through the same pipeline and
 * report the shift, because pro metrics were produced against pro opponents
 * and ours against the reference set.
 */
export function correctionTerm(candidateCard, bc0Card) {
  const d = (candidateCard?.overall ?? 0) - (bc0Card?.overall ?? 0);
  return {
    delta: d,
    stated: `correction ${d >= 0 ? '+' : ''}${d.toFixed(3)} vs frozen bc0`
  };
}

function nearestTier(axes, tierCentroids) {
  if (!tierCentroids || !Object.keys(tierCentroids).length) {
    return { tier: 'unknown', reason: 'no tier centroids' };
  }
  let best = null;
  let bestD = Infinity;
  const keys = STRENGTH_AXES.filter((a) => Number.isFinite(axes[a]));
  for (const [tier, c] of Object.entries(tierCentroids)) {
    let s = 0;
    for (const k of keys) {
      const d = (axes[k] ?? 0) - (c[k] ?? 0);
      s += d * d;
    }
    if (s < bestD) {
      bestD = s;
      best = tier;
    }
  }
  return { tier: best, distance: Math.sqrt(bestD) };
}

/**
 * Four verdicts, deliberately not merged (9.18).
 */
export function fourVerdicts({
  eloDelta = 0,
  card = null,
  honesty = {},
  exploitability = 0.5,
  examRegret = 0,
  contractPass = true,
  tierCentroids = null
} = {}) {
  const strength = {
    name: 'Strength',
    pass: eloDelta > 0,
    detail: `Elo Δ ${eloDelta >= 0 ? '+' : ''}${eloDelta.toFixed(1)} vs the pool`
  };
  const quality = {
    name: 'Quality',
    ...nearestTier(card?.axes || {}, tierCentroids),
    overall: card?.overall ?? null,
    correction: card?.correction || null
  };
  quality.pass = (card?.overall ?? 0) >= 0.4 && contractPass;
  const honestyFail = [];
  if (honesty.belief === false) honestyFail.push('belief');
  if (honesty.aim === false) honestyFail.push('aim');
  if (honesty.ks === false) honestyFail.push('KS');
  if (honesty.determinism === false) honestyFail.push('determinism');
  const honestyV = {
    name: 'Honesty',
    pass: honestyFail.length === 0,
    detail: honestyFail.length ? `failed ${honestyFail.join(', ')}` : 'gates green'
  };
  const robustness = {
    name: 'Robustness',
    pass: exploitability <= 0.6 && examRegret < 0.15,
    detail: `exploiter ${(exploitability * 100).toFixed(0)}%, exam regret ${examRegret.toFixed(3)}`
  };
  return { strength, quality, honesty: honestyV, robustness };
}

/** Frozen reference names the scorecard always scores, library or not. */
export const FROZEN_REFS = Object.freeze(['bc0', 'desire', 'scripted']);
