// ---------------------------------------------------------------------------
// replays/rounds/roundModel.js
// Who wins this round.
//
// Additive in log-odds, like the duel model and like coach/winProbability
// before it, because percentages do not compose: two edges each "worth ten
// points" cannot both be added to a round already at 90%, but their log-odds
// add cleanly and saturate on their own.
//
// The one thing worth saying about the shape: this model is not antisymmetric.
// The duel model had to be, because swapping two players is the same fight seen
// from the other end. Swapping T and CT is not the same round. They buy
// different guns, one of them has to plant a bomb and the other has to stop
// them, and the win rates differ by map. So there is a bias, there are per-map
// priors, and the plant terms are frankly one-sided.
//
// Output is P(CT wins).
//
// DOM-free: the trainer scores with it, the viewer can draw with it.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { DEFUSE_KIT_DEADLINE, DEFUSE_NO_KIT_DEADLINE } from '../coach/winProbability.js';
import { PRIOR_MAPS, ROUND_PARAM_INDEX } from './roundParamSpec.js';

const P = ROUND_PARAM_INDEX;

const MAP_PARAM = Object.fromEntries(PRIOR_MAPS.map((m) => [m, P[`map_${m}`]]));

export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

const sat = (x) => Math.tanh(x);

/**
 * Round win log-odds for CT.
 *
 * @param {import('./roundFeatures.js').RoundFeatures} f
 * @param {Float64Array} v
 * @param {string} [mapCode]
 * @returns {number} positive favours CT
 */
export function roundLogit(f, v, mapCode = '') {
  let z = v[P.bias];
  const mp = MAP_PARAM[mapCode];
  if (mp !== undefined) z += v[mp];

  // --- bodies --------------------------------------------------------------
  // Shallow on the first man, steeper after, saturating at the end. The power
  // is applied to the magnitude and the sign put back afterwards, because a
  // fractional power of a negative number is not a number.
  const menDiff = f.ctAlive - f.tAlive;
  if (menDiff !== 0) {
    const size = Math.pow(Math.abs(menDiff) / v[P.manTau], v[P.manPow]);
    z += v[P.manW] * Math.sign(menDiff) * sat(size);
    // The same gap against a thinner server. One man up out of nine bodies is a
    // 5v4 and worth about 68%; one man up out of three is a 2v1 and worth about
    // 84%. Without this the model cannot tell those apart.
    z += v[P.manShareW] * (menDiff / Math.max(1, f.ctAlive + f.tAlive));
  }

  // Health beyond the body count. `ctEff` is the health-weighted body count, so
  // the gap between it and the raw count is how hurt that side is; the model
  // reads the difference of the two sides' damage, not their absolute health.
  const ctHurt = f.ctAlive - f.ctEff;
  const tHurt = f.tAlive - f.tEff;
  z += v[P.hpW] * (tHurt - ctHurt);

  // Down to one player, with nobody to trade with.
  //
  // `<= 1` rather than `=== 1` on purpose. Firing only at exactly one left put
  // a step in the curve at the wipe: 5v1 collected this bonus and 5v0 did not,
  // so the model rated a wiped enemy *worse* for CT than a live last man. With
  // the previously fitted values that was 4.48 against 3.28, and it landed
  // squarely on the post-plant 5v0 moments the extraction censoring fix had
  // just added. A side with none left is not better off than a side with one.
  if (f.ctAlive <= 1 && f.tAlive > 1) z -= v[P.lastManW];
  if (f.tAlive <= 1 && f.ctAlive > 1) z += v[P.lastManW];

  // --- fights already in progress -----------------------------------------
  z += v[P.duelW] * sat(f.duelEdge / v[P.duelTau]);

  // --- economy, utility, map control --------------------------------------
  z += v[P.equipW] * sat(f.equipDiff / v[P.equipTau]);
  z += v[P.utilW] * sat(f.utilDiff / v[P.utilTau]);
  z += v[P.possW] * f.possessionDiff;

  // --- where they are standing --------------------------------------------
  z += v[P.centroidW] * sat(f.centroidDist);
  z += v[P.nearestW] * sat(f.nearestDist);

  // --- who is holding the ground around the bomb ---------------------------
  // Bodies in the live bombsite, and possession of the zones that lead into it.
  // Both read before a plant as well as after: a site that has been taken is a
  // site, whether or not the bomb is down yet.
  z += v[P.siteOccW] * ((f.ctInSite || 0) - (f.tInSite || 0));
  z += v[P.keyZoneW] * (f.keyZoneNet || 0);

  // --- the clock -----------------------------------------------------------
  if (!f.planted) {
    // Time spent without a plant is time the T side is running out of, so this
    // only ever helps CT. Applied as a rising power of elapsed share.
    const spent = Math.min(1, Math.max(0, 1 - f.secondsLeft / ROUND_SECONDS));
    z += v[P.timeW] * Math.pow(spent, v[P.timePow]);

    // How far the T side still is from the site it is converging on. Context
    // rather than advantage, like the centroid distance, so the sign is left to
    // the data.
    z += v[P.approachDistW] * sat(f.tBombDist || 0);
  } else {
    z += v[P.plantW];

    // Bomb timer: the closer to detonation, the less any of the CT's advantages
    // can be spent on anything other than the defuse.
    const left = Math.max(0, f.bombSecondsLeft);
    const burned = Math.min(1, Math.max(0, 1 - left / 40));
    z += v[P.bombW] * Math.pow(burned, v[P.bombPow]);

    if (f.ctHasKit) z += v[P.kitW];

    // Not enough time left to finish a defuse at all, kit or no kit. This is a
    // fact about the clock rather than a tendency, which is why it gets its own
    // term instead of being left to the timer curve to approximate.
    const deadline = f.ctHasKit ? DEFUSE_KIT_DEADLINE : DEFUSE_NO_KIT_DEADLINE;
    if (left > 0 && left < deadline) z += v[P.noDefuseW];

    // --- the race for the bomb ---------------------------------------------
    // Who is closer to it, and who wins the fight over it. The bomb duel is the
    // retake in miniature and is a different question from the average of every
    // open duel on the map, which is why it is weighted separately.
    z += v[P.bombDistW] * sat(f.bombDistDiff || 0);
    z += v[P.bombDuelW] * (f.bombDuelEdge || 0);

    // Travel plus defuse against the clock. Saturating on the way out, because
    // the seconds either side of zero carry the whole signal: twenty spare
    // seconds and thirty are both just "there is time".
    z += v[P.defuseSlackW] * sat((f.defuseSlack || 0) / v[P.defuseSlackTau]);

    // And the hard version of the same fact: the defuse cannot happen at all,
    // whoever is alive and wherever they are standing. Five players cannot
    // defuse faster than one, so this holds at 5v0 exactly as it does at 1v0.
    if (f.defuseImpossible) z += v[P.defuseImpossibleW];
  }

  return z;
}

/**
 * P(CT wins the round).
 *
 * @param {import('./roundFeatures.js').RoundFeatures} f
 * @param {Float64Array} v
 * @param {string} [mapCode]
 */
export function predictRound(f, v, mapCode = '') {
  return sigmoid(roundLogit(f, v, mapCode));
}
