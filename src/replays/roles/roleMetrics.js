// ---------------------------------------------------------------------------
// Role metrics from tick samples (no demo re-parse).
//
// T: spatial diversity of positions at clock 1:45 / 1:30 / 1:15 / 1:00.
// CT: pulled-string distance travelled (PSDT) with a 125u radius.
// CT A/B lean: bombsite zones + key zones (key = 75% of bombsite weight).
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { pieceCenter, sanitizeBombSites } from '../zones/bombSites.js';
import { sanitizeKeyZones } from '../zones/keyZones.js';
import { pointInPiece } from '../zones/zoneGeom.js';

/** Pulled-string brush radius (game units). */
export const PSDT_RADIUS = 125;

/** Bombsite piece weight in CT A/B affinity. */
export const BOMB_ZONE_WEIGHT = 1;

/** Key-zone piece weight relative to a bombsite (75%). */
export const KEY_ZONE_WEIGHT = 0.75;

/** Soft falloff length for proximity scores (game units). */
const ZONE_FALLOFF = 480;

/**
 * Round-clock remaining seconds for T samples: 1:45, 1:30, 1:15, 1:00.
 * Live seconds after freeze = ROUND_SECONDS - remaining.
 */
export const T_CLOCK_REMAINING = [105, 90, 75, 60];

/** Demo ticks for T position samples (live phase, pre-plant only). */
export function tSampleTicks(timing) {
  const rate = timing.tickRate || 64;
  const plant = Number.isFinite(timing.plantTick) ? timing.plantTick : null;
  const out = [];
  for (const remain of T_CLOCK_REMAINING) {
    const liveSec = ROUND_SECONDS - remain;
    if (liveSec < 0) continue;
    const tick = timing.freezeEndTick + liveSec * rate;
    if (tick > timing.endTick) continue;
    if (plant != null && tick >= plant) continue;
    out.push(tick);
  }
  return out;
}

/** Sum of pairwise distances — high = positions vary a lot (pack). */
export function spatialDiversity(points) {
  if (!points?.length || points.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    for (let j = i + 1; j < points.length; j++) {
      const b = points[j];
      sum += Math.hypot(a.x - b.x, a.y - b.y);
    }
  }
  return sum;
}

/**
 * Pulled-string distance: a 125u circle only moves when the player pulls it.
 * Filters ADAD jitter that inflates raw path length.
 *
 * @param {{ x: number, y: number, alive?: boolean }[]} samples
 * @param {number} [radius]
 */
export function pulledStringDistance(samples, radius = PSDT_RADIUS) {
  if (!samples?.length) return 0;
  let i = 0;
  while (i < samples.length && samples[i].alive === false) i++;
  if (i >= samples.length) return 0;
  let cx = samples[i].x;
  let cy = samples[i].y;
  let total = 0;
  for (i += 1; i < samples.length; i++) {
    const s = samples[i];
    if (s.alive === false) continue;
    const dx = s.x - cx;
    const dy = s.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > radius) {
      const pull = d - radius;
      total += pull;
      const scale = radius / d;
      cx = s.x - dx * scale;
      cy = s.y - dy * scale;
    }
  }
  return total;
}

/** Raw path length (resets across death gaps). */
export function pathDistance(samples) {
  if (!samples?.length) return 0;
  let total = 0;
  let prev = null;
  for (const s of samples) {
    if (s.alive === false) {
      prev = null;
      continue;
    }
    if (prev) total += Math.hypot(s.x - prev.x, s.y - prev.y);
    prev = s;
  }
  return total;
}

/**
 * Average distance to A vs B centers; also rounds closer to each.
 * @param {{ x: number, y: number }[]} points
 * @param {{ a: {x:number,y:number}|null, b: {x:number,y:number}|null }} centers
 */
export function siteAffinity(points, centers) {
  const out = { distA: 0, distB: 0, n: 0, closerA: 0, closerB: 0 };
  if (!points?.length || (!centers?.a && !centers?.b)) return out;
  for (const p of points) {
    const da = centers.a ? Math.hypot(p.x - centers.a.x, p.y - centers.a.y) : Infinity;
    const db = centers.b ? Math.hypot(p.x - centers.b.x, p.y - centers.b.y) : Infinity;
    if (!Number.isFinite(da) && !Number.isFinite(db)) continue;
    out.n++;
    if (Number.isFinite(da)) out.distA += da;
    if (Number.isFinite(db)) out.distB += db;
    if (da < db) out.closerA++;
    else if (db < da) out.closerB++;
  }
  return out;
}

export function avgSiteDistances(aff) {
  if (!aff?.n) return { avgA: Infinity, avgB: Infinity };
  return {
    avgA: Number.isFinite(aff.distA) ? aff.distA / aff.n : Infinity,
    avgB: Number.isFinite(aff.distB) ? aff.distB / aff.n : Infinity
  };
}

/** Distance to a zone piece (0 when inside). */
function distToPiece(x, y, piece) {
  if (!piece) return Infinity;
  if (pointInPiece(x, y, piece)) return 0;
  const c = pieceCenter(piece);
  if (!c) return Infinity;
  return Math.hypot(x - c.x, y - c.y);
}

/** 1 inside / at the piece, decaying with distance. */
function proximityFromDist(d) {
  if (!Number.isFinite(d)) return 0;
  if (d <= 0) return 1;
  return 1 / (1 + d / ZONE_FALLOFF);
}

/**
 * One side's CT affinity: bombsite at full weight + best key zone at 75%.
 * @param {number} x
 * @param {number} y
 * @param {import('../zones/bombSites.js').BombSitePiece | null} bomb
 * @param {import('../zones/keyZones.js').KeyZonePiece[]} keys
 */
function sideZoneScore(x, y, bomb, keys) {
  const bombProx = proximityFromDist(distToPiece(x, y, bomb));
  let keyProx = 0;
  for (const k of keys || []) {
    keyProx = Math.max(keyProx, proximityFromDist(distToPiece(x, y, k)));
  }
  return BOMB_ZONE_WEIGHT * bombProx + KEY_ZONE_WEIGHT * keyProx;
}

/**
 * CT A/B affinity from bombsites + key zones.
 * Higher score = stronger attachment to that site (anchor lean).
 *
 * @param {{ x: number, y: number }[]} points
 * @param {object | null | undefined} network  zone network with bombSites + keyZones
 * @returns {{ scoreA: number, scoreB: number, n: number, closerA: number, closerB: number }}
 */
export function ctZoneAffinity(points, network) {
  const out = { scoreA: 0, scoreB: 0, n: 0, closerA: 0, closerB: 0 };
  if (!points?.length || !network) return out;
  const sites = sanitizeBombSites(network.bombSites);
  const keys = sanitizeKeyZones(network.keyZones);
  if (!sites.a && !sites.b && !keys.a.length && !keys.b.length) return out;

  for (const p of points) {
    const a = sideZoneScore(p.x, p.y, sites.a, keys.a);
    const b = sideZoneScore(p.x, p.y, sites.b, keys.b);
    if (a <= 0 && b <= 0) continue;
    out.n++;
    out.scoreA += a;
    out.scoreB += b;
    if (a > b) out.closerA++;
    else if (b > a) out.closerB++;
  }
  return out;
}
