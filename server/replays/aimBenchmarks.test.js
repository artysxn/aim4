// ---------------------------------------------------------------------------
// server/replays/aimBenchmarks.test.js
//   node --test server/replays/aimBenchmarks.test.js
//
// Which players get to define the scale.
//
// This is the quiet half of the calibration. The maths in aimCalibration.js is
// pinned by its own tests; what is pinned here is the population fed into it,
// because a scale measured from the wrong players is wrong in a way no amount
// of correct arithmetic downstream will show.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { MIN_ROUNDS, contribution } from './aimBenchmarks.js';
import { AIM_MIN_SAMPLE, AIM_V2_MIN_SAMPLE } from '../../src/replays/shared/aimMetrics.js';

const player = (over = {}) => ({
  rounds: MIN_ROUNDS,
  aimRaw: { accuracy: 0.35, precision: 34, reaction: 265 },
  aimSample: {
    accuracy: AIM_MIN_SAMPLE.accuracy,
    precision: AIM_V2_MIN_SAMPLE.precision,
    reaction: AIM_V2_MIN_SAMPLE.reaction
  },
  ...over
});

test('a well-measured player contributes every statistic they have', () => {
  const c = contribution(player());
  assert.deepEqual(c, { accuracy: 0.35, precision: 34, reaction: 265 });
});

test('a player with too few rounds does not define the scale', () => {
  // One match is a bad night or a smurf, and thousands of them would describe
  // a population that does not play the game the regulars play.
  assert.equal(contribution(player({ rounds: MIN_ROUNDS - 1 })), null);
  assert.ok(contribution(player({ rounds: MIN_ROUNDS })), 'and at the bar they do');
});

test('a statistic below its own sample gate is left out, not the player', () => {
  // The important one. `aimRaw` carries a value whenever the denominator was
  // above zero, so three flicks produce a precision number. Three flicks worth
  // of precision has no business helping to decide what the 3rd percentile is,
  // but the same player's accuracy over hundreds of shots still should.
  const c = contribution(
    player({
      aimSample: {
        accuracy: AIM_MIN_SAMPLE.accuracy,
        precision: 3,
        reaction: AIM_V2_MIN_SAMPLE.reaction
      }
    })
  );
  assert.deepEqual(Object.keys(c).sort(), ['accuracy', 'reaction']);
  assert.equal(c.precision, undefined, 'the thin statistic is dropped');
  assert.equal(c.accuracy, 0.35, 'the measured one survives');
});

test('a player with nothing measurable contributes nothing at all', () => {
  const c = contribution(player({ aimSample: { accuracy: 0, precision: 0, reaction: 0 } }));
  assert.equal(c, null, 'an empty contribution is not an entry in the population');
});

test('values that are not numbers never reach the population', () => {
  const c = contribution(
    player({
      aimRaw: { accuracy: null, precision: NaN, reaction: 265 },
      aimSample: {
        accuracy: 9999,
        precision: 9999,
        reaction: AIM_V2_MIN_SAMPLE.reaction
      }
    })
  );
  assert.deepEqual(c, { reaction: 265 });
});

test('a missing row is not a player', () => {
  assert.equal(contribution(null), null);
  assert.equal(contribution({}), null);
});
