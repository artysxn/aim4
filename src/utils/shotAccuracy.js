// ---------------------------------------------------------------------------
// shotAccuracy.js — movement-based shot spread (shared client + server)
// Full accuracy on ground at or below crouch speed; worse while faster; airborne
// shots are highly inaccurate (CS2-style).
// ---------------------------------------------------------------------------

import { CROUCH_SPEED, RUN_SPEED } from './SourceMovement.js';

/** Max angular spread (rad) at full run speed on the ground. */
export const MAX_MOVE_SPREAD = 0.042 * 1.5; // ~3.6° — 1.5× movement penalty
/** Spread while airborne — effectively cannot aim. */
export const AIR_SPREAD = 0.38 * 2.5; // ~55° — 2.5× jump penalty

/** Deterministic PRNG from a 32-bit seed (Mulberry32). */
export function spreadRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Half-angle cone spread (radians) from movement state.
 * @param {{ onGround: boolean, speedHoriz: number }} state
 */
export function shotSpreadRad({ onGround, speedHoriz }) {
  if (!onGround) return AIR_SPREAD;
  const speed = Math.max(0, speedHoriz);
  if (speed <= CROUCH_SPEED * 1.02) return 0;
  const t = Math.min(1, (speed - CROUCH_SPEED) / Math.max(1e-6, RUN_SPEED - CROUCH_SPEED));
  return t * MAX_MOVE_SPREAD;
}

/**
 * Random unit direction within a cone around `dir` (uniform over solid angle).
 * @param {{ x, y, z }} dir — need not be normalised
 * @param {number} spreadRad — cone half-angle (0 = no change)
 * @param {() => number} [rng]
 */
export function applySpreadToDir(dir, spreadRad, rng = Math.random) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const nx = dir.x / len;
  const ny = dir.y / len;
  const nz = dir.z / len;

  if (spreadRad <= 1e-6) {
    return { x: nx, y: ny, z: nz };
  }

  const u = rng();
  const v = rng();
  const cosMax = Math.cos(spreadRad);
  const cosAng = 1 - u * (1 - cosMax);
  const sinAng = Math.sqrt(Math.max(0, 1 - cosAng * cosAng));
  const phi = 2 * Math.PI * v;

  let tx;
  let ty;
  let tz;
  if (Math.abs(nx) < 0.9) {
    tx = 0;
    ty = 1;
    tz = 0;
  } else {
    tx = 1;
    ty = 0;
    tz = 0;
  }
  let px = ny * tz - nz * ty;
  let py = nz * tx - nx * tz;
  let pz = nx * ty - ny * tx;
  let plen = Math.hypot(px, py, pz) || 1;
  px /= plen;
  py /= plen;
  pz /= plen;
  const qx = py * nz - pz * ny;
  const qy = pz * nx - px * nz;
  const qz = px * ny - py * nx;

  const rx = nx * cosAng + (px * Math.cos(phi) + qx * Math.sin(phi)) * sinAng;
  const ry = ny * cosAng + (py * Math.cos(phi) + qy * Math.sin(phi)) * sinAng;
  const rz = nz * cosAng + (pz * Math.cos(phi) + qz * Math.sin(phi)) * sinAng;
  const rlen = Math.hypot(rx, ry, rz) || 1;
  return { x: rx / rlen, y: ry / rlen, z: rz / rlen };
}

/** Apply spread to a THREE.Ray (mutates direction). */
export function applySpreadToRay(ray, spreadRad, rng) {
  const d = applySpreadToDir(ray.direction, spreadRad, rng);
  ray.direction.set(d.x, d.y, d.z);
}

/** Resolve final shot direction on the server from aim + reported movement state. */
export function resolveShotDirection(aim, state, seed) {
  const spread = shotSpreadRad(state);
  const rng = spreadRng(seed >>> 0);
  return applySpreadToDir(
    { x: aim[0], y: aim[1], z: aim[2] },
    spread,
    rng
  );
}
