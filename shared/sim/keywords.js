// ---------------------------------------------------------------------------
// shared/sim/keywords.js
// Keywords are presets over the option arbiter: mask, risk, trigger.
//
// SIM-PLAN 20.6. Chapter 4's keywords are compressed orders that change how
// the whole team behaves. Every one of them decomposes into things the plan
// already has: a mask change, a risk distortion, and a trigger set. So a
// keyword is a PRESET over the option arbiter (6.17), which makes it
// simultaneously a Playstyle action head, a human command in the /sim UI,
// and a line in the decision log.
//
//   VP       solo peeks illegal; every remaining peek requires tradeCover;
//            no execute whose uncovered mass exceeds a floor. Risk is CVaR:
//            maximize a low quantile of dPRW, which is the same direction
//            clutch.js's QUANTILE_CAPS.vp already points.
//   Liquid   grouping constraint (core of 4+), commit window compressed to
//            the 5–10 s band. Risk is the mean. timingEdge is a caller
//            weight, not a mask.
//   Freeze   everything except the hold / fall-back family is masked until
//            the caller says splitEntropy dropped. Neutral risk. The caller
//            stops applying the preset; this file never looks at entropy.
//   Joker    four bots masked to hold_angle, walk, no utility, silent; one
//            initiator unmasked entirely. The cleanest test of whether the
//            comm and sound models are honest (4.7: walking emits nothing).
//
// THE MASK CAN ONLY EVER INTERSECT. `applyKeyword` is the same contract as
// clutch.js's `maskInitiation`: it cannot promote an option, cannot reorder
// one, and cannot invent one. A keyword that wants a ranking change has
// reached for the wrong file; the risk field is the distortion, and it is
// a number clutch.js already knows how to consume (`quantileBias` added to
// the baseline, `risk` choosing CVaR / mean / neutral).
//
// VP's solo-peek family is masked up front because those options ARE solo
// even when a teammate exists: a jiggle, a shoulder, a wide swing, a dummy
// run. Trade and refrag stay, because they are the cover. What we cannot
// know here is whether THIS peek has tradeCover right now, so repeek and
// punish_window survive the static mask and die in `applyKeyword` when
// `hasTradeCover` is false. Uncovered mass dropping execute_entry is the
// same kind of live restriction, read off clearPartition's uncovered set.
//
// Joker is two presets in one: `jokerPreset({ initiatorSlot })` fills the
// slot the four are collapsing onto; `applyKeyword` then unmasks that slot
// and leaves the others on hold_angle. The gait and silent flags are for
// the caller (translator / sound); they are not options.
//
// Pace is NOT a keyword. 20.6: a keyword sets the protocol and the risk
// posture, pace sets the tempo, and the pair is what Playstyle emits
// alongside the layer action. This file does not name a pace.
//
// Pure: no I/O, no clock, no rng. Same initiation and same preset always
// produce the same restriction, so a disputed VP call is reproducible from
// the log line alone.
// ---------------------------------------------------------------------------

import { OPTION_DEFS, OPTION_IDS } from './options.js';

export const KEYWORDS = Object.freeze(['vp', 'liquid', 'freeze', 'joker']);

/**
 * What Freeze still permits. Holds, the fall-back, a save: the options that
 * do not take ground and do not take a fight. `splitEntropy` dropping is the
 * caller's signal to stop applying the preset; it is not a field in here.
 */
export const freezeLegal = Object.freeze([
  'fall_back',
  'hold_angle',
  'off_angle_hold',
  'crossfire_hold',
  'stand_off',
  'save'
]);

/** Solo peeks VP forbids even when a teammate is alive. Trade / refrag stay. */
const VP_SOLO = Object.freeze(['jiggle', 'shoulder_peek', 'wide_swing', 'dummy_run']);

/** Everything the option table calls a peek, for the live tradeCover check. */
const PEEK_FAMILY = OPTION_IDS.filter((id) => OPTION_DEFS[id].family === 'peek');

/**
 * Uncovered mass above which VP refuses an execute. clearPartition reports
 * the mass; this is the floor. `[calibrate]`
 */
export const VP_UNCOVERED_MASS_FLOOR = 0.4;

/** How far VP moves the clutch baseline toward CVaR. `[calibrate]` */
export const VP_QUANTILE_BIAS = -0.2;

/** Liquid's commit window: midpoint of chapter 4's 5 to 10 seconds. */
export const LIQUID_COMMIT_WINDOW = 7.5;

/** Liquid's grouping constraint: a core of four. */
export const LIQUID_GROUPING_MIN = 4;

function assertOptionIds(ids, where) {
  for (const id of ids) {
    if (!OPTION_DEFS[id]) throw new Error(`keywords: ${where} names unknown option ${id}`);
  }
}

assertOptionIds(VP_SOLO, 'VP solo mask');
assertOptionIds(freezeLegal, 'freezeLegal');

const FREEZE_MASKS = OPTION_IDS.filter((id) => !freezeLegal.includes(id));
const JOKER_MASKS = OPTION_IDS.filter((id) => id !== 'hold_angle');

function preset({
  id,
  masks,
  gait = null,
  silent = false,
  risk = 'neutral',
  quantileBias = 0,
  groupingMin = 0,
  commitWindowSeconds = null,
  soloIllegal = false,
  tradeCoverRequired = false,
  uncoveredMassFloor = null,
  initiatorSlot = null,
  motive
}) {
  return Object.freeze({
    id,
    masks: new Set(masks),
    gait,
    silent,
    risk,
    quantileBias,
    groupingMin,
    commitWindowSeconds,
    soloIllegal,
    tradeCoverRequired,
    uncoveredMassFloor,
    initiatorSlot,
    motive
  });
}

const DEFAULT_PRESET = preset({
  id: 'default',
  masks: [],
  risk: 'neutral',
  quantileBias: 0,
  groupingMin: 0,
  motive: 'no keyword: the arbiter is undistorted'
});

const TABLE = {
  vp: () =>
    preset({
      id: 'vp',
      masks: VP_SOLO,
      risk: 'cvar',
      quantileBias: VP_QUANTILE_BIAS,
      groupingMin: 2,
      soloIllegal: true,
      tradeCoverRequired: true,
      uncoveredMassFloor: VP_UNCOVERED_MASS_FLOOR,
      motive: 'solo peeks illegal, trade cover required, play the low quantile'
    }),
  liquid: () =>
    preset({
      id: 'liquid',
      masks: [],
      risk: 'mean',
      quantileBias: 0,
      groupingMin: LIQUID_GROUPING_MIN,
      commitWindowSeconds: LIQUID_COMMIT_WINDOW,
      motive: 'core of four, commit inside the window, price the mean'
    }),
  freeze: () =>
    preset({
      id: 'freeze',
      masks: FREEZE_MASKS,
      risk: 'neutral',
      quantileBias: 0,
      groupingMin: 0,
      motive: 'hold until the split settles'
    }),
  joker: (initiatorSlot = null) =>
    preset({
      id: 'joker',
      masks: JOKER_MASKS,
      gait: 'walk',
      silent: true,
      risk: 'neutral',
      quantileBias: 0,
      groupingMin: 0,
      initiatorSlot,
      motive: 'four silent, one initiator, collapse on contact'
    })
};

/**
 * The preset for a keyword id. `null` and `'default'` are the undistorted
 * arbiter. Anything else unknown throws, because a typo in a keyword is a
 * silent no-op of the worst kind: the team thinks it called VP and did not.
 *
 * @param {string|null} id
 */
export function keywordPreset(id) {
  if (id == null || id === 'default') return DEFAULT_PRESET;
  const build = TABLE[id];
  if (!build) throw new Error(`keywords: unknown keyword ${id}`);
  return build();
}

/**
 * Joker needs to know which slot is the initiator. The four others walk and
 * hold; this one is unmasked. Filled by the caller, never guessed here.
 *
 * @param {{initiatorSlot: number}} args
 */
export function jokerPreset({ initiatorSlot } = {}) {
  if (!Number.isInteger(initiatorSlot)) {
    throw new Error('keywords: jokerPreset needs an initiatorSlot');
  }
  return TABLE.joker(initiatorSlot);
}

/**
 * Fold a keyword into whatever is already legal. Intersection only, in both
 * directions: nothing in the output that was not in the input, nothing the
 * preset forbids. A caller that wants a keyword to change a RANKING has
 * reached for the wrong file.
 *
 * VP live restrictions, on top of the static solo mask:
 *   tradeCoverRequired and no tradeCover  -> drop the peek family
 *   uncoveredMass above the floor         -> drop execute_entry
 *
 * Joker: the initiator slot is unmasked (still cannot promote); everyone
 * else is held to hold_angle.
 *
 * @param {Set<string>|Iterable<string>|null} initiationSet
 * @param {object} preset
 * @param {object} [ctx]
 * @param {number} [ctx.slot]
 * @param {number} [ctx.uncoveredMass]
 * @param {boolean} [ctx.hasTradeCover]
 * @returns {Set<string>}
 */
export function applyKeyword(initiationSet, preset, { slot = null, uncoveredMass = null, hasTradeCover = false } = {}) {
  const incoming = initiationSet ? new Set(initiationSet) : new Set();
  if (!preset || preset.id === 'default') return incoming;

  // Joker initiator: unmasked entirely, still a subset of what was legal.
  if (preset.id === 'joker' && slot === preset.initiatorSlot && preset.initiatorSlot != null) {
    return incoming;
  }

  const out = new Set();
  for (const id of incoming) {
    if (preset.masks.has(id)) continue;
    out.add(id);
  }

  if (preset.tradeCoverRequired && !hasTradeCover) {
    for (const id of PEEK_FAMILY) out.delete(id);
  }

  if (
    preset.uncoveredMassFloor != null &&
    Number.isFinite(uncoveredMass) &&
    uncoveredMass > preset.uncoveredMassFloor
  ) {
    out.delete('execute_entry');
  }

  return out;
}

/** English one-liner for the decision log. The motive is the product. */
export function keywordMotive(preset) {
  return preset?.motive || 'no keyword';
}
