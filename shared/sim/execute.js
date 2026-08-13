// ---------------------------------------------------------------------------
// shared/sim/execute.js
// Executes as effects and synchronization, not as tapes. Assignment solved.
//
// SIM-PLAN 19.10 and 20.13. Retrieval that stores lineups and tracks cannot
// answer the brief's real question: what do we do when we do not have the
// utility that execute assumes. A tape with a missing grenade has no
// representation except failure. So the template stores EFFECTS and an ANCHOR,
// and the bodies who produce those effects are derived every time.
//
// Three effects, and that is the whole vocabulary:
//
//   denySightline   a smoke, or a molotov that holds the same angle
//   grantExposure   a flash, or an HE, or a body eating the angle
//   deliverBodies   geometry. No grenade.
//
// THE REPAIR LADDER is the brief's question in the brief's own order:
//
//   1  Run it. Every means list still has something we hold, or is empty
//      (geometry-only). Timing tolerance is the mined variance, never zero.
//   2  Substitute. A named lineup is gone but the EFFECT is still achievable:
//      any nade NADE_BY_EFFECT maps to the same effect, and a body with
//      deathPermission can stand in for a flash. Substitution is computed, so
//      it needs no table of authors.
//   3  Retrieve a degraded case. The effect cannot be produced at all. This
//      file does not query a library; it returns `{ retrieve: { call, missing } }`
//      so the caller can. A-executes with no CT smoke exist in the thousands.
//   4  Improvise. Nothing matches. Hand the remaining effects to the option
//      layer as an objective. Tiers 1 to 3 are a prior and a saving of effort;
//      tier 4 is the actual bot.
//
// 20.13, THE ASSIGNMENT IS SOLVED, NOT MEMORIZED. Chapter 16 derives an entire
// utility order from properties: molotovs from close so the second man carries
// them, smokes where one and two already are so the third smokes, flashes last
// so the fourth arrives late, the first man holds. Nobody memorized that order.
// `assignExecute` is `assignAtMostOne` (19.5) with the value function left on
// grenades, distance to `from`, and role. A missing grenade changes the cost
// matrix rather than invalidating a script, which is tier 2 arriving for free,
// and it is the chapter's own thesis as a test.
//
// Pure: no I/O, no clock, no rng. The same template and the same pockets
// always produce the same ladder and the same pairs.
// ---------------------------------------------------------------------------

import { assignAtMostOne } from './clearPartition.js';
import { NADE } from './grenades.js';

export const EFFECT = Object.freeze({
  DENY_SIGHT: 'denySightline',
  GRANT_EXPOSURE: 'grantExposure',
  DELIVER: 'deliverBodies'
});

/**
 * Preferred means per effect, first to last. denySightline prefers smoke then
 * molotov; grantExposure prefers flash then HE; deliverBodies needs no nade.
 * Incendiary is the CT molotov. `[calibrate the preference order only in that
 * the qualitative ranking, not the nade identities, is what a demo would move]`
 */
export const NADE_BY_EFFECT = Object.freeze({
  [EFFECT.DENY_SIGHT]: Object.freeze([NADE.SMOKE, NADE.MOLOTOV, NADE.INCENDIARY]),
  [EFFECT.GRANT_EXPOSURE]: Object.freeze([NADE.FLASH, NADE.HE]),
  [EFFECT.DELIVER]: Object.freeze([])
});

/**
 * A body with deathPermission can stand in for a flash by eating the angle
 * (19.10 tier 2). The flag is the doctrine; the ladder reads it.
 */
export const BODY_SUBSTITUTES_FLASH = true;

/** Holding the grenade the step needs. Dominates distance. `[calibrate]` */
export const HAS_NADE_SCORE = 10;
/** Preferred nade (first in NADE_BY_EFFECT) over a fallback. `[calibrate]` */
export const PREFERRED_NADE_SCORE = 2;
/** Role-match bonus. `[calibrate]` */
export const ROLE_MATCH_SCORE = 2;
/** Distance scale in world units: closer is better. `[calibrate]` */
export const DISTANCE_SCALE = 500;
/** A geometry-only step is still worth assigning. `[calibrate]` */
export const BASE_STEP_SCORE = 1;

function asSet(xs) {
  if (!xs) return new Set();
  return xs instanceof Set ? xs : new Set(xs);
}

function bodyCount(bodies) {
  if (Array.isArray(bodies)) return bodies.length;
  const n = Number(bodies);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function meansHeld(means, availableMeans) {
  if (!means || means.length === 0) return true;
  const have = asSet(availableMeans);
  for (const m of means) {
    if (have.has(m)) return true;
    if (typeof m === 'string' && m.endsWith('*')) {
      const prefix = m.slice(0, -1);
      for (const a of have) if (String(a).startsWith(prefix)) return true;
    }
  }
  return false;
}

function nadesHeld(wanted, availableNades) {
  const have = Array.isArray(availableNades) ? availableNades : [];
  for (const n of wanted) if (have.includes(n)) return n;
  return null;
}

function normalizeStep(step, i) {
  return {
    id: step.id ?? `s${i + 1}`,
    effect: step.effect,
    from: step.from ?? null,
    to: step.to ?? null,
    at: step.at ?? null,
    means: Array.isArray(step.means) ? [...step.means] : [],
    window: Array.isArray(step.window) ? [...step.window] : [0, 0],
    actor: step.actor ?? null,
    requires: Array.isArray(step.requires) ? [...step.requires] : [],
    count: step.count,
    spread: step.spread,
    nade: step.nade,
    substitute: step.substitute
  };
}

/**
 * Normalize a mined execute into the shape the ladder and the assigner consume.
 *
 * @param {object} args
 * @param {string} args.id
 * @param {string} args.map
 * @param {string} args.side
 * @param {string} args.call
 * @param {Array<object>} args.steps
 * @param {string|object} args.anchor
 */
export function executeTemplate({ id, map, side, call, steps = [], anchor, source, outcome } = {}) {
  return {
    id,
    map,
    side,
    call,
    steps: steps.map(normalizeStep),
    anchor,
    source: source ?? null,
    outcome: outcome ?? null
  };
}

function classifyStep(step, { availableMeans, availableNades, bodies }) {
  const means = step.means || [];
  if (means.length === 0 || meansHeld(means, availableMeans)) {
    if (step.effect === EFFECT.DELIVER && bodyCount(bodies) < 1) {
      return { kind: 'impossible', missing: 'bodies', step };
    }
    return { kind: 'intact', step };
  }

  const wanted = NADE_BY_EFFECT[step.effect] || [];
  const sub = nadesHeld(wanted, availableNades);
  if (sub) {
    return {
      kind: 'substitute',
      step: { ...step, substitute: sub, means: [sub] },
      with: sub
    };
  }

  if (
    step.effect === EFFECT.GRANT_EXPOSURE &&
    BODY_SUBSTITUTES_FLASH &&
    bodyCount(bodies) >= 1
  ) {
    return {
      kind: 'substitute',
      step: { ...step, substitute: 'body', means: ['body'] },
      with: 'body'
    };
  }

  return { kind: 'impossible', missing: wanted[0] || step.effect, step };
}

/**
 * Walk the 19.10 ladder. Does not query a library: tier 3 returns the retrieve
 * handle, tier 4 returns the remaining effects as a goal.
 *
 * @param {object} args
 * @param {object} args.template
 * @param {Set<string>|string[]} args.availableMeans
 * @param {string[]} args.availableNades
 * @param {number|Array} args.bodies
 * @returns {{tier: 1|2|3|4, steps?: Array, motive: string, retrieve?: object, improvise?: boolean, goal?: Array}}
 */
export function repairLadder({ template, availableMeans = new Set(), availableNades = [], bodies = 0 } = {}) {
  const tpl = template?.steps ? template : executeTemplate(template || {});
  const classified = tpl.steps.map((s) => classifyStep(s, { availableMeans, availableNades, bodies }));
  const intact = classified.filter((c) => c.kind === 'intact');
  const subs = classified.filter((c) => c.kind === 'substitute');
  const dead = classified.filter((c) => c.kind === 'impossible');

  if (dead.length === 0 && subs.length === 0) {
    return {
      tier: 1,
      steps: classified.map((c) => c.step),
      motive: `run it: ${intact.length} steps, every means still in the pocket`
    };
  }

  if (dead.length === 0) {
    const what = subs.map((s) => s.with).join(', ');
    return {
      tier: 2,
      steps: classified.map((c) => c.step),
      motive: `substitute: ${what} still produces the effect`
    };
  }

  const missing = [...new Set(dead.map((d) => d.missing))];
  const call = tpl.call || tpl.id || null;
  if (call) {
    return {
      tier: 3,
      steps: classified.map((c) => c.step),
      retrieve: { call, missing },
      motive: `retrieve a degraded ${call}: missing ${missing.join(', ')}`
    };
  }

  const goal = classified.filter((c) => c.kind !== 'impossible').map((c) => c.step.effect);
  const leftover = dead.map((d) => d.step.effect);
  return {
    tier: 4,
    improvise: true,
    goal: leftover.length ? leftover : goal,
    steps: classified.map((c) => c.step),
    motive: `improvise: remaining effects ${leftover.join(', ') || 'none'}`
  };
}

function originOf(step) {
  if (step.from && Number.isFinite(step.from.x) && Number.isFinite(step.from.y)) return step.from;
  if (Number.isFinite(step.fromX) && Number.isFinite(step.fromY)) return { x: step.fromX, y: step.fromY };
  if (step.at && Number.isFinite(step.at.x) && Number.isFinite(step.at.y)) return step.at;
  return null;
}

function pointOf(body) {
  if (Number.isFinite(body.x) && Number.isFinite(body.y)) return body;
  if (body.pos && Number.isFinite(body.pos.x)) return body.pos;
  return null;
}

function roleMatches(body, step) {
  if (!body.role || !step.actor) return false;
  const actor = String(step.actor);
  const role = String(body.role);
  return actor === role || actor.endsWith(role) || actor.includes(`:${role}`) || actor.includes(role);
}

function wantedNades(step) {
  if (step.substitute && step.substitute !== 'body') return [step.substitute];
  if (step.nade) return [step.nade];
  return NADE_BY_EFFECT[step.effect] || [];
}

function defaultValueOf(body, step) {
  if (step.substitute === 'body') {
    let v = BASE_STEP_SCORE + (body.deathPermission ? HAS_NADE_SCORE : 0);
    if (roleMatches(body, step)) v += ROLE_MATCH_SCORE;
    return v;
  }

  const wanted = wantedNades(step);
  const grenades = body.grenades || [];
  let nadeScore = 0;
  if (wanted.length) {
    const idx = wanted.findIndex((n) => grenades.includes(n));
    if (idx < 0) return 0;
    nadeScore = HAS_NADE_SCORE + (idx === 0 ? PREFERRED_NADE_SCORE : 0);
  }

  let v = nadeScore + BASE_STEP_SCORE;
  if (roleMatches(body, step)) v += ROLE_MATCH_SCORE;

  const from = originOf(step);
  const at = pointOf(body);
  if (from && at) {
    const d = Math.hypot(at.x - from.x, at.y - from.y);
    v += DISTANCE_SCALE / (DISTANCE_SCALE + d);
  }
  return v;
}

function stepId(step) {
  return String(step.id ?? step.effect ?? '');
}

function pairSig(result) {
  return result.pairs
    .map((p) => `${p.row.slot ?? p.i}:${stepId(p.col)}`)
    .sort()
    .join(' ');
}

/**
 * 20.13: who throws what is derived from pockets and geometry, not retrieved.
 *
 * Default valueOf: holding the required nade scores high, closer to `from`
 * (euclidean, when both have x,y) is better, role match is a bonus. A body
 * without the nade scores 0 and is left idle for that step.
 *
 * @param {object} args
 * @param {Array<object>} args.steps
 * @param {Array<{slot:number, x?:number, y?:number, grenades:string[], role?:string}>} args.bodies
 * @param {Function} [args.valueOf]
 * @returns {{pairs: Array, idle: number[], open: Array, motive: string}}
 */
export function assignExecute(args = {}) {
  const steps = args.steps || [];
  const bodies = args.bodies || [];
  // `valueOf` is inherited on every object, so a missing option would silently
  // become Object.prototype.valueOf and throw. Own-property only.
  const score =
    Object.prototype.hasOwnProperty.call(args, 'valueOf') && typeof args.valueOf === 'function'
      ? args.valueOf
      : defaultValueOf;
  const { pairs, idleRows, openCols } = assignAtMostOne({
    rows: bodies,
    cols: steps,
    valueOf: (body, step, i, j) => score(body, step, i, j)
  });

  const idle = idleRows.map((i) => (bodies[i].slot != null ? bodies[i].slot : i));
  const open = openCols.map((j) => steps[j]);
  const who = pairs.map((p) => `slot ${p.row.slot ?? p.i} -> ${stepId(p.col)}`).join(', ');
  return {
    pairs,
    idle,
    open,
    motive: pairs.length
      ? `assignment derived: ${who}`
      : 'assignment derived: nobody takes a step'
  };
}

/**
 * Chapter 16's thesis as a function: a missing grenade changes the pairs
 * (or idles the step), it does not invalidate a script.
 *
 * @param {object} args
 * @param {Array<object>} args.steps
 * @param {Array<object>} args.bodies
 * @param {string} [args.nade]
 * @param {Function} [args.valueOf]
 */
export function assignmentChangesWhenNadeMissing(args = {}) {
  const steps = args.steps;
  const bodies = args.bodies;
  const nade = args.nade ?? NADE.SMOKE;
  const opts = { steps, bodies };
  if (Object.prototype.hasOwnProperty.call(args, 'valueOf') && typeof args.valueOf === 'function') {
    opts.valueOf = args.valueOf;
  }
  const before = assignExecute(opts);
  const stripped = bodies.map((b) => ({
    ...b,
    grenades: (b.grenades || []).filter((g) => g !== nade)
  }));
  const after = assignExecute({ ...opts, bodies: stripped });
  return {
    before,
    after,
    changed: pairSig(before) !== pairSig(after),
    motive: 'a missing grenade changes the cost matrix rather than invalidating a script'
  };
}
