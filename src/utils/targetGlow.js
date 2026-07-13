// ---------------------------------------------------------------------------
// targetGlow.js — emissive boost on dot targets; bloom is applied in-camera.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const GLOW_EMISSIVE = 3.4;

const _colorA = new THREE.Color();
const _colorB = new THREE.Color();

/** True for gridshot-style dot spheres (not bot heads / decoys / special markers). */
export function isDotTargetMesh(mesh, targetColor) {
  if (!(mesh.geometry instanceof THREE.SphereGeometry)) return false;
  if (mesh.userData.zone === 'head') return false;
  if (mesh.userData.targetGlow === false) return false;
  const mat = mesh.material;
  if (!mat?.color) return false;
  _colorA.copy(mat.color);
  _colorB.set(targetColor);
  return _colorA.equals(_colorB);
}

export function removeTargetGlow(mesh) {
  mesh.userData._glowEnabled = false;
  restoreTargetEmissive(mesh);
  if (mesh.material) mesh.material.toneMapped = true;
}

/**
 * Boost emissive on a dot target mesh so the bloom pass picks it up.
 * @param {THREE.Mesh} mesh
 * @param {{ enabled: boolean, color: string | number }} opts
 */
export function applyTargetGlow(mesh, { enabled, color }) {
  if (!enabled || !isDotTargetMesh(mesh, color)) {
    removeTargetGlow(mesh);
    return;
  }

  const mat = mesh.material;
  if (!mat?.emissive) return;

  if (mat.userData._baseEmissiveIntensity == null) {
    mat.userData._baseEmissiveIntensity = mat.emissiveIntensity ?? 0.5;
  }
  if (mat.userData._baseEmissiveColor == null) {
    mat.userData._baseEmissiveColor = mat.emissive.getHex();
  }

  mesh.userData._glowEnabled = true;
  mesh.userData._glowEmissiveIntensity = GLOW_EMISSIVE;
  mat.toneMapped = false;
  mat.emissive.set(color);
  mat.emissiveIntensity = GLOW_EMISSIVE;
}

export function restoreTargetEmissive(mesh) {
  const mat = mesh.material;
  if (!mat) return;
  if (mat.userData._baseEmissiveIntensity != null) {
    mat.emissiveIntensity = mat.userData._baseEmissiveIntensity;
  }
  if (mat.userData._baseEmissiveColor != null) {
    mat.emissive.set(mat.userData._baseEmissiveColor);
  }
}

/** Set glow strength multiplier (used during target death fade). */
export function setTargetGlowOpacity(mesh, alpha) {
  if (!mesh.userData._glowEnabled || !mesh.material) return;
  const base = mesh.userData._glowEmissiveIntensity ?? GLOW_EMISSIVE;
  const a = Math.max(0, Math.min(1, alpha));
  mesh.material.emissiveIntensity = base * a;
}

export function primeTargetGlowOpacity(mesh) {
  if (!mesh.userData._glowEnabled || !mesh.material) return;
  if (mesh.userData._glowEmissiveIntensity == null) {
    mesh.userData._glowEmissiveIntensity = mesh.material.emissiveIntensity;
  }
}

export function refreshScenarioTargetGlow(scenario) {
  const enabled = scenario.settings.data.targetGlow === true;
  const color = scenario.settings.data.colors?.target;
  if (!color) return;
  for (const t of scenario.targets || []) {
    for (const mesh of t.colliders || []) {
      applyTargetGlow(mesh, { enabled, color });
      if (enabled) primeTargetGlowOpacity(mesh);
    }
  }
}
