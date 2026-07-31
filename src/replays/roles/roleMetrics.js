// ---------------------------------------------------------------------------
// Role metrics from tick samples (no demo re-parse).
//
// T: spatial diversity of positions at clock 1:45 / 1:30 / 1:15 / 1:00.
// CT: pulled-string distance travelled (PSDT) with a 125u radius.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';

/** Pulled-string brush radius (game units). */
export const PSDT_RADIUS = 125;

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
