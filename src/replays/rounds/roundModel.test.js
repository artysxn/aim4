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
import { FLAG_ALIVE } from '../shared/tickFormat.js';
import { bombRaceAt } from './bombRace.js';
import { isAlive, livingSide } from './stateReading.js';

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
    bombDuelEdge: 0,
    ctBombDist: 0.5,
    tBombDist: 0.5,
    bombDistDiff: 0,
    ctInSite: 0,
    tInSite: 0,
    keyZoneNet: 0,
    defuseSlack: 0,
    defuseImpossible: false,
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
  // Monotone the whole way out and symmetric about even, whatever shape the
  // power puts on the curve.
  for (let n = 4; n >= 1; n--) {
    assert(
      predictRound(f({ tAlive: n - 1, tEff: n - 1 }), v, 'MIR') >
        predictRound(f({ tAlive: n, tEff: n }), v, 'MIR'),
      `5v${n - 1} should beat 5v${n} for CT`
    );
    assert(
      predictRound(f({ ctAlive: n - 1, ctEff: n - 1 }), v, 'MIR') <
        predictRound(f({ ctAlive: n, ctEff: n }), v, 'MIR'),
      `${n - 1}v5 should be worse than ${n}v5 for CT`
    );
  }

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

  // --- the race for the bomb ----------------------------------------------
  // Everything about defusing is meaningless until there is something to
  // defuse, so none of it may move the number before a plant.
  assert(
    close(
      predictRound(
        f({ bombDistDiff: 1, bombDuelEdge: 1, defuseSlack: 15, defuseImpossible: true }),
        v,
        'MIR'
      ),
      predictRound(f(), v, 'MIR')
    ),
    'the bomb race must do nothing before a plant'
  );

  // A plant with the clock still open, as the baseline for the terms below.
  const race = f({ planted: true, bombSecondsLeft: 35, secondsLeft: 0, defuseSlack: 10 });
  const raceP = predictRound(race, v, 'MIR');
  assert(
    predictRound({ ...race, bombDuelEdge: 1 }, v, 'MIR') >= raceP,
    'winning the fight over the bomb should not hurt CT'
  );
  assert(
    predictRound({ ...race, bombDuelEdge: -1 }, v, 'MIR') <= raceP,
    'losing the fight over the bomb should not help CT'
  );
  assert(
    predictRound({ ...race, defuseSlack: 20 }, v, 'MIR') >= raceP,
    'more spare seconds should not hurt CT'
  );
  assert(
    predictRound({ ...race, defuseSlack: -5 }, v, 'MIR') <= raceP,
    'running short of the defuse should not help CT'
  );

  // The whole point of the term: a defuse that physically cannot happen. Five
  // players cannot defuse faster than one, so a full CT side with the bomb
  // ticking out of reach must still read as a round already lost, and must read
  // worse than the same five players with time to work with.
  const doomed = f({
    planted: true,
    bombSecondsLeft: 9.9,
    secondsLeft: 0,
    ctHasKit: false,
    ctAlive: 5,
    tAlive: 0,
    ctEff: 5,
    tEff: 0,
    defuseSlack: -12,
    defuseImpossible: true,
    ctBombDist: 1.6,
    tBombDist: 0
  });
  const reachable = { ...doomed, bombSecondsLeft: 40, defuseSlack: 15, defuseImpossible: false };
  assert(
    predictRound(doomed, v, 'MIR') < predictRound(reachable, v, 'MIR'),
    'an impossible defuse must read worse than a reachable one at the same 5v0'
  );
  // The flag itself may fit to zero: defuseSlack and the deadline term carry
  // the same fact in continuous form, and training is free to prefer them. The
  // structural guarantee is only that the flag can never point the wrong way.
  assert(
    predictRound(doomed, v, 'MIR') <=
      predictRound({ ...doomed, defuseImpossible: false }, v, 'MIR'),
    'the impossible-defuse flag must never help CT'
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

// --- kill-log stub states ---------------------------------------------------
// The stats index and the round-decided detector build states from the kill log
// alone: `{ alive, health }`, no flags and no coordinates. That used to make
// every player read as dead, which made the bomb race declare the defuse
// impossible, which scored every post-plant moment as a certain T win. The
// guarantee is that missing geometry reads as no information.
{
  const players = [
    { id: 'a1', slot: 0, team: 1 },
    { id: 'a2', slot: 1, team: 1 },
    { id: 'b1', slot: 5, team: 2 },
    { id: 'b2', slot: 6, team: 2 }
  ];
  const teamSides = { 1: 'CT', 2: 'T' };
  const stubs = [];
  stubs[0] = { alive: true, health: 100 };
  stubs[1] = { alive: true, health: 100 };
  stubs[5] = { alive: true, health: 100 };
  stubs[6] = { alive: true, health: 100 };

  for (const side of ['CT', 'T']) {
    const live = livingSide(players, stubs, teamSides, new Set(), side);
    assert(live.all.length === 2, `${side}: stubs must read as alive`);
    assert(live.positioned.length === 0, `${side}: stubs have no positions`);
    assert(live.geometryKnown === false, `${side}: geometry must read as unknown`);
  }

  // Real tick records, by contrast, are fully positioned.
  const ticks = [];
  ticks[0] = { flags: FLAG_ALIVE, health: 100, x: 10, y: 20 };
  ticks[5] = { flags: FLAG_ALIVE, health: 100, x: 30, y: 40 };
  const realCt = livingSide(players, ticks, teamSides, new Set(['a2']), 'CT');
  assert(realCt.geometryKnown === true, 'tick records must read as positioned');

  // A dead player is dead in both representations.
  assert(!isAlive({ alive: false, health: 100 }), 'stub dead');
  assert(!isAlive({ alive: true, health: 0 }), 'stub at zero hp');
  assert(!isAlive({ flags: 0, health: 100 }), 'record without the alive flag');
  assert(isAlive({ flags: FLAG_ALIVE, health: 1 }), 'record alive on one hp');

  // The bomb race must stay neutral rather than invent a verdict.
  const race = bombRaceAt({
    meta: { players, events: { bomb: [{ type: 'planted', tick: 0, x: 100, y: 100, site: 'a' }] } },
    states: stubs,
    tick: 500,
    network: { bombSites: { a: null, b: null }, keyZones: { a: [], b: [] } },
    deadIds: new Set(),
    teamSides,
    bombSecondsLeft: 9.9,
    ctHasKit: false
  });
  assert(race.defuseImpossible === false, 'an unseen defuse is not an impossible one');
  assert(race.geometryKnown === false, 'the race must admit it cannot see');
  assert(race.ctBombDist === 0 && race.bombDistDiff === 0, 'unknown distances are neutral');

  // And the whole point: the prediction must not collapse to a certain T win.
  for (const v of [initialVector(), roundParamVector()]) {
    const blind = f({
      planted: true,
      bombSecondsLeft: 9.9,
      ctHasKit: false,
      ctAlive: 5,
      tAlive: 0,
      ctEff: 5,
      tEff: 0,
      secondsLeft: 0,
      defuseSlack: 0,
      defuseImpossible: false,
      ctBombDist: 0,
      tBombDist: 0,
      bombDistDiff: 0,
      duelEdge: 0,
      bombDuelEdge: 0
    });
    const p = predictRound(blind, v, 'MIR');
    assert(p > 0.02, `a blind post-plant 5v0 must not read as hopeless for CT (got ${p})`);
  }
}

console.log('roundModel.test.js: ok');
