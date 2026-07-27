// ---------------------------------------------------------------------------
// replays/zones/mapControl.js
// Beam-hit map control: accumulate FOV ray hits to claim positions, and build
// a T / neutral / CT area series for the stacked control chart.
//
// Rules (per vision check — one player every VISION_STRIDE ticks):
//   • Each of 11 FOV beams that touch a position adds 1 hit.
//   • Neutral → claim needs CLAIM_NEUTRAL_HITS (3).
//   • Flip enemy ownership → CLAIM_FLIP_HITS (20).
//   • No hits for CONTEST_DECAY_SECONDS → reset that side's progress.
//   • Owner stays until flipped; unfinished contests revert to prior owner
//     (or stay neutral if never claimed).
// ---------------------------------------------------------------------------

import { pieceBounds } from './zoneGeom.js';
import { positionsAtPoint } from './pointInZone.js';
import { cellsNear } from './dynamicControl.js';

/** Demo ticks between vision firings (one living player per stride). */
export const VISION_STRIDE = 10;
/** Hits to take a never-owned (neutral) position. */
export const CLAIM_NEUTRAL_HITS = 3;
/** Hits to steal a position from the other side. */
export const CLAIM_FLIP_HITS = 20;
/** Seconds without hits before a side's progress resets. */
export const CONTEST_DECAY_SECONDS = 2;

/**
 * @typedef {{
 *   owner: 'T'|'CT'|null,
 *   ownerTick: number|null,
 *   tHits: number,
 *   ctHits: number,
 *   tLast: number|null,
 *   ctLast: number|null
 * }} ClaimState
 */

function ringArea(ring) {
  if (!ring || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) * 0.5;
}

function areaOfPosition(zone) {
  let area = 0;
  for (const p of zone?.pieces || []) {
    if (!p) continue;
    if (p.type === 'rect' || (p.w > 0 && p.h > 0 && !p.ring)) {
      area += Math.max(0, Number(p.w) || 0) * Math.max(0, Number(p.h) || 0);
      continue;
    }
    if (p.type === 'poly' || p.ring?.length) {
      area += ringArea(p.ring);
      continue;
    }
    const b = pieceBounds(p);
    if (Number.isFinite(b.minX)) {
      area += Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
    }
  }
  return area;
}

/** @returns {ClaimState} */
export function emptyClaim() {
  return {
    owner: null,
    ownerTick: null,
    tHits: 0,
    ctHits: 0,
    tLast: null,
    ctLast: null
  };
}

/** Deep-enough copy of a claims map (per-position state objects). */
export function cloneClaims(claims) {
  /** @type {Map<string, ClaimState>} */
  const out = new Map();
  for (const [id, st] of claims || []) {
    if (!st) continue;
    out.set(id, {
      owner: st.owner ?? null,
      ownerTick: st.ownerTick ?? null,
      tHits: st.tHits || 0,
      ctHits: st.ctHits || 0,
      tLast: st.tLast ?? null,
      ctLast: st.ctLast ?? null
    });
  }
  return out;
}

/**
 * Deterministic beam-claim simulator with per-stride snapshots.
 * Seeking to any tick returns the same claims as playing forward from freeze.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {{ sampleAll: Function }} args.track
 * @param {(ctx: { viewer: object, side: string, tick: number, states: Array }) => Map<string, number>} args.castPlayerBeams
 */
export function createBeamClaimSimulator({ meta, track, castPlayerBeams }) {
  if (!meta || !track || !castPlayerBeams) {
    return {
      claimsAt: () => new Map(),
      ensureUntil: () => {},
      from: 0,
      end: 0
    };
  }
  const tickRate = meta.tickRate || 64;
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const end = Math.max(from, meta.endTick ?? from);
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const scratch = [];
  /** @type {Map<string, ClaimState>} */
  let claims = new Map();
  let rr = 0;
  let nextTick = from;
  /** @type {Array<{ tick: number, claims: Map<string, ClaimState> }>} */
  const snapshots = [];

  function stepOnce() {
    if (nextTick > end) return false;
    const tick = nextTick;
    track.sampleAll(tick, scratch);
    decayClaims(claims, tick, tickRate);

    /** @type {Array<{ player: object, side: 'T'|'CT', viewer: object }>} */
    const viewers = [];
    for (const p of players) {
      const side = teamSides[p.team];
      if (side !== 'T' && side !== 'CT') continue;
      const s = scratch[p.slot];
      if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      if (!Number.isFinite(s.yaw)) continue;
      viewers.push({
        player: p,
        side,
        viewer: { x: s.x, y: s.y, yaw: s.yaw }
      });
    }

    if (viewers.length) {
      const focus = viewers[rr % viewers.length];
      rr++;
      const beams = castPlayerBeams({
        viewer: focus.viewer,
        side: focus.side,
        tick,
        states: scratch
      });
      for (const [posId, n] of beams || []) {
        if (!claims.has(posId)) claims.set(posId, emptyClaim());
        applyBeamHits(claims.get(posId), focus.side, n, tick, tickRate);
      }
    }

    snapshots.push({ tick, claims: cloneClaims(claims) });
    nextTick += VISION_STRIDE;
    return true;
  }

  function ensureUntil(toTick) {
    const target = Math.min(Math.max(Number(toTick) || from, from), end);
    while (nextTick <= target) {
      if (!stepOnce()) break;
    }
  }

  /**
   * Claims as of the last vision stride at or before `tick`.
   * Always returns a fresh clone so callers can mutate safely.
   */
  function claimsAt(tick) {
    const t = Number(tick);
    if (!Number.isFinite(t) || t < from) return new Map();
    ensureUntil(t);
    if (!snapshots.length) return new Map();
    let lo = 0;
    let hi = snapshots.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (snapshots[mid].tick <= t) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? cloneClaims(snapshots[best].claims) : new Map();
  }

  return { claimsAt, ensureUntil, from, end };
}

/**
 * Decay + apply beam hits for one side on one position.
 * @param {ClaimState} st
 * @param {'T'|'CT'} side
 * @param {number} beams  distinct FOV rays that hit (0–11)
 * @param {number} tick
 * @param {number} tickRate
 */
export function applyBeamHits(st, side, beams, tick, tickRate) {
  const decay = CONTEST_DECAY_SECONDS * (tickRate || 64);
  if (st.tLast != null && tick - st.tLast > decay) {
    st.tHits = 0;
    st.tLast = null;
  }
  if (st.ctLast != null && tick - st.ctLast > decay) {
    st.ctHits = 0;
    st.ctLast = null;
  }
  if (!beams || (side !== 'T' && side !== 'CT')) return st;

  // Already own it — clear any enemy contest meter; no self-progress.
  if (st.owner === side) {
    if (side === 'T') {
      st.ctHits = 0;
      st.ctLast = null;
    } else {
      st.tHits = 0;
      st.tLast = null;
    }
    return st;
  }

  if (side === 'T') {
    st.tHits += beams;
    st.tLast = tick;
  } else {
    st.ctHits += beams;
    st.ctLast = tick;
  }

  const hits = side === 'T' ? st.tHits : st.ctHits;
  const needed = st.owner == null ? CLAIM_NEUTRAL_HITS : CLAIM_FLIP_HITS;
  if (hits >= needed) {
    st.owner = side;
    st.ownerTick = tick;
    st.tHits = 0;
    st.ctHits = 0;
    st.tLast = null;
    st.ctLast = null;
  }
  return st;
}

/** Decay-only pass so time scrubbing still clears unfinished contests. */
export function decayClaims(claims, tick, tickRate) {
  const decay = CONTEST_DECAY_SECONDS * (tickRate || 64);
  for (const st of claims.values()) {
    if (st.tLast != null && tick - st.tLast > decay) {
      st.tHits = 0;
      st.tLast = null;
    }
    if (st.ctLast != null && tick - st.ctLast > decay) {
      st.ctHits = 0;
      st.ctLast = null;
    }
  }
}

/**
 * Visual control from claim state (ignores feet — caller layers active on top).
 * @returns {'T'|'CT'|'contested'|null}
 */
export function claimVisual(st) {
  if (!st) return null;
  const tBusy = st.tHits > 0;
  const ctBusy = st.ctHits > 0;
  if (tBusy && ctBusy) return 'contested';
  if (st.owner === 'T' && ctBusy) return 'contested';
  if (st.owner === 'CT' && tBusy) return 'contested';
  if (!st.owner && (tBusy || ctBusy)) return 'contested';
  if (st.owner === 'T' || st.owner === 'CT') return st.owner;
  return null;
}

/**
 * @param {object} network
 * @returns {Map<string, number>}
 */
export function positionAreas(network) {
  if (network?._areaCache instanceof Map) return network._areaCache;
  const map = new Map();
  for (const pos of network?.zones || []) {
    if (!pos?.id || pos.hidden) continue;
    map.set(pos.id, Math.max(0, areaOfPosition(pos)));
  }
  if (network) network._areaCache = map;
  return map;
}

/**
 * Area-weighted T / CT / neutral shares.
 * Contested and empty both count as neutral for the stacked chart.
 *
 * @param {object} network
 * @param {Map<string, ClaimState>} claims
 * @param {{ t?: Set<string>, ct?: Set<string> }} [active]
 * @returns {{ t: number, ct: number, neu: number }}
 */
export function controlShares(network, claims, active = null) {
  const areas = positionAreas(network);
  let tArea = 0;
  let ctArea = 0;
  let neuArea = 0;
  let total = 0;
  for (const [id, area] of areas) {
    total += area;
    const tAct = active?.t?.has(id);
    const ctAct = active?.ct?.has(id);
    let side = null;
    if (tAct && !ctAct) side = 'T';
    else if (ctAct && !tAct) side = 'CT';
    else if (!tAct && !ctAct) {
      const v = claimVisual(claims.get(id));
      side = v === 'T' || v === 'CT' ? v : null;
    }
    if (side === 'T') tArea += area;
    else if (side === 'CT') ctArea += area;
    else neuArea += area;
  }
  if (total <= 0) return { t: 0, ct: 0, neu: 100 };
  return {
    t: (tArea / total) * 100,
    ct: (ctArea / total) * 100,
    neu: (neuArea / total) * 100
  };
}

/**
 * Active feet sets from a sampled tick buffer.
 * @param {object} meta
 * @param {Array} states
 * @param {object} network
 */
export function activeFromStates(meta, states, network) {
  const t = new Set();
  const ct = new Set();
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const grid = network?._dynGrid;
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    if (grid) {
      for (const id of cellsNear(grid, s.x, s.y)) {
        if (side === 'T') t.add(id);
        else ct.add(id);
      }
    } else {
      for (const z of positionsAtPoint(s.x, s.y, network)) {
        if (!z?.id) continue;
        if (side === 'T') t.add(z.id);
        else ct.add(z.id);
      }
    }
  }
  return { t, ct };
}

/**
 * Simulate beam claims across a round for the stacked control chart.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {{ sampleAll: Function }} args.track
 * @param {object} args.network
 * @param {(ctx: { viewer: object, side: string, tick: number, states: Array }) => Map<string, number>} args.castPlayerBeams
 * @returns {Array<{ tick: number, t: number, ct: number, neu: number }>}
 */
export function buildMapControlSeries({ meta, track, network, castPlayerBeams }) {
  if (!meta || !track || !castPlayerBeams) return [];
  if (!network?.zones?.length) return [];
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const to = Math.max(from, meta.endTick ?? from);
  const scratch = [];
  const sim = createBeamClaimSimulator({ meta, track, castPlayerBeams });
  const series = [];

  for (let tick = from; tick <= to; tick += VISION_STRIDE) {
    const claims = sim.claimsAt(tick);
    track.sampleAll(tick, scratch);
    const active = activeFromStates(meta, scratch, network);
    const shares = controlShares(network, claims, active);
    series.push({ tick, t: shares.t, ct: shares.ct, neu: shares.neu });
  }
  return series;
}
