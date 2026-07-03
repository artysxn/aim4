// ---------------------------------------------------------------------------
// lib/aim4Ratings.test.js — lightweight assertions for the rating engines.
// Standalone: run with `node src/lib/aim4Ratings.test.js` (no test runner).
// ---------------------------------------------------------------------------

import {
  precisionScore,
  higherIsBetter,
  lowerIsBetter,
  calculateAim4Ratings
} from './aim4Ratings.js';

let failures = 0;
function approx(name, got, want, tol = 0.01) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  } else {
    console.log(`ok   ${name} = ${got}`);
  }
}

// Precision breakpoints.
approx('precision 75%', precisionScore(75), 1.0);
approx('precision 95%', precisionScore(95), 1.49);
approx('precision 100%', precisionScore(100), 2.0);
approx('precision 0%', precisionScore(0), 0.0);
approx('precision 37.5% linear', precisionScore(37.5), 0.5);

// Higher-is-better clamp + ratio.
approx('speed at baseline', higherIsBetter(2000, 2000), 1.0);
approx('speed double clamps', higherIsBetter(6000, 2000), 2.0);
approx('speed zero', higherIsBetter(0, 2000), 0.0);

// Lower-is-better clamp + ratio.
approx('tension at baseline', lowerIsBetter(30, 30), 1.0);
approx('tension zero best', lowerIsBetter(0, 30), 2.0);
approx('tension triple clamps', lowerIsBetter(90, 30), 0.0);

// End-to-end routing.
const out = calculateAim4Ratings(
  {
    precision_accuracy_percent: 95,
    speed: 2000,
    tracking: 0.45,
    flicks_error_percent: 15,
    adjustments: 2,
    reaction_time_ms: 200,
    tension_percent: 30
  },
  { baselines: { speed: 2000, tracking: 0.45, flicks_error_percent: 15, adjustments: 2, reaction_time_ms: 200, tension_percent: 30 } }
);
approx('e2e precision', out.precision_accuracy_percent, 1.49);
approx('e2e speed', out.speed, 1.0);
approx('e2e tracking', out.tracking, 1.0);
approx('e2e flicks', out.flicks_error_percent, 1.0);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
