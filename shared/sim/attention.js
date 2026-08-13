// ---------------------------------------------------------------------------
// shared/sim/attention.js
// The two caps that keep a human-looking bot from being a superhuman one.
//
// SIM-PLAN 5.7. The aim motor already caps the crosshair at human speed (8.1),
// but an 8 Hz policy that re-decides strategy 125 ms after any event is
// mechanically human and tactically superhuman — that was correction #2 of the
// second pass. Two mechanisms close it:
//
//   ATTENTION. A bot tracks `k` enemy slots at full fidelity; the rest of its
//   personal belief is the marginal view (knowledge.js: personalView). This is
//   the mechanism that produces "he forgot about the lurker" without anyone
//   authoring dumbness, and death converts a bot's motor loop into pure
//   attention: the dead watch the radar (5.8), capped so a wiped team is not
//   somehow more aware than a full one.
//
//   DECISION LATENCY. An event may not change a bot's chosen option faster
//   than a LogNormal draw, and a TEAM replan pays the caller's own latency
//   plus the comm delay on top. Reflex exceptions — taking damage, fire on my
//   feet, an enemy inside my crosshair cone — bypass it; those are spinal, and
//   they are exactly the events interrupts.js already classifies as local.
//
// Both caps are trait-scaled (6.16): `concentration` buys attention,
// `decisionSpeed` buys latency. Neither touches the motor, so neither can
// cross the anti-aimbot wall no matter how it is set.
// ---------------------------------------------------------------------------

import {
  ATTENTION_SLOTS_MAX,
  ATTENTION_SLOTS_MIN,
  COMM_DELAY_MAX,
  COMM_DELAY_MIN,
  DEAD_ATTENTION_BONUS_CAP,
  DECISION_LATENCY_MEDIAN_FLOOR,
  DECISION_LATENCY_MEDIAN_PRO,
  DECISION_LATENCY_P90_RATIO,
  TICK_RATE
} from './constants.js';

/**
 * Events that bypass the latency gate. Spinal, not deliberate: the same set
 * 10.2 classifies as local interrupts, minus the housekeeping ones.
 */
export const REFLEX_EVENTS = Object.freeze(new Set(['damage', 'contact', 'molotov_feet']));

/** Slots a living bot may track at full fidelity, from its concentration. */
export function attentionBudget(profile) {
  const c = profile?.concentration ?? 0.5;
  return ATTENTION_SLOTS_MIN + (ATTENTION_SLOTS_MAX - ATTENTION_SLOTS_MIN) * c;
}

/**
 * Per-bot budgets for a side, with the dead contributing what spectators
 * contribute: eyes on the radar, shared out through comms.
 *
 * The dead-bot bonus is spread evenly over the living, is scaled by each dead
 * bot's own concentration (tilted players stop calling), and is capped so the
 * bonus can never exceed DEAD_ATTENTION_BONUS_CAP in total. A 5v2 therefore
 * has a genuine, modelled awareness edge on both sides (5.8).
 *
 * @param {Array<object>} profiles  five trait profiles
 * @param {Array<boolean>} alive    five flags
 * @returns {number[]} budget per slot; dead slots get 0
 */
export function teamAttention(profiles, alive) {
  let deadPool = 0;
  let living = 0;
  for (let s = 0; s < profiles.length; s += 1) {
    if (alive[s]) living += 1;
    else deadPool += 0.5 * (profiles[s]?.concentration ?? 0.5);
  }
  deadPool = Math.min(DEAD_ATTENTION_BONUS_CAP, deadPool);
  const share = living > 0 ? deadPool / living : 0;
  return profiles.map((p, s) => (alive[s] ? attentionBudget(p) + share : 0));
}

/**
 * Which enemy slots does this bot attend right now?
 *
 * Fractional budgets are resolved by a deterministic draw: a budget of 2.4
 * attends the top two priorities always and the third 40% of decision steps,
 * which is what intermittently checking the lurker looks like from outside.
 *
 * @param {number} budget            from teamAttention
 * @param {Array<{slot:number, priority:number}>} priorities  caller-ranked
 *   (belief mass near me, threat, recency — the caller owns the ranking)
 * @param {import('./rng.js').Rng} rng
 * @returns {number[]} attended enemy slots, for personalView()
 */
export function chooseAttended(budget, priorities, rng) {
  const ranked = [...priorities].sort((a, b) => b.priority - a.priority);
  const whole = Math.floor(budget);
  const frac = budget - whole;
  const n = Math.min(ranked.length, whole + (rng.next() < frac ? 1 : 0));
  return ranked.slice(0, n).map((r) => r.slot);
}

/**
 * The latency gate: when may this bot next change its chosen option?
 *
 * The 8 Hz clock is how often a bot MAY decide, not how often it does. An
 * event opens a window only after the draw elapses; a reflex event opens it
 * now. Option commitment (6.6 minCommitTicks) stacks on top of this — the
 * gate answers "may I re-decide", not "must I".
 */
export class LatencyGate {
  /**
   * @param {object} cfg
   * @param {import('./rng.js').Rng} cfg.rng
   * @param {object} cfg.profile   trait profile (6.16); decisionSpeed scales
   * @param {number} [cfg.tickRate]
   */
  constructor({ rng, profile, tickRate = TICK_RATE }) {
    this.rng = rng;
    this.tickRate = tickRate;
    const speed = profile?.decisionSpeed ?? 0.5;
    // Weak end waits twice as long. The pro median is a FLOOR: no trait value
    // makes deliberation instant, which is the whole point of the gate.
    this.median =
      DECISION_LATENCY_MEDIAN_FLOOR +
      (DECISION_LATENCY_MEDIAN_PRO - DECISION_LATENCY_MEDIAN_FLOOR) *
        Math.max(0, Math.min(1, speed));
    this.p90 = this.median * DECISION_LATENCY_P90_RATIO;
    /** Earliest tick a deliberate re-decision is allowed. 0 = free to decide. */
    this.openAtTick = 0;
  }

  /**
   * An event arrived that might change the chosen option. Returns the tick at
   * which the bot may act on it. Multiple events race: the EARLIEST window
   * wins, because any one of them is sufficient reason to re-plan.
   */
  onEvent(tick, eventType) {
    if (REFLEX_EVENTS.has(eventType)) {
      this.openAtTick = tick;
      return tick;
    }
    const delay = this.rng.logNormalFromP90(this.median, this.p90);
    const at = tick + Math.max(1, Math.round(delay * this.tickRate));
    if (this.openAtTick === 0 || at < this.openAtTick) this.openAtTick = at;
    return this.openAtTick;
  }

  /**
   * May the bot act on a pending event at this tick? False both while the
   * window is still closed and when no event is pending at all — an option
   * that simply terminated re-decides through its own termination, not here.
   */
  mayDecide(tick) {
    return this.openAtTick !== 0 && tick >= this.openAtTick;
  }

  /** The option changed: consume the window. */
  decided() {
    this.openAtTick = 0;
  }
}

/**
 * Earliest tick a TEAM replan ordered by `callerSlot` can take effect for the
 * others: the caller's own deliberation plus one comm-delay draw (5.1). The
 * caller acts on its own conclusion immediately after its gate; teammates hear
 * about it strictly later. Nothing in the design lets a team think faster than
 * its IGL can speak.
 */
export function teamReplanTick(tick, callerGate, rng, tickRate = TICK_RATE) {
  const deliberate = rng.logNormalFromP90(callerGate.median, callerGate.p90);
  const comm = COMM_DELAY_MIN + rng.next() * (COMM_DELAY_MAX - COMM_DELAY_MIN);
  return tick + Math.max(1, Math.round((deliberate + comm) * tickRate));
}
