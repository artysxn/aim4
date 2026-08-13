// ---------------------------------------------------------------------------
// shared/sim/voi.js
// The visualization budget: when a bot considers every possibility, and when it
// commits to the most likely one.
//
// SIM-PLAN 19.4, plus the novelty cap from 20.11 which is the correction that
// keeps 19.4 from being a naive information maximizer.
//
// TWO BUDGETS, and keeping them apart is the whole point. 6.7 caps foresight at
// twelve hypotheses and three options because that is what the CPU can afford:
// that is a MACHINE budget, it is a hard ceiling, and it lives in foresight.js
// (HYPOTHESIS_COUNT) — this file never names it. Underneath it sits the softer
// TACTICAL budget, which is how much of that ceiling to actually spend on THIS
// decision, paid for in round clock and attention, chosen per decision. That
// second budget is all this module computes.
//
// The rule is the standard one and it is computable from prices foresight has
// already produced:
//
//   VOI = E_h[ max_a price(a|h) ]  −  max_a E_h[ price(a|h) ]
//
// the gap between best-responding to a KNOWN hypothesis and playing best
// against the mixture. If every hypothesis agrees on the best move the two
// terms are the same sum of the same products in the same order, so VOI is
// EXACTLY zero (not nearly zero — voi.test.js asserts ===), more thinking
// cannot change the decision, and the bot commits immediately. If the top two
// options swap under different hypotheses, the read matters and it is worth
// buying.
//
// ONE INEQUALITY, THREE REGIMES. Every purchase a bot can make is a (gain,
// seconds) pair and the whole file is one line applied three times:
//
//   surplus = gain − seconds * dPRW_per_second        take it if surplus > 0
//
//   widen        think: draw the next hypothesis batch. Only the share of the
//                VOI that ARITHMETIC can remove is on offer, `resolvable`.
//   gather       act: jiggle, scout, listen, an HE into the smoke. Buys the
//                other share, the part that is about the world rather than the
//                arithmetic, which no amount of thinking resolves.
//   contingency  arm one cheap trigger row and commit anyway. Same inequality,
//                a much smaller cost, because arming a contingency defers
//                nothing — it only splits attention.
//
// commit is what is left when nothing clears. 19.4's three rows then fall out
// rather than being authored:
//
//   early, low clock pressure, high splitEntropy
//       a second is nearly free and the hypotheses disagree, so widen AND
//       gather both clear. This is what a default round IS, derived.
//   mid round, a lean exists
//       VOI has shrunk and the clock has started to bite, so neither the think
//       nor the action clears, but the near-free contingency still does:
//       commit to the modal hypothesis with one cheap option armed.
//   entry, or any closing window
//       dPRW per second is large enough that it dominates any plausible VOI.
//       Widen fails, gather fails, and the contingency fails too: commit,
//       pre-aim the modal angle, and check nothing else. The plan is explicit
//       that this third row "is the same inequality rather than a special
//       case", and here it is literally the same line with a bigger
//       dPRWPerSecond, which is why 19.4's "skip every other potential angle"
//       needs no rule of its own.
//
// RESOLVABLE is the split between the two kinds of ignorance, and it is the
// only genuinely new modelling in the file. Thinking means drawing more
// hypotheses from the SAME belief, so thinking can only fix SAMPLING error: if
// the current draw is too small to settle which option leads under the mixture,
// another batch settles it. If the belief itself is spread — the top two
// options swap because the enemy really might be in either place — more draws
// converge to the same mixture and the VOI survives untouched, and the only
// thing that moves it is an action that changes the belief. resolvableShare()
// reads that off the matrix as the chance another batch flips the mixture
// ranking: the top-two margin against its own standard error across hypotheses,
// 2*Phi(−|z|). Wide margin plus swapping argmaxes is exactly the "gather" case.
//
// THE NOVELTY CAP (20.11) is an override, not another term. A VOI agent widens
// hardest when it is most uncertain; chapter 14 says that in genuine novelty
// that is the losing move, because the delay cost in Counter-Strike is convex
// and the enemy is acting while you think. Wrong but decisive beats right but
// late. So when retrieval finds no matching situation (18.3's backoff
// exhausted) AND the split is open AND no option's price dominates, the budget
// is set to zero deliberately, the argmax is taken, a hysteresis lock raises
// minCommitTicks so the bot cannot oscillate back out of it, and a Level 5 comm
// with an ASP goes out so the team commits with you rather than watching one
// bot be stubborn. It runs BEFORE the inequality and short-circuits it, because
// its whole content is that the arithmetic is wrong here.
//
// TRAITS (6.16) wire into the budget rather than the inequality:
// `concentration` sets how much budget exists, `composure` shrinks it under
// pressure (a low-composure bot collapses its breadth in a 1v2, which is what a
// tier-2 player does in a clutch), `anticipation` sets how far ahead it may
// look. `decisions` — whether the argmax is actually taken — is deliberately
// NOT re-implemented here: arbiter.js already owns it as a softmax temperature
// and applying it twice would double-count the same trait.
//
// THE BOUNDARY. This runs at the decision cadence, 8 Hz per bot, so everything
// here is arithmetic over a price matrix that has ALREADY been computed. It
// must NEVER call foresight.priceOption: that is the expensive evaluator, and a
// budget that pays the price it is deciding whether to pay is circular as well
// as unaffordable. The module has no imports at all, which is the cheapest
// available enforcement of that boundary. Pure functions, no I/O, no clock, no
// dice: the same matrix always decides the same way.
//
// NOT yet wired: arbiter.js's PRICE_BUDGET is still a constant 3. Steering it
// from budgetDecision().budget is the next step and belongs in that file.
// ---------------------------------------------------------------------------

/**
 * What one more hypothesis batch costs in deliberation, in seconds. 5.7's
 * decision latency: a pro median is 0.35 s, so this is the cheapest a human can
 * buy one more round of thinking before acting. Callers with a measured latency
 * should pass their own. `[calibrate]`
 */
export const WIDEN_SECONDS = 0.35;

/** Hypotheses bought per widen. A third of 6.7's twelve. `[calibrate]` */
export const WIDEN_BATCH = 4;

/**
 * What the cheapest resolving ACTION costs, in seconds: a jiggle out and back.
 * A scout, a listen, or an HE into a smoke costs more and the caller should say
 * so per option. `[calibrate]`
 */
export const GATHER_SECONDS = 0.45;

/**
 * Arming one contingency costs a fraction of a deliberation: it defers no
 * decision, it only splits attention off the modal angle. This is the number
 * that makes 19.4's second and third rows differ, so it is load-bearing.
 * `[calibrate]`
 */
export const CONTINGENCY_SECONDS = 0.08;

/**
 * And it recovers this share of the VOI: a contingency reacts after the world
 * has spoken, so it buys less than the read would have. `[calibrate]`
 */
export const CONTINGENCY_CAPTURE = 0.4;

/** splitEntropy (knowledge.js) above this is "we do not know the split". `[calibrate]` */
export const NOVELTY_ENTROPY_BITS = 1.5;

/**
 * A price DOMINATES when the mixture-best option is also the per-hypothesis
 * best in this much of the weight mass. Above it the situation may be novel but
 * the answer is not in doubt, so the cap does not fire. `[calibrate]`
 */
export const NOVELTY_DOMINANCE_SHARE = 0.8;

/**
 * The hysteresis lock, as a multiple of the caller's own minCommitTicks (6.6
 * owns the base; this module does not duplicate it). At the default 24 ticks
 * this is over a second of not switching, which is the blind maze's "pick a
 * wall, follow it, do not switch" expressed in the only units the option layer
 * understands. `[calibrate]`
 */
export const NOVELTY_COMMIT_MULT = 3;

/** Breadth a bot with no concentration still gets, as a share of its ceiling. */
export const CONCENTRATION_FLOOR = 0.35;

/** How far ahead the budget may look, at zero and at full `anticipation`. `[calibrate]` */
export const LOOKAHEAD_MIN_SECONDS = 1.5;
export const LOOKAHEAD_MAX_SECONDS = 6;

/**
 * Drain (19.4, and the most speculative mechanism in the section): thinking
 * wide early costs breadth late. Cumulative hypotheses spent this round, over
 * the ceiling, discount the budget by this much. The falsification is whether
 * pro demos show late-round decision quality degrading with early-round
 * complexity; if they do not, delete the term rather than defend it.
 * `[calibrate, and be willing to delete]`
 */
export const DRAIN_K = 0.25;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const n3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '0.000');

/** A&S 7.1.26, |error| < 1.5e-7. Deterministic, and the only transcendental here. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

/**
 * The value of information, from an already-priced (option, hypothesis) matrix.
 *
 * @param {object} args
 * @param {number[][]} args.prices   option-major: prices[a][h] = price(a | h),
 *   in pWin units (foresight.priceOption().pWin). Must be rectangular.
 * @param {number[]} [args.weights]  hypothesis weights, any positive scale;
 *   normalized here. Defaults to uniform, which is what drawLayouts' systematic
 *   resampling produces.
 * @param {string[]} [args.ids]      option labels, for the motive string
 * @returns {{
 *   value:number, clairvoyant:number, mixture:number, expected:number[],
 *   best:number, bestId:string|null, second:number, secondId:string|null,
 *   margin:number, marginSd:number, bestShare:number, unanimous:boolean,
 *   options:number, hypotheses:number, effective:number
 * }}
 */
export function voi({ prices, weights = null, ids = null } = {}) {
  const rows = Array.isArray(prices) ? prices : [];
  const n = rows.length;
  const m = n ? (rows[0]?.length ?? 0) : 0;
  if (!n || !m) {
    return {
      value: 0,
      clairvoyant: 0,
      mixture: 0,
      expected: [],
      best: -1,
      bestId: null,
      second: -1,
      secondId: null,
      margin: 0,
      marginSd: 0,
      bestShare: 0,
      unanimous: true,
      options: n,
      hypotheses: m,
      effective: 0
    };
  }
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== m) throw new Error('voi: price matrix is ragged');
  }
  if (weights && weights.length !== m) {
    throw new Error(`voi: ${weights.length} weights for ${m} hypotheses`);
  }

  // A belief with no mass left is a caller bug, but the decision layer does not
  // get to divide by zero at 8 Hz: fall back to uniform.
  const raw = weights ? weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0)) : null;
  const total = raw ? raw.reduce((s, w) => s + w, 0) : 0;
  const w = raw && total > 0 ? raw.map((x) => x / total) : new Array(m).fill(1 / m);

  // One pass, hypothesis-major. Both terms of the formula accumulate the same
  // products in the same order, which is what makes unanimity give exactly 0
  // instead of 1e-17.
  const expected = new Array(n).fill(0);
  const argmaxPerH = new Array(m).fill(0);
  let clairvoyant = 0;
  for (let h = 0; h < m; h += 1) {
    const wh = w[h];
    let bestVal = -Infinity;
    let bestA = 0;
    for (let a = 0; a < n; a += 1) {
      const p = rows[a][h];
      const val = Number.isFinite(p) ? p : 0;
      expected[a] += wh * val;
      if (val > bestVal) {
        bestVal = val;
        bestA = a;
      }
    }
    argmaxPerH[h] = bestA;
    clairvoyant += wh * bestVal;
  }

  let best = 0;
  let second = -1;
  for (let a = 1; a < n; a += 1) if (expected[a] > expected[best]) best = a;
  for (let a = 0; a < n; a += 1) {
    if (a === best) continue;
    if (second < 0 || expected[a] > expected[second]) second = a;
  }

  const mixture = expected[best];
  const gap = clairvoyant - mixture;
  const value = gap > 0 ? gap : 0; // clairvoyance is never worth less than nothing

  let bestShare = 0;
  for (let h = 0; h < m; h += 1) if (argmaxPerH[h] === best) bestShare += w[h];

  // The top-two margin and how much it moves between hypotheses: the input to
  // resolvableShare, and free to compute here.
  let margin = 0;
  let marginSd = 0;
  if (second >= 0) {
    margin = mixture - expected[second];
    let varSum = 0;
    for (let h = 0; h < m; h += 1) {
      const d = rows[best][h] - rows[second][h] - margin;
      varSum += w[h] * d * d;
    }
    marginSd = Math.sqrt(varSum);
  }

  let sumSq = 0;
  for (let h = 0; h < m; h += 1) sumSq += w[h] * w[h];
  const effective = sumSq > 0 ? 1 / sumSq : m;

  return {
    value,
    clairvoyant,
    mixture,
    expected,
    best,
    bestId: ids?.[best] ?? null,
    second,
    secondId: second >= 0 ? (ids?.[second] ?? null) : null,
    margin,
    marginSd,
    bestShare,
    unanimous: argmaxPerH.every((a) => a === argmaxPerH[0]),
    options: n,
    hypotheses: m,
    effective
  };
}

/**
 * How much of the VOI more THINKING can remove, 0..1.
 *
 * Another batch drawn from the same belief only moves the decision if the
 * mixture ranking is inside sampling noise, so this is the two-sided chance
 * that the top-two margin's sign is not yet settled: 2*Phi(-|margin| / se).
 * A margin that every hypothesis agrees on has se = 0 and returns 0, which is
 * the "gather" case in one line: the disagreement is about the world, and the
 * world does not care how long you look at the same twelve layouts.
 *
 * @param {ReturnType<typeof voi>} v
 * @returns {number} 0..1
 */
export function resolvableShare(v) {
  if (!v || !(v.second >= 0)) return 0; // one option is not a choice
  // Kish's effective count, not the raw one: a peaked weight vector is fewer
  // hypotheses than it looks and the standard error has to know that.
  const m = Number.isFinite(v.effective) && v.effective > 0 ? v.effective : 1;
  const se = v.marginSd / Math.sqrt(m);
  if (!(se > 0)) return v.margin === 0 ? 1 : 0;
  const z = Math.abs(v.margin) / se;
  return clamp01(1 - erf(z / Math.SQRT2));
}

/**
 * How much of the machine ceiling this bot may spend right now (19.4's traits
 * paragraph). The ceiling itself is the caller's: pass foresight's
 * HYPOTHESIS_COUNT, or whatever the frame budget has left.
 *
 * @param {object} args
 * @param {number} args.cap          the machine ceiling, in hypotheses (6.7)
 * @param {object} [args.traits]     6.16: concentration, composure, anticipation
 * @param {number} [args.pressure]   0..1 situational pressure (a 1v2, a closing
 *                                   window). Only composure resists it.
 * @param {number} [args.spent]      hypotheses already visualized this round
 * @returns {{cap:number, lookaheadSeconds:number, scale:number}}
 */
export function visualizationBudget({ cap, traits = {}, pressure = 0, spent = 0 } = {}) {
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : 0;
  const concentration = clamp01(traits.concentration ?? 0.5);
  const composure = clamp01(traits.composure ?? 0.5);
  const anticipation = clamp01(traits.anticipation ?? 0.5);

  const breadth = CONCENTRATION_FLOOR + (1 - CONCENTRATION_FLOOR) * concentration;
  const nerve = 1 - clamp01(pressure) * (1 - composure);
  const drain = 1 / (1 + DRAIN_K * (ceiling > 0 ? Math.max(0, spent) / ceiling : 0));
  const scale = breadth * nerve * drain;

  return {
    // One hypothesis is the floor: a bot that has collapsed still has to price
    // something, and zero options is not a decision.
    cap: ceiling > 0 ? Math.max(1, Math.round(ceiling * scale)) : 0,
    lookaheadSeconds:
      LOOKAHEAD_MIN_SECONDS + (LOOKAHEAD_MAX_SECONDS - LOOKAHEAD_MIN_SECONDS) * anticipation,
    scale
  };
}

const NO_CAP = Object.freeze({
  capped: false,
  budget: null,
  commitMult: 1,
  commitTicks: null,
  comm: null,
  reason: ''
});

/**
 * The novelty cap (20.11). Three conjuncts, all three required: retrieval found
 * nothing, the split is open, and no price dominates. Any one of them missing
 * and the ordinary inequality is trusted.
 *
 * @param {object} args
 * @param {boolean} args.retrievalMatched  did 18.3 find a matching situation
 *   before its backoff was exhausted?
 * @param {number} args.splitEntropy       knowledge.js splitEntropy(zones), bits
 * @param {number} args.dominance          weight share in which the modal option
 *   is also the per-hypothesis best (voi().bestShare)
 * @param {number} [args.entropyBits]
 * @param {number} [args.dominanceShare]
 * @param {number} [args.minCommitTicks]   the caller's own base (options.js
 *   MIN_COMMIT_TICKS); omitted, only the multiplier comes back
 * @param {string} [args.id]               the option being committed to
 * @returns {{capped:boolean, budget:number|null, commitMult:number,
 *   commitTicks:number|null, comm:object|null, reason:string}}
 */
export function noveltyCap({
  retrievalMatched = true,
  splitEntropy = 0,
  dominance = 1,
  entropyBits = NOVELTY_ENTROPY_BITS,
  dominanceShare = NOVELTY_DOMINANCE_SHARE,
  minCommitTicks = null,
  id = null
} = {}) {
  const blind = retrievalMatched === false;
  const open = Number.isFinite(splitEntropy) && splitEntropy > entropyBits;
  const undominated = !(Number.isFinite(dominance) && dominance >= dominanceShare);
  if (!blind || !open || !undominated) return NO_CAP;

  const target = id || 'the argmax';
  return {
    capped: true,
    budget: 0, // the plan's literal "budget := 0"
    commitMult: NOVELTY_COMMIT_MULT,
    commitTicks: Number.isFinite(minCommitTicks)
      ? Math.round(minCommitTicks * NOVELTY_COMMIT_MULT)
      : null,
    // Level 5 (20.1): the ASP is what makes this a team behaviour instead of a
    // stubborn bot. Callers fill in the zone; the shape is the contract.
    comm: {
      level: 5,
      asp: { if: `I take contact on ${target}`, then: 'commit with me, trade off me' }
    },
    reason: `nothing familiar, the split is open at ${n3(splitEntropy)} bits and no price dominates, so pick a wall and follow it`
  };
}

/**
 * Widen, gather, or commit: 19.4's rule, as one surplus test over three
 * purchases.
 *
 * @param {object} args
 * @param {number|ReturnType<typeof voi>} args.voi  the read's worth in pWin
 *   units, or the whole voi() result (preferred: it carries the modal option's
 *   id and its dominance share)
 * @param {number} [args.resolvable]      0..1 share of the VOI that THINKING can
 *   remove (resolvableShare). Defaults to 1, which degrades to the plan's plain
 *   widen-or-commit rule for callers with no world/arithmetic split modelled.
 * @param {number} [args.secondsCost]     seconds the next hypothesis batch costs
 * @param {number} [args.gatherSeconds]   seconds the cheapest resolving action costs
 * @param {number} [args.contingencySeconds]  seconds arming one trigger row costs
 * @param {number} args.dPRWPerSecond     what a second of clock is worth here,
 *   in pWin units per second. This is the term that closes windows.
 * @param {number} [args.cap]             hypotheses this bot may spend
 *   (visualizationBudget().cap). Absent, the ceiling is unknown and only the
 *   inequality decides.
 * @param {number} [args.layoutCount]     hypotheses already priced
 * @param {number} [args.widenBatch]
 * @param {boolean} [args.gatherAvailable] is there an action that would reveal
 *   it? No utility and no cover means the purchase is not on the shelf.
 * @param {object} [args.novelty]         noveltyCap() inputs, or its result
 * @param {number} [args.minCommitTicks]  options.js MIN_COMMIT_TICKS
 * @returns {{decision:'widen'|'gather'|'commit', alsoGather:boolean,
 *   contingency:boolean, budget:number, commitMult:number,
 *   commitTicks:number|null, comm:object|null, reason:string, parts:object}}
 */
export function budgetDecision({
  voi: read = 0,
  resolvable = 1,
  secondsCost = WIDEN_SECONDS,
  gatherSeconds = GATHER_SECONDS,
  contingencySeconds = CONTINGENCY_SECONDS,
  dPRWPerSecond = 0,
  cap = Infinity,
  layoutCount = 0,
  widenBatch = WIDEN_BATCH,
  gatherAvailable = true,
  novelty = null,
  minCommitTicks = null
} = {}) {
  const isResult = read && typeof read === 'object';
  const value = Math.max(0, (isResult ? read.value : read) || 0);
  const id = (isResult ? read.bestId : null) || 'the modal option';
  const dominance = isResult ? read.bestShare : 1;
  const drawn = Math.max(0, layoutCount);

  // The novelty cap runs first and short-circuits, because its whole content is
  // that the inequality below is the wrong instrument here (20.11).
  const capResult = !novelty
    ? NO_CAP
    : typeof novelty.capped === 'boolean'
      ? novelty
      : noveltyCap({ dominance, minCommitTicks, id, ...novelty });

  const perSecond = Math.max(0, dPRWPerSecond) || 0;
  const share = clamp01(resolvable);
  const headroom = cap > drawn;

  // The one inequality. Every row of 19.4's table is this line with different
  // numbers in it.
  const surplus = (gain, seconds) => gain - Math.max(0, seconds) * perSecond;

  const widenGain = headroom ? share * value : 0;
  const gatherGain = gatherAvailable ? (1 - share) * value : 0;
  const contingencyGain = CONTINGENCY_CAPTURE * value;

  const widenSurplus = surplus(widenGain, secondsCost);
  const gatherSurplus = surplus(gatherGain, gatherSeconds);
  const contingencySurplus = surplus(contingencyGain, contingencySeconds);

  let decision = 'commit';
  if (widenSurplus > 0 || gatherSurplus > 0) {
    decision = widenSurplus >= gatherSurplus ? 'widen' : 'gather';
  }
  const alsoGather = decision === 'widen' && gatherSurplus > 0;
  // A contingency is a rider on COMMITTING: it is what stays armed when the
  // bot stops buying. Widening or gathering has not committed to anything yet.
  const contingency = decision === 'commit' && contingencySurplus > 0;

  const parts = {
    voi: value,
    resolvable: share,
    perSecond,
    widenGain,
    widenCost: Math.max(0, secondsCost) * perSecond,
    widenSurplus,
    gatherGain,
    gatherCost: Math.max(0, gatherSeconds) * perSecond,
    gatherSurplus,
    contingencyGain,
    contingencyCost: Math.max(0, contingencySeconds) * perSecond,
    contingencySurplus,
    headroom,
    capped: capResult.capped
  };

  if (capResult.capped) {
    return {
      decision: 'commit',
      alsoGather: false,
      contingency: false,
      budget: 0,
      commitMult: capResult.commitMult,
      commitTicks: capResult.commitTicks,
      comm: capResult.comm,
      reason: `commit ${id}: ${capResult.reason}`,
      parts
    };
  }

  const base = {
    alsoGather,
    contingency,
    commitMult: 1,
    commitTicks: Number.isFinite(minCommitTicks) ? Math.round(minCommitTicks) : null,
    comm: null,
    parts
  };

  if (decision === 'widen') {
    return {
      ...base,
      decision,
      budget: Math.min(cap, drawn + Math.max(1, widenBatch)),
      reason: alsoGather
        ? `widen: another batch buys ${n3(widenGain)} for ${n3(parts.widenCost)} of clock, and an action is worth ${n3(gatherGain)}`
        : `widen: another batch buys ${n3(widenGain)} for ${n3(parts.widenCost)} of clock`
    };
  }

  if (decision === 'gather') {
    return {
      ...base,
      decision,
      budget: drawn,
      reason: `gather: the read is worth ${n3(gatherGain)} and no amount of thinking resolves it, so spend an action`
    };
  }

  let reason;
  if (value === 0) {
    reason = `commit ${id}: every hypothesis wants it, more thinking cannot change the pick`;
  } else if (contingency) {
    reason = `commit ${id}: the read is worth ${n3(value)}, thinking costs ${n3(parts.widenCost)}, one contingency stays armed`;
  } else {
    reason = `commit ${id}: a second costs ${n3(perSecond)} against a ${n3(value)} read, check nothing else`;
  }
  return { ...base, decision, budget: drawn, reason };
}
