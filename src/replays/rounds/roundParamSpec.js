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
/** By size and side of the advantage. The man terms steer on these. */
const MEN_SIZE = [
  'men_ct_d1',
  'men_ct_d2',
  'men_ct_d3up',
  'men_t_d1',
  'men_t_d2',
  'men_t_d3up'
];
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
  // The dominant term by far, and the one that was most wrong.
  //
  // It used to be a plain tanh of the man difference, which is steepest at zero
  // and flattens after. Measured against 937 rounds that is the wrong way
  // round: the true log-odds of a man advantage rise roughly linearly, about
  // 1.8 per body, so a curve that spends most of its travel on the first man
  // has to be cranked up to reach two and three and then badly overshoots one.
  // It did: a one-man lead came out twelve points too confident while two and
  // three men were calibrated to within a point.
  //
  // `manPow` puts an inflection in it. Above one, the first man is compressed
  // and the curve steepens after, which is the shape the rounds actually have;
  // at exactly one this is the old tanh back again, so the optimizer can still
  // choose it if the data ever says so.
  { name: 'manW', init: 5, min: 0, max: 12, group: 'grad', buckets: [...ALL, ...MEN_SIZE] },
  { name: 'manTau', init: 3, min: 0.3, max: 10, group: 'shape', buckets: [...MEN, ...MEN_SIZE] },
  { name: 'manPow', init: 1.8, min: 0.5, max: 4, group: 'shape', buckets: [...MEN, ...MEN_SIZE] },
  // How big the advantage is relative to how many bodies are still on the
  // server. The difference alone cannot tell 5v4 from 2v1, and the rounds say
  // those are not the same thing at all: a one-man lead is worth 68% at 5v4 and
  // 84% at 2v1. Sharing one man term between them fits a compromise that is too
  // confident in the common case and not confident enough in the rare one.
  // Non-negative, which keeps the model monotone in bodies: adding a player
  // raises both the gap and the total, and raises the ratio with them.
  {
    name: 'manShareW',
    init: 1.5,
    min: 0,
    max: 8,
    group: 'grad',
    buckets: [...ALL, ...MEN_SIZE]
  },
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
  { name: 'noDefuseW', init: -1.5, min: -5, max: 0, group: 'grad', buckets: ['planted'] },

  // --- the race for the bomb -----------------------------------------------
  // The first version knew the bomb timer and nothing about the geometry around
  // it, so "nine seconds left, no kit, nearest CT across the map" was invisible
  // to it. These terms are that geometry.
  //
  // Who is closer to the planted bomb, which is the retake in one number.
  { name: 'bombDistW', init: 0.4, min: -2, max: 2, group: 'grad', buckets: ['planted'] },
  // The specific fight that decides the site: nearest CT against nearest T.
  // Signed like duelEdge, so the weight stays non-negative and the direction is
  // a structural guarantee rather than something training has to rediscover.
  { name: 'bombDuelW', init: 0.5, min: 0, max: 3, group: 'grad', buckets: ['planted'] },
  // Spare seconds after travelling to the bomb and defusing it. Saturating,
  // because the seconds either side of zero are the entire signal: twenty
  // spare seconds and thirty are both simply "there is time".
  { name: 'defuseSlackW', init: 0.8, min: 0, max: 4, group: 'grad', buckets: ['planted'] },
  { name: 'defuseSlackTau', init: 5, min: 0.5, max: 20, group: 'shape', buckets: ['planted'] },
  // The defuse physically cannot happen, whoever is alive and wherever they
  // are. Bounded well below the other plant terms so the model can say so
  // outright instead of approximating it with a timer curve.
  { name: 'defuseImpossibleW', init: -2, min: -8, max: 0, group: 'grad', buckets: ['planted'] },

  // --- who is holding the ground ------------------------------------------
  // Bodies in the live bombsite and possession of the zones around it. Both
  // read before a plant as well as after: an executed site is a site whether or
  // not the bomb is down yet.
  { name: 'siteOccW', init: 0.3, min: -1.5, max: 1.5, group: 'grad', buckets: [...PHASES, 'planted'] },
  { name: 'keyZoneW', init: 0.3, min: -1.5, max: 1.5, group: 'grad', buckets: [...PHASES, 'planted'] },
  // Before a plant, how far the T side still is from the site it is converging
  // on. Free to go either way for the same reason the centroid distance is:
  // far apart is a round still being set up, not an advantage to anyone.
  { name: 'approachDistW', init: 0, min: -1.5, max: 1.5, group: 'grad', buckets: [...PHASES, 'unplanted'] }
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
