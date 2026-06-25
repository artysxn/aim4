// ---------------------------------------------------------------------------
// BoxCollision.js
// Circle-vs-AABB push-out for player movement against cover boxes and walls.
// Shared by the client PlayerController and usable server-side if needed.
// ---------------------------------------------------------------------------

import { BODY_R, crouchScale, BODY_H } from '../multiplayer/constants.js';

/**
 * Highest walkable surface at (x, z): floor plus box tops the feet can reach.
 * Ignores elevated surfaces far above `footY` so players don't snap onto cover roofs.
 *
 * @param {number} x
 * @param {number} z
 * @param {{ pos: number[], size: number[] }[] | null} boxes
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
    if (Math.abs(x - box.pos[0]) > hw || Math.abs(z - box.pos[2]) > hd) continue;
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
    const bx = box.pos[0];
    const bz = box.pos[2];

    const dx = pos.x - bx;
    const dz = pos.z - bz;

    if (Math.abs(dx) >= hw || Math.abs(dz) >= hd) continue;

    const ox = hw - Math.abs(dx);
    const oz = hd - Math.abs(dz);

    if (ox < oz) {
      pos.x += dx > 0 ? ox : -ox;
      if ((dx > 0 && vel.x < 0) || (dx < 0 && vel.x > 0)) vel.x = 0;
    } else {
      pos.z += dz > 0 ? oz : -oz;
      if ((dz > 0 && vel.z < 0) || (dz < 0 && vel.z > 0)) vel.z = 0;
    }
  }
}
