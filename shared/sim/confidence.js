// ---------------------------------------------------------------------------
// shared/sim/confidence.js
// confidenceBias: the gap between the odds a bot is GIVEN and the odds it
// DECIDES with.
//
// SIM-PLAN 6.9: the PFW a bot decides with is `sigmoid(logit(PFW) + b_i)`.
// A positive `b_i` makes every fight look better than the model says it is,
// which is exactly what a player who takes fights the model dislikes and wins
// them anyway is doing; a negative one is the player who only takes free
// fights and still passes some up. SIM-PLAN 8.2 lists `confidenceBias` in the
// skill profile and says it is FITTED from the mimicked player's own pfw/pfo
// rather than typed in by hand, which is what `fitConfidenceBias` does here.
//
// The fit is the bias that would make the decided odds equal the realized
// ones. duelStats measures pfw (average predicted fight winrate of the fights
// they took) and pfo (realized winrate minus that prediction), so the realized
// rate is pfw + pfo and the principled bias is
//
//   b = logit(pfw + pfo) - logit(pfw)
//
// i.e. exactly the log-odds shift the player's results say they are applying
// to the model's numbers. Two disciplines are layered on top:
//
// - A hard band, |b| <= CONFIDENCE_BIAS_MAX (1.5). At b = 1.5 a coin-flip
//   fight already reads as ~82%, which is past any self-belief a human
//   actually sustains; beyond that the sigmoid saturates and the arbiter goes
//   blind to the real odds, which is an aimbot of the mind the same way an
//   uncapped turn rate is one of the wrist (8.2's pro envelope, in spirit).
// - Small-sample shrinkage (SIM-PLAN 10.3, "Sample-size discipline ... below a
//   floor of rounds per player, each habit falls back"): the clamped fit is
//   scaled by n / (n + CONFIDENCE_SHRINK_HALF), so a thin sample keeps only a
//   sliver of its raw bias and drifts toward the honest default of 0. One
//   map's worth of fights earns roughly half the raw value; a few maps earn
//   most of it. The clamp is applied BEFORE the shrink so an outlandish raw
//   fit is first capped, then discounted — no sample size can buy more than
//   the band, and a small one buys proportionally less of it.
//
// Field-name mapping (read from src/replays/duels/duelStats.js and
// scripts/duel-stats.test.mjs): `summarizeDuelStats` yields per player
// `{ pfw, pfo, duels }` where pfw and pfo are in PERCENTAGE POINTS (pfw in
// (0, 100), pfo in (-100, 100)) and `duels` is the duel weight (one per duel).
// The names match this module's; the UNITS do not — the core here works in
// probabilities. `fitConfidenceBiasFromDuels` is the adapter: it divides by
// 100 and uses `duels` as the sample size.
//
// Pure functions, no I/O, no rng: the fit is a deterministic map from measured
// numbers to a trait, so the same demos always produce the same bot.
//
// NOT yet wired into desireBot.js / skill.js — the arbiter integration is a
// later step; this module is the transform and the fit only.
// ---------------------------------------------------------------------------

/**
 * Probabilities are clamped into [PFW_EPS, 1 - PFW_EPS] before logit so the
 * transform is finite for any input. 1% is far below anything duelStats can
 * emit for a real player (a measured pfw of 0 or 1 would mean the model never
 * gave them a moment of doubt across every duel of a match).
 */
export const PFW_EPS = 0.01;

/** The hard band on a fitted or configured bias, in log-odds. */
export const CONFIDENCE_BIAS_MAX = 1.5;

/**
 * Sample size at which the fit keeps half of its (clamped) raw value.
 * ~25 duels is about one map for an active player, so one map earns half,
 * four maps earn ~80%, and a handful of fights earns almost nothing.
 */
export const CONFIDENCE_SHRINK_HALF = 25;

const clampProb = (p) => Math.min(1 - PFW_EPS, Math.max(PFW_EPS, p));

const logit = (p) => Math.log(p / (1 - p));

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * The odds a bot decides with: `sigmoid(logit(pfw) + bias)` (SIM-PLAN 6.9).
 *
 * A zero bias is a no-op up to float eps (the logit/sigmoid round trip), so a
 * bot with no personality fitted decides on exactly the model's numbers.
 *
 * @param {number} pfw   predicted fight winrate, a probability in (0, 1);
 *                       clamped into [PFW_EPS, 1 - PFW_EPS]; non-finite reads
 *                       as a coin flip (0.5)
 * @param {number} bias  confidenceBias in log-odds; non-finite reads as 0
 * @returns {number} the decided probability, always in (0, 1)
 */
export function decidedPfw(pfw, bias) {
  const p = clampProb(Number.isFinite(pfw) ? pfw : 0.5);
  const b = Number.isFinite(bias) ? bias : 0;
  return sigmoid(logit(p) + b);
}

/**
 * Fit `confidenceBias` from a player's measured pfw/pfo.
 *
 * Both inputs are PROBABILITIES here (0..1 scale). Coming from duelStats,
 * which speaks in percentage points, use `fitConfidenceBiasFromDuels`.
 *
 * Missing or non-finite numbers, and an empty sample, fit to 0: no evidence
 * means no personality, not a random one.
 *
 * @param {object} args
 * @param {number} args.pfw     average predicted fight winrate, 0..1
 * @param {number} args.pfo     overperformance vs that prediction, -1..1
 * @param {number} args.rounds  sample size backing the numbers — rounds or
 *                              fight count, whichever the caller measures with
 * @returns {number} bias in [-CONFIDENCE_BIAS_MAX, CONFIDENCE_BIAS_MAX]
 */
export function fitConfidenceBias({ pfw, pfo, rounds } = {}) {
  if (!Number.isFinite(pfw) || !Number.isFinite(pfo)) return 0;
  const n = Number.isFinite(rounds) ? rounds : 0;
  if (n <= 0) return 0;

  const raw = logit(clampProb(pfw + pfo)) - logit(clampProb(pfw));
  const banded = Math.min(CONFIDENCE_BIAS_MAX, Math.max(-CONFIDENCE_BIAS_MAX, raw));
  return banded * (n / (n + CONFIDENCE_SHRINK_HALF));
}

/**
 * Adapter from a `summarizeDuelStats` entry (src/replays/duels/duelStats.js):
 * `{ pfw, pfo, duels }` in percentage points, `duels` being the duel weight.
 * Converts to probabilities and uses the duel count as the sample size.
 *
 * @param {{ pfw: number, pfo: number, duels: number }} entry
 * @returns {number} bias in [-CONFIDENCE_BIAS_MAX, CONFIDENCE_BIAS_MAX]
 */
export function fitConfidenceBiasFromDuels(entry = {}) {
  return fitConfidenceBias({
    pfw: entry.pfw / 100,
    pfo: entry.pfo / 100,
    rounds: entry.duels
  });
}
