// ---------------------------------------------------------------------------
// shared/sim/callValue.js
// The caller's value head (SIM-PLAN 9.25 stage 1).
//
// Target: P(this side wins | picture, candidate plan). Not an 8 Hz policy —
// the caller decides a handful of times a round, so this is contextual-bandit
// scoring over the library's shortlist, and the recall rule collapses to one
// comparison:
//
//   V(current tape) vs V(best close match)
//     current still better            -> keep walking
//     an alternative wins by the posture's recallMargin -> that IS the recall
//     ahead, and every fight is -EV versus holding      -> freeze
//
// No new action space. The hundred answers are still library tapes (stage 0);
// this only ranks them. `strategyCall` stops being a polite hint to `pickCall`
// and becomes the prior.
//
// Three ingredients, and it matters which is which:
//
//   PICTURE. `pictureWinrate` already prices the believed round, and 18.6b's
//   calibration bias is already inside it. That is P(win) with no plan in it.
//
//   PLAN. A decision changes which fight we take next, and `fightEV` prices
//   exactly that. Freeze takes none of it; commit takes it as priced; delay
//   defers it; a turnaround buys a different fight and pays to travel to it.
//   These deltas are heuristic in magnitude and deliberately correct in SIGN,
//   the same standard `fallbackCtWin` is held to: a caller that gets the sign
//   wrong freezes when it should hit.
//
//   MEMORY. `ExperienceIndex.read(key, call)` is the supervised head 18.4
//   already stores — Wilson lower bound over how this call has actually gone
//   in this situation. It is blended in by count, so a call with three rounds
//   behind it does not outvote the model.
//
// The head is injectable (`memoryOf`) so stage 4's Playstyle net can replace
// the tabular read without this file learning about nets.
//
// That parameter is NOT called `valueOf`, and must not be renamed to it.
// Destructuring reads inherited properties, so `const { valueOf = null } =
// { picture, decision }` finds `Object.prototype.valueOf` rather than falling
// back to the default — every memory-off call would then invoke it and throw
// "Cannot convert undefined or null to object" from inside this file. The same
// trap is waiting under `toString`, `constructor`, and `hasOwnProperty`.
//
// Pure. No I/O, no rng.
// ---------------------------------------------------------------------------

import { fightEV, pictureWinrate } from './caller.js';

/** Below this many rounds a situation's memory is a rumour, not a head. */
export const MEMORY_MIN_N = 8;
/** The most the tabular head may pull the model's number. */
export const MEMORY_MAX_WEIGHT = 0.35;

/**
 * How much of the next fight each decision actually takes.
 *
 * Freeze is the anchor at 0: holding is the plan that takes no fight, which
 * is what makes "freeze when every fight is -EV" fall out of the comparison
 * rather than needing its own rule.
 */
export const DECISION_FIGHT_SHARE = Object.freeze({
  commit: 1,
  delay: 0.45,
  turnaround: 0.8,
  fake: 0.3,
  freeze: 0
});

/**
 * What it costs to stop running the plan we are running. Continuity is most
 * of what makes a team look coached rather than teleported (playbook.js), so
 * changing the plan is never free and a turnaround costs the most.
 */
export const SWITCH_COST = Object.freeze({
  commit: 0.01,
  delay: 0.02,
  turnaround: 0.05,
  fake: 0.03,
  freeze: 0.01
});

/** A plan already in motion keeps this much, so ties do not thrash the tape. */
export const INCUMBENT_BONUS = 0.02;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);

/**
 * The tabular head: P(win | situation, call) as the index has actually seen
 * it, blended into the model's number by how much evidence there is.
 *
 * Returns the model number unchanged when the situation is thin, which is the
 * common case early in a lineage and must not be a silent zero.
 */
export function blendMemory(pWin, memory, { minN = MEMORY_MIN_N, maxWeight = MEMORY_MAX_WEIGHT } = {}) {
  const n = memory?.n || 0;
  if (!(n >= minN) || !Number.isFinite(memory?.lower)) return pWin;
  const w = Math.min(maxWeight, n / 40);
  return (1 - w) * pWin + w * memory.lower;
}

/**
 * V(picture, plan): what this side's round is worth if it runs this plan.
 *
 * @param {object} args
 * @param {object} args.picture     the believed picture (calBias already in it)
 * @param {string} args.decision    commit | delay | turnaround | fake | freeze
 * @param {object} [args.entry]     the playbook tape, when there is one
 * @param {(call: string|null) => {n:number, lower:number}|null} [args.memoryOf]
 *        the head; defaults to no memory at all
 * @param {boolean} [args.incumbent]  is this the plan already running
 * @param {object} [args.model]     the fitted round model, when injected
 * @returns {{value:number, pWin:number, fightEv:number, share:number, memory:object|null}}
 */
export function planValue({
  picture,
  decision = 'commit',
  entry = null,
  memoryOf = null,
  incumbent = false,
  model = null
} = {}) {
  const share = DECISION_FIGHT_SHARE[decision] ?? DECISION_FIGHT_SHARE.commit;

  // A turnaround is a fight somewhere the enemy is not, so it is priced as a
  // fresh contact rather than as the one in front of us. Everything else is
  // priced on the picture as it stands.
  const fightPicture =
    decision === 'turnaround' && picture?.contactRel === 'behind'
      ? { ...picture, contactRel: 'front' }
      : picture;

  const pWin = pictureWinrate(picture, model);
  const fightEv = fightEV(fightPicture, model);
  const memory = memoryOf ? memoryOf(entry?.call ?? null) : null;

  let value = blendMemory(pWin, memory) + share * fightEv;
  value -= incumbent ? 0 : SWITCH_COST[decision] ?? 0.02;
  if (incumbent) value += INCUMBENT_BONUS;

  return { value: clamp01(value), pWin, fightEv, share, memory: memory || null };
}

/**
 * Score the library's shortlist, best first. `candidates` is what
 * `closeMatches` returned: the answer book, unranked.
 *
 * @returns {Array<{entry:object, decision:string, distance:number, value:number, pWin:number, fightEv:number}>}
 */
export function rankPlans(candidates = [], { picture, memoryOf = null, model = null, incumbentId = null } = {}) {
  return candidates
    .map((c) => {
      const scored = planValue({
        picture,
        decision: c.decision,
        entry: c.entry,
        memoryOf,
        incumbent: Boolean(incumbentId && c.entry?.id === incumbentId),
        model
      });
      return { ...c, ...scored };
    })
    .sort((a, b) => b.value - a.value);
}

/**
 * The one comparison (9.25 stage 1).
 *
 * Freeze is not a special case here — it is a candidate like any other, the
 * one whose fight share is zero — which is exactly the spec's definition:
 * "ahead, and every fight we would take is -EV versus holding".
 *
 * @param {object} args
 * @param {object} args.picture
 * @param {Array<object>} args.candidates   from `closeMatches`
 * @param {string|null} args.currentDecision
 * @param {object|null} [args.currentEntry]
 * @param {number} [args.recallMargin]      the posture's margin
 * @param {(call: string|null) => object|null} [args.memoryOf]
 * @param {object} [args.model]
 * @returns {{recall:boolean, decision:string|null, entry:object|null, reason:string,
 *   value:number, currentValue:number, margin:number, ranked:Array<object>}}
 */
export function comparePlans({
  picture,
  candidates = [],
  currentDecision = null,
  currentEntry = null,
  recallMargin = 0.1,
  memoryOf = null,
  model = null
} = {}) {
  const current = planValue({
    picture,
    decision: currentDecision || 'commit',
    entry: currentEntry,
    memoryOf,
    incumbent: true,
    model
  });

  // Holding is always available, tape or no tape: a caller that can only
  // choose between two ways of walking forward cannot decide to stop.
  const hold = planValue({
    picture,
    decision: 'freeze',
    entry: currentEntry,
    memoryOf,
    incumbent: currentDecision === 'freeze',
    model
  });

  const ranked = rankPlans(candidates, {
    picture,
    memoryOf,
    model,
    incumbentId: currentEntry?.id || null
  });
  const alternatives = [{ entry: currentEntry, decision: 'freeze', distance: 0, ...hold }, ...ranked];
  const best = alternatives.reduce((a, b) => (b.value > a.value ? b : a), alternatives[0]);
  const margin = best.value - current.value;

  if (!best || margin < recallMargin) {
    return {
      recall: false,
      decision: currentDecision,
      entry: currentEntry,
      reason: 'plan stays in motion',
      value: current.value,
      currentValue: current.value,
      margin,
      ranked
    };
  }
  return {
    recall: true,
    decision: best.decision,
    entry: best.entry || null,
    reason:
      best.decision === 'freeze'
        ? 'ahead: every fight is -EV versus holding'
        : `${best.decision} is worth ${margin.toFixed(2)} more than continuing`,
    value: best.value,
    currentValue: current.value,
    margin,
    ranked
  };
}

/**
 * Softmax temperature over VALUE, which is a different scale from the
 * playbook's softmax over distance: plan values sit inside one probability,
 * and the margins that matter are hundredths.
 */
export const VALUE_TEMPERATURE = 0.05;

/**
 * The freeze-time pick: rank the opening shortlist by value, then draw.
 *
 * Not argmax. Stage 0 bans it ("a team that plays the same round forever and
 * is trivially exploitable") and nothing about owning a head repeals that —
 * a head with an argmax on top is the same mono-strat with better taste. The
 * head moves the ODDS; the draw keeps the entropy that league admission
 * checks for (9.8.4).
 *
 * Consumes exactly one rng draw, like `pickRound` does.
 */
export function pickPlan({
  candidates = [],
  picture,
  memoryOf = null,
  model = null,
  incumbentId = null,
  rng = null,
  temperature = VALUE_TEMPERATURE
} = {}) {
  const ranked = rankPlans(candidates, { picture, memoryOf, model, incumbentId });
  if (!ranked.length) return null;
  if (!(temperature > 0)) return ranked[0];
  const top = ranked[0].value;
  let total = 0;
  const weights = ranked.map((r) => {
    const w = Math.exp((r.value - top) / temperature);
    total += w;
    return w;
  });
  let r = (rng?.next ? rng.next() : 0.5) * total;
  for (let i = 0; i < ranked.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return ranked[i];
  }
  return ranked[ranked.length - 1];
}

/**
 * The caller's read of the experience index, as `planValue` wants it. Kept
 * here rather than in caller.js so the caller never imports the index: the
 * head is a function it is handed, which is what lets stage 4 swap a net in.
 */
export function indexValueOf(index, situationHash) {
  if (!index || !situationHash) return null;
  return (call) => index.read(situationHash, call || null);
}
