// ---------------------------------------------------------------------------
// shared/sim/clutch.js
// Two ways a bot misprices risk, and the two cheapest corrections in the plan.
//
// SIM-PLAN 20.9 (threat level and the 82 percent) and 20.12 (clutch
// discipline). They live in one file because they are the same mistake seen
// from two sides: a bot that collapses a distribution of outcomes to its mean
// and then treats every legal option as merely expensive rather than forbidden
// will happily flip a coin while it is winning and concede a chain of isolated
// 1v1s while it is up two. Neither is a pricing error the price can fix.
//
// 20.9, the risk quantile. 6.7 already says the objective is PRW, so
// variance-seeking when behind falls out of the mathematics. What does NOT
// fall out is the other direction: a side that is ahead should refuse the coin
// flip it is nominally indifferent to, because the mean it is indifferent at
// hides a tail that ends the round. So the quantile a bot maximizes is a
// function of state, not a personality constant (plan principle 61):
//
//     riskQuantile = f( PRW, manDelta, doctrine posture )
//       PRW well above 0.5  ->  low quantile (CVaR): trade on our terms
//       PRW well below 0.5  ->  high quantile: seek variance, force isolation
//       PRW near 0.5        ->  the trait's own baseline
//
// The trait supplies the BASELINE, `audacity` (6.9, drawn once per round)
// supplies the SPREAD around it, and the state supplies the DIRECTION. That is
// 20.9's sentence implemented literally, and it is why the same bot in the same
// state crosses the smoke on round 7 and waits on round 8 without one line of
// `if (rand() < 0.05)`.
//
// The risk quantile is a DECISION-side trait, not a motor one. skill.js clamps
// `reactionMedian`, the aim sigmas, `maxTurnRate` and friends inside the pro
// envelope because those are ability; the envelope is a ceiling on how fast a
// wrist may be. A quantile cannot make a bot mechanically superhuman at any
// setting, only more or less willing to gamble, so it is NOT clamped by
// `clampToEnvelope` and must never be added to skill.js's CLAMP table. It is
// bounded here instead, by [QUANTILE_MIN, QUANTILE_MAX], which is a sanity
// band and not an anti-aimbot wall.
//
// The 82 percent is an ANCHOR TO BE CHECKED, not a number this repo asserts.
// Chapter 13's figure (professional teams convert the first pick into a round
// win about 82 percent of the time) is an external calibration target for a
// model the plan already ships: run `predictRoundCalibrated` on library
// first-pick states in full-buy 5v5 and see whether it reproduces roughly that
// figure. If it does not, that is a finding about the FITTED MODEL, reported
// rather than patched (14.23's rule, and the P3d gate says "the result is
// reported either way"). So `FIRST_PICK_ANCHOR` is consumed by exactly one
// function, `checkFirstPickAnchor`, which compares and reports. Nothing in the
// risk quantile, the mask, or any price reads it, and no code path here bends a
// prediction toward it.
//
// 20.12, the clutch mask. Chapter 15 is four sentences and worth more than most
// of section 6: in a man advantage of +2 or more, either everyone peeks
// together or nobody peeks, because a chain of isolated 1v1s is what lets one
// player win a clutch and numbers only convert if they arrive simultaneously.
// It is a MASK, the same shape as the bomb-cover mask desireBot.js already
// carries: the legal wants are restricted, never outbid. Outbidding cannot work
// here for the same reason it cannot work for the bomb. The price is honest
// about the fight and blind to the forfeit, so a wandering option prices better
// than the discipline every time, and the only fix is to stop it being a want.
//
// So everything in this file is a restriction. `clutchMask` returns a set of
// option ids and an English motive; it never returns a score, an order, or a
// preference, and `maskInitiation` can only ever intersect. A caller cannot use
// this module to promote an option, which is the property that makes the mask
// auditable ("isolated duels conceded at +2 or better" is 20.15's chapter-15
// metric, and it is only gradeable if the mask is the only channel).
//
// Wiring, without this file touching the two files it serves:
//   - foresight.js collapses its M layouts to a MEAN internally (`ctSum /
//     layouts.length`) and returns one `pWin`, so the distribution
//     `applyQuantile` collapses has to come from the caller: repeated
//     `priceOption` draws, or a per-layout readout if foresight ever exposes
//     one. `riskAdjustedPrice` returns `{pWin, ...}`, which is exactly the
//     shape arbiter.js's `price` callback contract wants.
//   - `maskInitiation(initiationSet(engine, slot), clutchMask(state))` is the
//     `initiation` argument DesireArbiter.decide already takes. Forced
//     candidates still outrank priced ones inside the arbiter; a mask applies
//     before that, which is the correct order (the bomb is not a preference,
//     and neither is the discipline).
//
// Pure: no I/O, no clock, no rng. Same state in, same restriction out, so a
// disputed clutch is reproducible from the log line alone.
// ---------------------------------------------------------------------------

import { OPTION_DEFS, OPTION_IDS } from './options.js';
import { DEFUSE_SECONDS, DEFUSE_SECONDS_KIT, PLANT_SECONDS } from './constants.js';

// ---------------------------------------------------------------------------
// 20.9 the anchor: checked, never assumed
// ---------------------------------------------------------------------------

/**
 * Chapter 13's figure: the share of rounds a professional team converts after
 * taking the first pick. An EXTERNAL anchor for `predictRoundCalibrated`, not
 * a constant this sim plays by. `checkFirstPickAnchor` is its only consumer.
 */
export const FIRST_PICK_ANCHOR = 0.82;

/**
 * How far the model's mean prediction may sit from the anchor before the
 * comparison reads as a disagreement, on top of the sampling band. Covers the
 * gap between "professional teams" and whatever tier the library actually
 * holds. `[calibrate against the library's own first-pick conversion]`
 */
export const ANCHOR_TOLERANCE = 0.03;

/**
 * Compare a model against the 82 percent, and REPORT.
 *
 * The caller mines the states (library first-pick states, full-buy 5v5) and
 * runs `predictRoundCalibrated` on them; this is the arithmetic and the
 * English, so that the comparison is a testable pure function rather than a
 * number somebody eyeballed once. `outcomes`, when supplied, is the library's
 * own realized conversion for the same states, which is the more honest anchor
 * of the two: if the library converts at 0.79 the doctrine's 0.82 is a claim
 * about a different tier, and that is worth seeing next to the model's number.
 *
 * Never throws, never patches, never feeds anything else in this file.
 *
 * @param {object} args
 * @param {number[]} args.predictions  P(round win) per first-pick state, 0..1
 * @param {number[]} [args.outcomes]   1 for a converted round, 0 otherwise
 * @param {number} [args.anchor]
 * @param {number} [args.tolerance]
 * @returns {{n:number, modelMean:number|null, realized:number|null,
 *   anchor:number, delta:number|null, band:number, agrees:boolean,
 *   report:string}}
 */
export function checkFirstPickAnchor({
  predictions = [],
  outcomes = null,
  anchor = FIRST_PICK_ANCHOR,
  tolerance = ANCHOR_TOLERANCE
} = {}) {
  const preds = finiteNumbers(predictions);
  const n = preds.length;
  const modelMean = n ? preds.reduce((s, p) => s + p, 0) / n : null;

  const obs = outcomes ? finiteNumbers(outcomes) : [];
  const realized = obs.length ? obs.reduce((s, o) => s + o, 0) / obs.length : null;

  // A binomial standard error at the anchor, doubled: with fifty first-pick
  // states even a perfect model wanders by more than the tolerance, so the
  // band has to widen as the sample shrinks or the check reports noise.
  const se = n ? Math.sqrt((anchor * (1 - anchor)) / n) : Infinity;
  const band = Math.max(tolerance, 2 * se);
  const delta = modelMean == null ? null : modelMean - anchor;
  const agrees = delta != null && Math.abs(delta) <= band;

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  let report;
  if (modelMean == null) {
    report = 'no first-pick states supplied, so the anchor is unchecked';
  } else {
    const head =
      `${n} first-pick states: the model says ${pct(modelMean)}, ` +
      `the doctrine's anchor is ${pct(anchor)} (band ${pct(band)})`;
    const tail = agrees
      ? ', which agrees'
      : `, a gap of ${(delta * 100).toFixed(1)}pp. A finding about the fitted round model, to report rather than patch`;
    const lib = realized == null ? '' : `. The library itself converted ${pct(realized)}`;
    report = head + tail + lib;
  }

  return { n, modelMean, realized, anchor, delta, band, agrees, report };
}

// ---------------------------------------------------------------------------
// 20.9 the state-dependent risk quantile
// ---------------------------------------------------------------------------

/** The neutral collapse: q = 0.5 is the median, which stands in for the mean. */
export const QUANTILE_NEUTRAL = 0.5;

/** How far from 0.5 a PRW has to sit to read as fully ahead or behind. `[calibrate]` */
export const PRW_FULL = 0.2;

/**
 * The man gap that reads the same way. Down two is already not a fair fight,
 * which is the number conservation.js's `BODY_GAP_FULL` uses for the mirrored
 * problem (what posture to EXPECT from a priced-out enemy). Kept as a local
 * constant rather than an import so the two can be recalibrated apart.
 */
export const MAN_FULL = 2;

/**
 * The man term's weight in the blend. Deliberately below one: PRW already
 * contains the man count (roundFeatures carries ctAlive/tAlive), so counting
 * bodies again is a re-weighting of something the model has, not new
 * information. The plan lists both inputs, so both are read. `[calibrate]`
 */
export const MAN_WEIGHT = 0.5;

/** How far the quantile travels from baseline at full advantage. `[calibrate]` */
export const QUANTILE_SPREAD = 0.3;

/** How far `audacity` moves it, end to end, within one round. `[calibrate]` */
export const AUDACITY_SPREAD = 0.15;

/** The sanity band. Not an envelope: see the header. `[calibrate]` */
export const QUANTILE_MIN = 0.1;
export const QUANTILE_MAX = 0.9;

/**
 * One-sided caps: states and orders that may only ever make a bot MORE averse.
 * 6.9 names the first two ("anchors and save rounds maximize a lower quantile
 * of dPRW rather than its mean"); 20.9 names the third ("calling VP is calling
 * for the low quantile plus the trade masks"). A cap rather than a shift,
 * because an anchor who is also two men down must still not gamble: the state
 * raises the quantile and the cap refuses it. `[calibrate all three]`
 */
export const QUANTILE_CAPS = Object.freeze({
  anchor: 0.35,
  save: 0.25,
  vp: 0.25
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clampSigned = (x) => Math.max(-1, Math.min(1, x));
const finite = (x, fallback) => (Number.isFinite(x) ? x : fallback);

const finiteNumbers = (arr) =>
  (Array.isArray(arr) ? arr : []).map(numberOf).filter((x) => Number.isFinite(x));

/** Accept a bare number or anything foresight-shaped (`{pWin}`). */
function numberOf(x) {
  if (typeof x === 'number') return x;
  if (x && typeof x === 'object') {
    if (Number.isFinite(x.pWin)) return x.pWin;
    if (Number.isFinite(x.value)) return x.value;
  }
  return NaN;
}

/**
 * The quantile of dPRW this bot should be maximizing right now.
 *
 * @param {object} state
 * @param {number} [state.pWin]      PRW as it stands, 0..1 (foresight's `pWin`)
 * @param {number} [state.manDelta]  my living count minus theirs
 * @param {number} [state.baseline]  the bot's own `riskQuantile` trait (8.2)
 * @param {number} [state.audacity]  this round's draw, 0..1, 0.5 neutral (6.9)
 * @param {string} [state.posture]   doctrine keyword: 'vp' | 'liquid' | other
 * @param {string} [state.role]      'anchor' caps it (6.9)
 * @param {boolean} [state.saving]   a save round caps it harder (6.9)
 * @returns {number} a quantile in [QUANTILE_MIN, QUANTILE_MAX]
 */
export function riskQuantile(state = {}) {
  return explainRiskQuantile(state).quantile;
}

/**
 * The same number with its reasoning, for the decision log. The motive string
 * is the product (arbiter.js's header): "up two and priced at 71%: a low
 * quantile, no coin flips" is a line a human can argue with.
 */
export function explainRiskQuantile({
  pWin = QUANTILE_NEUTRAL,
  manDelta = 0,
  baseline = QUANTILE_NEUTRAL,
  audacity = 0.5,
  posture = null,
  role = null,
  saving = false
} = {}) {
  const prw = clamp01(finite(pWin, QUANTILE_NEUTRAL));
  const men = finite(manDelta, 0);
  const base = clamp01(finite(baseline, QUANTILE_NEUTRAL));
  const aud = clamp01(finite(audacity, 0.5));

  const prwTerm = clampSigned((prw - QUANTILE_NEUTRAL) / PRW_FULL);
  const manTerm = clampSigned(men / MAN_FULL);
  // Either channel alone can price a side out, so they sum before the clamp.
  const advantage = clampSigned(prwTerm + MAN_WEIGHT * manTerm);

  // Baseline from the trait, spread from this round's audacity, direction from
  // the doctrine. Ahead lowers the quantile; behind raises it.
  const audacityShift = AUDACITY_SPREAD * (aud - 0.5) * 2;
  let q = base + audacityShift - QUANTILE_SPREAD * advantage;

  // A keyword is an order and outranks the read (20.6: a keyword is a preset
  // over the arbiter). Liquid asks for the neutral collapse explicitly.
  if (posture === 'liquid') q = QUANTILE_NEUTRAL;

  let cap = null;
  const capWith = (name) => {
    const c = QUANTILE_CAPS[name];
    if (c != null && (cap == null || c < cap)) cap = c;
  };
  if (role === 'anchor') capWith('anchor');
  if (saving) capWith('save');
  if (posture === 'vp') capWith('vp');
  if (cap != null) q = Math.min(q, cap);

  const quantile = Math.max(QUANTILE_MIN, Math.min(QUANTILE_MAX, q));

  const pct = `${(prw * 100).toFixed(0)}%`;
  const menStr = men > 0 ? `up ${men}` : men < 0 ? `down ${-men}` : 'even on bodies';
  let motive;
  if (advantage > 0.15) {
    motive = `${menStr} and priced at ${pct}: a low quantile, trade on our terms`;
  } else if (advantage < -0.15) {
    motive = `${menStr} and priced at ${pct}: a high quantile, manufacture variance`;
  } else {
    motive = `level at ${pct}: the trait's own baseline`;
  }
  if (cap != null && quantile <= cap + 1e-9) {
    const why = saving ? 'a save round' : role === 'anchor' ? 'an anchor' : 'VP';
    motive = `${why} does not gamble: capped at ${cap.toFixed(2)}`;
  }

  return { quantile, baseline: base, advantage, audacityShift, cap, motive };
}

// ---------------------------------------------------------------------------
// 6.9 collapsing a distribution somewhere other than its middle
// ---------------------------------------------------------------------------

/**
 * The plain quantile (value-at-risk) of a distribution, linearly interpolated
 * between order statistics. At q = 0.5 this is the median exactly.
 *
 * @param {Array<number|{pWin:number}>} outcomes
 * @param {number} q  0..1, clamped
 * @returns {number} NaN if there is nothing to collapse
 */
export function quantileOf(outcomes, q) {
  const s = finiteNumbers(outcomes).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const idx = clamp01(finite(q, QUANTILE_NEUTRAL)) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}

/**
 * The mean of the tail the quantile points at: the worst ceil(q*n) outcomes
 * below the middle, the best ceil((1-q)*n) above it. Conditional value at risk
 * on the low side, its mirror on the high side. Always at least one outcome, so
 * the extremes read as the minimum and the maximum rather than as NaN.
 */
export function tailMeanOf(outcomes, q) {
  const s = finiteNumbers(outcomes).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  const qc = clamp01(finite(q, QUANTILE_NEUTRAL));
  const low = qc <= QUANTILE_NEUTRAL;
  const k = Math.max(1, Math.min(n, Math.ceil((low ? qc : 1 - qc) * n)));
  const tail = low ? s.slice(0, k) : s.slice(n - k);
  return tail.reduce((a, b) => a + b, 0) / k;
}

/**
 * Collapse a distribution of priced outcomes at a quantile instead of at its
 * mean (6.9, 20.9). CVaR-style at the averse end: the further the caller asks
 * from neutral, the more the collapse averages the whole tail rather than
 * trusting one order statistic, because a single order statistic drawn from a
 * dozen sampled layouts (foresight's HYPOTHESIS_COUNT) is noise. So:
 *
 *   q = 0.5           the median exactly, the neutral stand-in for the mean
 *   q -> 0            the worst outcome, having passed through its tail mean
 *   q -> 1            the best outcome, symmetrically
 *
 * Weighted by distance from neutral, so the neutral case is a clean median and
 * the extremes are clean CVaR, with no seam between them.
 *
 * Pure arithmetic over an array the caller supplies. Entries may be bare
 * numbers or foresight-shaped `{pWin}` records; non-finite entries are dropped
 * (a layout that failed to price is not an outcome). An EMPTY distribution
 * returns NaN, loudly, because a price nobody could compute must not be
 * mistakable for a bad one.
 *
 * @param {Array<number|{pWin:number}>} outcomes
 * @param {number} q
 * @returns {number}
 */
export function applyQuantile(outcomes, q) {
  const values = finiteNumbers(outcomes);
  if (!values.length) return NaN;
  const qc = clamp01(finite(q, QUANTILE_NEUTRAL));
  const w = Math.min(1, Math.abs(qc - QUANTILE_NEUTRAL) * 2);
  const varq = quantileOf(values, qc);
  if (w === 0) return varq;
  return (1 - w) * varq + w * tailMeanOf(values, qc);
}

/**
 * The one-line integration for the arbiter's `price` callback: take the
 * samples the caller drew for one option, work out the quantile this state
 * wants, collapse there, and hand back the arbiter's shape plus the English.
 *
 * @param {object} args
 * @param {Array<number|{pWin:number}>} args.samples  one option, many draws
 * @param {object} [args.state]  whatever `riskQuantile` reads
 * @returns {{pWin:number, quantile:number, motive:string, samples:number}}
 */
export function riskAdjustedPrice({ samples = [], state = {} } = {}) {
  const r = explainRiskQuantile(state);
  const values = finiteNumbers(samples);
  return {
    pWin: applyQuantile(values, r.quantile),
    quantile: r.quantile,
    motive: r.motive,
    samples: values.length
  };
}

// ---------------------------------------------------------------------------
// 20.12 the clutch masks
// ---------------------------------------------------------------------------

/** The man advantage at which the sync rule switches on. Chapter 15's number. */
export const SYNC_ADVANTAGE = 2;

/**
 * How many teammates must be able to peek the same space inside the shared
 * window before a peek stops being an isolated duel. Two, so that at +2 (the
 * smallest such team is three) the rule means what the chapter says: everyone
 * peeks, or nobody does. `[calibrate against the library's +2 rounds]`
 */
export const SYNC_MIN_PEERS = 2;

/**
 * The shared window itself, in seconds. This module takes the peer COUNT the
 * caller measured; the constant lives here so both sides of that measurement
 * agree on what simultaneous means. `[calibrate]`
 */
export const SYNC_WINDOW_SECONDS = 1.5;

/**
 * Slack on the clock arithmetic below: how early the last window to start a
 * channel opens. Covers the ticks between deciding and arriving that the
 * caller's travel estimate does not. `[calibrate]`
 */
export const CLUTCH_MARGIN_SECONDS = 1.5;

/** Everything the plan calls the peek family, read off the option table. */
const PEEK_FAMILY = OPTION_IDS.filter((id) => OPTION_DEFS[id].family === 'peek');

/**
 * Options with no legal parameters when nobody else is alive. Derived where
 * the option table already says so (a `mate` or `trackSlot` parameter cannot
 * be filled), then extended by hand for the two whose whole point is a
 * teammate even though their parameters do not name one: a `dummy_run` draws
 * attention so that somebody else can move, and a `refrag` re-takes the fight
 * a teammate just opened. Declared rather than inferred, because a wrong guess
 * here silently deletes a want.
 */
const NEEDS_A_TEAMMATE = new Set([
  ...OPTION_IDS.filter((id) =>
    (OPTION_DEFS[id].params || []).some((p) => p === 'mate' || p === 'trackSlot')
  ),
  'dummy_run',
  'refrag'
]);

/**
 * Options that definitionally take a body off the bomb. Peeks are not here:
 * a peek returns to where it started, so a lone T can swing the defuser and
 * still be covering the bomb, while an `advance` is somewhere else by
 * construction. `save` is here because with the bomb down and the clock ours,
 * saving forfeits a round the price cannot see us winning.
 */
const LEAVES_THE_BOMB = new Set([
  'advance',
  'clear',
  'rotate',
  'flank',
  'take_space',
  'execute_entry',
  'run_in_behind',
  'drop_deep',
  'scout',
  'save'
]);

/** What is still legal in the last window in which a defuse can start. */
const TO_THE_BOMB = ['defuse', 'retake', 'advance', 'rotate'];

/** And in the last window in which the bomb can still go down. */
const TO_THE_PLANT = ['plant', 'advance', 'execute_entry', 'take_space', 'rotate'];

/** What is left when the round is arithmetically lost and only the gun is not. */
const CASH_OUT = ['save', 'fall_back'];

/** Seconds of channel a defuse needs, kit or no kit. */
export const defuseSeconds = (hasKit) => (hasKit ? DEFUSE_SECONDS_KIT : DEFUSE_SECONDS);

/**
 * Which options are still LEGAL wants, given the clutch state.
 *
 * Two regimes, both from 20.12, and they cannot fire together (being alone and
 * being up two are mutually exclusive states):
 *
 * 1. THE SYNC RULE, verbatim. At +2 or better, peek-family options are illegal
 *    unless enough teammates can peek the same space inside the shared window,
 *    or the team posture is `hold`. The reason is exact: a chain of isolated
 *    1v1s is what lets one player win a clutch.
 *
 * 2. THE LAST ALIVE RULES. Alone, two whole classes of want stop existing.
 *    Options that need a teammate have no parameters to fill, and channels the
 *    clock will not let me finish are forfeits dressed as plays. The second one
 *    is the plan's time and plant discipline and it is pure arithmetic over
 *    PLANT_SECONDS, DEFUSE_SECONDS and DEFUSE_SECONDS_KIT: you may not start a
 *    channel that cannot end, you must start the one that still can, and once
 *    the bomb has beaten the defuse outright the only thing left to maximize is
 *    the gun. These are deliberately scoped to being ALONE. With a teammate
 *    alive a defuse nobody can finish is a bait and a plant is coverable, so
 *    the arithmetic stops being the whole story.
 *
 * A T alone with the bomb down owns the clock, so the wandering options go too:
 * the same bomb-cover mask desireBot.js applies to the whole side, made
 * absolute by there being nobody left to trade for the man covering the bomb.
 * It lifts the moment a defuse actually starts, because then the clock belongs
 * to them and the fight is the only thing left.
 *
 * The returned set is never empty: every keep-set below is a literal list of
 * option ids that survives the other rules in force with it.
 *
 * @param {object} state
 * @param {'CT'|'T'} [state.side]
 * @param {number} [state.alive]           my side's living count, me included
 * @param {number} [state.enemiesAlive]
 * @param {boolean} [state.bombDown]       planted
 * @param {boolean} [state.hasBomb]        I am carrying it, pre-plant
 * @param {boolean} [state.hasKit]
 * @param {number} [state.secondsLeft]     the round clock
 * @param {number} [state.bombSecondsLeft] after the plant
 * @param {boolean} [state.defusing]       a defuse channel is running
 * @param {number} [state.secondsToObjective]  my travel time to the bomb or the
 *                                         plant spot, the caller's geodesic
 * @param {string} [state.posture]         'hold' lifts the sync rule
 * @param {number} [state.syncPeers]       teammates able to peek the same space
 *                                         inside SYNC_WINDOW_SECONDS
 * @returns {{legal:Set<string>, masked:string[], motive:string,
 *   rules:Array<{id:string, motive:string}>, restricted:boolean}}
 */
export function clutchMask({
  side = 'CT',
  alive = 5,
  enemiesAlive = 5,
  bombDown = false,
  hasBomb = false,
  hasKit = false,
  secondsLeft = Infinity,
  bombSecondsLeft = Infinity,
  defusing = false,
  secondsToObjective = 0,
  posture = null,
  syncPeers = 0
} = {}) {
  const legal = new Set(OPTION_IDS);
  const rules = [];
  const drop = (ids, id, motive) => {
    let hit = false;
    for (const opt of ids) {
      if (legal.delete(opt)) hit = true;
    }
    if (hit) rules.push({ id, motive });
  };
  const keepOnly = (ids, id, motive) => {
    const keep = new Set(ids);
    let hit = false;
    for (const opt of [...legal]) {
      if (!keep.has(opt) && legal.delete(opt)) hit = true;
    }
    if (hit) rules.push({ id, motive });
  };

  const manAdvantage = finite(alive, 5) - finite(enemiesAlive, 5);
  const lastAlive = finite(alive, 5) === 1;
  const reach = Math.max(0, finite(secondsToObjective, 0));

  // 1. The sync rule.
  if (manAdvantage >= SYNC_ADVANTAGE && posture !== 'hold' && finite(syncPeers, 0) < SYNC_MIN_PEERS) {
    drop(
      PEEK_FAMILY,
      'sync',
      `up ${manAdvantage} with ${finite(syncPeers, 0)} able to peek together: ` +
        'numbers only convert if they arrive at once'
    );
  }

  if (lastAlive) {
    // 2. Nobody to fill the parameter.
    drop(NEEDS_A_TEAMMATE, 'alone', 'last alive: nobody to trade with, cover, or follow');

    if (side === 'T' && bombDown) {
      // 3. The clock is mine until a defuse says otherwise.
      if (!defusing) {
        drop(
          LEAVES_THE_BOMB,
          'bomb-cover',
          'alone with the bomb down: the clock wins this, wandering forfeits it'
        );
      }
    } else if (side === 'T' && hasBomb && !bombDown) {
      // 4. The plant discipline.
      const need = PLANT_SECONDS + reach;
      if (finite(secondsLeft, Infinity) < need) {
        drop(['plant'], 'dead-channel', 'no time left to finish a plant: the bomb is not the play');
      } else if (finite(secondsLeft, Infinity) <= need + CLUTCH_MARGIN_SECONDS) {
        keepOnly(
          TO_THE_PLANT,
          'plant-window',
          `${finite(secondsLeft, 0).toFixed(0)}s left: this is the last window the bomb can go down in`
        );
      }
    } else if (side === 'CT' && bombDown) {
      // 5. The defuse discipline, kit-aware.
      const need = defuseSeconds(hasKit) + reach;
      const bomb = finite(bombSecondsLeft, Infinity);
      if (bomb < need) {
        keepOnly(
          CASH_OUT,
          'lost-defuse',
          `the bomb beats ${hasKit ? 'a kit defuse' : 'a bare defuse'} by ` +
            `${(need - bomb).toFixed(1)}s: the round is gone, the gun is not`
        );
      } else if (bomb <= need + CLUTCH_MARGIN_SECONDS) {
        keepOnly(
          TO_THE_BOMB,
          'defuse-window',
          `${bomb.toFixed(0)}s on the bomb: the defuse has to start now or not at all`
        );
      }
    }
  }

  const masked = OPTION_IDS.filter((id) => !legal.has(id));
  const motive = rules.length
    ? rules.map((r) => r.motive).join('; ')
    : 'no clutch restriction in force';

  return { legal, masked, motive, rules, restricted: rules.length > 0 };
}

/**
 * Fold a clutch mask into whatever else is already legal (`initiationSet` from
 * options.js). Intersection only, in both directions, which is the whole
 * contract: this function cannot promote an option, cannot reorder one, and
 * cannot invent one. A caller that wants a clutch to change a RANKING has
 * reached for the wrong file.
 *
 * @param {Set<string>|Iterable<string>|null} initiation
 * @param {{legal:Set<string>}} mask
 * @returns {Set<string>}
 */
export function maskInitiation(initiation, mask) {
  const legal = mask?.legal ?? new Set(OPTION_IDS);
  if (!initiation) return new Set(legal);
  const out = new Set();
  for (const id of initiation) if (legal.has(id)) out.add(id);
  return out;
}
