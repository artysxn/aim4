// The round model's structural guarantees: every input has to push the odds the
// way the game does, for any parameter vector, including ones training has not
// produced yet.
//
// Not an accuracy test. Accuracy is what the three exams in the trainer measure
// against real rounds. These check the things that must hold regardless: that a
// man advantage helps, that planting flips the job, that a defuse kit matters
// only after a plant, and that no input can drive the output outside (0, 1).

import { ROUND_BUCKET_IDS, bucketizeRound } from './roundBuckets.js';
import { predictRound, roundLogit, sigmoid } from './roundModel.js';
import { ROUND_PARAM_SPEC, clampVector, fromNamed, initialVector, toNamed } from './roundParamSpec.js';
import { roundParamVector } from './roundModelParams.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/** A dead-even round: five each, full health, nothing bought either way. */
function f(over = {}) {
  return {
    ctAlive: 5,
    tAlive: 5,
    ctEff: 5,
    tEff: 5,
    equipDiff: 0,
    utilDiff: 0,
    possessionDiff: 0,
    duelEdge: 0,
    openDuels: 0,
    centroidDist: 1,
    nearestDist: 1,
    secondsLeft: 115,
    planted: false,
    bombSecondsLeft: 0,
    ctHasKit: false,
    ...over
  };
}

for (const v of [initialVector(), roundParamVector()]) {
  // --- output is always a probability -------------------------------------
  const extremes = [
    f(),
    f({ ctAlive: 5, tAlive: 0, ctEff: 5, tEff: 0 }),
    f({ ctAlive: 0, tAlive: 5, ctEff: 0, tEff: 5 }),
    f({ planted: true, bombSecondsLeft: 0.5, ctHasKit: false, ctAlive: 1, tAlive: 4, ctEff: 0.5, tEff: 4 }),
    f({ equipDiff: 10, utilDiff: 10, possessionDiff: 1, duelEdge: 20, secondsLeft: 0 }),
    f({ equipDiff: -10, utilDiff: -10, possessionDiff: -1, duelEdge: -20 })
  ];
  for (const [i, s] of extremes.entries()) {
    const p = predictRound(s, v, 'MIR');
    assert(Number.isFinite(p), `case ${i}: not finite`);
    assert(p > 0 && p < 1, `case ${i}: probability out of range (${p})`);
  }

  // --- men ----------------------------------------------------------------
  const even = predictRound(f(), v, 'MIR');
  assert(predictRound(f({ tAlive: 4, tEff: 4 }), v, 'MIR') > even, 'a man up should help CT');
  assert(predictRound(f({ ctAlive: 4, ctEff: 4 }), v, 'MIR') < even, 'a man down should hurt CT');
  assert(
    predictRound(f({ tAlive: 3, tEff: 3 }), v, 'MIR') >
      predictRound(f({ tAlive: 4, tEff: 4 }), v, 'MIR'),
    'two men up should beat one man up'
  );

  // Health beyond the body count.
  assert(predictRound(f({ tEff: 3.5 }), v, 'MIR') > even, 'hurting the T side should help CT');
  assert(predictRound(f({ ctEff: 3.5 }), v, 'MIR') < even, 'being hurt should hurt CT');

  // --- fights in progress --------------------------------------------------
  assert(predictRound(f({ duelEdge: 2 }), v, 'MIR') > even, 'winning the open fights should help');
  assert(predictRound(f({ duelEdge: -2 }), v, 'MIR') < even, 'losing them should hurt');

  // --- economy, utility, map control --------------------------------------
  assert(predictRound(f({ equipDiff: 0.6 }), v, 'MIR') >= even, 'better guns should not hurt CT');
  assert(predictRound(f({ possessionDiff: 0.5 }), v, 'MIR') >= even, 'map control should not hurt CT');
  assert(predictRound(f({ utilDiff: 1 }), v, 'MIR') >= even, 'more utility should not hurt CT');

  // --- the clock -----------------------------------------------------------
  // Time draining without a plant is a T problem, so it can only help CT.
  assert(
    predictRound(f({ secondsLeft: 10 }), v, 'MIR') >= predictRound(f({ secondsLeft: 100 }), v, 'MIR'),
    'time running out unplanted should not favour T'
  );

  // --- the plant -----------------------------------------------------------
  const planted = f({ planted: true, bombSecondsLeft: 35, secondsLeft: 0 });
  assert(
    predictRound(planted, v, 'MIR') < predictRound(f({ secondsLeft: 20 }), v, 'MIR'),
    'a plant should swing the round toward T'
  );
  assert(
    predictRound({ ...planted, bombSecondsLeft: 5 }, v, 'MIR') < predictRound(planted, v, 'MIR'),
    'a bomb closer to detonating should favour T more'
  );
  assert(
    predictRound({ ...planted, ctHasKit: true }, v, 'MIR') >= predictRound(planted, v, 'MIR'),
    'a defuse kit should not hurt CT'
  );
  // The kit only exists as a concept after a plant.
  assert(
    close(predictRound(f({ ctHasKit: true }), v, 'MIR'), predictRound(f(), v, 'MIR')),
    'a kit must do nothing before a plant'
  );
  // Bomb timer must do nothing before a plant either.
  assert(
    close(predictRound(f({ bombSecondsLeft: 3 }), v, 'MIR'), predictRound(f(), v, 'MIR')),
    'the bomb timer must do nothing before a plant'
  );
}

// --- maps -------------------------------------------------------------------
{
  const v = initialVector();
  const i = ROUND_PARAM_SPEC.findIndex((p) => p.name === 'map_MIR');
  v[i] = 0.5;
  assert(
    predictRound(f(), v, 'MIR') > predictRound(f(), v, 'DD2'),
    'a map prior should apply only to its own map'
  );
  assert(
    close(predictRound(f(), v, 'DD2'), predictRound(f(), v, 'NOT_A_MAP')),
    'an unknown map should fall back to the global bias alone'
  );
}

// --- parameter plumbing -----------------------------------------------------
{
  const v = initialVector();
  assert(v.length === ROUND_PARAM_SPEC.length, 'vector length matches the spec');
  const round = fromNamed(toNamed(v));
  for (let i = 0; i < v.length; i++) assert(close(round[i], v[i]), 'named round trip');
  // Unknown names are ignored and missing ones fall back to their init, so a
  // params file written before a parameter existed still loads.
  const partial = fromNamed({ manW: 3, notAParameter: 99 });
  assert(partial[ROUND_PARAM_SPEC.findIndex((p) => p.name === 'manW')] === 3, 'known name applied');

  const wild = Float64Array.from(v, () => 1e9);
  clampVector(wild);
  for (let i = 0; i < wild.length; i++) {
    assert(wild[i] <= ROUND_PARAM_SPEC[i].max, `${ROUND_PARAM_SPEC[i].name} clamped to max`);
  }
}

// --- buckets ----------------------------------------------------------------
{
  const ids = new Set(ROUND_BUCKET_IDS);
  const plain = bucketizeRound(f(), 'early');
  assert(plain.every((b) => ids.has(b)), 'every bucket must be a declared id');
  assert(plain.includes('phase_early') && plain.includes('man_even') && plain.includes('unplanted'));
  assert(plain.includes('eco_even'), 'no equipment gap is an even economy');

  const clutch = bucketizeRound(
    f({ ctAlive: 1, tAlive: 3, ctEff: 1, tEff: 3, planted: true, equipDiff: -0.5 }),
    'late'
  );
  for (const want of ['phase_late', 'man_t_up', 'planted', 'eco_t', 'clutch']) {
    assert(clutch.includes(want), `expected ${want}, got ${clutch.join(',')}`);
  }
  // A 2v1 is a clutch; a 5v5 is not.
  assert(!bucketizeRound(f(), 'late').includes('clutch'), 'an even round is not a clutch');
}

// --- sigmoid ----------------------------------------------------------------
{
  assert(close(sigmoid(0), 0.5), 'sigmoid(0)');
  assert(sigmoid(800) > 0.999999 && Number.isFinite(sigmoid(-800)), 'no overflow either way');
  assert(close(predictRound(f(), initialVector(), ''), sigmoid(roundLogit(f(), initialVector(), ''))));
}

console.log('roundModel.test.js: ok');
