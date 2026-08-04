// ---------------------------------------------------------------------------
// replays/duels/duelModel.js
// Who wins this fight.
//
// Everything composes in log-odds, for the same reason winProbability.js does:
// percentages do not add up. Two independent edges worth "plus ten percent"
// cannot both be applied to a fight already at 90%, but the log-odds they
// correspond to add cleanly and saturate on their own at the ends. So every
// term below is an additive contribution to a logit, and the only place a
// probability appears is the sigmoid at the very end.
//
// Two stages:
//
//   1. The pair on its own. Each player gets a lethality score from their
//      crosshair, gun, range, movement, health, flash and reload state. The
//      duel's logit is the difference between the two scores, which makes the
//      whole thing antisymmetric by construction: swapping the players negates
//      the logit, so P(a) + P(b) is exactly 1 and can never drift.
//
//   2. The rest of the map. A duel you are winning is a duel you lose when a
//      second enemy is also watching you, and how much depends on whether that
//      enemy stands beside the first or across the map from them. Both
//      adjustments are applied as a difference between the two sides, so stage
//      two preserves the antisymmetry stage one established.
//
// Every coefficient is fitted. Nothing here is a hand-picked constant, and the
// starting values in paramSpec are only somewhere to begin.
//
// DOM-free: the trainer scores with it, the viewer draws with it.
// ---------------------------------------------------------------------------

import { RUN_SPEED } from './duelFeatures.js';
import { CURVE_CATEGORIES, DIST_KNOTS, PARAM_INDEX } from './paramSpec.js';

const P = PARAM_INDEX;

/** Category offset parameter per weapon class. */
const CAT_PARAM = {
  pistol: P.catPistol,
  smg: P.catSmg,
  shotgun: P.catShotgun,
  rifle: P.catRifle,
  sniper: P.catSniper,
  lmg: P.catLmg,
  knife: P.catKnife,
  other: P.catOther
};

/** First knot index of each class's distance curve. */
const DIST_BASE = Object.fromEntries(
  CURVE_CATEGORIES.map((cat) => [cat, P[`dist_${cat}_0`]])
);
const MOVE_PARAM = Object.fromEntries(
  CURVE_CATEGORIES.map((cat) => [cat, P[`move_${cat}`]])
);

/** Classes with no curve of their own borrow the nearest one that has shape. */
const CURVE_FALLBACK = { lmg: 'rifle', knife: 'pistol', other: 'pistol' };

export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Smooth, saturating map from any real number to (-1, 1). */
function sat(x) {
  return Math.tanh(x);
}

/** Piecewise-linear interpolation of a class's range curve at `dist`. */
function distanceTerm(v, category, dist) {
  const cat = CURVE_FALLBACK[category] || category;
  const base = DIST_BASE[cat];
  if (base === undefined) return 0;
  if (dist <= DIST_KNOTS[0]) return v[base];
  const last = DIST_KNOTS.length - 1;
  if (dist >= DIST_KNOTS[last]) return v[base + last];
  for (let i = 0; i < last; i++) {
    const lo = DIST_KNOTS[i];
    const hi = DIST_KNOTS[i + 1];
    if (dist <= hi) {
      const t = (dist - lo) / (hi - lo);
      return v[base + i] * (1 - t) + v[base + i + 1] * t;
    }
  }
  return v[base + last];
}

/**
 * How dangerous one player is to another right now, in log-odds.
 *
 * Read on its own this is "how likely is this player to land the shot that
 * matters"; the duel logit is the difference between the two players' scores,
 * so any term that applies equally to both cancels out and costs nothing.
 *
 * @param {import('./duelFeatures.js').PlayerFeatures} me
 * @param {import('./duelFeatures.js').PlayerFeatures} foe
 * @param {number} off    my crosshair error toward the foe, degrees
 * @param {number} dist   world units between us
 * @param {Float64Array} v
 */
export function threatScore(me, foe, off, dist, v) {
  let s = 0;

  // Crosshair placement. The steepness and the falloff shape are both fitted,
  // which is what lets one degree matter far more than the next fifty.
  s += v[P.crossW] * Math.exp(-Math.pow(Math.max(0, off) / v[P.crossSigma], v[P.crossPow]));

  // Weapon: class offset, absolute value, range curve for that class.
  s += v[CAT_PARAM[me.category] ?? P.catOther];
  s += v[P.valW] * Math.log(Math.max(50, me.price) / 500);
  s += distanceTerm(v, me.category, dist);

  // Movement. Scaled per class because a running SMG is barely affected and a
  // running AWP may as well be unarmed.
  const moveP = MOVE_PARAM[CURVE_FALLBACK[me.category] || me.category];
  if (moveP !== undefined) s += v[moveP] * (me.speed / RUN_SPEED);

  // Condition. Health is the share of a magazine the opponent still has to land.
  s += v[P.hpW] * (me.hp / 100 - 1);
  s += v[P.armorW] * (me.armor > 0 ? 1 : 0);

  // Helmet interaction, both halves. Holding a gun that one-taps a helmeted
  // head is worth something; it is worth more when the target has no helmet,
  // and that second half is why an AK's edge over an M4 evaporates against a
  // helmetless opponent, because then the M4 one-taps too.
  if (me.oneTap) s += v[P.oneTapW];
  if (!foe.helmet) s += v[P.noHelmetW];

  // Flash, reload, firing cycle.
  if (me.flash > 0) s -= v[P.flashW] * Math.pow(me.flash, v[P.flashPow]);
  if (me.reloading) s -= v[P.reloadW];
  s -= v[P.lowMagW] * (1 - me.magFraction);
  if (me.sinceShot < me.cycleSeconds) {
    // Mid-cycle: the shot is spent and the next one is not available yet.
    s -= v[P.cycleW] * (1 - me.sinceShot / me.cycleSeconds);
  }

  // Stance.
  if (me.scoped) s += v[P.scopedW];
  if (me.ducking) s += v[P.duckW];
  if (me.airborne) s += v[P.airW];

  return s;
}

/**
 * The pair on its own, in log-odds, positive when A is favoured.
 *
 * Antisymmetric by construction: every term is either a difference of the two
 * players' scores or an odd function of an A-minus-B quantity.
 */
export function pairLogit(pair, v) {
  const { a, b, offA, offB, dist, infoAdvSecs } = pair;
  // No constant term anywhere in the model: a duel has no inherent "first"
  // player, so a bias would be a claim that being listed first makes you win.
  let z = threatScore(a, b, offA, dist, v) - threatScore(b, a, offB, dist, v);
  z += v[P.infoW] * sat(infoAdvSecs / v[P.infoTau]);
  z += v[P.diffW] * sat(Math.log(Math.max(50, a.price) / Math.max(50, b.price)) / v[P.diffSat]);
  return z;
}

/**
 * Pressure from the enemies watching a player besides the one they are fighting.
 *
 * Each extra enemy is weighed as its own duel, not as a raw lethality score.
 * The distinction is the whole thing: a lethality score is an absolute quantity
 * with a large arbitrary offset in it (class, price, health all pile in), so
 * summing those and calling it pressure means a fight against two bad players
 * with cheap guns still reads as enormous danger. Scoring each extra enemy
 * against the player who has to survive them puts every term in the same
 * currency the duel logit already uses, and lands it in a bounded range where
 * one extra gun means at most one extra lost duel.
 *
 * The player's own crosshair is committed to the opponent, so `selfOff` is
 * usually terrible against a third party. That, rather than any assumption
 * about arithmetic, is why being outnumbered hurts.
 *
 * The crossfire multiplier is on top: two enemies stood together can be
 * answered with one angle and one spray, while the same two split wide cannot
 * both be faced, and turning to one is turning your back on the other.
 */
function threatPressure(threats, target, spreadDeg, v) {
  if (!threats?.length) return 0;
  let total = 0;
  for (const t of threats) {
    const theirs = threatScore(t.p, target, t.off, t.dist, v);
    // selfOff is absent on samples cached before it was carried; treating the
    // player as fully unaware is the safer reading of a missing commitment.
    const off = Number.isFinite(t.selfOff) ? t.selfOff : 180;
    const mine = threatScore(target, t.p, off, t.dist, v);
    total += sigmoid((theirs - mine) / v[P.threatSat]);
  }
  const crossfire = 1 + v[P.spreadW] * (1 - Math.exp(-Math.max(0, spreadDeg) / v[P.spreadSigma]));
  return total * Math.pow(threats.length, v[P.countPow] - 1) * crossfire;
}

/**
 * The duel in its surroundings.
 *
 * @param {object} ctx  from duelSnapshot's duelContext
 * @param {Float64Array} v
 * @returns {number} log-odds, positive favours A
 */
export function contextLogit(ctx, v) {
  const { pair, threatsOnA, threatsOnB, spreadA, spreadB } = ctx;
  let z = pairLogit(pair, v);

  // Extra guns on A hurt A; extra guns on B help A, which is the same fact read
  // from the other end. Applied as a difference so the whole expression stays
  // antisymmetric under swapping the two players, and P(a) + P(b) stays 1.
  const pressureA = threatPressure(threatsOnA, pair.a, spreadA, v);
  const pressureB = threatPressure(threatsOnB, pair.b, spreadB, v);
  z -= v[P.lambdaEnemy] * (pressureA - pressureB);

  return z;
}

/**
 * P(A wins this duel), given it resolves.
 *
 * @param {object} ctx
 * @param {Float64Array} v
 */
export function predictDuel(ctx, v) {
  return sigmoid(contextLogit(ctx, v));
}
