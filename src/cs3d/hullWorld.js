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

import { createHullTracer } from '../../shared/sim3d/hullTrace.js';

/**
 * The query box, as a Box3 in everything but its constructor.
 *
 * three-mesh-bvh hands `intersectsBounds` a real THREE.Box3 and the test runs
 * on THAT object (`box.intersectsBox(_bounds)`), which only ever reads
 * `.min.x`, `.max.z` and their siblings off the argument. So this file needs a
 * shape, not a class — and needing a shape rather than a class is what lets the
 * aim trainer import it. The trainer's renderer is `three` (WebGL) and the
 * explorer's is `three/webgpu`; a single `new THREE.Box3()` here would have put
 * a second 1.2 MB three core on whichever page did not own this import.
 */
const _bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };

/**
 * Does the swept hull actually reach this BVH node?
 *
 * The Minkowski form of the question: grow the node by the hull's half-extents
 * and ask whether the sweep's centre segment enters it — a slab clip, six
 * compares and two divides a node.
 *
 * This replaces testing the node against the AABB of the WHOLE sweep, which is
 * only tight for a short trace. A smoke's sun ray is 6000 units on a diagonal,
 * and its bounding box swallows a third of the map: the box filter handed the
 * narrow phase 3316 triangles per trace where twelve are within reach of the
 * ray, so a cloud's ~600 sun cells cost 526 ms. Same answers either way — this
 * only rejects nodes the sweep provably cannot touch — but it rejects them at
 * the top of the tree instead of one triangle at a time.
 *
 * Conservative on purpose: a node the segment merely grazes is kept, and a
 * zero-length sweep degenerates to a plain box overlap.
 */
function segmentHitsBox(seg, box) {
  let t0 = 0;
  let t1 = 1;
  // x, then y, then z. Written out rather than looped: this is the hottest
  // function in a trace and the axes come from named fields, not an array.
  for (let axis = 0; axis < 3; axis++) {
    const c = axis === 0 ? seg.cx : axis === 1 ? seg.cy : seg.cz;
    const d = axis === 0 ? seg.dx : axis === 1 ? seg.dy : seg.dz;
    const e = axis === 0 ? seg.ex : axis === 1 ? seg.ey : seg.ez;
    const lo = (axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z) - e;
    const hi = (axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z) + e;
    if (d === 0) {
      // Parallel to this slab: either the whole sweep is inside it or none is.
      if (c < lo || c > hi) return false;
      continue;
    }
    const inv = 1 / d;
    let n = (lo - c) * inv;
    let f = (hi - c) * inv;
    if (n > f) {
      const s = n;
      n = f;
      f = s;
    }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }
  return true;
}

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

/**
 * @param {object} collider
 * @param {'walk'|'nade'|'light'} [audience]
 * @param {object} [movers]
 * @param {{ unitScale?: number }} [opts]  metres per Source unit when the BVH is
 *   in metres (the aim trainer's ported maps), 1 when it is in Source units
 *   (the explorer's packs).
 */
export function createHullWorld(collider, audience = 'walk', movers = null, opts = {}) {
  const bvh = collider.bvh;
  /**
   * The BVH's units per the sim's unit, and its reciprocal.
   *
   * shared/sim3d/hullTrace.js already converts between the sim's frame and the
   * scene's; what it cannot know is that the two might not be to the same
   * SCALE. The explorer's collision geometry is in Source units and this is 1.
   * The trainer's ported maps are in metres, because everything else in the
   * trainer is, so its hull world hands the same tracer a `k` of 0.0254 and the
   * query box goes down while the triangles come back up. Six multiplies on the
   * box, nine per triangle — cheaper than either a second collision mesh in the
   * other scale or a trainer that has to think in units.
   */
  const k = opts.unitScale || 1;
  const kInv = 1 / k;
  const scaled = k !== 1;
  const ranges = collider.ranges?.[audience] || null;
  const mask = collider.mask || null;
  // Whole-soup fast path: when the audience is everything there is, skip the
  // per-triangle range test rather than pay for a comparison that cannot fail.
  const whole =
    !ranges ||
    (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= (collider.triangles ?? Infinity));

  // Everything below is built ONCE, not per trace. These closures used to be
  // allocated inside the query — four of them, plus the shapecast descriptor
  // object — and a smoke's flood fill runs this a couple of thousand times in
  // one frame, movement several times a tick. `_visit` and `_seg` are the live
  // arguments, rebound on entry.
  let _visit = null;
  let _hitSeg = null;
  let _stop = false;

  const emit = (tri) => {
    if (_stop) return true;
    const a = tri.a;
    const b = tri.b;
    const c = tri.c;
    // A visitor that returns true has the answer already and wants no more
    // triangles (boxSolid). Anything else keeps the shapecast going.
    const hit = scaled
      ? _visit(
          a.x * kInv, a.y * kInv, a.z * kInv,
          b.x * kInv, b.y * kInv, b.z * kInv,
          c.x * kInv, c.y * kInv, c.z * kInv
        )
      : _visit(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    if (hit === true) {
      _stop = true;
      return true;
    }
    return false;
  };
  const inRange = (i) => {
    for (let r = 0; r < ranges.length; r++) {
      if (i >= ranges[r][0] && i < ranges[r][1]) return true;
    }
    return false;
  };
  const filtered = (tri, i) => {
    if (mask && mask[i]) return false;
    if (!whole && !inRange(i)) return false;
    return emit(tri);
  };
  const boundsSeg = (box) => segmentHitsBox(_hitSeg, box);
  /** The same slab clip, with the sweep brought down into the BVH's scale. */
  const _scaledSeg = { cx: 0, cy: 0, cz: 0, dx: 0, dy: 0, dz: 0, ex: 0, ey: 0, ez: 0 };
  const boundsSegScaled = (box) => segmentHitsBox(_scaledSeg, box);
  const boundsBox = (box) => box.intersectsBox(_bounds);
  const cast = {
    intersectsBounds: boundsBox,
    intersectsTriangle: whole && !mask ? emit : filtered
  };

  const tracer = createHullTracer((minX, minY, minZ, maxX, maxY, maxZ, visit, seg) => {
    _bounds.min.x = minX * k;
    _bounds.min.y = minY * k;
    _bounds.min.z = minZ * k;
    _bounds.max.x = maxX * k;
    _bounds.max.y = maxY * k;
    _bounds.max.z = maxZ * k;
    _visit = visit;
    _hitSeg = seg;
    _stop = false;
    if (seg && scaled) {
      _scaledSeg.cx = seg.cx * k;
      _scaledSeg.cy = seg.cy * k;
      _scaledSeg.cz = seg.cz * k;
      _scaledSeg.dx = seg.dx * k;
      _scaledSeg.dy = seg.dy * k;
      _scaledSeg.dz = seg.dz * k;
      _scaledSeg.ex = seg.ex * k;
      _scaledSeg.ey = seg.ey * k;
      _scaledSeg.ez = seg.ez * k;
    }
    cast.intersectsBounds = seg ? (scaled ? boundsSegScaled : boundsSeg) : boundsBox;
    bvh.shapecast(cast);
    if (movers && !_stop) movers.emit(minX, minY, minZ, maxX, maxY, maxZ, visit);
  });
  // Only a walking body climbs; a grenade is not stopped by a climb volume and
  // must not be steered by one either.
  if (audience === 'walk') {
    const probe = createLadderProbe(collider);
    if (probe) tracer.ladderAt = probe;
  }
  return tracer;
}
