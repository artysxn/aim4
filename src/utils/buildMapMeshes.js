// ---------------------------------------------------------------------------
// buildMapMeshes.js — turn map JSON (boxes + extruded vertices) into THREE meshes.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { createCoverGridMaterial, applyCoverGridRepeat } from './ColorUtils.js';
import { markBulletDecalSurface } from './bulletImpact.js';

/** Axis-aligned box collider from a vertex footprint (for player movement). */
export function vertexColliderBox(v) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of v.footprint) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const w = maxX - minX;
  const h = v.topY - v.bottomY;
  const d = maxZ - minZ;
  return {
    pos: [minX + w / 2, v.bottomY + h / 2, minZ + d / 2],
    size: [w, h, d]
  };
}

function buildVertexMesh(v, material) {
  const shape = new THREE.Shape();
  const fp = v.footprint;
  shape.moveTo(fp[0][0], fp[0][1]);
  for (let i = 1; i < fp.length; i++) shape.lineTo(fp[i][0], fp[i][1]);
  shape.closePath();

  const height = v.topY - v.bottomY;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, v.bottomY, 0);

  const mesh = new THREE.Mesh(geo, material);
  markBulletDecalSurface(mesh);
  return mesh;
}

/**
 * @param {object} map — { boxes, vertices, bounds }
 * @param {{ coverColor, floorColor, root, onMesh? }} opts
 * @returns {{ coverMeshes: THREE.Mesh[], colliderBoxes: object[] }}
 */
export function buildMapMeshes(map, { coverColor, floorColor, root, onMesh }) {
  const coverMeshes = [];
  const colliderBoxes = [];
  const boxMat = createCoverGridMaterial(coverColor, floorColor);

  for (const b of map.boxes || []) {
    const mat = boxMat.clone();
    mat.map = mat.map.clone();
    applyCoverGridRepeat(mat, b.size[0], b.size[1]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]), mat);
    mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
    if (b.rotationY) mesh.rotation.y = b.rotationY;
    markBulletDecalSurface(mesh);
    root.add(mesh);
    onMesh?.(mesh);
    coverMeshes.push(mesh);
    colliderBoxes.push({ pos: b.pos, size: b.size, rotationY: b.rotationY || 0 });
  }

  for (const v of map.vertices || []) {
    const mat = boxMat.clone();
    mat.map = mat.map.clone();
    const mesh = buildVertexMesh(v, mat);
    root.add(mesh);
    onMesh?.(mesh);
    coverMeshes.push(mesh);
    colliderBoxes.push(vertexColliderBox(v));
  }

  return { coverMeshes, colliderBoxes };
}
