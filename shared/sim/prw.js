// ---------------------------------------------------------------------------
// shared/sim/prw.js
// The two PRWs (SIM-PLAN 18.6b): what the team believed, what was true, and
// the residual between them.
//
// BC teaches WHAT. dPRW at decision time is WHY, given the picture. The
// ceiling on dPRW is almost always perception: the option was priced honestly
// on a picture that was not the round. So every priced TEAM decision writes a
// row while the round is live —
//
//   { tick, situation, picture, pWin_belief, fightEv, decision, motive, attrib }
//
// — and after the round the SAME model is run again on the true state at the
// same ticks. That number is `pWin_true`, `residual = pWin_true - pWin_belief`,
// and it buys three things that are not the same thing:
//
//   1. perception calibration, as a bias on a SITUATION (18.6b.1)
//   2. a third attribution bucket, `perc` (18.6b.2, applied in review.js)
//   3. the belief-value aux head's target (9.14) — one float per decision
//
// Two rules hold this file up, and both are enforced structurally rather than
// by discipline:
//
//   NO POSITIONS. A row's picture is an ALLOWLIST of scalars (counts, clock,
//   bomb, occupancy expectations). Coordinates, anchor ids and enemy slots
//   cannot reach a row even if a caller hands them in, so nothing here can
//   teach round 10's particle filter where somebody stood in round 9 (5.4).
//
//   TRUTH IS SEALED. `pWin_true` is god-view in exactly the way a VOD review
//   is god-view, legal for the same reason 9.5's potentials may read engine
//   state: training-only, never an actor input. The true snapshot is taken
//   live (the engine is gone by review time) but parked in a private array
//   that `rows()` does not return. It becomes visible only after `grade()`,
//   which is a post-round call by construction.
//
// Belief and truth go through the SAME feature builder (`pictureFeatures`)
// and the SAME model. A residual therefore measures the picture, not two
// different arithmetics.
//
// Pure apart from the log object's own accumulation. No I/O, no rng, no clock.
// ---------------------------------------------------------------------------

import { pictureFeatures } from './caller.js';
import { winProbability } from './objective.js';
import { BOMB_SECONDS, TICK_RATE } from './constants.js';
import { CAL_CAP, CAL_MIN_N, CAL_SHRINK, calibrationBias } from './experience.js';

// The gate lives with the other memory gates (18.3); re-exported here because
// 18.6b is where a reader looks for it.
export { CAL_CAP, CAL_MIN_N, CAL_SHRINK, calibrationBias };

export const PRW_LOG_VERSION = 1;

/**
 * Why a row exists. The Individual arbiter at 8 Hz is too dense to log; the
 * team frame plus the events that move a round is the right density (18.6b).
 */
export const PRW_REASON = Object.freeze({
  FREEZE: 'freeze',
  FRAME: 'frame',
  RECALL: 'recall',
  PLANT: 'plant',
  DEATH: 'death',
  OPPORTUNITY: 'opportunity'
});

/** Reasons that are events: never rate-limited, however close together. */
const EVENT_REASONS = new Set([
  PRW_REASON.FREEZE,
  PRW_REASON.RECALL,
  PRW_REASON.PLANT,
  PRW_REASON.DEATH,
  PRW_REASON.OPPORTUNITY
]);

/** Team-frame rows no denser than this. 2 Hz: ~30 rows in a full round. */
export const FRAME_EVERY_TICKS = Math.round(TICK_RATE / 2);

/**
 * The only fields a row's picture may carry. Everything else is dropped,
 * including anything positional. Adding a field here is a deliberate act:
 * it must be a scalar that describes the SITUATION, never a location.
 */
export const PICTURE_FIELDS = Object.freeze([
  'side',
  'alive',
  'enemyAlive',
  'clock',
  'secondsLeft',
  'bombSecondsLeft',
  'planted',
  'hasKit',
  'contactRel',
  'siteExpectedTarget',
  'siteExpectedOther',
  'packAtTarget',
  'teamBroken',
  'experienceMean',
  'experienceN'
]);

/**
 * How far `pWin_belief` must be from `pWin_true` before the miss is worth
 * calling perception. 80 believed against 78 true is noise; 80 against 51 is
 * the site it had empty being full.
 */
export const PERC_MARGIN = 0.15;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);

/**
 * Allowlisted copy of a picture. Anything not in PICTURE_FIELDS — x, y,
 * anchor ids, enemy slots, particle sets — does not survive.
 */
export function scrubPicture(picture) {
  const out = {};
  if (!picture) return out;
  for (const field of PICTURE_FIELDS) {
    const v = picture[field];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue; // no bags, no bodies, no vectors
    out[field] = v;
  }
  return out;
}

/**
 * The true picture at a tick, in the same shape the caller's believed picture
 * has, so both sides of the residual go through `pictureFeatures` unchanged.
 *
 * God-view: alive counts, health, the bomb, the kit, and who is actually
 * standing on the sites. Never handed to an actor — the log seals it.
 *
 * @param {object} engine
 * @param {object} args
 * @param {'T'|'CT'} args.side
 * @param {number[]} args.ourSlots
 * @param {number[]} args.enemySlots
 * @param {(body:object) => boolean} [args.inTarget]  at the site we called
 * @param {(body:object) => boolean} [args.inOther]   at the other site
 * @param {number} [args.clock]  seconds since live, for the row's own clock
 */
export function truePictureFrom(engine, { side, ourSlots = [], enemySlots = [], inTarget = null, inOther = null, clock = null } = {}) {
  const state = engine.state;
  const bodies = state.bodies;
  const ours = ourSlots.map((s) => bodies[s]).filter(Boolean);
  const theirs = enemySlots.map((s) => bodies[s]).filter(Boolean);
  const alive = ours.filter((b) => b.alive);
  const enemyAlive = theirs.filter((b) => b.alive);
  const tick = state.tick;
  const planted = Boolean(state.bomb.planted);

  return {
    side,
    alive: alive.length,
    enemyAlive: enemyAlive.length,
    clock: Number.isFinite(clock) ? clock : (tick - state.liveTick) / TICK_RATE,
    // The engine's own clock, exactly as the believed picture reads it. Both
    // are then interpreted by `pictureFeatures`, which swaps in the bomb
    // clock after a plant — so every field of the two pictures stays
    // comparable, and a field that differs is a perception error rather than
    // a difference in bookkeeping.
    secondsLeft: Math.max(0, engine.clock()),
    bombSecondsLeft: planted
      ? Math.max(0, BOMB_SECONDS - (tick - state.plantTick) / TICK_RATE)
      : BOMB_SECONDS,
    planted,
    hasKit: alive.some((b) => b.hasKit),
    // The believed picture's `siteExpected*` is the filter's expected enemy
    // count in that zone; the true counterpart is the count itself.
    siteExpectedTarget: inTarget ? enemyAlive.filter(inTarget).length : 0,
    siteExpectedOther: inOther ? enemyAlive.filter(inOther).length : 0,
    packAtTarget: inTarget ? alive.filter(inTarget).length : 0
  };
}

/**
 * P(this side wins) from a picture, believed or true, through the one model.
 */
export function prwOf(picture, model = null) {
  return clamp01(winProbability(pictureFeatures(picture), picture.side, model));
}

/**
 * One log per side per round.
 *
 * @param {object} args
 * @param {'T'|'CT'} args.side
 * @param {string} [args.map]
 * @param {number} [args.gen]
 * @param {number} [args.frameEvery]  ticks between FRAME rows
 */
export function createPrwLog({ side, map = null, gen = 0, frameEvery = FRAME_EVERY_TICKS } = {}) {
  const rows = [];
  // Sealed: same index as `rows`, never returned before grade().
  const truths = [];
  let lastFrameTick = -Infinity;
  let graded = false;

  return {
    side,
    map,
    gen,

    /**
     * Write one row. `truth` is the god-view picture at this tick and is the
     * only argument that does not reach the row until grading.
     *
     * @returns {object|null} the row, or null when rate-limited
     */
    log({ tick, reason = PRW_REASON.FRAME, situation = null, picture = null, pWinBelief = null, fightEv = null, decision = null, motive = null, truth = null } = {}) {
      if (!Number.isFinite(tick)) return null;
      if (!EVENT_REASONS.has(reason)) {
        if (tick - lastFrameTick < frameEvery) return null;
        lastFrameTick = tick;
      }
      const row = {
        tick,
        reason,
        situation: typeof situation === 'string' ? situation : situation?.hash || null,
        picture: scrubPicture(picture),
        pWin_belief: Number.isFinite(pWinBelief) ? pWinBelief : prwOf(picture || { side }),
        fightEv: Number.isFinite(fightEv) ? fightEv : null,
        decision: decision || null,
        motive: motive || null,
        attrib: null
      };
      rows.push(row);
      truths.push(truth ? scrubPicture(truth) : null);
      graded = false;
      return row;
    },

    /** Rows as they stand. Before grading these carry belief and nothing else. */
    rows() {
      return rows.map((r) => ({ ...r }));
    },

    size() {
      return rows.length;
    },

    isGraded() {
      return graded;
    },

    /**
     * Post-round. Score the sealed truth with the same model, attach
     * `pWin_true` and the residual, and return the graded rows.
     */
    grade({ model = null } = {}) {
      for (let i = 0; i < rows.length; i += 1) {
        const truth = truths[i];
        if (!truth) continue;
        const t = prwOf({ ...truth, side }, model);
        rows[i].pWin_true = t;
        rows[i].residual = t - rows[i].pWin_belief;
      }
      graded = true;
      return this.rows();
    },

    /** Drain for storage: graded rows, and the log is empty after. */
    drain() {
      const out = this.rows();
      rows.length = 0;
      truths.length = 0;
      lastFrameTick = -Infinity;
      graded = false;
      return out;
    },

    toJSON() {
      return { v: PRW_LOG_VERSION, side, map, gen, rows: this.rows() };
    }
  };
}

/**
 * Both curves on one clock, which is what the inspector draws and what a
 * human reads as the "why" (18.6b, last paragraph).
 *
 * @returns {{tick:number, believed:number, truth:number|null, residual:number|null, motive:string|null, decision:string|null}[]}
 */
export function prwCurves(rows = []) {
  return rows
    .filter((r) => Number.isFinite(r?.tick))
    .map((r) => ({
      tick: r.tick,
      believed: r.pWin_belief,
      truth: Number.isFinite(r.pWin_true) ? r.pWin_true : null,
      residual: Number.isFinite(r.residual) ? r.residual : null,
      motive: r.motive || null,
      decision: r.decision || null,
      reason: r.reason || null
    }))
    .sort((a, b) => a.tick - b.tick);
}

/**
 * How honest the picture was, over a set of graded rows. `mean` is the bias
 * (positive: the picture was pessimistic; negative: overconfident), `mae` is
 * how wrong it was regardless of direction.
 */
export function residualStats(rows = []) {
  const vals = rows.map((r) => r?.residual).filter((x) => Number.isFinite(x));
  if (!vals.length) return { n: 0, mean: 0, mae: 0, rmse: 0, over: 0, under: 0 };
  let sum = 0;
  let abs = 0;
  let sq = 0;
  let over = 0;
  let under = 0;
  for (const v of vals) {
    sum += v;
    abs += Math.abs(v);
    sq += v * v;
    if (v < -PERC_MARGIN) over += 1;
    if (v > PERC_MARGIN) under += 1;
  }
  const n = vals.length;
  return { n, mean: sum / n, mae: abs / n, rmse: Math.sqrt(sq / n), over, under };
}

/**
 * Fold graded rows into per-situation calibration entries. This is the thing
 * 18.6b writes into the experience index: `calibrations[key] = mean residual`,
 * gated before anyone reads it.
 *
 * @returns {Map<string, {n:number, sum:number, mean:number, bias:number}>}
 */
export function calibrationFromRows(rows = [], opts = {}) {
  const acc = new Map();
  for (const r of rows) {
    if (!r?.situation || !Number.isFinite(r.residual)) continue;
    const cur = acc.get(r.situation) || { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += r.residual;
    acc.set(r.situation, cur);
  }
  const out = new Map();
  for (const [key, cur] of acc) {
    out.set(key, { n: cur.n, sum: cur.sum, mean: cur.sum / cur.n, bias: calibrationBias(cur, opts) });
  }
  return out;
}

/**
 * Did the believed ranking of options match the true one? This is the test
 * that separates `perc` from `call` (18.6b.2): a team that ranked its options
 * correctly and simply mispriced the round has a perception problem, not a
 * calling problem.
 *
 * Top-1 agreement, because that is the option that actually got played.
 *
 * @param {Array<{id:string, value:number}>} believed
 * @param {Array<{id:string, value:number}>} truth
 */
export function rankAgrees(believed = [], truth = []) {
  if (!believed.length || !truth.length) return false;
  const bestOf = (list) => list.reduce((a, b) => (b.value > a.value ? b : a), list[0]);
  return bestOf(believed).id === bestOf(truth).id;
}

/**
 * The aux-head dataset (9.14): one float per decision. The clone proposes,
 * the calibrated value ranks — which is how G0 acquires a `why` without
 * waiting for PPO.
 *
 * `obsAt(tick)` is optional; without it the rows still carry the situation
 * and both PRWs, which is what a tabular head needs.
 */
export function valueSamples(rows = [], { obsAt = null, side = null, map = null } = {}) {
  const out = [];
  for (const r of rows) {
    if (!Number.isFinite(r?.pWin_true)) continue;
    const obs = obsAt ? obsAt(r.tick) : null;
    out.push({
      tick: r.tick,
      side: side || r.picture?.side || null,
      map,
      situation: r.situation || null,
      obs: obs || null,
      pWin_true: r.pWin_true,
      pWin_belief: r.pWin_belief,
      residual: r.residual
    });
  }
  return out;
}
