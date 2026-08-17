// ---------------------------------------------------------------------------
// src/cs3d/sunlight.js
// Does the sun reach this point, and how hard.
//
// The world already knows: lightmapped geometry carries the baked shadow mask
// and props stand under a real DirectionalLight with a shadow map. The two
// things that did not were the viewmodel — its own pass, its own scene, lit by
// a key light bolted to the camera that never moved when the player turned —
// and anything that needed to know whether the player is standing in the sun.
//
// This answers that with one ray against the collision BVH the movement sim
// already uses. Indoors the sun is not switched off but turned down (INDOOR):
// a gun that goes black the moment you step into a doorway reads as a bug, and
// CS2's own interiors are lit by a lot of bounced daylight. The number is a
// deliberate cheat, not a measurement.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';

/** The share of the sun a point in shadow still gets. */
export const INDOOR = 0.2;
/** Seconds the shade blend takes. A doorway should fade, not switch. */
export const EASE = 0.15;
/** Seconds between rays. The answer changes at walking pace, not at 200 fps. */
export const PROBE = 0.05;
/** How far up the ray to look. Longer than any map is wide. */
export const REACH = 20000;

const _origin = new THREE.Vector3();

export class SunTracker {
  /** @param {THREE.Vector3} toSun  unit vector toward the sun, world space */
  constructor(toSun) {
    this.toSun = toSun ? toSun.clone() : new THREE.Vector3(0, 1, 0);
    this.collider = null;
    /** Smoothed 0..1: how much sun reaches the tracked point. */
    this.factor = 1;
    this._target = 1;
    this._acc = PROBE;
    this._ray = new THREE.Ray();
  }

  setCollider(collider) {
    this.collider = collider || null;
  }

  setSun(toSun) {
    if (toSun) this.toSun.copy(toSun).normalize();
  }

  /**
   * Is this point in direct sun?
   *
   * Against the collision hull, but only the part of it that stops light.
   * mapLoader merges the light blockers first, so a hit on a triangle below
   * `lightTriangles` is real geometry and anything above it is a tool brush —
   * the `sky` lid over the whole map and the `playerclip` fences, neither of
   * which the game shadows with either. Tracing the whole hull instead reported
   * shade everywhere you can actually stand, and full sun only once the camera
   * climbed above the clip.
   *
   * Every hit, not the nearest: the nearest is usually one of those tool
   * brushes, and the question is whether ANY blocker is in the way.
   *
   * The ray starts a little way along its own direction so a point resting on
   * the floor does not hit the floor it is resting on.
   */
  lit(point) {
    const bvh = this.collider?.bvh;
    if (!bvh) return true;
    const limit = this.collider.lightTriangles;
    _origin.copy(point).addScaledVector(this.toSun, 1);
    this._ray.origin.copy(_origin);
    this._ray.direction.copy(this.toSun);
    this._ray.far = REACH;
    if (!Number.isFinite(limit)) return !bvh.raycastFirst(this._ray, THREE.DoubleSide);
    const hits = bvh.raycast(this._ray, THREE.DoubleSide, 0, REACH);
    for (const h of hits) if (h.faceIndex < limit) return false;
    return true;
  }

  /**
   * Advance the blend, re-testing at most every PROBE seconds.
   * @returns {number} the smoothed 0..1 factor
   */
  update(dt, point) {
    this._acc += dt;
    if (point && this._acc >= PROBE) {
      this._acc = 0;
      this._target = this.lit(point) ? 1 : INDOOR;
    }
    this.factor += (this._target - this.factor) * (1 - Math.exp(-Math.max(0, dt) / EASE));
    return this.factor;
  }
}
