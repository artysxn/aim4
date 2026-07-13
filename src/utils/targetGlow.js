// ---------------------------------------------------------------------------
// targetGlow.js — mark dot-target meshes for selective bloom (any target color).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BLOOM_LAYER } from './bloomLayers.js';

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
  mesh.userData._glowStrength = 1;
  mesh.layers.disable(BLOOM_LAYER);
  restoreTargetEmissive(mesh);
  if (mesh.material) mesh.material.toneMapped = true;
}

/**
 * Register a dot target mesh for the bloom pass (works with dark target colors).
 * @param {THREE.Mesh} mesh
 * @param {{ enabled: boolean, color: string | number }} opts
 */
export function applyTargetGlow(mesh, { enabled, color }) {
  if (!enabled || !isDotTargetMesh(mesh, color)) {
    removeTargetGlow(mesh);
    return;
  }

  const mat = mesh.material;
  if (!mat) return;

  if (mat.userData._baseEmissiveIntensity == null && mat.emissive) {
    mat.userData._baseEmissiveIntensity = mat.emissiveIntensity ?? 0.5;
  }
  if (mat.userData._baseEmissiveColor == null && mat.emissive) {
    mat.userData._baseEmissiveColor = mat.emissive.getHex();
  }

  mesh.userData._glowEnabled = true;
  mesh.userData._glowColor = new THREE.Color(color).getHex();
  mesh.userData._glowStrength = mesh.userData._glowStrength ?? 1;
  mesh.layers.enable(BLOOM_LAYER);

  if (mat.emissive) {
    mat.emissive.set(color);
    mat.emissiveIntensity = mat.userData._baseEmissiveIntensity ?? 0.5;
  }
}

export function restoreTargetEmissive(mesh) {
  const mat = mesh.material;
  if (!mat) return;
  if (mat.userData._baseEmissiveIntensity != null) {
    mat.emissiveIntensity = mat.userData._baseEmissiveIntensity;
  }
  if (mat.userData._baseEmissiveColor != null && mat.emissive) {
    mat.emissive.set(mat.userData._baseEmissiveColor);
  }
}

/** Set glow strength multiplier (used during target death fade). */
export function setTargetGlowOpacity(mesh, alpha) {
  if (!mesh.userData._glowEnabled) return;
  mesh.userData._glowStrength = Math.max(0, Math.min(1, alpha));
}

export function primeTargetGlowOpacity(mesh) {
  if (!mesh.userData._glowEnabled) return;
  if (mesh.userData._glowStrength == null) mesh.userData._glowStrength = 1;
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
