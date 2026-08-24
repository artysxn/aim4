// Run: node src/maps/sliceGeometry.test.js
//
// The render slab (src/maps/meshMap.js `sliceGeometryX`), which the Doors
// gamemode uses to throw away the 70% of dust2 it can never see.
//
// Worth a test because the failure mode is not "it looks wrong", it is a HOLE
// IN THE FLOOR the player falls through — and only for one triangle, in one
// spot, on one map. The three things that have to hold:
//
//   nothing outside the slab survives,
//   everything that REACHES INTO it does, including a triangle whose every
//     vertex is outside (a ground quad spanning the whole slab is the case
//     that a naive per-vertex test drops),
//   and the surviving triangles still address the right vertices after the
//     buffer has been compacted around them.

import assert from 'node:assert';
import * as THREE from 'three';
import { sliceGeometryX } from './meshMap.js';

let failures = 0;
function check(ok, msg) {
  if (ok) {
    console.log('  ok:', msg);
    return;
  }
  failures++;
  console.error('  FAIL:', msg);
}

/** An indexed geometry from a flat list of triangles, each [ax,ay,az, bx..cz]. */
function geometryOf(tris) {
  const P = new Float32Array(tris.length * 9);
  const I = new Uint32Array(tris.length * 3);
  const C = new Uint16Array(tris.length * 9);
  tris.forEach((t, i) => {
    for (let k = 0; k < 9; k++) {
      P[i * 9 + k] = t[k];
      // A per-vertex marker that has to travel with its vertex: the triangle's
      // own index, so a mis-compacted buffer is visible rather than plausible.
      C[i * 9 + k] = i;
    }
    I[i * 3] = i * 3;
    I[i * 3 + 1] = i * 3 + 1;
    I[i * 3 + 2] = i * 3 + 2;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.BufferAttribute(C, 3, true));
  g.setIndex(new THREE.BufferAttribute(I, 1));
  return g;
}

/** Every triangle of a sliced geometry, as [minX, maxX] of its vertices. */
function trianglesOf(g) {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const out = [];
  for (let t = 0; t < idx.count / 3; t++) {
    const xs = [0, 1, 2].map((k) => pos.getX(idx.getX(t * 3 + k)));
    out.push([Math.min(...xs), Math.max(...xs)]);
  }
  return out;
}

// A slab of 0..10, and one triangle of each interesting kind.
const INSIDE = [1, 0, 0, 2, 0, 0, 1.5, 1, 0];
const OVER = [20, 0, 0, 21, 0, 0, 20.5, 1, 0];
const UNDER = [-20, 0, 0, -19, 0, 0, -19.5, 1, 0];
const STRADDLE_HI = [8, 0, 0, 14, 0, 0, 9, 1, 0];
const STRADDLE_LO = [-4, 0, 0, 3, 0, 0, -2, 1, 0];
/** Every vertex outside, yet it crosses the whole slab — the floor quad. */
const SPANNING = [-50, 0, 0, 50, 0, 0, 0, 1, -60];

console.log('what survives the slab');
{
  const src = geometryOf([INSIDE, OVER, UNDER, STRADDLE_HI, STRADDLE_LO, SPANNING]);
  const { geometry, kept, total } = sliceGeometryX(src, 0, 10);
  const tris = trianglesOf(geometry);
  check(total === 6, `counted every triangle in (${total})`);
  check(kept === 4, `kept the four that reach the slab, dropped two (kept ${kept})`);
  check(
    !tris.some(([lo]) => lo === 20) && !tris.some(([, hi]) => hi === -19),
    'a triangle wholly past either end is gone'
  );
  check(tris.some(([lo, hi]) => lo === 1 && hi === 2), 'a triangle wholly inside survives');
  check(tris.some(([lo, hi]) => lo === 8 && hi === 14), 'one straddling the high end survives whole');
  check(tris.some(([lo, hi]) => lo === -4 && hi === 3), 'one straddling the low end survives whole');
  check(
    tris.some(([lo, hi]) => lo === -50 && hi === 50),
    'a triangle that SPANS the slab with no vertex inside survives (no hole in the floor)'
  );
}

console.log('the buffer after compaction');
{
  const src = geometryOf([OVER, INSIDE, UNDER, STRADDLE_HI]);
  const { geometry } = sliceGeometryX(src, 0, 10);
  const pos = geometry.getAttribute('position');
  const col = geometry.getAttribute('color');
  const idx = geometry.getIndex();
  check(pos.count === 6, `only the surviving triangles' vertices are kept (${pos.count})`);
  check(col.normalized === true, 'a normalized attribute stays normalized');
  check(col.array instanceof Uint16Array, 'and keeps its array type');
  // Every vertex still carries the marker of the triangle it came from, and
  // the two survivors are source triangles 1 (INSIDE) and 3 (STRADDLE_HI).
  // Read from the raw array, not `getX`: the attribute is normalized, so the
  // accessor divides by 65535 and a marker of 3 comes back as 4.6e-5.
  const markers = new Set();
  for (let i = 0; i < idx.count; i++) markers.add(col.array[idx.getX(i) * col.itemSize]);
  check(
    markers.size === 2 && markers.has(1) && markers.has(3),
    `each surviving vertex still belongs to its own triangle (${[...markers].join(',')})`
  );
  let inRange = true;
  for (let i = 0; i < idx.count; i++) if (idx.getX(i) >= pos.count) inRange = false;
  check(inRange, 'no index points past the end of the compacted buffer');
  check(!!geometry.boundsTree, 'the slice gets its own BVH, so raycasts hit the right triangles');
}

console.log('interleaved attributes (what a meshopt glb actually hands over)');
{
  // dust2's normals and greys arrive INTERLEAVED with a stride of 4 against an
  // itemSize of 3, while position is a plain array by then. Indexing the
  // packed buffer by itemSize walks a slot further in with every vertex and
  // reads a sliding mixture of neighbouring vertices — which threw nothing,
  // kept the map's shape (position is unaffected), and scrambled every normal
  // into a glossy metallic sheen across flat concrete.
  const tris = [INSIDE, OVER, STRADDLE_HI];
  const g = geometryOf(tris);
  // Rebuild `normal` as an interleaved, padded attribute: unit +Y everywhere,
  // with a marker in the spare slot that must never be read as a normal.
  const packed = new Int8Array(tris.length * 3 * 4);
  for (let v = 0; v < tris.length * 3; v++) {
    packed[v * 4] = 0;
    packed[v * 4 + 1] = 127; // +Y
    packed[v * 4 + 2] = 0;
    packed[v * 4 + 3] = -128; // padding; reading this as a normal is the bug
  }
  const buf = new THREE.InterleavedBuffer(packed, 4);
  g.setAttribute('normal', new THREE.InterleavedBufferAttribute(buf, 3, 0, true));

  const { geometry } = sliceGeometryX(g, 0, 10);
  const n = geometry.getAttribute('normal');
  check(!n.isInterleavedBufferAttribute, 'the slice writes a plain attribute');
  let unit = true;
  let padLeaked = false;
  for (let i = 0; i < n.count; i++) {
    const L = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
    if (Math.abs(L - 1) > 0.02) unit = false;
    // -128/127 is the padding slot; it can only appear if the stride was ignored.
    if (n.getX(i) < -0.9 || n.getZ(i) < -0.9) padLeaked = true;
  }
  check(unit, 'every copied normal is still unit length');
  check(!padLeaked, 'the padding slot never gets read as a normal component');
  check(
    n.getY(0) > 0.99 && n.getY(n.count - 1) > 0.99,
    'the first and last vertex still point the way they did'
  );
}

console.log('degenerate slabs');
{
  const src = geometryOf([INSIDE, OVER]);
  const none = sliceGeometryX(src, 100, 200);
  check(none.kept === 0, 'a slab with nothing in it keeps nothing');
  check(none.geometry.getIndex().count === 0, 'and produces an empty index rather than throwing');
  const all = sliceGeometryX(src, -1000, 1000);
  check(all.kept === 2, 'a slab containing everything keeps everything');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
