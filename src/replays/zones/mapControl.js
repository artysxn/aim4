// ---------------------------------------------------------------------------
// replays/zones/mapControl.js
// Possession accumulation over the control field.
//
// Rules (applied once per VISION_STRIDE, for every living player):
//   • Each player's visibility polygon adds `stride / tickRate` seconds of
//     exposure to the cells it covers.
//   • Neutral ground is taken after CLAIM_NEUTRAL_SECONDS of exposure.
//   • Enemy ground needs CLAIM_FLIP_SECONDS, and an owner still looking at a
//     cell wipes the challenger's progress.
//   • CONTEST_DECAY_SECONDS without exposure resets a side's progress.
//
// Exposure is time, not "hits", so the numbers no longer depend on how often
// the simulation happens to sample. VISION_STRIDE is now only a sampling rate.
// ---------------------------------------------------------------------------

import {
  CLASS_CT,
  CLASS_T,
  FOOT_NEAR_WORLD,
  SIDE_CT,
  SIDE_NONE,
  SIDE_T,
  cellsNearInto,
  classifyCell,
  createControlField,
  decaySoftControl,
  rasterizeConeInto,
  resetControlField,
  resolveOwners,
  restoreField,
  snapshotField,
  stampDiscInto
} from './controlField.js';

/** Demo ticks between vision samples. Every living player fires on each one. */
export const VISION_STRIDE = 16;
/** Seconds of exposure to take never-owned ground. */
export const CLAIM_NEUTRAL_SECONDS = 0.35;
/** Seconds of exposure to steal ground from the other side. */
export const CLAIM_FLIP_SECONDS = 2.5;
/** Seconds without exposure before a side's progress resets. */
export const CONTEST_DECAY_SECONDS = 2;
/**
 * Seconds a side can go without eyes or boots on ground it owns before that
 * ground starts giving way. Only applies where the surroundings are more
 * neutral than controlled, so a held position is never on the clock.
 */
export const SOFT_HOLD_SECONDS = 10;
/**
 * Seconds an exposed cell spends dissolving. One ring peels per interval, so a
 * long abandoned salient retracts from its open end rather than vanishing.
 */
export const SOFT_DISSOLVE_SECONDS = 1.5;
/** Strides between seek keyframes. */
export const KEYFRAME_STRIDES = 32;

/** Scratch for foot lookups; a player never touches more than a handful. */
const footScratch = new Int32Array(64);

/**
 * Per-side foot occupancy masks for a sampled tick.
 * Buffers are reused, so callers must consume the result before the next call.
 *
 * @param {object} meta
 * @param {Array} states
 * @param {object} geom  FieldGeometry
 * @param {{ t: Uint8Array, ct: Uint8Array }} out
 */
export function activeMasksFromStates(meta, states, geom, out) {
  out.t.fill(0);
  out.ct.fill(0);
  if (!meta || !geom) return out;
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const mask = side === 'T' ? out.t : out.ct;
    const n = cellsNearInto(geom, s.x, s.y, 48, footScratch);
    for (let i = 0; i < n; i++) mask[footScratch[i]] = 1;
  }
  return out;
}

/** Allocate reusable mask buffers for a lattice. */
export function createActiveMasks(geom) {
  return { t: new Uint8Array(geom.count), ct: new Uint8Array(geom.count) };
}

/**
 * Deterministic possession simulator with keyframed seeking.
 *
 * Playing forward never restores; seeking backward rewinds to the nearest
 * keyframe and replays, so any tick yields the same field as playing to it.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {{ sampleAll: Function }} args.track
 * @param {object} args.geom  FieldGeometry
 * @param {(ctx: { viewer: object, side: 'T'|'CT', tick: number }) => Float32Array|null} args.castCone
 */
export function createControlSimulator({ meta, track, geom, castCone }) {
  const field = createControlField(geom);
  if (!meta || !track || !castCone || !field) {
    return { fieldAt: () => field, from: 0, end: 0, field };
  }

  const tickRate = meta.tickRate || 64;
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const end = Math.max(from, meta.endTick ?? from);
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const rules = {
    decayTicks: CONTEST_DECAY_SECONDS * tickRate,
    neutralSeconds: CLAIM_NEUTRAL_SECONDS,
    flipSeconds: CLAIM_FLIP_SECONDS
  };
  const softRules = {
    holdTicks: SOFT_HOLD_SECONDS * tickRate,
    dissolveSeconds: SOFT_DISSOLVE_SECONDS
  };
  const dt = VISION_STRIDE / tickRate;
  const lastStride = Math.floor((end - from) / VISION_STRIDE);
  const scratch = [];
  /** Snapshots taken *before* stride `j * KEYFRAME_STRIDES` runs. */
  const keyframes = [];
  /** Index of the last stride applied; -1 means nothing has run. */
  let cursor = -1;

  function runStride(k) {
    if (k % KEYFRAME_STRIDES === 0) {
      const j = k / KEYFRAME_STRIDES;
      if (!keyframes[j]) keyframes[j] = snapshotField(field, k);
    }
    const tick = from + k * VISION_STRIDE;
    track.sampleAll(tick, scratch);
    for (const p of players) {
      const side = teamSides[p.team];
      if (side !== 'T' && side !== 'CT') continue;
      const s = scratch[p.slot];
      if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const sideId = side === 'T' ? SIDE_T : SIDE_CT;
      // Boots hold ground regardless of where the player happens to be looking.
      stampDiscInto(field, s.x, s.y, FOOT_NEAR_WORLD, sideId, dt, tick);
      if (!Number.isFinite(s.yaw)) continue;
      const ring = castCone({ viewer: s, side, tick });
      if (ring) rasterizeConeInto(field, ring, sideId, dt, tick);
    }
    resolveOwners(field, tick, rules);
    decaySoftControl(field, tick, dt, softRules);
    cursor = k;
  }

  /** Field state as of the last stride at or before `tick`. */
  function fieldAt(tick) {
    const t = Number(tick);
    if (!Number.isFinite(t) || t < from) return field;
    const target = Math.min(lastStride, Math.floor((t - from) / VISION_STRIDE));
    if (target < 0) return field;

    if (target < cursor) {
      const j = Math.floor(target / KEYFRAME_STRIDES);
      if (keyframes[j]) {
        restoreField(field, keyframes[j]);
        cursor = j * KEYFRAME_STRIDES - 1;
      } else {
        resetControlField(field);
        cursor = -1;
      }
    }
    while (cursor < target) runStride(cursor + 1);
    return field;
  }

  return { fieldAt, field, from, end };
}

/**
 * Area-weighted T / CT / neutral shares.
 * Contested and empty both count as neutral, matching the stacked chart.
 *
 * @param {object} field  ControlField
 * @param {{ t: Uint8Array, ct: Uint8Array } | null} [active]
 * @returns {{ t: number, ct: number, neu: number }}
 */
export function controlShares(field, active = null) {
  if (!field) return { t: 0, ct: 0, neu: 100 };
  const { walkable, count, walkableCount } = field;
  const aT = active?.t || null;
  const aCT = active?.ct || null;
  let tCells = 0;
  let ctCells = 0;

  for (let i = 0; i < count; i++) {
    if (!walkable[i]) continue;
    const tAct = aT ? aT[i] === 1 : false;
    const ctAct = aCT ? aCT[i] === 1 : false;
    if (tAct && !ctAct) {
      tCells++;
      continue;
    }
    if (ctAct && !tAct) {
      ctCells++;
      continue;
    }
    if (tAct && ctAct) continue;
    const cls = classifyCell(field, i);
    if (cls === CLASS_T) tCells++;
    else if (cls === CLASS_CT) ctCells++;
  }

  if (!walkableCount) return { t: 0, ct: 0, neu: 100 };
  const t = (tCells / walkableCount) * 100;
  const ct = (ctCells / walkableCount) * 100;
  return { t, ct, neu: Math.max(0, 100 - t - ct) };
}

/**
 * Possession over a whole round for the stacked control chart.
 * Walks forward once, so the sim never re-seeks.
 *
 * @returns {Array<{ tick: number, t: number, ct: number, neu: number }>}
 */
export function buildMapControlSeries({ meta, track, geom, castCone }) {
  if (!meta || !track || !geom || !castCone) return [];
  const sim = createControlSimulator({ meta, track, geom, castCone });
  const masks = createActiveMasks(geom);
  const scratch = [];
  const series = [];

  for (let tick = sim.from; tick <= sim.end; tick += VISION_STRIDE) {
    const field = sim.fieldAt(tick);
    track.sampleAll(tick, scratch);
    activeMasksFromStates(meta, scratch, geom, masks);
    const shares = controlShares(field, masks);
    series.push({ tick, t: shares.t, ct: shares.ct, neu: shares.neu });
  }
  return series;
}

export { SIDE_CT, SIDE_NONE, SIDE_T };
