// ---------------------------------------------------------------------------
// shared/sim/reward.js
// The training-only team reward: what a generation is paid for.
//
// SIM-PLAN 9.5 is the formula and the anti-hacking contract. A bot's goal is
// to win the round (decision 11 / objective.js). Everything else is a training
// wheel: potential-based shaping on god-view P(win), a damage residual, sparse
// plant/defuse events, a capped coach slap, a plan-adherence nudge, a trade
// bonus that encodes a fact about CS, and a small information-gain term that
// must later anneal to zero or bots will scout for a living. β2 (xK potential)
// and β9 (readability) sit in the genome so a later generation can turn them
// on; this spine leaves them at the coefficients the plan's example genome
// carries, with β9 starting at 0 because a critic that can read our option
// from the enemy observation does not exist yet.
//
// Both Φ terms are potential-based (Ng, Harada, Russell): r += γΦ(s′) − Φ(s).
// That identity does not change the optimal policy, which is why 9.5 can
// anneal β1, β2 → 0 across generations without having taught a different game.
// The potentials MAY read god-view engine state. They never reach an actor.
// Stating it here because 9.5 is explicit that the same person will otherwise
// write the trainer's Φ and the observation's belief summaries on the same
// afternoon and quietly merge them.
//
// SIM-PLAN 9.10 is team spirit τ: each agent optimizes
// (1 − τ) · own + τ · team mean, annealed from TAU_START (0.3) to TAU_END
// (1.0). Sharing one team reward from step one buries "I positioned well"
// under four teammates; OpenAI Five's τ is the fix, adopted verbatim. own
// shaping is deliberately small (damage/100 + a trade crumb) and has NO term
// for dying — 19.9 / 9.5: a bot paid to die will find a way, and possession
// is also refused so nobody paints the map instead of winning.
//
// SIM-PLAN 9.4 supplies γ = 0.999 (800-step horizons). Terminal R_win (±1) is
// not folded into stepReward; it is terminalReward(winner, side), written on
// the last sample of a round. discountedReturns is the Monte Carlo backbone
// the numpy PPO trainer uses when samples have no critic values.
//
// Pure. No I/O, no rng, no clock. The same inputs always produce the same
// {team, parts}, because a generation autopsy that cannot replay a β
// contribution is not an autopsy.
// ---------------------------------------------------------------------------

import { featuresFromEngine, winProbability, deltaWin } from './objective.js';

/**
 * β1..β9 as 9.5 names them, coefficients from the plan's genome example
 * with β9 (readability) starting at 0. Index 0 is β1.
 *
 *   β1 ΔΦ_round   β2 ΔΦ_xk   β3 damage   β4 objective   β5 coach
 *   β6 plan       β7 trade   β8 info     β9 readability
 */
export const DEFAULT_BETA = Object.freeze([1.0, 0.6, 0.2, 1.0, 0.4, 0.3, 0.3, 0.1, 0.0]);

/** 9.4: γ 0.999 for 800-step horizons. */
export const GAMMA = 0.999;

/** 9.10: τ starts selfish-enough-to-learn and anneals to selfless. */
export const TAU_START = 0.3;
export const TAU_END = 1.0;

const PLANT_EVENT = 0.3;
const DEFUSE_EVENT = 0.5;
const PLAN_MISS = -0.05;
const COACH_CAP = 3;
const OWN_TRADE = 0.2;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Linear τ schedule. progress01 is the generation's life, 0..1. */
export function annealTau(progress01) {
  const p = clamp01(progress01);
  return TAU_START + (TAU_END - TAU_START) * p;
}

/** (1 − τ) · own + τ · team mean. τ = 1 is pure team; τ = 0 is pure own. */
export function teamSpirit(own, teamMean, tau) {
  return (1 - tau) * own + tau * teamMean;
}

/**
 * Φ_round: P(this side wins) from god-view engine features.
 *
 * Training only. `model` is the injected fitted round model when a host has
 * one; the fallback in objective.js is monotone in the four win conditions
 * and is enough for a spine.
 */
export function potentialRound(engine, side, model = null) {
  return winProbability(featuresFromEngine(engine), side, model);
}

/** Potential-based shaping: γΦ(s′) − Φ(s). */
export function shaped(prevPhi, nextPhi, gamma = GAMMA) {
  return gamma * nextPhi - prevPhi;
}

function eventType(e) {
  return typeof e === 'string' ? e : e?.type;
}

/** Plant +0.3, defuse +0.5. Accepts the engine's bomb_* names too. */
function objectiveEvents(events) {
  let s = 0;
  for (const e of events || []) {
    const t = eventType(e);
    if (t === 'plant' || t === 'bomb_planted') s += PLANT_EVENT;
    else if (t === 'defuse' || t === 'bomb_defused') s += DEFUSE_EVENT;
  }
  return s;
}

/**
 * One decision-step of team reward. Terminal ±1 is NOT here.
 *
 * `parts` is named so a generation autopsy can log each β contribution
 * without reverse-engineering a scalar. No `death` key, no possession term.
 * Coach hits are capped at 3 so one weird round cannot dominate a batch.
 *
 * `deltaWin` is imported because 9.5 prices a change in P(win), not a level;
 * the Φ term uses `shaped` (the potential form) rather than a raw delta so
 * annealing β1 later does not change the game.
 */
export function stepReward({
  prevPhi,
  nextPhi,
  side,
  events = [],
  damageDealt = 0,
  damageTaken = 0,
  beta = DEFAULT_BETA,
  infoGain = 0,
  traded = false,
  coachHits = 0,
  planAdhered = true
}) {
  const b = beta;
  const dPhi = shaped(prevPhi, nextPhi);
  const dmg = (damageDealt - damageTaken) / 100;
  const obj = objectiveEvents(events);
  const coach = Math.min(Math.max(0, coachHits), COACH_CAP);
  const plan = planAdhered ? 0 : PLAN_MISS;
  const trade = traded ? 1 : 0;

  const parts = {
    phi: b[0] * dPhi,
    xk: 0,
    damage: b[2] * dmg,
    objective: b[3] * obj,
    coach: -b[4] * coach,
    plan: b[5] * plan,
    trade: b[6] * trade,
    info: b[7] * infoGain,
    read: b[8] * 0
  };
  let team = 0;
  for (const v of Object.values(parts)) team += v;
  return { team, parts };
}

/** +1 if this side won, −1 if it lost. */
export function terminalReward(winner, side) {
  if (winner === side) return 1;
  if (winner == null) return 0;
  return -1;
}

/**
 * The selfish crumb 9.10 mixes under (1 − τ). Damage residual plus a trade
 * bonus. NEVER a term for dying: a death bonus is how you train baiters.
 */
export function ownShaping({ damageDealt = 0, damageTaken = 0, traded = false }) {
  return (damageDealt - damageTaken) / 100 + (traded ? OWN_TRADE : 0);
}

/** Mix one agent's team reward with its own crumb at the current τ. */
export function mixAgent(teamReward, ownReward, tau) {
  return teamSpirit(ownReward, teamReward, tau);
}

/**
 * Monte Carlo returns. `dones[t] = 1` cuts the bootstrap so a new round
 * does not leak into the previous one. Used as advantages when the dataset
 * has no critic values (P5 spine: no centralized critic yet).
 */
export function discountedReturns(rewards, dones, gamma = GAMMA) {
  const n = rewards.length;
  const out = new Array(n);
  let acc = 0;
  for (let t = n - 1; t >= 0; t -= 1) {
    const done = dones[t] ? 1 : 0;
    acc = rewards[t] + gamma * acc * (1 - done);
    out[t] = acc;
  }
  return out;
}
