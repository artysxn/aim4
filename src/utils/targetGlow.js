// ---------------------------------------------------------------------------
// targetGlow.js — mark dot-target meshes for selective bloom (any target color).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BLOOM_LAYER } from './bloomLayers.js';
import { resolveTargetGlowConfig } from './targetGlowConfig.js';

const _tmp = new THREE.Color();

/** Saturated halo color used by the bloom pass. */
export function glowHaloColor(color) {
  return _tmp.set(color).getHex();
}

/** Bright emissive core (lightsaber blade) — mostly white with a hint of the target hue. */
export function glowCoreColor(color, whiteness = 0.82, out = new THREE.Color()) {
  out.set(color);
  return out.lerp(new THREE.Color(0xffffff), Math.max(0, Math.min(1, whiteness)));
}

/** True for gridshot-style dot spheres (not bot bodies / heads). */
export function isBloomTargetMesh(mesh) {
  if (!mesh?.isMesh) return false;
  if (!mesh.userData.target) return false;
  if (mesh.userData.targetGlow === false) return false;
  if (!(mesh.geometry instanceof THREE.SphereGeometry)) return false;
  if (mesh.userData.zone === 'head') return false;
  return true;
}

/** @deprecated Use isBloomTargetMesh */
export function isDotTargetMesh(mesh, targetColor) {
  return isBloomTargetMesh(mesh);
}

export function removeTargetGlow(mesh) {
  mesh.userData._glowEnabled = false;
  mesh.userData._glowStrength = 1;
  mesh.layers.disable(BLOOM_LAYER);
  restoreTargetEmissive(mesh);
  const mat = mesh.material;
  if (mat?.color && mat.userData._baseColor != null) {
    mat.color.set(mat.userData._baseColor);
  }
  if (mat) mat.toneMapped = true;
}

/**
 * Register a dot target mesh for the bloom pass (works with dark target colors).
 * @param {THREE.Mesh} mesh
 * @param {{ enabled: boolean, color: string | number }} opts
 */
export function applyTargetGlow(mesh, { enabled, color, config } = {}) {
  if (!enabled || !isBloomTargetMesh(mesh)) {
    removeTargetGlow(mesh);
    return;
  }

  const glow = resolveTargetGlowConfig(config);

  const mat = mesh.material;
  if (!mat) return;

  if (mat.userData._baseColor == null && mat.color) {
    mat.userData._baseColor = mat.color.getHex();
  }
  if (mat.userData._baseEmissiveIntensity == null && mat.emissive) {
    mat.userData._baseEmissiveIntensity = mat.emissiveIntensity ?? 0.5;
  }
  if (mat.userData._baseEmissiveColor == null && mat.emissive) {
    mat.userData._baseEmissiveColor = mat.emissive.getHex();
  }

  mesh.userData._glowEnabled = true;
  mesh.userData._glowColor = glowHaloColor(color);
  mesh.userData._glowStrength = mesh.userData._glowStrength ?? 1;
  mesh.layers.enable(BLOOM_LAYER);

  const core = glowCoreColor(color, glow.coreWhiteness);
  if (mat.color) mat.color.copy(core);
  if (mat.emissive) {
    mat.emissive.copy(core);
    mat.emissiveIntensity = glow.coreIntensity;
  }
  mat.toneMapped = false;
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
  const s = scenario.settings.activeSettings?.() ?? scenario.settings.data;
  const enabled = s.targetGlow === true;
  const color = s.colors?.target;
  const config = s.targetGlowConfig;
  if (!color) return;
  for (const t of scenario.targets || []) {
    for (const mesh of t.colliders || []) {
      applyTargetGlow(mesh, { enabled, color, config });
      if (enabled) primeTargetGlowOpacity(mesh);
    }
  }
}
