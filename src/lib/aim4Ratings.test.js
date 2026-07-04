// ---------------------------------------------------------------------------
// lib/aim4Ratings.test.js — lightweight assertions for the rating engines.
// Standalone: run with `node src/lib/aim4Ratings.test.js` (no test runner).
// ---------------------------------------------------------------------------

import {
  precisionScore,
  higherIsBetter,
  lowerIsBetter,
  adjustmentsScore,
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

// Precision breakpoints (70% closeness = 1.00).
approx('precision 70%', precisionScore(70), 1.0);
approx('precision 100%', precisionScore(100), 2.0);
approx('precision 0%', precisionScore(0), 0.0);
approx('precision 35% linear', precisionScore(35), 0.5);

// Higher-is-better clamp + ratio (speed °/s while flicking).
approx('speed at baseline', higherIsBetter(250, 250), 1.0);
approx('speed double clamps', higherIsBetter(800, 250), 2.0);
approx('speed zero', higherIsBetter(0, 250), 0.0);

// Lower-is-better clamp + ratio (tension: 40% deviation = 1.00, 0% = 2.00).
approx('tension at baseline', lowerIsBetter(40, 40), 1.0);
approx('tension zero best', lowerIsBetter(0, 40), 2.0);
approx('tension double clamps', lowerIsBetter(80, 40), 0.0);

// Adjustments per target: 1.0 = one-and-done = 2.00; baseline (2.0) = 1.00.
approx('adjustments perfect', adjustmentsScore(1.0, 2.0), 2.0);
approx('adjustments elite', adjustmentsScore(1.2, 2.0), 1.8);
approx('adjustments baseline', adjustmentsScore(2.0, 2.0), 1.0);
approx('adjustments triple clamps', adjustmentsScore(3.5, 2.0), 0.0);

// End-to-end routing on the new telemetry keys.
const out = calculateAim4Ratings(
  {
    precision_accuracy_percent: 70,
    speed: 250,
    tracking: 0.5,
    flicks_hit_percent: 100,
    adjustments: 1.0,
    reaction_time_ms: 0,
    tension_percent: 0
  },
  { baselines: { speed: 250, tracking: 0.5, flicks_hit_percent: 50, adjustments: 2, reaction_time_ms: 200, tension_percent: 40 } }
);
approx('e2e precision', out.precision_accuracy_percent, 1.0);
approx('e2e speed', out.speed, 1.0);
approx('e2e tracking', out.tracking, 1.0);
approx('e2e flicks hit all', out.flicks_hit_percent, 2.0);
approx('e2e adjustments aimbot', out.adjustments, 2.0);
approx('e2e reaction aimbot', out.reaction_time_ms, 2.0);
approx('e2e tension aimbot', out.tension_percent, 2.0);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
if (failures) process.exit(1);
