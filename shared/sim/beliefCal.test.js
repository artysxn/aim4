// Run: node shared/sim/beliefCal.test.js
//
// Calibration is a property of a stream of (prediction, truth) pairs, so the
// tests hold the arithmetic rather than any particular filter:
//
//   a Dirac on the truth is Brier 0
//   a uniform is worse than a peaked-and-right distribution
//   ECE is 0 when predicted p equals empirical frequency
//   beatsBaseline refuses a filter that is worse than the prior

import {
  BRIER_MARGIN,
  beatsBaseline,
  brierBinary,
  brierCount,
  calibrateCount,
  eceBinary
} from './beliefCal.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const dirac = [0, 0, 1, 0, 0, 0];
  assert(brierCount(dirac, 2) === 0, 'a Dirac on the truth is Brier 0');
  assert(brierCount(dirac, 3) > 0, 'and positive when it missed');
  const uniform = [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6];
  assert(brierCount(uniform, 2) > brierCount(dirac, 2), 'uniform loses to the Dirac');
}

{
  assert(brierBinary(1, true) === 0, 'certain and true is 0');
  assert(brierBinary(0, false) === 0, 'certain and false is 0');
  assert(brierBinary(0.5, true) === 0.25, 'a coin is 0.25');
}

{
  const rows = [
    { p: 0.2, y: false },
    { p: 0.2, y: false },
    { p: 0.2, y: false },
    { p: 0.2, y: false },
    { p: 0.2, y: true }
  ];
  const { ece } = eceBinary(rows, 5);
  assert(ece < 0.05, `five 0.2s with one hit is calibrated (${ece})`);
}

{
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push({ dist: [0.8, 0.2, 0, 0, 0, 0], truth: i < 16 ? 0 : 1 });
  }
  const cal = calibrateCount(rows);
  assert(cal.n === 20, 'n is the stream length');
  assert(cal.brier < 0.4, 'a peaked empty-site read is a low Brier');
  assert(cal.pEmptyBrier < 0.2, 'and pEmpty is its own number');
}

{
  const good = calibrateCount(
    Array.from({ length: 10 }, () => ({ dist: [0, 0, 1, 0, 0, 0], truth: 2 }))
  );
  const prior = calibrateCount(
    Array.from({ length: 10 }, () => ({
      dist: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6],
      truth: 2
    }))
  );
  const g = beatsBaseline(good, prior);
  assert(g.pass, g.reason);
  const bad = beatsBaseline(prior, good, BRIER_MARGIN);
  assert(!bad.pass, 'a uniform does not beat a Dirac');
}

console.log('beliefCal: ok');
