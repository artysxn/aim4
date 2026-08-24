// ---------------------------------------------------------------------------
// simWorld.js
// The aim trainer's worlds, as shared/sim3d/motion.js wants to see them.
//
// The trainer used to run its own movement: SourceMovement.js integrated in
// metres against a circle-vs-box push-out. The map explorer runs the real
// thing — Source's CGameMovement in f32 at a fixed 64 Hz, swept AABB against
// the map hull. Both were "the Source model" and they did not feel the same,
// because a hand-rolled friction/accelerate pair is not a duck transition, a
// stamina curve, a step-up, a surf plane or a bunny-hop cap.
//
// So there is one mover now, and this file is the other half of moving it in:
// motion.js only ever asks the world one question —
//
//   traceHull(start, end, halfWide, height) → { fraction, endpos, normal, startSolid }
//
// — and everything the trainer can stand on can answer it. A ported CS2 map
// answers it out of the same BVH its bullets already trace against; the arenas
// answer it out of their cover list.
//
// Two frames and two scales meet here, and neither is negotiable:
//
//   the sim    Source: x east, y north, z UP, units (1 u = 2.54 cm).
//   the trainer  three: y up, z = −(source y), METRES.
//
// hullTrace.js already owns the axis swap. The scale is this file's, and it is
// handed to the broadphase (`unitScale`) rather than applied to the geometry,
// because the geometry is shared with the renderer, the bots and the decal
// placer, all of which are in metres and none of which should have to move.
// ---------------------------------------------------------------------------

import { createHullWorld } from '../cs3d/hullWorld.js';
import { createHullTracer } from '../../shared/sim3d/hullTrace.js';
import { UNIT_M } from '../../shared/sim3d/units.js';

/** Source units per metre, for the trainer→sim direction. */
export const U_PER_M = 1 / UNIT_M;

/**
 * A ported map's hull (src/utils/MeshCollision.js) as a sim world.
 *
 * `audience` is ignored: the trainer's ported maps carry ONE collision mesh,
 * not the explorer's banded one, because the porter merges walk-solid geometry
 * and leaves grenadeclip behind. A grenade in the trainer is therefore stopped
 * by the same hull a player is, which is wrong in exactly the places CS2 puts a
 * grenadeclip and right everywhere else. Noted rather than hidden.
 */
export function meshSimWorld(collider) {
  if (!collider?.bvh) return null;
  return createHullWorld({ bvh: collider.bvh }, 'walk', null, { unitScale: UNIT_M });
}

// ---- the arenas -------------------------------------------------------------

/**
 * The trainer's own arenas as a triangle soup.
 *
 * A cover box is twelve triangles and an arena has a few dozen boxes, so there
 * is no tree here and no need for one: the broadphase is a linear scan over
 * per-box AABBs, which for 40 boxes beats building anything. The floor is one
 * quad, big enough to cover the bounds and no bigger — an infinite plane would
 * make the sweep's bounding test useless.
 *
 * Boxes keep their `rotationY`, so the arena the player collides against is the
 * one that is drawn, rotated walls and all. That is why the triangles are baked
 * once here rather than the box being tested analytically: a rotated box is not
 * an AABB, and motion.js is a triangle sweeper.
 */
export function boxSimWorld(boxes, { floorY = 0, extent = 64 } = {}) {
  const tris = [];
  const push = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    tris.push(
      ax * U_PER_M, ay * U_PER_M, az * U_PER_M,
      bx * U_PER_M, by * U_PER_M, bz * U_PER_M,
      cx * U_PER_M, cy * U_PER_M, cz * U_PER_M
    );
  };
  const quad = (p0, p1, p2, p3) => {
    push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    push(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
  };

  const e = extent;
  quad([-e, floorY, -e], [e, floorY, -e], [e, floorY, e], [-e, floorY, e]);

  for (const b of boxes || []) {
    const [px, py, pz] = b.pos;
    const hx = b.size[0] / 2;
    const hy = b.size[1] / 2;
    const hz = b.size[2] / 2;
    const ry = b.rotationY || 0;
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    // Local corner → world, honouring the box's own Y rotation.
    const c = (sx, sy, sz) => {
      const lx = sx * hx;
      const lz = sz * hz;
      return [px + lx * cos + lz * sin, py + sy * hy, pz - lx * sin + lz * cos];
    };
    const p = [
      c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1),
      c(-1, 1, -1), c(1, 1, -1), c(1, 1, 1), c(-1, 1, 1)
    ];
    quad(p[4], p[5], p[6], p[7]); // top
    quad(p[3], p[2], p[1], p[0]); // bottom
    quad(p[0], p[1], p[5], p[4]);
    quad(p[1], p[2], p[6], p[5]);
    quad(p[2], p[3], p[7], p[6]);
    quad(p[3], p[0], p[4], p[7]);
  }

  const P = Float32Array.from(tris);
  const n = P.length / 9;
  // Per-triangle bounds, once, so the broadphase is nine compares and not a
  // min/max over nine floats every time a hull moves.
  const bmin = new Float32Array(n * 3);
  const bmax = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let a = 0; a < 3; a++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < 3; v++) {
        const q = P[t * 9 + v * 3 + a];
        if (q < lo) lo = q;
        if (q > hi) hi = q;
      }
      bmin[t * 3 + a] = lo;
      bmax[t * 3 + a] = hi;
    }
  }

  return createHullTracer((minX, minY, minZ, maxX, maxY, maxZ, visit) => {
    for (let t = 0; t < n; t++) {
      if (bmax[t * 3] < minX || bmin[t * 3] > maxX) continue;
      if (bmax[t * 3 + 1] < minY || bmin[t * 3 + 1] > maxY) continue;
      if (bmax[t * 3 + 2] < minZ || bmin[t * 3 + 2] > maxZ) continue;
      const i = t * 9;
      if (
        visit(
          P[i], P[i + 1], P[i + 2],
          P[i + 3], P[i + 4], P[i + 5],
          P[i + 6], P[i + 7], P[i + 8]
        ) === true
      ) {
        return;
      }
    }
  });
}

/**
 * The world a scenario's `colliders` value stands for, whatever kind it is.
 *
 * The same dispatch src/utils/mapCollision.js does for the bots, for the one
 * caller that needs a swept hull rather than a push-out. Cached on the collider
 * object: an arena's soup is a few thousand triangles to bake and a scenario
 * respawns the player a lot.
 */
export function simWorldFor(colliders, { floorY = 0, extent = 64 } = {}) {
  if (!colliders) return null;
  if (colliders.isMeshCollider) {
    if (!colliders._simWorld) colliders._simWorld = meshSimWorld(colliders);
    return colliders._simWorld;
  }
  if (!colliders.length) return null;
  // Keyed on the extent as well, because the arena's ground quad is sized for
  // the scenario that asked for it and the SAME box list is handed to
  // scenarios with very different bounds. A cached 24 m floor under a run that
  // needs 64 would be a hole to walk off.
  if (!colliders._simWorld || colliders._simWorldKey !== `${floorY}:${extent}`) {
    colliders._simWorld = boxSimWorld(colliders, { floorY, extent });
    colliders._simWorldKey = `${floorY}:${extent}`;
  }
  return colliders._simWorld;
}
