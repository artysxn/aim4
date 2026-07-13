// ---------------------------------------------------------------------------
// targetGlow.js — soft additive halo around dot targets (settings.colors.target).
// Uses layered additive shells instead of full-scene bloom for a lightweight glow.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const GLOW_SHELLS = [
  { scale: 1.38, opacity: 0.42 },
  { scale: 1.92, opacity: 0.2 },
  { scale: 2.55, opacity: 0.085 }
];

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
  const group = mesh.userData._targetGlowGroup;
  if (!group) return;
  mesh.remove(group);
  for (const child of group.children) {
    child.geometry?.dispose();
    child.material?.dispose();
  }
  delete mesh.userData._targetGlowGroup;
}

/**
 * Attach or remove a soft colored halo on a dot target mesh.
 * @param {THREE.Mesh} mesh
 * @param {{ enabled: boolean, color: string | number }} opts
 */
export function applyTargetGlow(mesh, { enabled, color }) {
  removeTargetGlow(mesh);
  if (!enabled || !isDotTargetMesh(mesh, color)) return;

  const radius = mesh.geometry.parameters.radius;
  const group = new THREE.Group();
  group.name = 'targetGlow';

  for (const shell of GLOW_SHELLS) {
    const geo = new THREE.SphereGeometry(radius * shell.scale, 22, 16);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: shell.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const halo = new THREE.Mesh(geo, mat);
    halo.renderOrder = (mesh.renderOrder || 0) - 1;
    group.add(halo);
  }

  mesh.add(group);
  mesh.userData._targetGlowGroup = group;

  if (mesh.material?.emissive) {
    if (mesh.userData._baseEmissiveIntensity == null) {
      mesh.userData._baseEmissiveIntensity = mesh.material.emissiveIntensity ?? 0.5;
    }
    mesh.material.emissive.set(color);
    mesh.material.emissiveIntensity = Math.max(mesh.userData._baseEmissiveIntensity, 0.85);
  }
}

export function restoreTargetEmissive(mesh) {
  if (mesh.material && mesh.userData._baseEmissiveIntensity != null) {
    mesh.material.emissiveIntensity = mesh.userData._baseEmissiveIntensity;
  }
}

/** Set halo opacity multiplier (used during target death fade). */
export function setTargetGlowOpacity(mesh, alpha) {
  const group = mesh.userData._targetGlowGroup;
  if (!group) return;
  const a = Math.max(0, Math.min(1, alpha));
  for (const child of group.children) {
    const base = child.userData._glowBaseOpacity;
    if (base != null && child.material) child.material.opacity = base * a;
  }
}

export function primeTargetGlowOpacity(mesh) {
  const group = mesh.userData._targetGlowGroup;
  if (!group) return;
  for (const child of group.children) {
    if (child.material && child.userData._glowBaseOpacity == null) {
      child.userData._glowBaseOpacity = child.material.opacity;
    }
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
