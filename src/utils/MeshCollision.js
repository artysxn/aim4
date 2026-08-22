// ---------------------------------------------------------------------------
// MeshCollision.js
// The collision model for a ported CS2 map: the same two questions
// BoxCollision.js answers, asked of a triangle mesh instead of a box list.
//
//   "what am I standing on"   a ray straight down through the BVH
//   "what am I inside of"     the body cylinder against every triangle near it
//
// The movement model does NOT change. A player is still a vertical cylinder
// pushed out horizontally, still stepping up onto whatever the ground query
// finds, because the trainer's feel comes out of SourceMovement.js and this is
// only the world it runs against. Anything else here would make dust2 play
// differently from the arenas, which is not what porting a map means.
//
// Two things a box list never had to think about:
//
//   walkable slopes  a floor is a surface, so unlike a box top it is inside the
//                    body's own vertical span and would push the player
//                    sideways every frame. Surfaces flatter than Source's own
//                    walkable limit are left to the ground query instead — see
//                    WALKABLE_NY, which is that limit and not a taste.
//   nothing below    an arena has a floor plane at y=0 and a map does not. Off
//                    the edge of the world the ground query has no answer, so
//                    it returns the map's own floor and the player falls to it
//                    rather than through it forever.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { BODY_R, crouchScale, BODY_H } from '../multiplayer/constants.js';

/**
 * How far up the ground query looks from the feet.
 *
 * The same 0.5 m BoxCollision.groundHeightAt uses, and for the same reason: it
 * is the step a player takes without jumping. The ray starts here and points
 * down, so the first thing it hits is the highest surface within one step.
 */
const STEP_UP = 0.5;

/**
 * The steepest surface that counts as ground rather than as wall — cos of
 * Source's own 45.57 degree limit, the angle at which the engine stops letting
 * a player walk up a slope. Above it a surface pushes; below it, it carries.
 */
const WALKABLE_NY = 0.7;

/** Kept clear of the feet so the surface underneath never also pushes sideways. */
const SKIN = 0.05;

/**
 * How far past contact a push-out goes, and how many times it may try again.
 *
 * A box arena resolves in one pass because there are forty convex boxes and a
 * body touches one of them. A map corner is dozens of triangles from three
 * walls at once, and leaving each one exactly at the contact distance means the
 * next push can put the body back inside the last one. So: overshoot by a
 * millimetre, and re-ask until a pass finds nothing left to push out of.
 */
const PUSH_EPS = 0.001;
const RESOLVE_PASSES = 4;

const _ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _triPt = new THREE.Vector3();
const _capPt = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * A map's collision hull, ready to be pushed against.
 *
 * Duck-typed against the box list everywhere the two are interchangeable:
 * `length` is non-zero so the `colliders?.length` guards that already exist
 * keep meaning "there is a world here", and `isMeshCollider` is what the
 * dispatchers in mapCollision.js switch on.
 *
 * @param {THREE.BufferGeometry} geometry  metres, y-up, indexed
 * @param {{floorY?: number}} [opts] where the world ends underneath
 */
export class MeshCollider {
  constructor(geometry, { floorY = -Infinity } = {}) {
    this.isMeshCollider = true;
    this.geometry = geometry;
    this.bvh = geometry.boundsTree || new MeshBVH(geometry, { targetLeafSize: 8 });
    geometry.boundsTree = this.bvh;
    this.floorY = floorY;
    /** So `colliders?.length` reads as "yes, there is collision" (see above). */
    this.length = geometry.index ? geometry.index.count / 3 : 0;
  }

  /**
   * Highest surface at (x, z) the feet can reach, or the map floor.
   *
   * Downward from one step above the feet, so a kerb the player is walking into
   * is found and a ceiling is not. `raycastFirst` going down returns the
   * topmost surface below the start, which is the definition being asked for.
   */
  groundHeightAt(x, z, footY, floorY = this.floorY) {
    _ray.origin.set(x, footY + STEP_UP, z);
    _ray.direction.set(0, -1, 0);
    // DoubleSide: a collision hull is not wound for rendering and half of any
    // brush faces away. Culling here drops the floor under the player at random.
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide);
    if (!hit) return floorY;
    return footY + STEP_UP - hit.distance;
  }

  /**
   * Push a body cylinder out of the walls it is inside, horizontally.
   *
   * Mutates `pos` and `vel` exactly as resolveBoxCollisions does, so the two
   * are interchangeable to every caller.
   */
  resolve(pos, vel, footY, crouch, radius = BODY_R) {
    const bottom = footY + SKIN;
    const top = footY + BODY_H * crouchScale(crouch);
    if (top <= bottom) return;
    const r = radius;

    for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
      let pushed = false;
      // The cylinder axis, as the segment the triangle test measures against.
      _seg.start.set(pos.x, bottom, pos.z);
      _seg.end.set(pos.x, top, pos.z);
      _box.min.set(pos.x - r, bottom, pos.z - r);
      _box.max.set(pos.x + r, top, pos.z + r);

      this.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_box),
        intersectsTriangle: (tri) => {
          // Ground and ceiling are not walls. The floor the player is standing
          // on runs straight through the body's own span, and pushing away from
          // it would slide them off every slope in the map.
          tri.getNormal(_nrm);
          if (Math.abs(_nrm.y) > WALKABLE_NY) return false;

          // Closest approach between the body's axis and this triangle.
          tri.closestPointToSegment(_seg, _triPt, _capPt);
          let dx = pos.x - _triPt.x;
          let dz = pos.z - _triPt.z;
          // Only the part of the overlap that is in the body's own span
          // matters: a wall two metres above the feet is not underfoot.
          if (_triPt.y < bottom - 0.01 || _triPt.y > top + 0.01) return false;
          let d = Math.hypot(dx, dz);
          if (d >= r) return false;
          if (d < 1e-6) {
            // Dead centre on the face: there is no direction to leave by except
            // the way the wall is pointing.
            dx = _nrm.x;
            dz = _nrm.z;
            d = Math.hypot(dx, dz);
            if (d < 1e-6) return false;
          }
          const nx = dx / d;
          const nz = dz / d;
          const push = r - d + PUSH_EPS;
          pos.x += nx * push;
          pos.z += nz * push;
          pushed = true;
          // Keep the segment and the query box honest for the triangles still
          // to come, or a corner resolves against a body that has already moved
          // out from under it.
          _seg.start.x = _seg.end.x = pos.x;
          _seg.start.z = _seg.end.z = pos.z;
          _box.min.x = pos.x - r;
          _box.max.x = pos.x + r;
          _box.min.z = pos.z - r;
          _box.max.z = pos.z + r;
          const vn = vel.x * nx + vel.z * nz;
          if (vn < 0) {
            vel.x -= vn * nx;
            vel.z -= vn * nz;
          }
          return false;
        }
      });
      if (!pushed) return;
    }
  }

  /**
   * Would a body standing here be inside a wall?
   *
   * The mesh answer to "is this point in cover" — what the bots ask before they
   * pick somewhere to walk to. Same test `resolve` runs, stopped at the first
   * hit instead of pushing out of it.
   */
  blockedAt(x, y, z, radius = BODY_R) {
    const bottom = y + SKIN;
    const top = y + BODY_H;
    _seg.start.set(x, bottom, z);
    _seg.end.set(x, top, z);
    _box.min.set(x - radius, bottom, z - radius);
    _box.max.set(x + radius, top, z + radius);
    let hit = false;
    this.bvh.shapecast({
      intersectsBounds: (box) => !hit && box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        tri.getNormal(_nrm);
        if (Math.abs(_nrm.y) > WALKABLE_NY) return false;
        tri.closestPointToSegment(_seg, _triPt, _capPt);
        if (_triPt.y < bottom - 0.01 || _triPt.y > top + 0.01) return false;
        if (Math.hypot(x - _triPt.x, z - _triPt.z) >= radius) return false;
        hit = true;
        return true;
      }
    });
    return hit;
  }

  /** True when nothing blocks the segment. Endpoints are left a little slack. */
  losClear(from, to) {
    _a.set(from[0], from[1], from[2]);
    _b.set(to[0], to[1], to[2]);
    const dist = _a.distanceTo(_b);
    if (dist < 1e-4) return true;
    _ray.origin.copy(_a);
    _ray.direction.copy(_b).sub(_a).divideScalar(dist);
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, dist - 0.04);
    return !hit;
  }

  dispose() {
    this.geometry?.dispose?.();
    this.bvh = null;
  }
}
