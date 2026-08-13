// ---------------------------------------------------------------------------
// shared/sim/objective.js
// What a bot is trying to do, and how it knows whether it is working.
//
// A bot's goal is to WIN THE ROUND. Not to get kills, not to hold an angle, not
// to take map control. Those are all things that sometimes raise the chance of
// winning and sometimes lower it, and a bot that pursues any of them as an end
// plays badly in a specific, recognizable way: an xK-maximizing bot never
// enters a site, because entering is always a worse fight than holding.
//
// There are exactly four ways a round ends in a win, and every action a bot can
// take is worth something only insofar as it moves one of them:
//
//   ELIMINATE   kill everyone on the other side
//   PLANT       get the bomb down, then survive the timer (T)
//   DEFUSE      cut the wire before it runs out (CT)
//   TIME        deny the plant until the clock expires (CT)
//
// So the value of a kill is not a kill. It is the difference between the round
// win probability with that enemy alive and with them dead, which is large in a
// 1v1 and small in a 5v1, and which is exactly what makes trading correct and
// farming incorrect. The same is true of the plant, the defuse, and the clock.
//
// The probabilities come from the site's own fitted round model, so a bot's
// idea of "am I winning" and the analytics' idea are the same number. That
// matters more than accuracy: a second, differently-fitted model would make the
// coach's read of a sim round disagree with the bot's read of it while the round
// was happening, and there would be no way to tell which was wrong.
//
// SIM-PLAN decision 11: bots maximize PRW. xK is a feature and a metric, never
// a target.
// ---------------------------------------------------------------------------

import { BOMB_SECONDS, ROUND_SECONDS, TICK_RATE } from './constants.js';

/** The four ways to win, named so a bot's motive string can say which. */
export const WIN_BY = Object.freeze({
  ELIMINATE: 'eliminate',
  PLANT: 'plant',
  DEFUSE: 'defuse',
  TIME: 'time'
});

/**
 * Which win conditions are still available to a side, right now.
 *
 * Being explicit about this is worth more than it looks. A T side after a plant
 * cannot win on time and does not need to kill anybody; a CT side after a plant
 * cannot win on time either, and must either defuse or wipe. Bots that do not
 * represent this play the same round before and after the bomb goes down, which
 * is the most common way an FPS bot looks stupid.
 */
export function availableWins(state, side) {
  const planted = state.bomb.planted;
  if (side === 'T') {
    return planted ? [WIN_BY.PLANT, WIN_BY.ELIMINATE] : [WIN_BY.ELIMINATE, WIN_BY.PLANT];
  }
  return planted ? [WIN_BY.DEFUSE, WIN_BY.ELIMINATE] : [WIN_BY.ELIMINATE, WIN_BY.TIME];
}

/**
 * Round state as the fitted model's feature bag.
 *
 * Deliberately built from engine state rather than from belief, because this is
 * used two ways and only one of them is a bot's own view: the trainer prices a
 * finished round with god-view features (which is legal, it never reaches an
 * actor), and a bot prices a hypothetical with features drawn from its belief.
 * Same function, different inputs, which is why it takes plain numbers.
 */
export function roundFeatures({
  ctAlive,
  tAlive,
  ctEff = ctAlive,
  tEff = tAlive,
  planted = false,
  secondsLeft = ROUND_SECONDS,
  bombSecondsLeft = BOMB_SECONDS,
  equipDiff = 0,
  utilDiff = 0,
  possessionDiff = 0,
  hasKit = false,
  ctInSite = 0,
  tInSite = 0
}) {
  return {
    ctAlive,
    tAlive,
    ctEff,
    tEff,
    planted,
    secondsLeft: planted ? bombSecondsLeft : secondsLeft,
    duelEdge: 0,
    equipDiff,
    utilDiff,
    possessionDiff,
    centroidDist: 0,
    nearestDist: 0,
    ctInSite,
    tInSite,
    keyZoneNet: 0,
    hasKit,
    geometryKnown: false
  };
}

/**
 * P(this side wins), 0..1, from the shipped model when it is available.
 *
 * `predictRoundCalibrated` lives in the analytics stack and pulls in fitted
 * parameters, so it is injected rather than imported: the engine must stay
 * loadable without the model, and a trainer that has it gets a sharper number
 * than one that does not. The fallback is deliberately crude and deliberately
 * monotone in the things that matter, so a bot without the model still prefers
 * being alive, being up a man, and having the bomb down.
 */
export function winProbability(features, side, model = null) {
  let ct;
  if (model) {
    ct = model(features);
  } else {
    ct = fallbackCtWin(features);
  }
  ct = Math.max(0, Math.min(1, ct));
  return side === 'CT' ? ct : 1 - ct;
}

/**
 * A model-free estimate, monotone in exactly the four win conditions.
 *
 * Not a substitute for the fitted model and not calibrated against anything.
 * Its job is to be right about the SIGN of every decision a bot makes: killing
 * an enemy helps, dying hurts, planting helps the T, the clock helps the CT
 * before a plant and the T after one. A bot trained against this alone would be
 * mediocre; a bot trained against something non-monotone would be broken.
 */
export function fallbackCtWin(f) {
  const ct = Math.max(0, f.ctAlive);
  const t = Math.max(0, f.tAlive);

  // Wipes are certainties, and they must be exactly 0 or 1 or a bot will keep
  // playing a round it has already won.
  if (t === 0 && !f.planted) return 1;
  if (ct === 0) return 0;

  // Man advantage, as a share rather than a difference: one man up in a 2v1 is
  // worth far more than one man up in a 5v4, and a model that cannot tell those
  // apart cannot price a trade.
  const total = ct + t;
  let z = 2.6 * ((ct - t) / Math.max(1, total));

  // Health, beyond the body count.
  z += 0.5 * ((f.ctEff - ct) - (f.tEff - t));

  if (f.planted) {
    // The bomb is down: the CT must defuse or wipe, and the clock is now the
    // T side's friend. A kit is most of the difference between those.
    z -= 1.5;
    const left = Math.max(0, f.secondsLeft) / BOMB_SECONDS;
    const needed = f.hasKit ? 5 : 10;
    z -= 2.2 * (1 - Math.min(1, (left * BOMB_SECONDS) / (needed + 4)));
  } else {
    // No plant: time spent is time the T side is running out of.
    const spent = Math.min(1, Math.max(0, 1 - f.secondsLeft / ROUND_SECONDS));
    z += 1.4 * spent * spent;
  }

  z += 0.6 * (f.equipDiff || 0);
  z += 0.4 * (f.utilDiff || 0);
  z += 0.8 * (f.possessionDiff || 0);

  return 1 / (1 + Math.exp(-z));
}

/**
 * How much a thing is worth: the change in win probability it causes.
 *
 * This is the only currency in the system. Every option a bot considers is
 * priced by asking what the round looks like afterwards, which is why the same
 * function answers "is this kill worth dying for" and "should I plant here".
 */
export function deltaWin(before, after, side, model = null) {
  return winProbability(after, side, model) - winProbability(before, side, model);
}

/**
 * The value of each win condition from here, so a bot can say which one it is
 * playing for. This is what a motive string is built from, and it is why a
 * bot's decision log can read "planting: +0.31" rather than "action 7".
 */
export function winPaths(features, side, model = null) {
  const now = winProbability(features, side, model);
  const out = [];

  for (const path of availableWins({ bomb: { planted: features.planted } }, side)) {
    let after = null;
    switch (path) {
      case WIN_BY.ELIMINATE:
        after = { ...features, [side === 'T' ? 'ctAlive' : 'tAlive']: 0 };
        after[side === 'T' ? 'ctEff' : 'tEff'] = 0;
        break;
      case WIN_BY.PLANT:
        after = features.planted ? features : { ...features, planted: true, secondsLeft: BOMB_SECONDS };
        break;
      case WIN_BY.DEFUSE:
        after = { ...features, planted: false, tAlive: features.tAlive };
        break;
      case WIN_BY.TIME:
        after = { ...features, secondsLeft: 0 };
        break;
      default:
        after = features;
    }
    out.push({ path, value: winProbability(after, side, model) - now });
  }

  return out.sort((a, b) => b.value - a.value);
}

/**
 * What killing this enemy is worth, right now.
 *
 * The number a bot needs in order to understand that a kill is not the point.
 * In a 5v5 it is small; in a 1v1 it is the round. That difference is the whole
 * reason trading is correct and baiting is not, and it is not something a bot
 * has to be told: it falls out of asking the question properly.
 */
export function valueOfKill(features, side, model = null) {
  const key = side === 'T' ? 'ctAlive' : 'tAlive';
  const effKey = side === 'T' ? 'ctEff' : 'tEff';
  if (features[key] <= 0) return 0;
  const after = {
    ...features,
    [key]: features[key] - 1,
    [effKey]: Math.max(0, features[effKey] - 1)
  };
  return deltaWin(features, after, side, model);
}

/** What dying costs, which is not the same magnitude as what killing gains. */
export function costOfDeath(features, side, model = null) {
  const key = side === 'T' ? 'tAlive' : 'ctAlive';
  const effKey = side === 'T' ? 'tEff' : 'ctEff';
  if (features[key] <= 0) return 0;
  const after = {
    ...features,
    [key]: features[key] - 1,
    [effKey]: Math.max(0, features[effKey] - 1)
  };
  return -deltaWin(features, after, side, model);
}

/** What getting the bomb down is worth from here. */
export function valueOfPlant(features, model = null) {
  if (features.planted) return 0;
  const after = { ...features, planted: true, secondsLeft: BOMB_SECONDS };
  return deltaWin(features, after, 'T', model);
}

/** What defusing is worth, which is the round when the bomb is down. */
export function valueOfDefuse(features, model = null) {
  if (!features.planted) return 0;
  const after = { ...features, planted: false, secondsLeft: 1 };
  return deltaWin(features, after, 'CT', model);
}

/**
 * Build the feature bag straight from a live engine.
 *
 * God-view, and therefore for the trainer, the reward, and the inspector rather
 * than for an actor. A bot prices its own options from belief-derived features
 * (SIM-PLAN 9.5 is explicit that the two must not be conflated, because they
 * will otherwise be written by the same person on the same afternoon).
 */
export function featuresFromEngine(engine) {
  const s = engine.state;
  let ctAlive = 0;
  let tAlive = 0;
  let ctEff = 0;
  let tEff = 0;
  let hasKit = false;

  for (const b of s.bodies) {
    if (!b.alive) continue;
    const eff = b.health / 100;
    if (b.side === 'CT') {
      ctAlive += 1;
      ctEff += eff;
      if (b.hasKit) hasKit = true;
    } else {
      tAlive += 1;
      tEff += eff;
    }
  }

  const secondsLeft = engine.clock();
  return roundFeatures({
    ctAlive,
    tAlive,
    ctEff,
    tEff,
    planted: s.bomb.planted,
    secondsLeft: s.bomb.planted ? ROUND_SECONDS : secondsLeft,
    bombSecondsLeft: s.bomb.planted ? secondsLeft : BOMB_SECONDS,
    hasKit
  });
}

/** Seconds of round left, as the model wants it. */
export function secondsLeft(engine) {
  return Math.max(0, engine.clock());
}

export { TICK_RATE };
