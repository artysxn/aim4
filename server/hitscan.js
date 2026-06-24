// ---------------------------------------------------------------------------
// server/hitscan.js
// Server-authoritative hit detection. Pure analytic ray tests (no THREE) so the
// server can validate a shot against the same map geometry + player models the
// client renders. A shot hits a target only if the ray reaches the body/head
// BEFORE it is blocked by any cover box (occlusion check).
// ---------------------------------------------------------------------------

import { BODY_R, BODY_H, HEAD_R, crouchScale, headCenterY } from '../src/multiplayer/constants.js';

const EPS = 1e-6;

/** Ray vs axis-aligned box (centre `pos`, full `size`). Returns entry t or Infinity. */
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

/** Ray vs sphere (centre c, radius r). Returns nearest positive t or Infinity. */
function raySphere(o, d, c, r) {
  const ox = o[0] - c[0];
  const oy = o[1] - c[1];
  const oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  if (t0 >= 0) return t0;
  const t1 = -b + sq;
  return t1 >= 0 ? t1 : Infinity;
}

/**
 * Ray vs finite vertical cylinder (axis along +y), base at (cx, baseY, cz),
 * radius r, height h. Returns nearest positive t on the side wall within the
 * height span, or Infinity.
 */
function rayCylinder(o, d, cx, cz, baseY, r, h) {
  const dx = d[0];
  const dz = d[2];
  const ox = o[0] - cx;
  const oz = o[2] - cz;
  const a = dx * dx + dz * dz;
  if (a < EPS) return Infinity; // ray parallel to cylinder axis
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0) return Infinity;
  const y = o[1] + d[1] * t;
  if (y < baseY || y > baseY + h) return Infinity;
  return t;
}

/**
 * Resolve a shot. Returns { zone:'head'|'body', t } for the nearest target part
 * hit (if not occluded), else null.
 *
 * @param origin  [x,y,z] shot origin (shooter eye)
 * @param dir     [x,y,z] normalised shot direction
 * @param target  { x, z, crouch, footY? }   victim feet position + crouch amount
 * @param boxes   array of { pos:[x,y,z], size:[w,h,d] } cover
 */
export function resolveShot(origin, dir, target, boxes) {
  const crouch = target.crouch || 0;
  const sc = crouchScale(crouch);
  const footY = Number.isFinite(target.footY) ? target.footY : 0;
  const bodyH = BODY_H * sc;
  const hCenter = footY + headCenterY(crouch);

  const tBody = rayCylinder(origin, dir, target.x, target.z, footY, BODY_R, bodyH);
  const tHead = raySphere(origin, dir, [target.x, hCenter, target.z], HEAD_R);

  let zone = null;
  let tHit = Infinity;
  if (tHead < tHit) {
    tHit = tHead;
    zone = 'head';
  }
  if (tBody < tHit) {
    tHit = tBody;
    zone = 'body';
  }
  if (!zone) return null;

  // Occlusion: any cover box hit closer than the target part blocks the shot.
  for (const box of boxes) {
    const tb = rayAABB(origin, dir, box.pos, box.size);
    if (tb < tHit - 0.02) return null;
  }
  return { zone, t: tHit };
}
