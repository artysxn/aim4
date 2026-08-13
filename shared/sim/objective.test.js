// Run: node shared/sim/objective.test.js
//
// This file checks that a bot's goal is coherent, which is a lower bar than
// "accurate" and a much more important one. The estimate does not have to be
// calibrated to be useful, but it does have to be right about the SIGN and the
// ORDER of every decision, because those are what a policy optimizes against:
//
//   winning is the four win conditions and nothing else
//   a kill is worth what it changes, so it is worth far more in a 1v1 than in
//     a 5v5, which is what makes trading correct and farming incorrect
//   the plant flips which side the clock belongs to
//   a wipe is a certainty, not a high probability
//
// A model that is wrong about accuracy trains a mediocre bot. A model that is
// wrong about one of these trains a broken one.

import { BOMB_SECONDS, ROUND_SECONDS } from './constants.js';
import {
  WIN_BY,
  availableWins,
  costOfDeath,
  fallbackCtWin,
  roundFeatures,
  valueOfDefuse,
  valueOfKill,
  valueOfPlant,
  winPaths,
  winProbability
} from './objective.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const f = (over = {}) => roundFeatures({ ctAlive: 5, tAlive: 5, ...over });

// ---- the four win conditions ------------------------------------------------

{
  const preT = availableWins({ bomb: { planted: false } }, 'T');
  assert(preT.includes(WIN_BY.ELIMINATE) && preT.includes(WIN_BY.PLANT), 'a T can wipe or plant');
  assert(!preT.includes(WIN_BY.TIME), 'and can never win on time');

  const preCt = availableWins({ bomb: { planted: false } }, 'CT');
  assert(preCt.includes(WIN_BY.TIME), 'a CT can win on time before a plant');

  const postCt = availableWins({ bomb: { planted: true } }, 'CT');
  assert(!postCt.includes(WIN_BY.TIME), 'but not once the bomb is down');
  assert(postCt.includes(WIN_BY.DEFUSE), 'after a plant the CT must defuse or wipe');

  const postT = availableWins({ bomb: { planted: true } }, 'T');
  assert(!postT.includes(WIN_BY.TIME), 'and the T still cannot win on time, it wins on the bomb');
}

// ---- a decided round is decided ---------------------------------------------

{
  assert(fallbackCtWin(f({ tAlive: 0, tEff: 0 })) === 1, 'wiping the Ts is a certainty, not 0.97');
  assert(fallbackCtWin(f({ ctAlive: 0, ctEff: 0 })) === 0, 'and so is being wiped');
  // With the bomb down, killing the last T does not end it.
  assert(
    fallbackCtWin(f({ tAlive: 0, tEff: 0, planted: true })) < 1,
    'but not while a planted bomb is still ticking'
  );
}

// ---- more men is better, and the effect is not linear -----------------------

{
  const even = winProbability(f(), 'CT');
  assert(Math.abs(even - 0.5) < 0.05, `a 5v5 is about even (${even.toFixed(3)})`);

  const up = winProbability(f({ ctAlive: 5, tAlive: 4, tEff: 4 }), 'CT');
  assert(up > even, 'a man up is better');

  const down = winProbability(f({ ctAlive: 4, ctEff: 4 }), 'CT');
  assert(down < even, 'and a man down is worse');

  // The share matters, not just the difference. One up in a 2v1 is a much
  // bigger deal than one up in a 5v4, and a model that cannot tell those apart
  // cannot price a trade.
  const fiveFour = winProbability(f({ ctAlive: 5, tAlive: 4, ctEff: 5, tEff: 4 }), 'CT');
  const twoOne = winProbability(f({ ctAlive: 2, tAlive: 1, ctEff: 2, tEff: 1 }), 'CT');
  assert(twoOne > fiveFour, `2v1 is worth more than 5v4 (${twoOne.toFixed(3)} vs ${fiveFour.toFixed(3)})`);
}

// ---- a kill is worth what it changes ----------------------------------------

{
  const inFive = valueOfKill(f(), 'CT');
  const inTwo = valueOfKill(f({ ctAlive: 2, tAlive: 2, ctEff: 2, tEff: 2 }), 'CT');
  const lastOne = valueOfKill(f({ ctAlive: 1, tAlive: 1, ctEff: 1, tEff: 1 }), 'CT');

  assert(inFive > 0, 'killing someone is always worth something');
  assert(inTwo > inFive, `a kill in a 2v2 beats one in a 5v5 (${inTwo.toFixed(3)} vs ${inFive.toFixed(3)})`);
  assert(lastOne > inTwo, 'and the last one is the round');
  assert(Math.abs(lastOne - (1 - winProbability(f({ ctAlive: 1, tAlive: 1, ctEff: 1, tEff: 1 }), 'CT'))) < 0.5,
    'winning the 1v1 is worth roughly the rest of the round');

  // This is the property that makes farming incorrect: the fifth kill of a
  // round is worth far more than the first, so a bot that trades early and
  // converts late is playing correctly and one that hunts for kills is not.
  assert(valueOfKill(f({ ctAlive: 5, tAlive: 1, ctEff: 5, tEff: 1 }), 'CT') > inFive,
    'the closing kill is worth more than an opening one');

  assert(valueOfKill(f({ tAlive: 0, tEff: 0 }), 'CT') === 0, 'and there is nothing to gain from a wiped side');
}

{
  // Dying costs something, and it costs more when there are fewer of you.
  const deathInFive = costOfDeath(f(), 'CT');
  const deathInTwo = costOfDeath(f({ ctAlive: 2, tAlive: 2, ctEff: 2, tEff: 2 }), 'CT');
  assert(deathInFive > 0, 'dying is bad');
  assert(deathInTwo > deathInFive, 'and worse when the team is small');
}

// ---- the plant flips the clock ----------------------------------------------

{
  const late = f({ secondsLeft: 20 });
  const beforePlant = winProbability(late, 'T');
  const afterPlant = winProbability({ ...late, planted: true, secondsLeft: BOMB_SECONDS }, 'T');
  assert(afterPlant > beforePlant, 'planting late is a big gain for the T');
  assert(valueOfPlant(late) > 0.1, `and the model says so (${valueOfPlant(late).toFixed(3)})`);

  // Before a plant the clock runs against the T; after it, against the CT.
  const early = winProbability(f({ secondsLeft: ROUND_SECONDS }), 'T');
  const nearlyOut = winProbability(f({ secondsLeft: 5 }), 'T');
  assert(early > nearlyOut, 'time hurts the T before a plant');

  const bombFresh = winProbability(f({ planted: true, bombSecondsLeft: 38 }), 'T');
  const bombNearly = winProbability(f({ planted: true, bombSecondsLeft: 3 }), 'T');
  assert(bombNearly > bombFresh, 'and helps them after one');
}

{
  // A defuse is the round, and a kit is worth real probability.
  const down = f({ planted: true, bombSecondsLeft: 8 });
  assert(valueOfDefuse(down) > 0.2, `defusing is worth a lot (${valueOfDefuse(down).toFixed(3)})`);
  assert(valueOfDefuse(f()) === 0, 'and nothing at all when there is no bomb down');

  const withKit = winProbability(f({ planted: true, bombSecondsLeft: 8, hasKit: true }), 'CT');
  const without = winProbability(f({ planted: true, bombSecondsLeft: 8, hasKit: false }), 'CT');
  assert(withKit > without, 'a kit is worth probability when the clock is tight');
}

// ---- the paths a bot can name -----------------------------------------------

{
  const paths = winPaths(f({ ctAlive: 5, tAlive: 1, ctEff: 5, tEff: 1 }), 'CT');
  assert(paths[0].path === WIN_BY.ELIMINATE, 'five against one should be looking to eliminate');
  assert(paths.every((p) => p.value >= -1 && p.value <= 1), 'every path is a probability change');

  const tPaths = winPaths(f({ secondsLeft: 25 }), 'T');
  assert(tPaths.some((p) => p.path === WIN_BY.PLANT), 'a T side always has the plant available');
  assert(!tPaths.some((p) => p.path === WIN_BY.TIME), 'and never the clock');
}

// ---- equipment, utility, and ground all point the right way -----------------

{
  const base = winProbability(f(), 'CT');
  assert(winProbability(f({ equipDiff: 1 }), 'CT') > base, 'better guns help');
  assert(winProbability(f({ utilDiff: 1 }), 'CT') > base, 'more utility helps');
  assert(winProbability(f({ possessionDiff: 0.5 }), 'CT') > base, 'and so does holding ground');
  assert(winProbability(f({ possessionDiff: -0.5 }), 'CT') < base, 'losing it does the opposite');
}

// ---- the fitted model can be swapped in -------------------------------------

{
  // The point of the injection: a trainer with the shipped model gets its
  // numbers, and a bot's read of the round and the coach's read of the same
  // round are then the same number rather than two similar ones.
  const alwaysCt = () => 0.9;
  assert(Math.abs(winProbability(f(), 'CT', alwaysCt) - 0.9) < 1e-9, 'an injected model is used');
  assert(Math.abs(winProbability(f(), 'T', alwaysCt) - 0.1) < 1e-9, 'and read from the other side');
  assert(winProbability(f(), 'CT', () => 5) === 1, 'and clamped to a probability');
}

console.log('objective: ok');
