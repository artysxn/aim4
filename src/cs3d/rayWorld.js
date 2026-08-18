// ---------------------------------------------------------------------------
// src/cs3d/rayWorld.js
// The map as a bullet sees it: the `trace(from, to)` interface
// shared/sim3d/penetration.js takes, over the pack's collision BVH.
//
// The sibling of src/cs3d/hullWorld.js and the same shape of thing — a
// broadphase adapter, with all the physics on the other side of the interface.
// Three differences from the hull tracer, and each one is a rule of the game:
//
//   A bullet has its own collision set. It is NOT stopped by `playerclip` or
//   `grenadeclip` (both invisible movement fences) and it IS stopped by the
//   drawn world and by the sky lid. That is the `light` band plus `sky`, which
//   is neither the walk set nor the nade set.
//
//   `physics_passbullets_*` brushes are skipped outright. The mapper flagged
//   them as no obstacle at all, so a bullet through Nuke's chainlink and
//   metal grates pays nothing rather than paying what the surface table would
//   charge for a grate (`collider.passBullets`, set in mapLoader).
//
//   It reports WHAT it hit, not just where. The triangle index carries the
//   surface name (`collider.surfaces[collider.surfaceOf[i]]`), which is the
//   key into the game's own penetration table, and it is also how a shot finds
//   the window it just broke (src/cs3d/interactives.js `ownerOf`).
//
// Frames: the sim speaks Source (z up), the BVH is in the scene frame. Both
// ends convert here and shared/sim3d/units.js owns the mapping.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { sourceToScene } from '../../shared/sim3d/units.js';

const _ray = new THREE.Ray();
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * @param {object} collider  from MapPack.onPhys
 * @param {object} [movers]  an object with `rayHit(from, to)` in the SOURCE
 *   frame for geometry outside the BVH (a swinging door)
 */
export function createRayWorld(collider, movers = null) {
  const bvh = collider.bvh;
  const mask = collider.mask || null;
  const pass = collider.passBullets || null;
  const surfaces = collider.surfaces || [];
  const surfaceOf = collider.surfaceOf || null;
  // Everything drawn, plus the sky lid: `light` is solid + entity and `walk`
  // adds sky before the clips, so the bullet set is [0, the end of sky).
  const light = collider.ranges?.light?.[0]?.[1] ?? collider.triangles ?? 0;
  const nade = collider.ranges?.nade?.[0]?.[1] ?? light;
  const limit = Math.max(light, nade);

  return {
    /**
     * @param {{x,y,z}} from  Source frame
     * @param {{x,y,z}} to
     * @returns {{point,normal,distance,triangle,surface}|null}
     */
    trace(from, to) {
      const a = sourceToScene(from.x, from.y, from.z);
      const b = sourceToScene(to.x, to.y, to.z);
      _from.set(a[0], a[1], a[2]);
      _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const far = _dir.length();
      if (!(far > 0)) return null;
      _dir.multiplyScalar(1 / far);
      _ray.set(_from, _dir);

      let best = null;
      // raycastFirst hands back the ORIGINAL triangle index under an indirect
      // BVH (measured: 8/8 on a deliberately scrambled buffer), which is what
      // makes the mask and the surface lookup below mean anything. See the
      // header of src/cs3d/hullWorld.js for why that is not free.
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far);
      if (hit && hit.faceIndex < limit && !(mask && mask[hit.faceIndex]) && !(pass && pass[hit.faceIndex])) {
        best = hit;
      } else if (hit) {
        // The nearest triangle is one this bullet ignores, so walk forward past
        // it and ask again. Bounded, because a chainlink fence is a handful of
        // surfaces and not a hundred.
        let t = hit.distance;
        for (let i = 0; i < 16 && t < far; i++) {
          _ray.origin.copy(_from).addScaledVector(_dir, t + 1 / 32);
          const next = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far - t);
          if (!next) break;
          t += next.distance + 1 / 32;
          if (next.faceIndex < limit && !(mask && mask[next.faceIndex]) && !(pass && pass[next.faceIndex])) {
            next.distance = t;
            best = next;
            break;
          }
        }
      }

      const world = best
        ? {
            point: { x: best.point.x, y: -best.point.z, z: best.point.y },
            normal: best.face
              ? { x: best.face.normal.x, y: -best.face.normal.z, z: best.face.normal.y }
              : { x: 0, y: 0, z: 1 },
            distance: best.distance,
            triangle: best.faceIndex,
            surface: surfaceOf ? surfaces[surfaceOf[best.faceIndex]] || 'default' : 'default'
          }
        : null;

      // A door leaf is not in the BVH at all — it swings. Whichever is nearer.
      const dyn = movers?.rayHit?.(from, to) || null;
      if (dyn && (!world || dyn.distance < world.distance)) return dyn;
      return world;
    }
  };
}
