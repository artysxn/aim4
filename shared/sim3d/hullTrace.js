// ---------------------------------------------------------------------------
// shared/sim3d/hullTrace.js
// `traceHull` for shared/sim3d/motion.js over a triangle soup: sweep the
// player's axis-aligned hull from start to end and report the first contact,
// Source style — fraction, end position pulled DIST_EPSILON short of the
// surface, contact normal, startsolid.
//
// The triangles come from a query callback so the same tracer runs over
// three-mesh-bvh in the browser (src/cs3d/hullWorld.js) and over any plain
// list or spatial index in Node — the sim never imports a renderer.
//
// Frames. The sim speaks Source (x east, y north, z up); the map packs and
// their BVH are in the scene frame (x, y up, z = −Source y). Both are
// axis-aligned to each other so a hull is a box in either; the sweep runs in
// the triangle frame and only the endpoints and the normal are converted:
//   scene = (x, z, −y)   Source = (x, −z, y)
// The contact test itself is shared/sim3d/sweptBox.js.
// ---------------------------------------------------------------------------

import { sweepBoxTriangle, createSweepHit } from './sweptBox.js';

/** Source's DIST_EPSILON: how far short of contact a trace stops. */
export const DIST_EPSILON = 1 / 32;
/**
 * A hull overlapping a triangle by more than this at the start is inside the
 * world (startsolid). Below it is float dust left by a previous pull-back and
 * is treated as touching.
 */
export const SOLID_DEPTH = 0.25;

const _hit = createSweepHit();

/**
 * @param {(minX, minY, minZ, maxX, maxY, maxZ, visit: (ax,ay,az,bx,by,bz,cx,cy,cz) => void) => void} query
 *   Calls `visit` for every triangle (scene frame) whose bounds touch the box.
 * @returns {{ traceHull(start, end, halfWide, height), traces: number, triTests: number }}
 */
export function createHullTracer(query) {
  const tracer = {
    traces: 0,
    triTests: 0,
    /**
     * @param {{x,y,z}} start   hull origin (feet, bottom centre), Source frame
     * @param {{x,y,z}} end
     * @param {number} halfWide
     * @param {number} height
     */
    traceHull(start, end, halfWide, height) {
      tracer.traces++;
      // Scene-frame box: centre at half height, half extents (hw, h/2, hw).
      const hy = height * 0.5;
      const cx = start.x;
      const cy = start.z + hy;
      const cz = -start.y;
      const dx = end.x - start.x;
      const dy = end.z - start.z;
      const dz = -(end.y - start.y);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

      let bestT = 2;
      let bnx = 0;
      let bny = 0;
      let bnz = 0;
      let solid = false;
      let solidDepth = 0;
      let snx = 0;
      let sny = 0;
      let snz = 0;

      const pad = DIST_EPSILON + 1e-3;
      query(
        Math.min(cx, cx + dx) - halfWide - pad,
        Math.min(cy, cy + dy) - hy - pad,
        Math.min(cz, cz + dz) - halfWide - pad,
        Math.max(cx, cx + dx) + halfWide + pad,
        Math.max(cy, cy + dy) + hy + pad,
        Math.max(cz, cz + dz) + halfWide + pad,
        (ax, ay, az, bx, by, bz, ccx, ccy, ccz) => {
          tracer.triTests++;
          if (!sweepBoxTriangle(cx, cy, cz, halfWide, hy, halfWide, dx, dy, dz, ax, ay, az, bx, by, bz, ccx, ccy, ccz, _hit)) return;
          if (_hit.depth > SOLID_DEPTH) {
            // Inside this triangle's volume at the start: the deepest one
            // supplies the push-out normal, and the trace reports startsolid.
            if (_hit.depth > solidDepth) {
              solidDepth = _hit.depth;
              snx = _hit.nx;
              sny = _hit.ny;
              snz = _hit.nz;
            }
            solid = true;
            return;
          }
          if (_hit.t < bestT) {
            bestT = _hit.t;
            bnx = _hit.nx;
            bny = _hit.ny;
            bnz = _hit.nz;
          }
        }
      );

      if (solid) {
        return {
          fraction: 0,
          endpos: { x: start.x, y: start.y, z: start.z },
          normal: { x: snx, y: -snz, z: sny },
          startSolid: true
        };
      }
      if (bestT > 1) {
        return { fraction: 1, endpos: { x: end.x, y: end.y, z: end.z }, normal: null, startSolid: false };
      }
      // Pull back so the hull stops DIST_EPSILON short of the surface.
      let fraction = bestT;
      if (len > 0) fraction -= DIST_EPSILON / len;
      if (fraction < 0) fraction = 0;
      return {
        fraction,
        endpos: {
          x: start.x + (end.x - start.x) * fraction,
          y: start.y + (end.y - start.y) * fraction,
          z: start.z + (end.z - start.z) * fraction
        },
        normal: { x: bnx, y: -bnz, z: bny },
        startSolid: false
      };
    }
  };
  return tracer;
}

/**
 * A tracer over a flat triangle array in the SCENE frame — for tests and for
 * headless use over small meshes. `tris` is [ax,ay,az,bx,by,bz,cx,cy,cz, ...].
 */
export function triangleSoupTracer(tris) {
  const n = Math.floor(tris.length / 9);
  // Per-triangle bounds, once.
  const lo = new Float64Array(n * 3);
  const hi = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[i * 9 + k];
      const b = tris[i * 9 + 3 + k];
      const c = tris[i * 9 + 6 + k];
      lo[i * 3 + k] = Math.min(a, b, c);
      hi[i * 3 + k] = Math.max(a, b, c);
    }
  }
  return createHullTracer((minX, minY, minZ, maxX, maxY, maxZ, visit) => {
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (hi[o] < minX || lo[o] > maxX || hi[o + 1] < minY || lo[o + 1] > maxY || hi[o + 2] < minZ || lo[o + 2] > maxZ) continue;
      const t = i * 9;
      visit(tris[t], tris[t + 1], tris[t + 2], tris[t + 3], tris[t + 4], tris[t + 5], tris[t + 6], tris[t + 7], tris[t + 8]);
    }
  });
}

/**
 * Convenience for building test worlds: an axis-aligned box in the SOURCE
 * frame (mins/maxs, z up) as 12 scene-frame triangles, both windings not
 * needed — the sweep is two-sided.
 */
export function boxTriangles(mins, maxs, out = []) {
  // Scene corners: (x, z, −y).
  const [x0, y0, z0] = mins;
  const [x1, y1, z1] = maxs;
  const P = (x, y, z) => [x, z, -y];
  const c = [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
  const quad = (a, b, cc, d) => out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  quad(0, 1, 2, 3); // bottom (z0)
  quad(4, 5, 6, 7); // top (z1)
  quad(0, 1, 5, 4); // y0 side
  quad(2, 3, 7, 6); // y1 side
  quad(1, 2, 6, 5); // x1 side
  quad(3, 0, 4, 7); // x0 side
  return out;
}
