// ---------------------------------------------------------------------------
// src/cs3d/hullWorld.js
// The map as shared/sim3d/motion.js sees it: `traceHull` over the pack's
// collision BVH. The tracing itself (swept hull, DIST_EPSILON, frames) is
// shared/sim3d/hullTrace.js — the one place the movement sim meets the
// renderer's BVH is this broadphase adapter.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { createHullTracer } from '../../shared/sim3d/hullTrace.js';

const _bounds = new THREE.Box3();

/**
 * @param {{ bvh: import('three-mesh-bvh').MeshBVH }} collider  from MapPack.onPhys
 * @returns {ReturnType<typeof createHullTracer>}
 */
export function createHullWorld(collider) {
  const bvh = collider.bvh;
  return createHullTracer((minX, minY, minZ, maxX, maxY, maxZ, visit) => {
    _bounds.min.set(minX, minY, minZ);
    _bounds.max.set(maxX, maxY, maxZ);
    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_bounds),
      intersectsTriangle: (tri) => {
        const a = tri.a;
        const b = tri.b;
        const c = tri.c;
        visit(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        return false;
      }
    });
  });
}
