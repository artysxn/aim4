// ---------------------------------------------------------------------------
// src/cs3d/hullWorld.js
// The map as shared/sim3d sees it: `traceHull` over the pack's collision BVH.
// The tracing itself (swept hull, DIST_EPSILON, frames) is
// shared/sim3d/hullTrace.js — the one place a sim meets the renderer's BVH is
// this broadphase adapter.
//
// One BVH serves several audiences. A player is stopped by `playerclip` and a
// grenade is not; a grenade is stopped by `grenadeclip` and a player is not.
// mapLoader merges the collision geometry in bands so each audience is a range
// of triangle indices (see `_loadPhys`), and this file turns a named audience
// into the per-triangle filter that enforces it.
//
// Two things can also change while the map is up:
//
//   `collider.mask`  a per-triangle kill switch. A window that has been shot
//                    out is not there any more, and neither is the static hull
//                    of a door that now swings on a mover.
//   `movers`         geometry that is not in the BVH at all because it moves:
//                    a door leaf, as an oriented box at whatever angle it has
//                    swung to this frame (src/cs3d/interactives.js).
//
// The index shapecast reports is the ORIGINAL triangle index, and only because
// the BVH is built `indirect: true`. Measured on the installed three-mesh-bvh,
// over 64 deliberately scrambled triangles:
//
//   indirect, callback index i          -> original triangle  64/64
//   indirect, resolveTriangleIndex(i)   -> original triangle  10/64
//   direct,   callback index i          -> original triangle  10/64
//
// So both the `indirect: true` and the ABSENCE of a resolveTriangleIndex call
// are load-bearing. An indirect BVH resolves the index before it hands it over;
// resolving it again walks the indirect buffer twice and lands on an unrelated
// triangle, which is a filter that passes and rejects at random. That bug
// shipped here once and the symptom was a grenade bouncing off player clips.
// The mask is indexed the same way, and gets the same guarantee for free.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { createHullTracer } from '../../shared/sim3d/hullTrace.js';

const _bounds = new THREE.Box3();

/**
 * @param {{ bvh: import('three-mesh-bvh').MeshBVH, ranges?: object, mask?: Uint8Array, triangles?: number }} collider
 *   from MapPack.onPhys
 * @param {'walk'|'nade'|'light'} [audience]  which collision set to trace against
 * @param {{ emit(minX,minY,minZ,maxX,maxY,maxZ, visit): void }} [movers]
 *   extra geometry that is not in the BVH because it moves
 * @returns {ReturnType<typeof createHullTracer>}
 */
/**
 * How far outside a climb volume a body still counts as on it.
 *
 * Source traces 2 units forward from the player to find a ladder; the volumes
 * themselves are thin plates against the wall and a standing body's hull stops
 * a hair short of them, so the reach is on this side instead.
 */
const LADDER_REACH = 4;

/**
 * `world.ladderAt` for shared/sim3d/motion.js: is this hull on a climb volume,
 * and which way does it face.
 *
 * Per FACE, not per volume: mapLoader splits the map's one ladder node into
 * its individual vertical faces precisely because the node's own bounding box
 * spans the level (see `_loadPhys`). The normal is the face's, flipped if
 * necessary so it points at the body — that is the direction jumping off
 * throws them.
 *
 * @param {object} collider
 * @returns {((pos, halfWide, height) => {normal:{x,y,z}}|null)|null}
 */
export function createLadderProbe(collider) {
  const faces = collider?.ladders;
  if (!faces?.length) return null;
  const out = { normal: { x: 0, y: 0, z: 0 } };
  return (pos, halfWide, height) => {
    const lo = [pos.x - halfWide - LADDER_REACH, pos.y - halfWide - LADDER_REACH, pos.z];
    const hi = [pos.x + halfWide + LADDER_REACH, pos.y + halfWide + LADDER_REACH, pos.z + height];
    for (const f of faces) {
      if (f.max[0] < lo[0] || f.min[0] > hi[0]) continue;
      if (f.max[1] < lo[1] || f.min[1] > hi[1]) continue;
      if (f.max[2] < lo[2] || f.min[2] > hi[2]) continue;
      // From the face's centre towards the body, so "away from the ladder" is
      // unambiguous however the triangle happens to be wound.
      const cx = (f.min[0] + f.max[0]) / 2;
      const cy = (f.min[1] + f.max[1]) / 2;
      const away = (pos.x - cx) * f.normal[0] + (pos.y - cy) * f.normal[1];
      const s = away < 0 ? -1 : 1;
      out.normal.x = f.normal[0] * s;
      out.normal.y = f.normal[1] * s;
      out.normal.z = f.normal[2] * s;
      return out;
    }
    return null;
  };
}

export function createHullWorld(collider, audience = 'walk', movers = null) {
  const bvh = collider.bvh;
  const ranges = collider.ranges?.[audience] || null;
  const mask = collider.mask || null;
  // Whole-soup fast path: when the audience is everything there is, skip the
  // per-triangle range test rather than pay for a comparison that cannot fail.
  const whole =
    !ranges ||
    (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= (collider.triangles ?? Infinity));

  const tracer = createHullTracer((minX, minY, minZ, maxX, maxY, maxZ, visit) => {
    _bounds.min.set(minX, minY, minZ);
    _bounds.max.set(maxX, maxY, maxZ);
    const emit = (tri) => {
      const a = tri.a;
      const b = tri.b;
      const c = tri.c;
      visit(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      return false;
    };
    const inRange = (i) => {
      for (let r = 0; r < ranges.length; r++) {
        if (i >= ranges[r][0] && i < ranges[r][1]) return true;
      }
      return false;
    };
    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_bounds),
      intersectsTriangle:
        whole && !mask
          ? emit
          : (tri, i) => {
              if (mask && mask[i]) return false;
              if (!whole && !inRange(i)) return false;
              return emit(tri);
            }
    });
    if (movers) movers.emit(minX, minY, minZ, maxX, maxY, maxZ, visit);
  });
  // Only a walking body climbs; a grenade is not stopped by a climb volume and
  // must not be steered by one either.
  if (audience === 'walk') {
    const probe = createLadderProbe(collider);
    if (probe) tracer.ladderAt = probe;
  }
  return tracer;
}
