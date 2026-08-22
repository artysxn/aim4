// ---------------------------------------------------------------------------
// quantizedGeometry.js
// Undoing the node transform a quantized glb carries, correctly.
//
// Its own module because the map loader needs it in the browser and
// MeshCollision.test.js needs it in Node, and meshMap.js cannot be imported
// there: it reaches the trainer's GLTFLoader through packBase.js, whose
// `?three-webgl` specifier only resolves under Vite. Nothing here imports
// anything but three.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/**
 * Fold a quantized mesh's node transform into its positions.
 *
 * `BufferGeometry.applyMatrix4` cannot do this and fails silently when asked:
 * quantized positions are Int16 flagged `normalized`, so the matrix is applied
 * to values it reads back as [-1, 1] and then WRITTEN BACK into the Int16
 * array, where a world coordinate of 40 clamps to 1. The whole map collapses
 * into a two-metre box at the origin and every raycast against it misses.
 *
 * So the positions are rebuilt as floats instead. Normals are left alone, and
 * may be: the transform is the one gltf-transform's quantize writes, which is a
 * uniform scale and a translation with no rotation in it — checked below rather
 * than assumed, because a silently rotated normal is a lighting bug nobody
 * would trace back to here.
 */
export function bakeNodeTransform(mesh) {
  const m = mesh.matrixWorld;
  const e = m.elements;
  const offAxis = Math.abs(e[1]) + Math.abs(e[2]) + Math.abs(e[4]) + Math.abs(e[6]) + Math.abs(e[8]) + Math.abs(e[9]);
  if (offAxis > 1e-6) throw new Error(`${mesh.name}: the map's node transform rotates; normals would need transforming too`);
  const src = mesh.geometry.getAttribute('position');
  const n = src.count;
  const P = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(src.getX(i), src.getY(i), src.getZ(i)).applyMatrix4(m);
    P[i * 3] = v.x;
    P[i * 3 + 1] = v.y;
    P[i * 3 + 2] = v.z;
  }
  mesh.geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
  mesh.position.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrixWorld(true);
}
