// ---------------------------------------------------------------------------
// lib/aim4Ratings.test.js — lightweight assertions for the rating engines.
// Standalone: run with `node src/lib/aim4Ratings.test.js` (no test runner).
// ---------------------------------------------------------------------------

import {
  precisionScore,
  higherIsBetter,
  lowerIsBetter,
  adjustmentsScore,
  reactionScore,
  speedScore,
  calculateAim4Ratings,
  telemetryFromAimStats,
  composeRatingFromBestRuns
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

// Higher-is-better clamp + ratio (generic engine: tracking, flicks).
approx('hib at baseline', higherIsBetter(250, 250), 1.0);
approx('hib double clamps', higherIsBetter(800, 250), 2.0);
approx('hib zero', higherIsBetter(0, 250), 0.0);

// Speed: forgiving sqrt curve, default baseline 44 °/s.
approx('speed at baseline', speedScore(44, 44), 1.0);
approx('speed 53 ≈ 1.10', speedScore(53, 44), 1.10);
approx('speed half baseline forgiving', speedScore(22, 44), 0.707);
approx('speed 4x clamps', speedScore(44 * 4, 44), 2.0);
approx('speed zero', speedScore(0, 44), 0.0);

// Lower-is-better clamp + ratio (tension: 40% deviation = 1.00, 0% = 2.00).
approx('tension at baseline', lowerIsBetter(40, 40), 1.0);
approx('tension zero best', lowerIsBetter(0, 40), 2.0);
approx('tension double clamps', lowerIsBetter(80, 40), 0.0);

// Brutal adjustments: 1 flick/target capped below 2.0; baseline 2.0 = 1.0.
approx('adjustments perfect capped', adjustmentsScore(1.0, 2.0), 1.78);
approx('adjustments baseline', adjustmentsScore(2.0, 2.0), 1.0);
approx('adjustments triple', adjustmentsScore(3.0, 2.0), 0.5);

// Brutal reaction: instant capped below 2.0; baseline 200 ms = 1.0.
approx('reaction instant capped', reactionScore(0, 200), 1.82);
approx('reaction baseline', reactionScore(200, 200), 1.0);
approx('reaction double baseline', reactionScore(400, 200), 0.5);

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
approx('e2e adjustments capped', out.adjustments, 1.78);
approx('e2e reaction capped', out.reaction_time_ms, 1.82);
approx('e2e tension aimbot', out.tension_percent, 2.0);

// telemetryFromAimStats fallbacks when reworked columns are 0 / missing.
const legacyRow = {
  games: 10,
  flick_accuracy_pct: 80,
  flick_speed_ms: 20,
  flicks_accurate: 80,
  flicks_over: 10,
  flicks_under: 10,
  click_late_ms: 500,
  tension_pct: 30,
  speed_deg_s: 0,
  tracking_pct: 0,
  adjustments_per_target: 0,
  reaction_ms: null
};
const tel = telemetryFromAimStats(legacyRow);
approx('telemetry speed fallback from ms/deg', tel.speed, 50);
approx('telemetry tracking fallback from accuracy', tel.tracking, 0.8);
approx('telemetry adjustments neutral when 0', tel.adjustments, 2.0);
approx('telemetry reaction fallback from click late', tel.reaction_time_ms, 50);

// Best-N per category: each axis picks from different runs when bestN = 1.
const baselines = { speed: 44, tracking: 0.5, flicks_hit_percent: 50, adjustments: 2, reaction_time_ms: 200, tension_percent: 40 };
const runA = {
  flick_accuracy_pct: 90, flick_speed_ms: 15, flicks_accurate: 10, flicks_over: 0, flicks_under: 0,
  tension_pct: 20, tracking_pct: 80, reaction_ms: 100, adjustments_per_target: 1.5, speed_deg_s: 60, games: 1
};
const runB = {
  flick_accuracy_pct: 60, flick_speed_ms: 30, flicks_accurate: 5, flicks_over: 5, flicks_under: 0,
  tension_pct: 10, tracking_pct: 40, reaction_ms: 50, adjustments_per_target: 2.5, speed_deg_s: 30, games: 1
};
const best1 = composeRatingFromBestRuns([runA, runB], { baselines }, 1);
const rA = calculateAim4Ratings(telemetryFromAimStats(runA), { baselines });
const rB = calculateAim4Ratings(telemetryFromAimStats(runB), { baselines });
approx('best1 speed from faster run', best1.speed, Math.max(rA.speed, rB.speed));
approx('best1 precision from better run', best1.precision_accuracy_percent, Math.max(rA.precision_accuracy_percent, rB.precision_accuracy_percent));

const best2 = composeRatingFromBestRuns([runA, runB], { baselines }, 2);
approx('best2 speed avg of two', best2.speed, (rA.speed + rB.speed) / 2);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
if (failures) process.exit(1);
