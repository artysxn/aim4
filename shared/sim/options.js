// ---------------------------------------------------------------------------
// shared/sim/options.js
// The option layer: temporally extended behaviors, not per-step targets.
//
// SIM-PLAN 6.6. A flat sampler firing at 8 Hz re-picks its target every 125 ms,
// dithers at every decision boundary, commits to nothing, and gives the
// inspector nothing to print but a softmax. So the Individual AI emits OPTIONS:
// an initiation set, a fixed micro-controller, and a termination condition —
// Sutton's options, which are also F.E.A.R.'s GOAP actions, Quake III's goal
// stack, and a StarCraft squad order. Every game with bots worth playing
// against arrived at the same structure.
//
// The boundary rules, verbatim from the plan:
//
//   Combat is never inside an option. The aim motor and the trigger stay live
//   through every option including `save` and `plant`. Options own feet,
//   attention, and utility; the motor owns the crosshair.
//
//   A bot re-decides when the current option terminates, or at 8 Hz once
//   `minCommitTicks` has elapsed — whichever is LATER — and never faster than
//   its decision latency allows (attention.js). Commitment is the other half
//   of the anti-dithering fix.
//
//   `follow` is just another option whose micro-controller is trackFollow. A
//   local interrupt is precisely "the follow option's termination fired for a
//   reason the plan did not own" (10.2).
//
// Micro-controllers compile to IndividualIntents (intents.js) and nothing
// else, so the translator stays the only thing that touches the engine and
// the 3D port story survives intact: the option is the decision, the
// micro-controller is the constant that gets rewritten per world.
// ---------------------------------------------------------------------------

import { TICK_RATE, ticksFor } from './constants.js';
import { INTENTS_VERSION, idleIntent } from './intents.js';

export const OPTIONS_VERSION = 1;

/** Default commitment: no option may be abandoned faster than this (6.6). */
export const MIN_COMMIT_TICKS = 24;

/**
 * The v1 vocabulary — also what the inspector prints and the BC extractor
 * labels (6.6), plus the football five (6.14), which are real CS behaviors
 * that never had names.
 *
 * `terminate` lists which standard conditions apply beyond `orderChanged`,
 * which every option honors. `exposure` is the peek style's flat share of its
 * duration spent visible, the cheap stand-in for 6.8's exposureCurve(t) that
 * foresight prices with until the baked curves land.
 */
export const OPTION_DEFS = Object.freeze({
  // ---- hold: stand somewhere on purpose -----------------------------------
  hold_angle: {
    family: 'hold',
    params: ['spot', 'yaw'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 20,
    exposure: 0.15
  },
  off_angle_hold: {
    family: 'hold',
    params: ['spot', 'yaw'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 12,
    exposure: 0.1
  },
  crossfire_hold: {
    family: 'hold',
    params: ['spot', 'yaw', 'mate'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 20,
    exposure: 0.15
  },
  stand_off: {
    family: 'hold',
    params: ['spot', 'enemyAnchor'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 8,
    exposure: 0.2
  },

  // ---- peek: trade exposure for information or a fight --------------------
  jiggle: {
    family: 'peek',
    params: ['spot', 'cover', 'yaw'],
    terminate: ['damaged', 'timeout'],
    timeoutSeconds: 3,
    exposure: 0.25
  },
  shoulder_peek: {
    family: 'peek',
    params: ['spot', 'cover'],
    terminate: ['damaged', 'timeout'],
    timeoutSeconds: 1.5,
    exposure: 0.35
  },
  wide_swing: {
    family: 'peek',
    params: ['spot', 'yaw'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 1.8,
    exposure: 1
  },
  repeek: {
    family: 'peek',
    params: ['spot', 'cover', 'delaySeconds'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 4,
    exposure: 0.5
  },
  punish_window: {
    family: 'peek',
    params: ['spot', 'yaw'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 2.5,
    exposure: 0.8
  },

  // ---- move: take, give, or cross ground ----------------------------------
  advance: {
    family: 'move',
    params: ['target', 'gait'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 25,
    exposure: 0.6
  },
  clear: {
    family: 'move',
    params: ['cornerSeq', 'gait'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 25,
    exposure: 0.5
  },
  rotate: {
    family: 'move',
    params: ['site', 'target'],
    terminate: ['arrived', 'damaged', 'timeout'],
    timeoutSeconds: 30,
    exposure: 0.7
  },
  flank: {
    family: 'move',
    params: ['target'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 40,
    exposure: 0.4
  },
  lurk: {
    family: 'move',
    params: ['spot'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 45,
    exposure: 0.1
  },
  fall_back: {
    family: 'move',
    params: ['target'],
    terminate: ['arrived', 'damaged', 'timeout'],
    timeoutSeconds: 12,
    exposure: 0.5
  },
  take_space: {
    family: 'move',
    params: ['target', 'gait'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 15,
    exposure: 0.5
  },
  follow: {
    family: 'move',
    params: ['trackSlot'],
    terminate: ['contact', 'damaged', 'follow_error', 'tape_done'],
    timeoutSeconds: 120,
    exposure: 0.5
  },

  // ---- the football five (6.14): runs named after what they buy -----------
  run_in_behind: {
    family: 'move',
    params: ['target'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 20,
    exposure: 0.3
  },
  drop_deep: {
    family: 'move',
    params: ['target'],
    terminate: ['arrived', 'damaged', 'timeout'],
    timeoutSeconds: 10,
    exposure: 0.3
  },
  show_short: {
    family: 'support',
    params: ['spot', 'mate'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 8,
    exposure: 0.4
  },
  dummy_run: {
    family: 'move',
    params: ['target'],
    terminate: ['arrived', 'damaged', 'timeout'],
    timeoutSeconds: 10,
    exposure: 0.9
  },
  overlap: {
    family: 'move',
    params: ['target', 'mate'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 12,
    exposure: 0.6
  },

  // ---- support: fight somebody else's fight -------------------------------
  trade: {
    family: 'support',
    params: ['mate', 'spot'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 10,
    exposure: 0.6
  },
  refrag: {
    family: 'support',
    params: ['spot'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 6,
    exposure: 0.8
  },
  bait: {
    family: 'support',
    params: ['spot', 'mate'],
    terminate: ['contact', 'damaged', 'timeout'],
    timeoutSeconds: 10,
    exposure: 0.5
  },
  scout: {
    family: 'support',
    params: ['target'],
    terminate: ['contact', 'arrived', 'damaged', 'timeout'],
    timeoutSeconds: 20,
    exposure: 0.3
  },
  utility_setup: {
    family: 'support',
    params: ['spot', 'utilityType', 'at'],
    terminate: ['thrown', 'damaged', 'timeout'],
    timeoutSeconds: 10,
    exposure: 0.4
  },

  // ---- objective: the bomb outranks everything -----------------------------
  execute_entry: {
    family: 'objective',
    params: ['site', 'target', 'preAim'],
    terminate: ['arrived', 'damaged', 'timeout'],
    timeoutSeconds: 20,
    exposure: 0.9
  },
  plant: {
    family: 'objective',
    params: ['spot'],
    terminate: ['planted', 'damaged', 'timeout'],
    timeoutSeconds: 20,
    exposure: 0.9
  },
  defuse: {
    family: 'objective',
    params: ['mode'],
    terminate: ['defused', 'damaged', 'timeout'],
    timeoutSeconds: 25,
    exposure: 0.9
  },
  retake: {
    family: 'objective',
    params: ['entry', 'site'],
    terminate: ['arrived', 'damaged', 'timeout'],
    timeoutSeconds: 25,
    exposure: 0.8
  },
  save: {
    family: 'objective',
    params: ['target'],
    terminate: ['arrived', 'damaged', 'timeout'],
    timeoutSeconds: 25,
    exposure: 0.3
  }
});

export const OPTION_IDS = Object.freeze(Object.keys(OPTION_DEFS));

/**
 * Which options may START right now. Engine truth only, like legalIntents:
 * whether the carrier stands on a site is not a belief (7.1). Belief-side
 * judgement (is this peek wise) is the arbiter's job, not the mask's.
 *
 * @param {object} engine  a createEngine() instance
 * @param {number} slot
 * @returns {Set<string>} option ids whose initiation set contains this state
 */
export function initiationSet(engine, slot) {
  const body = engine.state.bodies[slot];
  const out = new Set();
  if (!body?.alive || engine.state.phase !== 'live') return out;

  // A channelling body has surrendered its feet until the channel breaks.
  if (body.channel) return out;

  for (const id of OPTION_IDS) out.add(id);

  const s = engine.state;
  if (!(body.hasBomb && !s.bomb.planted)) out.delete('plant');
  if (!(body.side === 'CT' && s.bomb.planted && !s.bomb.defusedBy)) out.delete('defuse');
  if (!(body.side === 'CT' && s.bomb.planted)) out.delete('retake');
  if (!body.grenades?.length) out.delete('utility_setup');
  return out;
}

/**
 * An active option: the definition, its params, and its little bit of state.
 * @typedef {object} ActiveOption
 * @property {string} id
 * @property {object} params
 * @property {number} startedTick
 * @property {number} minCommitTicks
 * @property {number} timeoutTick
 * @property {object} micro  per-family scratch (jiggle phase, clear index...)
 */

/** Start an option. Pure: returns the active record, mutates nothing. */
export function beginOption(id, params, tick, { minCommitTicks = MIN_COMMIT_TICKS } = {}) {
  const def = OPTION_DEFS[id];
  if (!def) throw new Error(`options: unknown option ${id}`);
  return {
    id,
    params: { ...params },
    startedTick: tick,
    minCommitTicks,
    timeoutTick: tick + ticksFor(def.timeoutSeconds),
    micro: {}
  };
}

/**
 * Should this option end now, and why?
 *
 * The termination table IS the interrupt seam: `contact` and `damaged` here
 * are the same events interrupts.js classifies, and a follow ending on
 * `follow_error` is the local interrupt of 10.2 wearing its option name.
 *
 * @param {ActiveOption} active
 * @param {number} tick
 * @param {Array<{type:string, slot:number}>} events  this step's engine events
 * @param {object} ctx
 * @param {number} ctx.slot
 * @param {boolean} [ctx.arrived]   translator/engine: at the option's target
 * @param {boolean} [ctx.thrown]    utility one-shot has fired
 * @param {boolean} [ctx.planted]   engine truth
 * @param {boolean} [ctx.defused]
 * @returns {{reason: string}|null}
 */
export function checkTermination(active, tick, events, ctx) {
  const def = OPTION_DEFS[active.id];
  const has = (cond) => def.terminate.includes(cond);

  for (const e of events || []) {
    if (e.slot !== ctx.slot) continue;
    if (has('damaged') && e.type === 'damage') return { reason: 'damaged' };
    if (has('contact') && e.type === 'contact') return { reason: 'contact' };
    if (has('follow_error') && e.type === 'follow_error') return { reason: 'follow_error' };
    if (has('tape_done') && e.type === 'tape_done') return { reason: 'tape_done' };
  }
  if (has('arrived') && ctx.arrived) return { reason: 'arrived' };
  if (has('thrown') && ctx.thrown) return { reason: 'thrown' };
  if (has('planted') && ctx.planted) return { reason: 'planted' };
  if (has('defused') && ctx.defused) return { reason: 'defused' };
  if (has('timeout') && tick >= active.timeoutTick) return { reason: 'timeout' };
  return null;
}

/**
 * May the arbiter REPLACE this option deliberately (no termination fired)?
 * Later of the 8 Hz clock and the commitment window, gated by latency: the
 * three clocks all have to agree before a standing decision is abandoned.
 */
export function mayReplace(active, tick, gate) {
  if (tick - active.startedTick < active.minCommitTicks) return false;
  return gate ? gate.mayDecide(tick) : true;
}

// ---------------------------------------------------------------------------
// Micro-controllers: option in, intent out. Fixed, boring, never learned.
// Small state machines where the behavior needs one (jiggle, repeek, clear);
// everything else is a static mapping onto the translator's modes.
// ---------------------------------------------------------------------------

const base = () => idleIntent();

/** Peeks flip between a cover pose and an exposed pose on short timers. */
function outAndBack(active, tick, { outSeconds, backSeconds, spot, cover, posture, preAim }) {
  const m = active.micro;
  if (m.phase === undefined) {
    m.phase = 'out';
    m.phaseTick = tick;
  }
  const elapsed = (tick - m.phaseTick) / TICK_RATE;
  if (m.phase === 'out' && elapsed >= outSeconds) {
    m.phase = 'back';
    m.phaseTick = tick;
  } else if (m.phase === 'back' && elapsed >= backSeconds) {
    m.phase = 'out';
    m.phaseTick = tick;
  }
  const intent = base();
  intent.move = {
    mode: 'advance',
    target: m.phase === 'out' ? spot : cover,
    gait: 'run'
  };
  intent.combat = { posture, preAim: preAim ?? null };
  return intent;
}

/**
 * Compile one decision step of an active option into an IndividualIntent.
 *
 * @param {ActiveOption} active
 * @param {number} tick
 * @param {object} [view]  the little the micros need from outside:
 *   {myAnchor?: string} — where the bot currently is, for holds without a spot
 * @returns {import('./intents.js').IndividualIntent}
 */
export function microIntent(active, tick, view = {}) {
  const p = active.params;
  const intent = base();
  intent.v = INTENTS_VERSION;

  switch (active.id) {
    // ---- holds -------------------------------------------------------------
    case 'hold_angle':
    case 'off_angle_hold':
    case 'crossfire_hold': {
      // Run to the post, hold at it: a CT that shift-walks to its site meets
      // the execute in a corridor instead of behind its angle.
      intent.move = { mode: 'hold', target: p.spot, gait: 'run' };
      intent.combat = { posture: 'holdAngle', preAim: p.yaw ?? null };
      return intent;
    }
    case 'stand_off': {
      intent.move = { mode: 'hold', target: p.spot ?? view.myAnchor ?? null, gait: 'walk' };
      intent.combat = { posture: 'holdAngle', preAim: p.enemyAnchor ?? null };
      return intent;
    }

    // ---- peeks -------------------------------------------------------------
    case 'jiggle':
      return outAndBack(active, tick, {
        outSeconds: 0.4,
        backSeconds: 0.5,
        spot: p.spot,
        cover: p.cover,
        posture: 'free',
        preAim: p.yaw
      });
    case 'shoulder_peek':
      // Bait a shot, never take one: information at the price of a silhouette.
      return outAndBack(active, tick, {
        outSeconds: 0.35,
        backSeconds: 10,
        spot: p.spot,
        cover: p.cover,
        posture: 'avoid',
        preAim: null
      });
    case 'repeek': {
      const m = active.micro;
      const delay = p.delaySeconds ?? 1;
      if (m.holdUntil === undefined) m.holdUntil = tick + ticksFor(delay);
      if (tick < m.holdUntil) {
        intent.move = { mode: 'hold', target: p.cover, gait: 'walk' };
        intent.combat = { posture: 'holdAngle', preAim: p.spot ?? null };
        return intent;
      }
      intent.move = { mode: 'advance', target: p.spot, gait: 'run' };
      intent.combat = { posture: 'free', preAim: null };
      return intent;
    }
    case 'wide_swing':
    case 'punish_window': {
      intent.move = { mode: 'advance', target: p.spot, gait: 'run' };
      intent.combat = { posture: 'free', preAim: p.yaw ?? null };
      return intent;
    }

    // ---- moves -------------------------------------------------------------
    case 'clear': {
      const m = active.micro;
      if (m.i === undefined) m.i = 0;
      const seq = p.cornerSeq || [];
      if (view.arrived && m.i < seq.length - 1) m.i += 1;
      const target = seq[Math.min(m.i, seq.length - 1)] ?? null;
      const next = seq[Math.min(m.i + 1, seq.length - 1)] ?? null;
      intent.move = { mode: 'advance', target, gait: p.gait || 'walk' };
      // The crosshair leads the feet: pre-aim the corner about to open, which
      // is the spot-encounter sweep (6.8) in one line.
      intent.combat = { posture: 'free', preAim: next };
      return intent;
    }
    case 'rotate': {
      intent.move = { mode: 'rotate', target: p.target ?? p.site, gait: 'run' };
      intent.combat = { posture: 'free', preAim: null };
      return intent;
    }
    case 'lurk': {
      intent.move = { mode: 'hold', target: p.spot, gait: 'walk' };
      intent.combat = { posture: 'holdAngle', preAim: null };
      return intent;
    }
    case 'flank':
    case 'scout':
    case 'run_in_behind': {
      // Quiet ground-taking: the value is arriving unheard (5.6).
      intent.move = { mode: 'advance', target: p.target, gait: 'walk' };
      intent.combat = { posture: active.id === 'scout' ? 'avoid' : 'free', preAim: null };
      return intent;
    }
    case 'fall_back':
    case 'drop_deep': {
      intent.move = { mode: 'advance', target: p.target, gait: 'run' };
      intent.combat = { posture: 'free', preAim: null };
      return intent;
    }
    case 'advance':
    case 'take_space':
    case 'dummy_run':
    case 'overlap': {
      intent.move = { mode: 'advance', target: p.target, gait: p.gait || 'run' };
      intent.combat = { posture: 'free', preAim: null };
      return intent;
    }
    case 'follow': {
      intent.move = { mode: 'follow', target: null, gait: 'run' };
      intent.follow = { slot: p.trackSlot };
      return intent;
    }

    // ---- support -----------------------------------------------------------
    case 'trade':
    case 'bait':
    case 'show_short': {
      intent.move = { mode: 'hold', target: p.spot, gait: 'run' };
      intent.combat = { posture: 'free', preAim: null };
      return intent;
    }
    case 'refrag': {
      intent.move = { mode: 'advance', target: p.spot, gait: 'run' };
      intent.combat = { posture: 'free', preAim: p.spot ?? null };
      return intent;
    }
    case 'utility_setup': {
      intent.move = { mode: 'hold', target: p.spot, gait: 'run' };
      intent.combat = { posture: 'holdAngle', preAim: p.at ?? null };
      intent.utility = { type: p.utilityType, at: p.at };
      return intent;
    }

    // ---- objectives --------------------------------------------------------
    case 'execute_entry': {
      intent.move = { mode: 'rotate', target: p.target ?? p.site, gait: 'run' };
      // The slice this body was assigned by the entry partition (19.5), and
      // nothing else. An entry who pre-aims four angles pre-aims none of them;
      // the breadth belongs to the team, the commitment belongs to the body.
      intent.combat = { posture: 'free', preAim: p.preAim ?? null };
      return intent;
    }
    case 'plant': {
      intent.move = { mode: p.spot ? 'advance' : 'stop', target: p.spot ?? null, gait: 'run' };
      intent.objective = 'plant';
      return intent;
    }
    case 'defuse': {
      intent.move = { mode: 'stop', target: null, gait: 'run' };
      intent.objective = 'defuse';
      return intent;
    }
    case 'retake': {
      intent.move = { mode: 'rotate', target: p.entry ?? p.site, gait: 'run' };
      intent.combat = { posture: 'free', preAim: null };
      return intent;
    }
    case 'save': {
      intent.move = { mode: 'advance', target: p.target, gait: 'run' };
      intent.combat = { posture: 'avoid', preAim: null };
      return intent;
    }

    default:
      return intent;
  }
}

/**
 * One bot's option lifecycle: begin, step, terminate, replace. Owns nothing
 * but the active record; the arbiter decides WHAT runs, the runner decides
 * WHETHER it is still running and what intent it means this step.
 */
export class OptionRunner {
  /** @param {object} cfg  {slot, gate?: import('./attention.js').LatencyGate} */
  constructor({ slot, gate = null }) {
    this.slot = slot;
    this.gate = gate;
    /** @type {ActiveOption|null} */
    this.active = null;
    /** @type {{id:string, reason:string, tick:number}|null} the last ending */
    this.lastEnd = null;
  }

  /** Replace whatever runs with this option. The `orderChanged` path. */
  begin(tick, id, params, opts = {}) {
    if (this.active) {
      this.lastEnd = { id: this.active.id, reason: 'orderChanged', tick };
    }
    this.active = beginOption(id, params, tick, opts);
    if (this.gate) this.gate.decided();
    return this.active;
  }

  /**
   * One decision step. Returns the intent to hand the translator, and whether
   * the option just ended (the arbiter should then choose a successor).
   *
   * @param {number} tick
   * @param {Array} events   engine + translator events this step
   * @param {object} ctx     see checkTermination
   * @returns {{intent: object, ended: {id:string, reason:string}|null}}
   */
  step(tick, events, ctx = {}) {
    if (!this.active) return { intent: idleIntent(), ended: null };
    const end = checkTermination(this.active, tick, events, { slot: this.slot, ...ctx });
    if (end) {
      const ended = { id: this.active.id, reason: end.reason };
      this.lastEnd = { ...ended, tick };
      this.active = null;
      return { intent: idleIntent(), ended };
    }
    return {
      intent: microIntent(this.active, tick, { myAnchor: ctx.myAnchor, arrived: ctx.arrived }),
      ended: null
    };
  }

  /** May the arbiter deliberately swap options now? */
  mayReplace(tick) {
    if (!this.active) return true;
    return mayReplace(this.active, tick, this.gate);
  }
}
