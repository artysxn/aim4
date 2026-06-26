// ---------------------------------------------------------------------------
// spawnVisibility.js
// Pure helpers for deathmatch spawns and bot hit scaling (client + server).
// ---------------------------------------------------------------------------

import { STAND_EYE } from '../multiplayer/constants.js';

const EPS = 1e-6;

/** Bot hit odds scale: 1.0 at rest, 0.5 at half max speed, 1/3 at full speed. */
export function movementHitScale(speed, maxSpeed) {
  if (maxSpeed <= 1e-6) return 1;
  const ratio = Math.min(1, Math.max(0, speed / maxSpeed));
  return 1 / (1 + 2 * ratio);
}

/** FPS forward vector from yaw/pitch (matches InputManager / Three.js YXZ). */
export function forwardFromYawPitch(yaw, pitch = 0) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp];
}

function rayAABB(o, d, pos, size) {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const min = pos[i] - size[i] / 2;
    const max = pos[i] + size[i] / 2;
    if (Math.abs(d[i]) < EPS) {
      if (o[i] < min || o[i] > max) return Infinity;
    } else {
      let t1 = (min - o[i]) / d[i];
      let t2 = (max - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  if (tmax < 0) return Infinity;
  return tmin >= 0 ? tmin : 0;
}

function rayBox(o, d, box) {
  const ry = box.rotationY || 0;
  if (!ry) return rayAABB(o, d, box.pos, box.size);
  const c = Math.cos(-ry);
  const s = Math.sin(-ry);
  const dx = o[0] - box.pos[0];
  const dz = o[2] - box.pos[2];
  const lo = [dx * c - dz * s, o[1] - box.pos[1], dx * s + dz * c];
  const ld = [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c];
  return rayAABB(lo, ld, [0, 0, 0], box.size);
}

/** True when no cover box blocks the segment (excluding endpoints). */
export function lineOfSightClear(from, to, boxes = []) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  const d = [dx / dist, dy / dist, dz / dist];
  let nearest = Infinity;
  for (const box of boxes) {
    const t = rayBox(from, d, box);
    if (t < dist - 0.04) nearest = Math.min(nearest, t);
  }
  return nearest === Infinity;
}

/**
 * True when `point` lies inside the viewer's horizontal FOV cone and is not
 * occluded by cover.
 */
export function isPointVisible(from, dir, point, hFovDeg, boxes = []) {
  const dx = point[0] - from[0];
  const dy = point[1] - from[1];
  const dz = point[2] - from[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.5) return true;
  const dot = (dx * dir[0] + dy * dir[1] + dz * dir[2]) / dist;
  const cosHalf = Math.cos((hFovDeg * Math.PI) / 180 / 2);
  if (dot < cosHalf) return false;
  return lineOfSightClear(from, point, boxes);
}

/**
 * Pick a spawn far from `avoid` points, preferring spawns no living viewer can see.
 * @param {Array<{pos:number[]}>} spawns
 * @param {number[][]} avoid — [x,y,z] points to maximize distance from
 * @param {Array<{eye:number[], dir:number[], hFov:number}>} viewers
 * @param {object[]} boxes — map cover for LOS tests
 */
export function pickSpawnPreferHidden(spawns, avoid = [], viewers = [], boxes = []) {
  if (!spawns.length) return { pos: [0, 0, 0] };
  const scored = spawns.map((sp) => {
    const eye = [sp.pos[0], (sp.pos[1] || 0) + STAND_EYE, sp.pos[2]];
    let visible = false;
    for (const v of viewers) {
      if (isPointVisible(v.eye, v.dir, eye, v.hFov ?? 90, boxes)) {
        visible = true;
        break;
      }
    }
    let gap = Infinity;
    for (const a of avoid) {
      gap = Math.min(gap, Math.hypot(sp.pos[0] - a[0], sp.pos[2] - a[2]));
    }
    if (!avoid.length) gap = Math.random();
    return { sp, visible, gap };
  });
  const hidden = scored.filter((s) => !s.visible);
  const pool = hidden.length ? hidden : scored;
  let best = pool[0];
  for (const c of pool) {
    if (c.gap > best.gap) best = c;
  }
  return { pos: [...best.sp.pos] };
}
