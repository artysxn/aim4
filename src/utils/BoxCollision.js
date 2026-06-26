// ---------------------------------------------------------------------------
// BoxCollision.js
// Circle-vs-AABB push-out for player movement against cover boxes and walls.
// Shared by the client PlayerController and usable server-side if needed.
// ---------------------------------------------------------------------------

import { BODY_R, crouchScale, BODY_H } from '../multiplayer/constants.js';

/**
 * Project a world (x, z) offset from a box centre into the box's local frame,
 * undoing its Y rotation. Boxes without `rotationY` pass straight through.
 * Writes into `out` ({lx, lz}) to avoid allocation.
 */
function toBoxLocal(dx, dz, ry, out) {
  if (!ry) {
    out.lx = dx;
    out.lz = dz;
    return out;
  }
  const c = Math.cos(-ry);
  const s = Math.sin(-ry);
  out.lx = dx * c - dz * s;
  out.lz = dx * s + dz * c;
  return out;
}

const _local = { lx: 0, lz: 0 };

/**
 * Highest walkable surface at (x, z): floor plus box tops the feet can reach.
 * Ignores elevated surfaces far above `footY` so players don't snap onto cover roofs.
 *
 * @param {number} x
 * @param {number} z
 * @param {{ pos: number[], size: number[], rotationY?: number }[] | null} boxes
 * @param {number} footY — current feet height (used for step-up tolerance)
 * @param {number} [floorY=0]
 */
export function groundHeightAt(x, z, boxes, footY, floorY = 0) {
  let best = floorY;
  const stepUp = 0.5;

  if (!boxes?.length) return best;

  for (const box of boxes) {
    const top = box.pos[1] + box.size[1] / 2;
    const hw = box.size[0] / 2;
    const hd = box.size[2] / 2;
    const l = toBoxLocal(x - box.pos[0], z - box.pos[2], box.rotationY || 0, _local);
    if (Math.abs(l.lx) > hw || Math.abs(l.lz) > hd) continue;
    if (top <= footY + stepUp && top > best) best = top;
  }
  return best;
}

/**
 * Resolve horizontal collisions between a player disc and axis-aligned boxes.
 * Mutates `pos` ({x,z}) and `vel` ({x,z}). Skips boxes the player is jumping over.
 *
 * @param pos      player feet position (x, z)
 * @param vel      horizontal velocity
 * @param footY    feet height above ground
 * @param crouch   crouch amount 0..1
 * @param boxes    [{ pos:[x,y,z], size:[w,h,d] }]
 * @param radius   collision radius (defaults to BODY_R)
 */
export function resolveBoxCollisions(pos, vel, footY, crouch, boxes, radius = BODY_R) {
  if (!boxes?.length) return;

  for (const box of boxes) {
    const top = box.pos[1] + box.size[1] / 2;
    const bottom = box.pos[1] - box.size[1] / 2;
    const bodyTop = footY + BODY_H * crouchScale(crouch);

    // Jumping: skip boxes whose top is below the feet (cleared in the air).
    if (footY > bottom + 0.15 && footY + 0.35 > top) continue;
    // Head/clearance: standing body doesn't intersect this box vertically.
    if (bodyTop <= bottom + 0.05 || footY >= top - 0.05) continue;

    const hw = box.size[0] / 2 + radius;
    const hd = box.size[2] / 2 + radius;
    const ry = box.rotationY || 0;

    // Work in the box's local (axis-aligned) frame so rotated walls push out
    // along their true faces, then rotate the push-out back into world space.
    const l = toBoxLocal(pos.x - box.pos[0], pos.z - box.pos[2], ry, _local);
    const lx = l.lx;
    const lz = l.lz;

    if (Math.abs(lx) >= hw || Math.abs(lz) >= hd) continue;

    const ox = hw - Math.abs(lx);
    const oz = hd - Math.abs(lz);

    let plx = 0;
    let plz = 0;
    if (ox < oz) plx = lx > 0 ? ox : -ox;
    else plz = lz > 0 ? oz : -oz;

    // Rotate the local push-out (plx, plz) back to world (+ry).
    let wx = plx;
    let wz = plz;
    if (ry) {
      const c = Math.cos(ry);
      const s = Math.sin(ry);
      wx = plx * c - plz * s;
      wz = plx * s + plz * c;
    }
    pos.x += wx;
    pos.z += wz;

    // Kill the velocity component heading into the contact normal.
    const nlen = Math.hypot(wx, wz);
    if (nlen > 1e-6) {
      const nx = wx / nlen;
      const nz = wz / nlen;
      const vn = vel.x * nx + vel.z * nz;
      if (vn < 0) {
        vel.x -= vn * nx;
        vel.z -= vn * nz;
      }
    }
  }
}
