// ---------------------------------------------------------------------------
// shared/sim/arbiter.js
// Desire scoring: the arbitration layer that works before the ML does.
//
// SIM-PLAN 6.17, mapped from the one shipped bot API worth copying: Dota 2's
// modes each return GetDesire() in 0..1, the highest becomes the active mode,
// team desires are evaluated first, ability use runs on its own think, and a
// desire may return nil to fall through to a default. Onto our layers without
// deformation: team desires are the Playstyle AI, modes are our options (6.6),
// the independent think is the always-live aim motor, and the nil fallback is
// the seam where a learned policy will sit — any option whose learned desire
// is unavailable or unconfident falls through to THIS file, which is Dota's
// nil pattern and the cleanest possible hybrid.
//
// The MOTIVE STRING is not a debugging afterthought, it is the product. Every
// decision reads "wide_swing banana_car: 0.72, motive: their AWP is cycling
// and my earliest-occupy beats theirs" — what makes the /sim page worth
// opening, and a wrong decision diagnosable in one line instead of a gradient
// investigation.
//
// Budget (6.7): foresight prices the CHEAP-RANKED top few plus the incumbent;
// everything else is masked by cost, not evaluated. Hysteresis plus option
// commitment (6.6) plus decision latency (5.7) are the three anti-dither
// clocks, and all three must agree before a standing decision is abandoned.
// ---------------------------------------------------------------------------

/** Candidates priced per decision, beyond the incumbent. The plan's budget. */
export const PRICE_BUDGET = 3;

/** The incumbent's stickiness, in desire units. Dota's threshold, ours. */
export const HYSTERESIS = 0.08;

/** How many desire units one full pWin of priced edge is worth. `[calibrate]` */
export const PRICE_GAIN = 2.5;

/** Desire bonus for an option a trigger armed: the future outranks the now. */
export const TRIGGER_BONUS = 0.15;

/**
 * @typedef {object} Candidate
 * @property {string} id            option id (options.js)
 * @property {object} params
 * @property {number} [prior]       cheap pre-rank hint, 0..1, default 0.5
 * @property {{id:string, motive:string}} [trigger]  the row that armed it
 * @property {boolean} [isHome]     returns the bot toward its shape post
 * @property {string} [motive]      caller-supplied reason, used when no
 *                                  trigger and no price says better
 */

/**
 * The scripted arbiter for one bot. Owns nothing but its traits and dice;
 * candidates and prices come in, one decision with a motive goes out.
 */
export class DesireArbiter {
  /**
   * @param {object} cfg
   * @param {object} cfg.traits  the trait vector (6.16): decisions, teamwork,
   *   aggression, offBall are read here; the rest gate elsewhere
   * @param {import('./rng.js').Rng} cfg.rng
   * @param {number} [cfg.priceBudget]
   */
  constructor({ traits, rng, priceBudget = PRICE_BUDGET }) {
    this.traits = traits || {};
    this.rng = rng;
    this.priceBudget = priceBudget;
  }

  /**
   * Choose the next option.
   *
   * @param {object} args
   * @param {number} args.tick
   * @param {import('./options.js').OptionRunner} args.runner
   * @param {Candidate[]} args.candidates
   * @param {(c: Candidate) => {pWin:number}} args.price  the expensive
   *   evaluator (foresight.priceOption behind the caller's wiring)
   * @param {Set<string>} [args.initiation]  legal option ids now (options.js);
   *   candidates outside it are dropped, which is the mask being the contract
   * @returns {{chosen: Candidate|null, desire:number, motive:string, log:Array}}
   *   chosen === null means: keep whatever is running (or idle if nothing is)
   */
  decide({ tick, runner, candidates, price, initiation = null }) {
    // The three anti-dither clocks: commitment and latency first. If the
    // incumbent may not be replaced, there is no decision to make and the
    // price budget is not spent.
    if (runner.active && !runner.mayReplace(tick)) {
      return {
        chosen: null,
        desire: 0,
        motive: `committed to ${runner.active.id}`,
        log: []
      };
    }

    const legal = candidates.filter((c) => !initiation || initiation.has(c.id));
    if (!legal.length) {
      return { chosen: null, desire: 0, motive: 'nothing legal to want', log: [] };
    }

    // Forced candidates are rules, not preferences: the bomb must go down,
    // the bomb must come up. Pricing them against a hold is a category error —
    // the hold only looks safer because the round model prices the state, not
    // the forfeit — so a legal forced candidate wins without a price. The
    // commitment gate above still applies, and combat stays with the motor.
    const forced = legal.filter((c) => c.forced);
    if (forced.length) {
      const pick = forced.sort((a, b) => (b.prior ?? 0.5) - (a.prior ?? 0.5))[0];
      if (runner.active?.id === pick.id) {
        return { chosen: null, desire: 1, motive: `staying: ${pick.motive}`, log: [] };
      }
      return { chosen: pick, desire: 1, motive: pick.motive || 'the objective', log: [] };
    }

    // Cheap rank, then price the top few plus the incumbent's continuation.
    const ranked = [...legal].sort((a, b) => this.cheapDesire(b) - this.cheapDesire(a));
    const toPrice = ranked.slice(0, this.priceBudget);

    const incumbent = runner.active
      ? {
          id: runner.active.id,
          params: runner.active.params,
          isIncumbent: true
        }
      : null;
    if (incumbent && !toPrice.some((c) => c.isIncumbent)) toPrice.push(incumbent);

    const priced = toPrice.map((c) => ({ c, pWin: price(c).pWin }));
    const baseline = incumbent
      ? priced.find((p) => p.c.isIncumbent)?.pWin ?? 0.5
      : Math.min(...priced.map((p) => p.pWin));

    const log = [];
    let best = null;
    for (const { c, pWin } of priced) {
      let desire = this.desireOf(c, pWin, baseline);
      if (c.isIncumbent) desire += HYSTERESIS;
      desire = Math.max(0, Math.min(1, desire));
      const motive = this.motiveOf(c, pWin, baseline);
      log.push({ id: c.id, params: c.params, desire, pWin, motive });
      if (!best || desire > best.desire) best = { c, desire, motive };
    }

    // The `decisions` trait: how close to the true argmax the pick lands.
    // A softmax draw at a temperature the trait controls — weaker players
    // pick the third-best option often, and that is authored here, not in aim.
    const temp = 0.3 - 0.28 * Math.max(0, Math.min(1, this.traits.decisions ?? 0.5));
    if (log.length > 1 && temp > 0.02) {
      const weights = log.map((l) => Math.exp(l.desire / temp));
      const total = weights.reduce((s, w) => s + w, 0);
      let r = this.rng.next() * total;
      for (let i = 0; i < log.length; i += 1) {
        r -= weights[i];
        if (r <= 0) {
          best = { c: priced[i].c, desire: log[i].desire, motive: log[i].motive };
          break;
        }
      }
    }

    if (best.c.isIncumbent) {
      return { chosen: null, desire: best.desire, motive: `staying: ${best.motive}`, log };
    }
    return { chosen: best.c, desire: best.desire, motive: best.motive, log };
  }

  /**
   * The free pre-rank: priors, triggers, shape, and personality. This is what
   * decides which candidates DESERVE a price, so it must be cheap and it must
   * never read the engine.
   */
  cheapDesire(c) {
    let d = c.prior ?? 0.5;
    if (c.trigger) d += TRIGGER_BONUS;
    // Shape adherence is a teamwork trait expression (6.16): a team player
    // wants home more, a soloist barely feels it.
    if (c.isHome) d += 0.1 * (this.traits.teamwork ?? 0.5);
    // Aggression distorts risk toward the fight families (6.9's baseline).
    const family = c.id.startsWith('hold') || c.id === 'lurk' ? 'quiet' : null;
    if (!family && (this.traits.aggression ?? 0.5) > 0.5) {
      d += 0.08 * ((this.traits.aggression ?? 0.5) - 0.5) * 2;
    }
    // Off-ball feel: space-taking runs appeal to the bot that sees them.
    if (['take_space', 'run_in_behind', 'overlap'].includes(c.id)) {
      d += 0.08 * ((this.traits.offBall ?? 0.5) - 0.5) * 2;
    }
    return Math.max(0, Math.min(1, d));
  }

  /** Desire from a price: the edge over the standing state, plus the frame. */
  desireOf(c, pWin, baseline) {
    let d = 0.5 + PRICE_GAIN * (pWin - baseline);
    if (c.trigger) d += TRIGGER_BONUS;
    if (c.isHome) d += 0.1 * (this.traits.teamwork ?? 0.5);
    return d;
  }

  /** The English. A trigger explains itself; a price explains the edge. */
  motiveOf(c, pWin, baseline) {
    if (c.trigger) return c.trigger.motive;
    const edge = pWin - baseline;
    if (c.isIncumbent) return `still the best read (${(pWin * 100).toFixed(0)}%)`;
    if (c.motive) return c.motive;
    if (edge > 0.005) return `prices ${(edge * 100).toFixed(1)}pp over staying`;
    if (c.isHome) return 'nothing better to want: returning to shape';
    return `prices level with staying (${(pWin * 100).toFixed(0)}%)`;
  }
}
