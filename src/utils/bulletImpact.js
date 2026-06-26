// Shared helpers for bullet impact FX (sparks + wall decals).
import * as THREE from 'three';

const _normalMat = new THREE.Matrix3();

/** Mark a mesh as a static surface that should receive bullet-hole decals. */
export function markBulletDecalSurface(mesh) {
  mesh.userData.bulletDecal = true;
  return mesh;
}

export function isBulletDecalSurface(object) {
  return object?.userData?.bulletDecal === true;
}

/** World-space face normal from a THREE.Intersection. */
export function worldImpactNormal(hit, out = new THREE.Vector3()) {
  if (!hit?.face) {
    out.set(0, 1, 0);
    return out;
  }
  out.copy(hit.face.normal);
  _normalMat.getNormalMatrix(hit.object.matrixWorld);
  return out.applyMatrix3(_normalMat).normalize();
}
