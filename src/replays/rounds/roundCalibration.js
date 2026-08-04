// ---------------------------------------------------------------------------
// replays/rounds/roundCalibration.js
// Bending the model's output curve, per phase.
//
// The round model is additive in log-odds. That is what makes it readable and
// what keeps 35 parameters fittable on 937 rounds, but it also means the model
// has no way to say "my numbers are systematically timid in the first forty
// seconds and about right after that". Every term it owns moves the odds for a
// reason; none of them can reshape the curve the odds come out of.
//
// So the curve gets reshaped afterwards, by two numbers per phase:
//
//   p' = sigmoid(a * logit + b)
//
// `a` is sharpness. Below one it pulls predictions toward the middle, which is
// what an overconfident regime needs; above one it pushes them out. `b` is a
// straight thumb on the scale toward one side. Fitted by Newton's method, which
// on two parameters of a convex loss converges in a handful of iterations.
//
// This is Platt scaling, and the reason it is worth doing on a model this small
// is that it costs two parameters per phase and cannot touch the ranking of one
// prediction against another: `a > 0` makes it monotone in the logit. It can
// only fix how loud the model is, never what it believes is winning.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { roundLogit, sigmoid } from './roundModel.js';

/** The regimes that get their own curve. Matches roundPhases.js. */
export const CALIBRATION_PHASES = ['early', 'mid', 'late'];

/**
 * Sharpness bounds. A degenerate fit on a thin phase could otherwise drive `a`
 * to zero (every prediction becomes the base rate) or to something enormous
 * (every prediction becomes 0 or 1), and both score badly the moment the data
 * shifts underneath them.
 */
const A_MIN = 0.2;
const A_MAX = 3;
/** Ridge on the Newton step, so a near-singular Hessian cannot explode. */
const RIDGE = 1e-6;

/** The do-nothing curve: every phase passes its logit straight through. */
export function identityCalibration() {
  const out = {};
  for (const p of CALIBRATION_PHASES) out[p] = { a: 1, b: 0 };
  return out;
}

/** True when a calibration is present and is not simply the identity. */
export function isCalibrated(calib) {
  if (!calib) return false;
  return CALIBRATION_PHASES.some((p) => {
    const c = calib[p];
    return c && (c.a !== 1 || c.b !== 0);
  });
}

/**
 * Apply the phase's curve to a raw log-odds.
 *
 * Unknown phases and missing calibrations pass through untouched, so a params
 * file written before this existed still predicts exactly as it used to.
 *
 * @param {number} z raw round logit
 * @param {string} phase 'early' | 'mid' | 'late'
 * @param {object|null} calib
 */
export function calibratedLogit(z, phase, calib) {
  const c = calib?.[phase];
  if (!c || !Number.isFinite(c.a) || !Number.isFinite(c.b)) return z;
  return c.a * z + c.b;
}

/**
 * P(CT wins), with the phase's curve applied.
 *
 * @param {import('./roundFeatures.js').RoundFeatures} f
 * @param {Float64Array} v
 * @param {string} mapCode
 * @param {string} phase
 * @param {object|null} calib
 */
export function predictRoundCalibrated(f, v, mapCode, phase, calib) {
  return sigmoid(calibratedLogit(roundLogit(f, v, mapCode), phase, calib));
}

/**
 * Fit one phase's two parameters by Newton's method.
 *
 * The loss is weighted log loss over `p = sigmoid(a*z + b)`, which is convex in
 * (a, b), so there is one optimum and the Newton step goes straight at it:
 *
 *   dL/da = Σ w (p - y) z          d²L/da²  = Σ w p(1-p) z²
 *   dL/db = Σ w (p - y)            d²L/db²  = Σ w p(1-p)
 *                                  d²L/dadb = Σ w p(1-p) z
 *
 * @param {Array<{z:number, y:number, w:number}>} samples
 * @param {{iterations?: number}} [opts]
 * @returns {{a:number, b:number}}
 */
export function fitPhaseScale(samples, { iterations = 30 } = {}) {
  if (!samples?.length) return { a: 1, b: 0 };

  let a = 1;
  let b = 0;
  for (let it = 0; it < iterations; it++) {
    let ga = 0;
    let gb = 0;
    let haa = RIDGE;
    let hab = 0;
    let hbb = RIDGE;

    for (const s of samples) {
      const z = s.z;
      const p = sigmoid(a * z + b);
      const r = (p - s.y) * s.w;
      ga += r * z;
      gb += r;
      const wq = s.w * p * (1 - p);
      haa += wq * z * z;
      hab += wq * z;
      hbb += wq;
    }

    const det = haa * hbb - hab * hab;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    // Solve H d = -g for the 2x2 directly; no reason to reach for a library.
    const da = -(hbb * ga - hab * gb) / det;
    const db = -(haa * gb - hab * ga) / det;
    if (!Number.isFinite(da) || !Number.isFinite(db)) break;

    a += da;
    b += db;
    if (a < A_MIN) a = A_MIN;
    else if (a > A_MAX) a = A_MAX;

    if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) break;
  }

  return { a, b };
}

/**
 * Fit every phase's curve from labelled rows.
 *
 * Phases with too little to say are left at the identity rather than fitted to
 * noise: two parameters on a couple of hundred snapshots is a good way to
 * manufacture a calibration that only describes the demos it was fitted on.
 *
 * @param {Array<{z:number, y:number, w:number, phase:string}>} rows
 * @param {{minSamples?: number}} [opts]
 */
export function fitCalibration(rows, { minSamples = 500 } = {}) {
  const byPhase = new Map(CALIBRATION_PHASES.map((p) => [p, []]));
  for (const r of rows) {
    const bucket = byPhase.get(r.phase);
    if (bucket) bucket.push(r);
  }
  const out = identityCalibration();
  for (const [phase, samples] of byPhase) {
    if (samples.length < minSamples) continue;
    out[phase] = fitPhaseScale(samples);
  }
  return out;
}
