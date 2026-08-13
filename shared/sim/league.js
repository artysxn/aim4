// ---------------------------------------------------------------------------
// shared/sim/league.js
// Three populations, PFSP, and the exploitability gate.
//
// SIM-PLAN 9.12. A "league" that is just the current checkpoint plus the BC
// anchor collapses: everyone camps, or everyone learns one strategy really
// well. The version that actually prevented collapse in StarCraft has three
// roles, copied exactly:
//
//   Main agents         PFSP over the whole pool, plus 35% self-play
//   Main exploiters     the current main agent only; reset to BC when they
//                       succeed or after a budget
//   League exploiters   PFSP over the whole pool, so old holes do not return
//
// PFSP samples an opponent with probability proportional to f(P(win against
// it)), f(x) = (1 - x)^p, p around 2: hard-but-beatable. Exploiters are
// admitted to the pool but never shipped. A main agent's admission to
// generation N still requires the 9.8 gates; this file only does the pool
// arithmetic so the trainer and the eval harness cannot disagree about who
// plays whom.
//
// Pure. The caller injects rng. Win rates are numbers the eval already has.
// ---------------------------------------------------------------------------

/** Self-play share for a main agent. 9.12's 35%. */
export const SELF_PLAY = 0.35;

/** PFSP exponent. `[calibrate]` */
export const PFSP_P = 2;

/** Win rate at which a main exploiter is declared successful and reset to BC. `[calibrate]` */
export const EXPLOITER_RESET = 0.8;

/** Fresh-exploiter win rate above which a candidate is too fragile to admit. `[calibrate]` */
export const EXPLOITABILITY_FAIL = 0.8;

export const ROLE = Object.freeze({
  MAIN: 'main',
  MAIN_EXPLOITER: 'main-exploiter',
  LEAGUE_EXPLOITER: 'league-exploiter'
});

/**
 * f(x) = (1 - x)^p. x is P(this agent beats that opponent).
 * A 50/50 opponent is interesting; a 95% punching bag is not.
 */
export function pfspWeight(winRate, p = PFSP_P) {
  const x = Number.isFinite(winRate) ? Math.min(1, Math.max(0, winRate)) : 0.5;
  return Math.pow(1 - x, p);
}

/**
 * Draw one opponent id from a pool given this agent's win rates against them.
 *
 * @param {object} rng  {next()} or {int(n)}
 * @param {string[]} pool  opponent ids, excluding self
 * @param {Record<string, number>} winRates  P(I beat them)
 */
export function samplePfsp(rng, pool, winRates = {}, p = PFSP_P) {
  if (!pool?.length) return null;
  const weights = pool.map((id) => pfspWeight(winRates[id] ?? 0.5, p));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    const i = typeof rng.int === 'function' ? rng.int(pool.length) : Math.floor(rng.next() * pool.length);
    return pool[i];
  }
  let u = (typeof rng.next === 'function' ? rng.next() : Math.random()) * sum;
  for (let i = 0; i < pool.length; i += 1) {
    u -= weights[i];
    if (u <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * Who a given role trains against this step.
 *
 * @param {object} args
 * @param {string} args.role
 * @param {string} args.selfId
 * @param {string} args.mainId   current main champion
 * @param {string[]} args.pool   everyone admitted, including mains and exploiters
 * @param {Record<string, number>} args.winRates
 * @param {object} args.rng
 * @returns {{opponent: string, kind: 'self'|'pfsp'|'main'}}
 */
export function pickOpponent({
  role,
  selfId,
  mainId,
  pool = [],
  winRates = {},
  rng,
  selfPlay = SELF_PLAY
}) {
  if (role === ROLE.MAIN_EXPLOITER) {
    return { opponent: mainId, kind: 'main' };
  }
  if (role === ROLE.MAIN && rng.next() < selfPlay) {
    return { opponent: selfId, kind: 'self' };
  }
  const others = pool.filter((id) => id !== selfId);
  const opponent = samplePfsp(rng, others.length ? others : [mainId || selfId], winRates);
  return { opponent, kind: 'pfsp' };
}

/**
 * Should this main exploiter reset to the BC anchor?
 * Success (beat the main above the bar) or a spent budget both reset.
 */
export function exploiterShouldReset({ winRateVsMain, steps, budget }) {
  if (winRateVsMain >= EXPLOITER_RESET) return { reset: true, reason: 'beat the main' };
  if (Number.isFinite(budget) && steps >= budget) return { reset: true, reason: 'budget spent' };
  return { reset: false, reason: 'still hunting' };
}

/**
 * Exploitability gate: a fresh exploiter trained for a fixed budget must not
 * beat the candidate above EXPLOITABILITY_FAIL.
 */
export function exploitabilityGate(exploiterWinRate, fail = EXPLOITABILITY_FAIL) {
  const wr = Number(exploiterWinRate) || 0;
  return {
    pass: wr < fail,
    winRate: wr,
    reason: wr < fail
      ? `exploiter ${wr.toFixed(3)} under ${fail}`
      : `exploiter ${wr.toFixed(3)} beats the candidate; too fragile`
  };
}

/**
 * A generation directory's pool listing. Exploiters stay in the pool and are
 * flagged so the UI never offers them as a playable brain.
 */
export function poolEntry({ id, role, shipped = false, parent = null, winRates = {} }) {
  return {
    id,
    role,
    shipped: Boolean(shipped) && role === ROLE.MAIN,
    parent,
    winRates: { ...winRates }
  };
}
