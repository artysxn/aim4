// ---------------------------------------------------------------------------
// gunModels.js
// The blocky gun meshes (rifle / pistol / sniper) built from box primitives.
// Shared by the first-person Viewmodel and the third-person bot model, so the
// rifle a bot carries is literally the same model the player sees in hand.
// Guns are built in local space with the barrel pointing along -Z.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

function box(group, w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 })
  );
  m.position.set(x, y, z);
  group.add(m);
  return m;
}

export function makeMuzzleFlash(x, y, z) {
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 6),
    new THREE.MeshBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  flash.position.set(x, y, z);
  return flash;
}

/**
 * Build one gun model. Returns { group, flash, fwd, up, boltHandle? } where
 * fwd/up locate the muzzle tip along the local -Z barrel axis.
 */
export function buildGunModel(kind, { withFlash = true } = {}) {
  const group = new THREE.Group();
  let flash = null;
  let boltHandle = null;
  let fwd = 0.66;
  let up = 0.03;

  if (kind === 'rifle') {
    // Rifle (AK-like).
    box(group, 0.10, 0.10, 0.55, 0x202225, 0, 0, -0.18); // receiver / body
    box(group, 0.05, 0.05, 0.50, 0x303338, 0, 0.03, -0.40); // barrel
    box(group, 0.09, 0.20, 0.10, 0x2a2d31, 0, -0.16, -0.05); // magazine
    box(group, 0.07, 0.16, 0.09, 0x26282c, 0, -0.12, 0.12); // grip
    box(group, 0.06, 0.09, 0.20, 0x202225, 0, -0.02, 0.20); // stock
    fwd = 0.66;
    up = 0.03;
  } else if (kind === 'pistol') {
    // Pistol (USP-like): short slide, stubby barrel, grip + magazine, no stock.
    box(group, 0.085, 0.10, 0.34, 0x1f2123, 0, 0.02, -0.10); // slide / body
    box(group, 0.045, 0.045, 0.10, 0x303338, 0, 0.02, -0.26); // barrel nub
    box(group, 0.07, 0.18, 0.10, 0x26282c, 0, -0.13, 0.02); // grip
    box(group, 0.065, 0.05, 0.095, 0x202225, 0, -0.22, 0.02); // magazine base
    fwd = 0.34;
    up = 0.02;
  } else if (kind === 'sniper') {
    // Sniper (AWP-like): long receiver + barrel, big scope tube on top with
    // lens caps, magazine, grip and a full stock. Hidden entirely while scoped.
    box(group, 0.10, 0.11, 0.72, 0x1c3524, 0, 0, -0.16); // receiver / body
    box(group, 0.045, 0.045, 0.62, 0x24262a, 0, 0.02, -0.72); // long barrel
    box(group, 0.05, 0.03, 0.10, 0x1a1c1f, 0, 0.045, -1.00); // muzzle brake
    // Scope: main tube + objective/ocular bells + mounts.
    box(group, 0.055, 0.055, 0.34, 0x121316, 0, 0.115, -0.16); // scope tube
    box(group, 0.07, 0.07, 0.06, 0x0d0e10, 0, 0.115, -0.35); // objective bell
    box(group, 0.068, 0.068, 0.05, 0x0d0e10, 0, 0.115, 0.02); // ocular bell
    box(group, 0.03, 0.05, 0.04, 0x1a1c1f, 0, 0.07, -0.24); // front mount
    box(group, 0.03, 0.05, 0.04, 0x1a1c1f, 0, 0.07, -0.06); // rear mount
    box(group, 0.08, 0.18, 0.09, 0x23272b, 0, -0.15, -0.16); // magazine
    box(group, 0.07, 0.15, 0.09, 0x1f2830, 0, -0.12, 0.06); // grip
    box(group, 0.065, 0.11, 0.26, 0x1c3524, 0, -0.03, 0.24); // stock
    boltHandle = box(group, 0.02, 0.10, 0.05, 0x24262a, 0.065, 0.02, -0.02); // bolt handle
    boltHandle.userData.baseX = boltHandle.position.x;
    boltHandle.userData.baseZ = boltHandle.position.z;
    fwd = 1.06;
    up = 0.02;
  }

  if (withFlash) {
    flash = makeMuzzleFlash(0, up, -fwd);
    group.add(flash);
  }

  return { group, flash, fwd, up, boltHandle };
}
