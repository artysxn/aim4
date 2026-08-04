// ---------------------------------------------------------------------------
// replays/rounds/roundParamSpec.js
// The round model's parameter vector.
//
// Same arrangement as the duel model's spec, and for the same reason: every
// parameter declares which diagnostic scenarios it can move, so the optimizer
// can size a parameter's step by how badly calibrated its own scenarios are
// rather than by the overall loss, which cannot say which knob is at fault.
//
// The one structural difference from the duel model is that a constant term is
// legitimate here. A duel has no inherent first player, so a bias there would
// have been nonsense. A round does: T and CT are different jobs with different
// win rates, and the bias plus the per-map offsets are exactly that asymmetry.
//
// DOM-free.
// ---------------------------------------------------------------------------

/** @typedef {'grad'|'shape'} ParamGroup */

/** Maps that get their own CT prior. Anything else uses the global bias alone. */
export const PRIOR_MAPS = ['ANC', 'ANU', 'CCH', 'DD2', 'INF', 'MIR'];

const PHASES = ['phase_early', 'phase_mid', 'phase_late'];
const MEN = ['man_even', 'man_ct_up', 'man_t_up'];
const ALL = [...PHASES, ...MEN];

/**
 * @type {Array<{name:string, init:number, min:number, max:number, group:ParamGroup, buckets:string[]}>}
 */
export const ROUND_PARAM_SPEC = [
  // --- side priors ---------------------------------------------------------
  { name: 'bias', init: 0, min: -1.5, max: 1.5, group: 'grad', buckets: PHASES },
  ...PRIOR_MAPS.map((m) => ({
    name: `map_${m}`,
    init: 0,
    min: -0.8,
    max: 0.8,
    group: 'grad',
    buckets: PHASES
  })),

  // --- bodies --------------------------------------------------------------
  // The dominant term by far. Saturating, because 5v2 and 5v1 are both simply
  // winning, while 5v4 against 5v3 is a real difference.
  { name: 'manW', init: 1.6, min: 0, max: 12, group: 'grad', buckets: ALL },
  { name: 'manTau', init: 1.4, min: 0.3, max: 10, group: 'shape', buckets: MEN },
  // Health left over above the body count: five players on 30 hp are not five
  // players, and the man advantage alone cannot express that.
  { name: 'hpW', init: 0.5, min: 0, max: 6, group: 'grad', buckets: ALL },
  // Being down to the last player is worse than the man count suggests: no
  // trades, no information, and every angle to hold alone.
  { name: 'lastManW', init: 0.3, min: -1, max: 2, group: 'grad', buckets: ['phase_late'] },

  // --- gunfights in progress ----------------------------------------------
  // The duel model's verdict on every open fight. This is the term that lets a
  // five-man round already being lost read as a five-man round already being
  // lost, rather than waiting for the bodies to drop.
  { name: 'duelW', init: 0.8, min: 0, max: 4, group: 'grad', buckets: ALL },
  { name: 'duelTau', init: 1.2, min: 0.2, max: 10, group: 'shape', buckets: ALL },

  // --- economy and utility -------------------------------------------------
  { name: 'equipW', init: 0.8, min: 0, max: 10, group: 'grad', buckets: ['eco_ct', 'eco_t', 'eco_even'] },
  { name: 'equipTau', init: 0.5, min: 0.1, max: 3, group: 'shape', buckets: ['eco_ct', 'eco_t'] },
  { name: 'utilW', init: 0.35, min: 0, max: 3, group: 'grad', buckets: ['eco_ct', 'eco_t', 'eco_even'] },
  { name: 'utilTau', init: 0.6, min: 0.1, max: 6, group: 'shape', buckets: ['eco_ct', 'eco_t'] },

  // --- map control ---------------------------------------------------------
  { name: 'possW', init: 0.9, min: 0, max: 4, group: 'grad', buckets: PHASES },

  // --- where the two sides are standing ------------------------------------
  // Distance is read as context rather than advantage: two sides far apart is a
  // round still being set up, and the clock decides those. Which is why this is
  // allowed to go either way.
  { name: 'centroidW', init: 0, min: -1.5, max: 1.5, group: 'grad', buckets: PHASES },
  { name: 'nearestW', init: 0, min: -1.5, max: 1.5, group: 'grad', buckets: PHASES },

  // --- the clock, before a plant -------------------------------------------
  // Time running out is a T problem: they have to enter and plant, and the CT
  // only has to still be alive. The power lets the pressure arrive late rather
  // than build evenly, which is how it actually feels.
  { name: 'timeW', init: 1.0, min: 0, max: 4, group: 'grad', buckets: ['phase_late', 'unplanted'] },
  { name: 'timePow', init: 2.0, min: 0.5, max: 12, group: 'shape', buckets: ['phase_late', 'unplanted'] },

  // --- after the plant -----------------------------------------------------
  // Planting flips the job: now the CT has to do something in a fixed time and
  // the T only has to stop them.
  { name: 'plantW', init: -1.2, min: -4, max: 0.5, group: 'grad', buckets: ['planted'] },
  { name: 'bombW', init: -1.0, min: -4, max: 0.5, group: 'grad', buckets: ['planted'] },
  { name: 'bombPow', init: 1.5, min: 0.4, max: 5, group: 'shape', buckets: ['planted'] },
  { name: 'kitW', init: 0.7, min: -0.5, max: 3, group: 'grad', buckets: ['planted'] },
  // Not enough seconds left to complete a defuse at all. A hard fact, not a
  // tendency, and the model should be allowed to treat it as one.
  { name: 'noDefuseW', init: -1.5, min: -5, max: 0, group: 'grad', buckets: ['planted'] }
];

export const ROUND_PARAM_INDEX = Object.fromEntries(
  ROUND_PARAM_SPEC.map((p, i) => [p.name, i])
);
export const ROUND_PARAM_COUNT = ROUND_PARAM_SPEC.length;

export function initialVector() {
  return Float64Array.from(ROUND_PARAM_SPEC, (p) => p.init);
}

export function clampVector(v) {
  for (let i = 0; i < ROUND_PARAM_SPEC.length; i++) {
    const p = ROUND_PARAM_SPEC[i];
    if (v[i] < p.min) v[i] = p.min;
    else if (v[i] > p.max) v[i] = p.max;
  }
  return v;
}

export function toNamed(v) {
  const out = {};
  for (let i = 0; i < ROUND_PARAM_SPEC.length; i++) out[ROUND_PARAM_SPEC[i].name] = v[i];
  return out;
}

export function fromNamed(named) {
  const v = initialVector();
  for (let i = 0; i < ROUND_PARAM_SPEC.length; i++) {
    const hit = named?.[ROUND_PARAM_SPEC[i].name];
    if (Number.isFinite(hit)) v[i] = hit;
  }
  return clampVector(v);
}

/** Stable hash of the layout, so a checkpoint cannot be resumed into a different one. */
export function specHash() {
  let h = 2166136261;
  for (const p of ROUND_PARAM_SPEC) {
    const s = `${p.name}|${p.min}|${p.max}|${p.group}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16);
}
