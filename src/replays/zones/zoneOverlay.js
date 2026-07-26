// ---------------------------------------------------------------------------
// replays/zones/zoneOverlay.js
// Timeline "positions" overlay: who has been where up to the playhead, and who
// is there now. Colors: gray empty, T yellow, CT blue, both red; active vs
// controlled (darker) for single-side claims.
// ---------------------------------------------------------------------------

import { positionsAtPoint } from './pointInZone.js';
import { pieceBounds } from './zoneGeom.js';

/** @typedef {'empty'|'t-active'|'t-control'|'ct-active'|'ct-control'|'contested'|'contested-active'} ZonePaint */

export const ZONE_PAINT = {
  empty: { fill: 'rgba(130,138,150,0.22)', stroke: 'rgba(170,178,190,0.55)' },
  't-active': { fill: 'rgba(240,193,74,0.48)', stroke: '#f0c14a' },
  't-control': { fill: 'rgba(150,115,28,0.34)', stroke: '#9a7620' },
  'ct-active': { fill: 'rgba(91,159,212,0.48)', stroke: '#5b9fd4' },
  'ct-control': { fill: 'rgba(40,90,130,0.34)', stroke: '#2f6a96' },
  contested: { fill: 'rgba(210,70,70,0.40)', stroke: '#d45555' },
  'contested-active': { fill: 'rgba(240,70,70,0.52)', stroke: '#ff5a5a' }
};

/**
 * First tick each side entered each position (sampled once per second).
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {{ sampleAll: Function }} args.track
 * @param {object} args.network
 * @returns {{ firstT: Map<string, number>, firstCT: Map<string, number> } | null}
 */
export function buildZonePresence({ meta, track, network }) {
  if (!meta || !track || !network?.zones?.length) return null;
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const to = Math.max(from, meta.endTick ?? from);
  const tickRate = meta.tickRate || 64;
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  /** @type {Map<string, number>} */
  const firstT = new Map();
  /** @type {Map<string, number>} */
  const firstCT = new Map();
  const scratch = [];

  for (let tick = from; tick <= to; tick += tickRate) {
    track.sampleAll(tick, scratch);
    for (const p of players) {
      const side = teamSides[p.team];
      if (side !== 'T' && side !== 'CT') continue;
      const s = scratch[p.slot];
      if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const hits = positionsAtPoint(s.x, s.y, network);
      const map = side === 'T' ? firstT : firstCT;
      for (const z of hits) {
        if (!z?.id || map.has(z.id)) continue;
        map.set(z.id, tick);
      }
    }
  }
  return { firstT, firstCT };
}

/**
 * Position ids currently occupied by living players on each side.
 * @returns {{ t: Set<string>, ct: Set<string> }}
 */
export function activePositionsAt({ meta, states, network }) {
  const t = new Set();
  const ct = new Set();
  if (!meta || !network?.zones?.length) return { t, ct };
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    for (const z of positionsAtPoint(s.x, s.y, network)) {
      if (!z?.id) continue;
      if (side === 'T') t.add(z.id);
      else ct.add(z.id);
    }
  }
  return { t, ct };
}

/**
 * @param {string} posId
 * @param {number} tick
 * @param {{ firstT: Map<string, number>, firstCT: Map<string, number> }} presence
 * @param {{ t: Set<string>, ct: Set<string> }} active
 * @returns {ZonePaint}
 */
export function paintForPosition(posId, tick, presence, active) {
  const tVis = (presence?.firstT.get(posId) ?? Infinity) <= tick;
  const ctVis = (presence?.firstCT.get(posId) ?? Infinity) <= tick;
  const tAct = Boolean(active?.t?.has(posId));
  const ctAct = Boolean(active?.ct?.has(posId));
  if (tVis && ctVis) return tAct || ctAct ? 'contested-active' : 'contested';
  if (tVis) return tAct ? 't-active' : 't-control';
  if (ctVis) return ctAct ? 'ct-active' : 'ct-control';
  return 'empty';
}

/** Shoelace area for a closed or open ring in world units². */
function ringArea(ring) {
  if (!ring || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) * 0.5;
}

/** World-unit² area of one position (sum of its pieces). */
export function positionArea(zone) {
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
    // Fallback: axis-aligned bounds of unknown piece shapes.
    const b = pieceBounds(p);
    if (Number.isFinite(b.minX)) {
      area += Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
    }
  }
  return area;
}

/**
 * Counts + area-weighted map control for the current paint map.
 *
 * Map control % uses position area (not position count). Neutral = empty
 * gray + contested red. T/CT = that side's active + controlled only.
 *
 * @param {object} network
 * @param {Record<string, ZonePaint>} paint
 */
export function summarizeZoneControl(network, paint) {
  const counts = {
    tActive: 0,
    tControl: 0,
    ctActive: 0,
    ctControl: 0,
    contested: 0,
    neutral: 0,
    total: 0
  };
  let tArea = 0;
  let ctArea = 0;
  let neutralArea = 0;
  let totalArea = 0;

  for (const z of network?.zones || []) {
    if (!z?.id || z.hidden) continue;
    const key = paint?.[z.id] || 'empty';
    const area = positionArea(z);
    counts.total += 1;
    totalArea += area;

    if (key === 't-active') {
      counts.tActive += 1;
      tArea += area;
    } else if (key === 't-control') {
      counts.tControl += 1;
      tArea += area;
    } else if (key === 'ct-active') {
      counts.ctActive += 1;
      ctArea += area;
    } else if (key === 'ct-control') {
      counts.ctControl += 1;
      ctArea += area;
    } else if (key === 'contested' || key === 'contested-active') {
      counts.contested += 1;
      neutralArea += area;
    } else {
      counts.neutral += 1;
      neutralArea += area;
    }
  }

  const denom = totalArea > 0 ? totalArea : 1;
  return {
    counts,
    area: { t: tArea, ct: ctArea, neutral: neutralArea, total: totalArea },
    pct: {
      t: (tArea / denom) * 100,
      ct: (ctArea / denom) * 100,
      neutral: (neutralArea / denom) * 100
    }
  };
}
