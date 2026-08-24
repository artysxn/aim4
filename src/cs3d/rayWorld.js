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
//   A flashbang is a fourth audience. Leak FLASH_MASK is MASK_OPAQUE_AND_NPCS
//   | CONTENTS_DEBRIS, with CONTENTS_OPAQUE cleared (block-light brushes do
//   not block flash). That is the `light` band: solid + entity, not sky, not
//   playerclip, not grenadeclip. `passbullets` chainlink is still solid, so a
//   flash hits it. The pack drops tools/toolsblocklight at import, so there is
//   no CONTENTS_OPAQUE flag left to pass through at runtime.
//
// Frames: the sim speaks Source (z up), the BVH is in the scene frame. Both
// ends convert here and shared/sim3d/units.js owns the mapping.
// ---------------------------------------------------------------------------

import { sourceToScene } from '../../shared/sim3d/units.js';

/**
 * `THREE.DoubleSide`, as the number it is.
 *
 * three-mesh-bvh compares the side argument against the constant, so this file
 * does not need the enum. It DOES need a real `THREE.Ray` — `raycastFirst`
 * calls `ray.intersectTriangle()` on whatever it is handed, so a duck-typed
 * `{ origin, direction }` gets as far as the first leaf and throws. Hence the
 * `Ray` option below rather than an import: the trainer's renderer is `three`
 * (WebGL) and the explorer's is `three/webgpu`, and importing either here would
 * have put a second 1.2 MB three core on the other page.
 */
const DOUBLE_SIDE = 2;

/**
 * @param {object} collider  from MapPack.onPhys
 * @param {object} [movers]  an object with `rayHit(from, to)` in the SOURCE
 *   frame for geometry outside the BVH (a swinging door)
 * @param {{flash?:boolean, unitScale?:number, Ray:Function}} opts
 *   `flash: true` uses the light band and does not skip passbullets (leak
 *   FLASH_MASK). `unitScale` is the BVH's units per Source unit — 1 for the
 *   explorer's packs, UNIT_M for the aim trainer's ported maps, which are in
 *   metres because everything else in the trainer is. `Ray` is the caller's
 *   `THREE.Ray` class; see DOUBLE_SIDE for why it is passed in.
 */
export function createRayWorld(collider, movers = null, opts = {}) {
  const flash = !!opts.flash;
  const Ray = opts.Ray;
  if (typeof Ray !== 'function') {
    throw new Error('createRayWorld: pass the caller\'s THREE.Ray as opts.Ray');
  }
  const _ray = new Ray();
  const _from = _ray.origin;
  const _dir = _ray.direction;
  /**
   * Source units → the BVH's units, and back.
   *
   * The trace is asked in Source units (that is the frame penetration.js works
   * in) and answered in them, so the scale is applied on the way into the BVH
   * and undone on the way out — the ray, the far distance, the step past a
   * skipped triangle, the hit point and the reported distance. The NORMAL is a
   * direction and a uniform scale leaves it alone.
   */
  const k = opts.unitScale || 1;
  const kInv = 1 / k;
  const bvh = collider.bvh;
  const mask = collider.mask || null;
  const pass = collider.passBullets || null;
  const surfaces = collider.surfaces || [];
  const surfaceOf = collider.surfaceOf || null;
  // Everything drawn, plus the sky lid: `light` is solid + entity and `walk`
  // adds sky before the clips, so the bullet set is [0, the end of sky).
  const light = collider.ranges?.light?.[0]?.[1] ?? collider.triangles ?? 0;
  const nade = collider.ranges?.nade?.[0]?.[1] ?? light;
  const limit = flash ? light : Math.max(light, nade);
  const counts = (i) => {
    if (i >= limit) return false;
    if (mask && mask[i]) return false;
    if (!flash && pass && pass[i]) return false;
    return true;
  };

  return {
    /**
     * @param {{x,y,z}} from  Source frame
     * @param {{x,y,z}} to
     * @returns {{point,normal,distance,triangle,surface}|null}
     */
    trace(from, to) {
      const a = sourceToScene(from.x, from.y, from.z);
      const b = sourceToScene(to.x, to.y, to.z);
      _from.set(a[0] * k, a[1] * k, a[2] * k);
      const dx = (b[0] - a[0]) * k;
      const dy = (b[1] - a[1]) * k;
      const dz = (b[2] - a[2]) * k;
      const far = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(far > 0)) return null;
      _dir.set(dx / far, dy / far, dz / far);

      let best = null;
      // raycastFirst hands back the ORIGINAL triangle index under an indirect
      // BVH (measured: 8/8 on a deliberately scrambled buffer), which is what
      // makes the mask and the surface lookup below mean anything. See the
      // header of src/cs3d/hullWorld.js for why that is not free.
      const hit = bvh.raycastFirst(_ray, DOUBLE_SIDE, 0, far);
      if (hit && counts(hit.faceIndex)) {
        best = hit;
      } else if (hit) {
        // The nearest triangle is one this bullet ignores, so walk forward past
        // it and ask again. Bounded, because a chainlink fence is a handful of
        // surfaces and not a hundred.
        let t = hit.distance;
        // A 32nd of a Source unit, expressed in the BVH's units — `t` and
        // `far` are both in those. Nudging by a 32nd of a METRE instead (which
        // is what the unscaled epsilon becomes once k is 0.0254) steps over a
        // fence and lands a bullet a foot past what it hit.
        const eps = k / 32;
        // The origin walks forward and is put back at the end, because it IS
        // the ray's own vector — there is one Ray per world, not one per trace.
        const ox = _from.x;
        const oy = _from.y;
        const oz = _from.z;
        for (let i = 0; i < 16 && t < far; i++) {
          const step = t + eps;
          _from.set(ox + _dir.x * step, oy + _dir.y * step, oz + _dir.z * step);
          const next = bvh.raycastFirst(_ray, DOUBLE_SIDE, 0, far - t);
          if (!next) break;
          t += next.distance + eps;
          if (counts(next.faceIndex)) {
            next.distance = t;
            best = next;
            break;
          }
        }
        _from.set(ox, oy, oz);
      }

      const world = best
        ? {
            point: { x: best.point.x * kInv, y: -best.point.z * kInv, z: best.point.y * kInv },
            normal: best.face
              ? { x: best.face.normal.x, y: -best.face.normal.z, z: best.face.normal.y }
              : { x: 0, y: 0, z: 1 },
            distance: best.distance * kInv,
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
