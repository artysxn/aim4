// ---------------------------------------------------------------------------
// replays/duels/paramSpec.js
// The model's parameter vector: names, starting values, bounds, and the
// diagnostic buckets each one is answerable for.
//
// The bucket list on each parameter is the part that makes training converge on
// something sensible rather than something merely low-loss. A model can score
// well overall while being catastrophically wrong in one situation, because
// that situation is a small share of the data. Overall loss cannot tell the
// next generation which knob caused it. So every parameter declares which
// scenarios it influences, and the optimizer scales that parameter's step size
// by how badly calibrated those specific scenarios are. A model that is fine
// everywhere except 1v3 mutates its coupling terms hard and leaves the
// crosshair curve alone.
//
// `group` splits linear weights, where a gradient step is reliable, from curve
// shape parameters, where the loss surface is bumpy and random restarts do
// better than following a slope into a local minimum.
//
// DOM-free.
// ---------------------------------------------------------------------------

/** @typedef {'grad'|'shape'} ParamGroup */

/**
 * @typedef {object} ParamDef
 * @property {string} name
 * @property {number} init
 * @property {number} min
 * @property {number} max
 * @property {ParamGroup} group
 * @property {string[]} buckets  diagnostic buckets this parameter moves
 */

/** Weapon classes that get their own distance curve and movement penalty. */
export const CURVE_CATEGORIES = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

/** Range knots for the per-category effectiveness curves, world units. */
export const DIST_KNOTS = [250, 700, 1500, 3000];

const ALL_1V1 = ['1v1_close', '1v1_mid', '1v1_long'];
const ALL_RANGE = [...ALL_1V1, '1v2', '1v3plus'];

/**
 * @type {ParamDef[]}
 *
 * There is deliberately no constant term. The model is antisymmetric under
 * swapping the two players, which is what makes P(a) + P(b) exactly 1, and a
 * bias would break that by claiming one side of the pairing wins more for no
 * reason other than being listed first.
 */
export const PARAM_SPEC = [
  // --- crosshair placement -------------------------------------------------
  // The dominant term. exp(-(off/sigma)^pow) with a learnable power is what
  // gives the shape the game actually has: one degree off matters enormously,
  // sixty and a hundred and eighty are both simply "not looking at them".
  { name: 'crossW', init: 2.4, min: 0, max: 8, group: 'grad', buckets: ALL_RANGE },
  { name: 'crossSigma', init: 12, min: 1, max: 90, group: 'shape', buckets: ALL_RANGE },
  { name: 'crossPow', init: 1.1, min: 0.3, max: 4, group: 'shape', buckets: ALL_RANGE },

  // --- who saw whom first --------------------------------------------------
  { name: 'infoW', init: 0.7, min: 0, max: 4, group: 'grad', buckets: ALL_1V1 },
  { name: 'infoTau', init: 1.2, min: 0.15, max: 6, group: 'shape', buckets: ALL_1V1 },

  // --- weapon value --------------------------------------------------------
  // Absolute value and the gap between the two guns are separate terms on
  // purpose: a Deagle against an AK and an AK against an AWP are both $2000
  // apart and nothing like each other, which a single difference term cannot
  // express and a saturating pair of terms can.
  { name: 'valW', init: 0.35, min: -1, max: 3, group: 'grad', buckets: ['tier_even', 'tier_up', 'tier_down'] },
  { name: 'diffW', init: 0.8, min: 0, max: 4, group: 'grad', buckets: ['tier_up', 'tier_down'] },
  { name: 'diffSat', init: 1.0, min: 0.15, max: 4, group: 'shape', buckets: ['tier_up', 'tier_down'] },

  // --- weapon class offsets ------------------------------------------------
  { name: 'catPistol', init: -0.25, min: -3, max: 3, group: 'grad', buckets: ['tier_down'] },
  { name: 'catSmg', init: 0, min: -3, max: 3, group: 'grad', buckets: ['tier_even', 'tier_down'] },
  { name: 'catShotgun', init: -0.1, min: -3, max: 3, group: 'grad', buckets: ['tier_even'] },
  { name: 'catRifle', init: 0.3, min: -3, max: 3, group: 'grad', buckets: ['tier_even', 'tier_up'] },
  { name: 'catSniper', init: 0.5, min: -3, max: 3, group: 'grad', buckets: ['tier_up'] },
  { name: 'catLmg', init: 0.1, min: -3, max: 3, group: 'grad', buckets: ['tier_even'] },
  { name: 'catKnife', init: -2.5, min: -6, max: 1, group: 'grad', buckets: ['tier_down'] },
  { name: 'catOther', init: -2, min: -6, max: 1, group: 'grad', buckets: ['tier_down'] },

  // --- range effectiveness, per class --------------------------------------
  // Four knots per class, linearly interpolated. This is where "the AK one-taps
  // at range and the M4 does not" and "an SMG is fine in your face and useless
  // across mid" get to be different shapes rather than one shared slope.
  ...CURVE_CATEGORIES.flatMap((cat) =>
    DIST_KNOTS.map((knot, i) => ({
      name: `dist_${cat}_${i}`,
      init: 0,
      min: -2.5,
      max: 2.5,
      group: 'shape',
      buckets: [
        knot <= 250 ? '1v1_close' : knot <= 700 ? '1v1_mid' : '1v1_long',
        cat === 'sniper' ? 'tier_up' : 'tier_even'
      ]
    }))
  ),

  // --- movement ------------------------------------------------------------
  ...CURVE_CATEGORIES.map((cat) => ({
    name: `move_${cat}`,
    init: -0.5,
    min: -4,
    max: 0.5,
    group: 'grad',
    buckets: ['moving']
  })),

  // --- health, armour, helmet ----------------------------------------------
  { name: 'hpW', init: 0.9, min: 0, max: 4, group: 'grad', buckets: ALL_1V1 },
  { name: 'armorW', init: 0.35, min: -0.5, max: 2, group: 'grad', buckets: ALL_1V1 },
  // The helmet interaction: a gun that one-taps a helmeted head loses that edge
  // when the target has no helmet, because then everything one-taps.
  { name: 'oneTapW', init: 0.45, min: -0.5, max: 2.5, group: 'grad', buckets: ['tier_even', 'tier_up'] },
  { name: 'noHelmetW', init: 0.4, min: -0.5, max: 2.5, group: 'grad', buckets: ALL_1V1 },

  // --- flash ---------------------------------------------------------------
  { name: 'flashW', init: 1.6, min: 0, max: 6, group: 'grad', buckets: ['flashed'] },
  { name: 'flashPow', init: 0.7, min: 0.2, max: 3, group: 'shape', buckets: ['flashed'] },

  // --- reload and firing cycle ---------------------------------------------
  { name: 'reloadW', init: 1.2, min: 0, max: 5, group: 'grad', buckets: ['reloading'] },
  { name: 'lowMagW', init: 0.3, min: -0.5, max: 2, group: 'grad', buckets: ['reloading'] },
  // A bolt gun that just fired is defenceless until it cycles. This is the term
  // that turns a 99% AWP duel into a coin flip the instant they miss.
  { name: 'cycleW', init: 1.0, min: 0, max: 5, group: 'grad', buckets: ['tier_up', '1v1_long'] },

  // --- stance --------------------------------------------------------------
  { name: 'scopedW', init: 0.3, min: -1, max: 2, group: 'grad', buckets: ['1v1_long'] },
  { name: 'duckW', init: 0.15, min: -1, max: 1.5, group: 'grad', buckets: ALL_1V1 },
  { name: 'airW', init: -0.8, min: -3, max: 0.5, group: 'grad', buckets: ['moving'] },

  // --- stage two: outnumbered ---------------------------------------------
  // How much a second gun pointed at you costs. Learned, not assumed: the
  // arithmetic guess that two even duels halve your odds is only a guess.
  { name: 'lambdaEnemy', init: 1.2, min: 0, max: 6, group: 'grad', buckets: ['1v2', '1v3plus'] },
  { name: 'threatSat', init: 1.4, min: 0.2, max: 6, group: 'shape', buckets: ['1v2', '1v3plus'] },
  { name: 'countPow', init: 1.0, min: 0.3, max: 2.5, group: 'shape', buckets: ['1v3plus'] },

  // --- stage two: crossfire geometry --------------------------------------
  // Two enemies side by side are one angle to hold and can be sprayed through;
  // the same two split wide cannot both be faced. Same count, different fight.
  { name: 'spreadW', init: 0.8, min: 0, max: 4, group: 'grad', buckets: ['spread_tight', 'spread_mid', 'spread_wide'] },
  { name: 'spreadSigma', init: 55, min: 5, max: 180, group: 'shape', buckets: ['spread_mid', 'spread_wide'] }
];

/** Index by name, for readable model code. */
export const PARAM_INDEX = Object.fromEntries(PARAM_SPEC.map((p, i) => [p.name, i]));

export const PARAM_COUNT = PARAM_SPEC.length;

/** @returns {Float64Array} */
export function initialVector() {
  return Float64Array.from(PARAM_SPEC, (p) => p.init);
}

/** Clamp in place to the declared bounds. */
export function clampVector(v) {
  for (let i = 0; i < PARAM_SPEC.length; i++) {
    const p = PARAM_SPEC[i];
    if (v[i] < p.min) v[i] = p.min;
    else if (v[i] > p.max) v[i] = p.max;
  }
  return v;
}

/** Named object from a vector, for logging and for the exported params module. */
export function toNamed(v) {
  const out = {};
  for (let i = 0; i < PARAM_SPEC.length; i++) out[PARAM_SPEC[i].name] = v[i];
  return out;
}

/** Vector from a named object, tolerating params added since it was written. */
export function fromNamed(named) {
  const v = initialVector();
  for (let i = 0; i < PARAM_SPEC.length; i++) {
    const hit = named?.[PARAM_SPEC[i].name];
    if (Number.isFinite(hit)) v[i] = hit;
  }
  return clampVector(v);
}

/**
 * Stable hash of the spec's shape.
 *
 * A checkpoint is only resumable into the same parameter layout. Resuming a run
 * after adding a parameter would silently shift every value one slot along, and
 * the result would look like training rather than corruption.
 */
export function specHash() {
  let h = 2166136261;
  for (const p of PARAM_SPEC) {
    const s = `${p.name}|${p.min}|${p.max}|${p.group}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16);
}
