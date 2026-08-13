// Run: node shared/sim/confidence.test.js
//
// The transform and the fit are three lines of math each; what the tests pin
// down is the CONTRACT around them. Zero bias is a perfect no-op, the fit
// round-trips through the transform (decide with the fitted bias at the
// player's pfw and you land on their realized rate), the band holds at any
// extreme, thin samples shrink toward zero, and the duelStats adapter agrees
// with the core fit once its percentage points are read as probabilities.

import {
  CONFIDENCE_BIAS_MAX,
  CONFIDENCE_SHRINK_HALF,
  PFW_EPS,
  decidedPfw,
  fitConfidenceBias,
  fitConfidenceBiasFromDuels
} from './confidence.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A sample big enough that shrinkage is negligible for the fit tests below.
const BIG = 1e9;

// ---- decidedPfw: the transform --------------------------------------------------

{
  // Zero bias is a no-op up to float eps, across the whole range.
  for (const p of [PFW_EPS, 0.1, 0.25, 0.5, 0.6180339887, 0.9, 1 - PFW_EPS]) {
    assert(close(decidedPfw(p, 0), p, 1e-12), `decidedPfw(${p}, 0) must be ${p}`);
  }

  // Known number: +1 in log-odds from a coin flip is sigmoid(1).
  assert(close(decidedPfw(0.5, 1), 1 / (1 + Math.exp(-1))), 'sigmoid(logit(.5)+1)');

  // Positive bias raises, negative lowers, and both stay strict probabilities.
  for (const p of [0.1, 0.5, 0.9]) {
    const up = decidedPfw(p, 0.7);
    const down = decidedPfw(p, -0.7);
    assert(up > p && down < p, `bias must move the odds the right way at ${p}`);
    assert(up < 1 && down > 0, `decided odds stay in (0, 1) at ${p}`);
  }

  // Monotone in the bias.
  assert(decidedPfw(0.3, 1.5) > decidedPfw(0.3, 0.5), 'more bias, more confidence');

  // Inputs outside (0, 1) are clamped, not NaN.
  assert(Number.isFinite(decidedPfw(0, 0)) && Number.isFinite(decidedPfw(1, 0)), 'clamped logit');
  assert(close(decidedPfw(0, 0), PFW_EPS, 1e-12), 'p=0 reads as the clamp floor');
  assert(close(decidedPfw(0.4, NaN), 0.4, 1e-12), 'a non-finite bias reads as 0');
}

// ---- fitConfidenceBias: the principled fit --------------------------------------

{
  // The round trip: decide with the fitted bias at the player's own pfw and
  // you land on their realized winrate. This IS the definition of the fit.
  for (const [pfw, pfo] of [
    [0.45, 0.08], // takes even fights, beats the odds
    [0.62, -0.05], // takes good fights, still leaks
    [0.3, 0.15] // the model hates their fights; they win anyway
  ]) {
    const b = fitConfidenceBias({ pfw, pfo, rounds: BIG });
    assert(close(decidedPfw(pfw, b), pfw + pfo, 1e-6), `round trip at pfw=${pfw}, pfo=${pfo}`);
  }

  // Signs: positive pfo fits a positive bias, negative a negative one, and a
  // perfectly calibrated player fits zero exactly.
  assert(fitConfidenceBias({ pfw: 0.5, pfo: 0.1, rounds: BIG }) > 0, 'overperformer: b > 0');
  assert(fitConfidenceBias({ pfw: 0.5, pfo: -0.1, rounds: BIG }) < 0, 'underperformer: b < 0');
  assert(fitConfidenceBias({ pfw: 0.5, pfo: 0, rounds: BIG }) === 0, 'calibrated: b = 0');

  // Known number: pfw .5 -> realized .7 is logit(.7), since logit(.5) = 0.
  assert(
    close(fitConfidenceBias({ pfw: 0.5, pfo: 0.2, rounds: BIG }), Math.log(0.7 / 0.3), 1e-6),
    'b = logit(.7) when pfw is a coin flip'
  );

  // The band holds at any extreme, in both directions, even absurd inputs.
  for (const [pfw, pfo] of [
    [0.05, 0.9],
    [0.95, -0.9],
    [0.5, 5],
    [0.5, -5]
  ]) {
    const b = fitConfidenceBias({ pfw, pfo, rounds: BIG });
    assert(Math.abs(b) <= CONFIDENCE_BIAS_MAX + 1e-12, `band holds at pfw=${pfw}, pfo=${pfo}`);
  }
  assert(
    close(fitConfidenceBias({ pfw: 0.05, pfo: 0.9, rounds: BIG }), CONFIDENCE_BIAS_MAX, 1e-6),
    'an extreme fit sits ON the band, not past it'
  );
}

// ---- shrinkage: small-sample discipline -----------------------------------------

{
  const at = (rounds) => fitConfidenceBias({ pfw: 0.5, pfo: 0.1, rounds });
  const full = Math.log(0.6 / 0.4); // the unshrunk fit

  // At the half-sample the fit keeps exactly half; below it, less; a huge
  // sample converges to the raw fit; no sample means no personality.
  assert(close(at(CONFIDENCE_SHRINK_HALF), full / 2, 1e-9), 'half sample keeps half');
  assert(at(5) < at(CONFIDENCE_SHRINK_HALF), 'thinner sample, smaller bias');
  assert(at(5) > 0, 'but still the right sign');
  assert(close(at(BIG), full, 1e-6), 'a huge sample earns the raw fit');
  assert(at(0) === 0, 'zero rounds fits zero');
  assert(fitConfidenceBias({ pfw: 0.5, pfo: 0.1 }) === 0, 'missing rounds fits zero');

  // Monotone in the sample: more evidence never means less trait.
  assert(at(10) < at(50) && at(50) < at(200), 'shrinkage is monotone in the sample');

  // Missing or broken stats fit the honest default.
  assert(fitConfidenceBias({}) === 0, 'no numbers, no bias');
  assert(fitConfidenceBias({ pfw: NaN, pfo: 0.1, rounds: 50 }) === 0, 'NaN pfw fits zero');
  assert(fitConfidenceBias() === 0, 'no argument at all fits zero');
}

// ---- the duelStats adapter ------------------------------------------------------

{
  // summarizeDuelStats speaks percentage points and `duels`; the adapter must
  // agree with the core fed the same numbers as probabilities.
  const entry = { pfw: 45, pfo: 8, duels: 40 };
  assert(
    close(
      fitConfidenceBiasFromDuels(entry),
      fitConfidenceBias({ pfw: 0.45, pfo: 0.08, rounds: 40 }),
      1e-12
    ),
    'adapter matches the core fit at 1/100 scale'
  );
  assert(fitConfidenceBiasFromDuels({ pfw: 45, pfo: 8, duels: 40 }) > 0, 'adapter keeps the sign');
  assert(fitConfidenceBiasFromDuels({}) === 0, 'an empty entry fits zero');
  assert(fitConfidenceBiasFromDuels() === 0, 'no entry fits zero');
}

console.log('confidence: ok');
