// ---------------------------------------------------------------------------
// shared/sim/intents.js
// The DecisionInterface: what a brain may say, and what is legal to say now.
//
// This schema is the portability artifact (SIM-PLAN 6.1). Everything above it
// is learned; everything below it is constants. The 3D port swaps the
// translator, not the brains, and that only works if nothing above this line
// ever speaks in engine terms: intents name anchors and modes, never
// coordinates and never motor values.
//
// The masks are the contract (7.5). The engine computes what is legal, the
// policy samples inside that, and the translator executes without validation
// branches. A mask bug is therefore loud (an illegal action asserts in dev)
// rather than silent (a policy quietly learning to emit no-ops).
//
// v1 carries the modes the engine can execute today. The option layer (6.6)
// replaces the movement half in P3b; the schema is versioned so that is an
// addition, not a migration.
// ---------------------------------------------------------------------------

export const INTENTS_VERSION = 1;

/** What the feet are doing. */
export const MOVE_MODES = Object.freeze([
  'hold', // stay at an anchor, micro-adjust within its radius
  'advance', // pathfind to an anchor
  'follow', // shadow a recorded track until something happens
  'rotate', // advance, but the destination is a site and the translator hurries
  'stop' // stand down, bleed speed
]);

/** What the hands are allowed to do while the feet do that. */
export const COMBAT_POSTURES = Object.freeze([
  'free', // fight anything the motor acquires
  'holdAngle', // fight, but do not chase: stay pointed at preAim
  'avoid' // do not fire (saving, sneaking a flank)
]);

export const OBJECTIVES = Object.freeze(['none', 'plant', 'defuse', 'pickupBomb']);

export const GAITS = Object.freeze(['run', 'walk', 'crouchwalk']);

/**
 * One bot's intent for the current decision step. Everything optional except
 * the mode; the translator fills conservative defaults.
 *
 * @typedef {object} IndividualIntent
 * @property {number} v
 * @property {{mode: string, target?: string|null, gait?: string}} move
 * @property {{posture?: string, preAim?: string|null}} [combat]
 * @property {{type: string, at: string}|null} [utility]  throw at an anchor
 * @property {string} [objective]
 * @property {{slot: number}|null} [follow]  which recorded slot to shadow
 */

/** A conservative, always-legal intent: stand still, fight back. */
export function idleIntent() {
  return {
    v: INTENTS_VERSION,
    move: { mode: 'stop', target: null, gait: 'run' },
    combat: { posture: 'free', preAim: null },
    utility: null,
    objective: 'none',
    follow: null
  };
}

/**
 * What this bot may legally do right now.
 *
 * Computed from engine truth because legality IS engine truth: whether the
 * carrier stands on a site is not a belief. The policy never reads this
 * function's inputs, only its output, which is how god-view legality and
 * belief-driven choice stay separate (7.1).
 *
 * @param {object} engine  a createEngine() instance
 * @param {number} slot
 * @returns {object} mask
 */
export function legalIntents(engine, slot) {
  const body = engine.state.bodies[slot];
  const graph = engine.graph;
  if (!body?.alive) {
    return {
      alive: false,
      moveModes: [],
      targets: [],
      objectives: [],
      utility: [],
      postures: []
    };
  }

  const s = engine.state;
  const live = s.phase === 'live';

  // Anchors on this body's level are the movement vocabulary. Reachability is
  // not re-proved here: the graph was pruned of unreachable cells at bake, and
  // a pathological island would surface as a loud path_failed, not a crash.
  const targets = [];
  for (const a of graph.anchors.values()) {
    if (a.level === body.level) targets.push(a.id);
  }

  const objectives = ['none'];
  if (live && body.hasBomb && !s.bomb.planted) {
    // Site legality is checked by beginPlant itself; the mask advertises the
    // objective when a plant could be started from SOME position, and the
    // translator routes to a site first. With site geometry present, "can I
    // start the channel right here" is also answered, so a policy can tell
    // "walk to the site" from "press the button".
    objectives.push('plant');
  }
  if (live && body.side === 'CT' && s.bomb.planted && !s.bomb.defusedBy) {
    objectives.push('defuse');
  }
  if (live && body.side === 'T' && s.bomb.dropped && !body.hasBomb) {
    objectives.push('pickupBomb');
  }

  const utility = live && !body.channel ? [...new Set(body.grenades)] : [];

  return {
    alive: true,
    moveModes: body.channel ? ['stop'] : [...MOVE_MODES],
    targets,
    gaits: [...GAITS],
    objectives,
    utility,
    postures: [...COMBAT_POSTURES]
  };
}

/**
 * Is this intent inside the mask? The translator asserts this in dev, so an
 * illegal emission is a crash at the boundary rather than a quiet no-op that a
 * training run learns around.
 */
export function validateIntent(intent, mask) {
  const problems = [];
  if (!intent || intent.v !== INTENTS_VERSION) problems.push(`version ${intent?.v}`);
  if (!mask.alive) {
    if (intent?.move?.mode !== 'stop') problems.push('dead bodies do not move');
    return problems;
  }
  const move = intent.move || {};
  if (!mask.moveModes.includes(move.mode)) problems.push(`move.mode ${move.mode}`);
  if (move.target != null && !mask.targets.includes(move.target)) {
    problems.push(`move.target ${move.target}`);
  }
  if (move.gait && !mask.gaits.includes(move.gait)) problems.push(`gait ${move.gait}`);
  const objective = intent.objective || 'none';
  if (!mask.objectives.includes(objective)) problems.push(`objective ${objective}`);
  if (intent.utility && !mask.utility.includes(intent.utility.type)) {
    problems.push(`utility ${intent.utility.type}`);
  }
  if (intent.utility && intent.utility.at != null && !mask.targets.includes(intent.utility.at)) {
    problems.push(`utility.at ${intent.utility.at}`);
  }
  const posture = intent.combat?.posture || 'free';
  if (!mask.postures.includes(posture)) problems.push(`posture ${posture}`);
  return problems;
}

/**
 * TeamDirective: the hivemind's order set, one per round plus re-plans (6.1).
 * v1 carries what the scripted planner uses; the pattern-grammar fields (shape,
 * pace) join when the Playstyle AI does.
 *
 * @typedef {object} TeamDirective
 * @property {number} v
 * @property {string} call
 * @property {Array<{to: number[], task: string, anchor?: string|null, trackSlot?: number|null}>} orders
 */

export function validateDirective(directive, { slots = 5 } = {}) {
  const problems = [];
  if (!directive || directive.v !== INTENTS_VERSION) problems.push(`version ${directive?.v}`);
  if (typeof directive?.call !== 'string' || !directive.call) problems.push('call missing');
  const seen = new Set();
  for (const order of directive?.orders || []) {
    if (!Array.isArray(order.to) || order.to.length === 0) {
      problems.push('order with no addressee');
      continue;
    }
    for (const slot of order.to) {
      if (!Number.isInteger(slot) || slot < 0 || slot >= slots * 2) {
        problems.push(`order to bad slot ${slot}`);
      }
      if (seen.has(slot)) problems.push(`slot ${slot} ordered twice`);
      seen.add(slot);
    }
    if (!['hold', 'execute', 'lurk', 'rotate', 'follow', 'autonomous'].includes(order.task)) {
      problems.push(`task ${order.task}`);
    }
  }
  return problems;
}
