// ---------------------------------------------------------------------------
// Target.js
// Base target: a THREE.Group container plus one or more "collider" meshes, each
// tagged with a hit-zone (body / head), point value and crit flag. Handles the
// shared lifecycle: spawn pop-in animation, death fade-out, disposal.
//
// Scenarios build concrete shapes on top of this (a single sphere for Gridshot,
// a body cylinder + head sphere for the Arena) via addCollider().
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { easeOutBack } from '../utils/MathUtils.js';
import { primeTargetGlowOpacity, setTargetGlowOpacity } from '../utils/targetGlow.js';

export class Target {
  constructor() {
    this.object = new THREE.Group();
    this.object.scale.setScalar(0.001); // grows in via spawn animation
    this.colliders = []; // THREE.Mesh[] tagged in userData

    this.age = 0; // seconds alive (used by time-limit logic)
    this.alive = true; // false once death animation completes -> removed
    this.state = 'alive'; // 'alive' | 'dying'

    this.spawnT = 0;
    this.spawnDuration = 0.12;
    this.dyingT = 0;
    this.dyingDuration = 0.18;

    this._fadeColor = new THREE.Color(0xffffff);
  }

  /**
   * Register a mesh as a hittable zone of this target.
   * @param {THREE.Mesh} mesh
   * @param {{zone?:string, points?:number, crit?:boolean}} opts
   */
  addCollider(mesh, { zone = 'body', points = 1, crit = false } = {}) {
    mesh.userData.target = this;
    mesh.userData.zone = zone;
    mesh.userData.points = points;
    mesh.userData.crit = crit;
    this.colliders.push(mesh);
    this.object.add(mesh);
    return mesh;
  }

  getColliders() {
    return this.colliders;
  }

  /** Begin the death (or expiry) fade-out. */
  startDying(fadeColor) {
    if (this.state === 'dying') return;
    this.state = 'dying';
    this.dyingT = 0;
    if (fadeColor != null) this._fadeColor.set(fadeColor);
    for (const m of this.colliders) {
      if (m.material) {
        m.material.transparent = true;
        if (m.material.emissive) m.material.emissive.copy(this._fadeColor);
        if ('emissiveIntensity' in m.material) m.material.emissiveIntensity = 0.9;
      }
      primeTargetGlowOpacity(m);
    }
  }

  update(dt) {
    this.age += dt;

    // Spawn pop-in.
    if (this.spawnT < this.spawnDuration) {
      this.spawnT += dt;
      const t = Math.min(1, this.spawnT / this.spawnDuration);
      this.object.scale.setScalar(Math.max(0.001, easeOutBack(t)));
    }

    // Death fade-out: scale up slightly + fade opacity, then mark for removal.
    if (this.state === 'dying') {
      this.dyingT += dt;
      const t = Math.min(1, this.dyingT / this.dyingDuration);
      this.object.scale.setScalar(1 + t * 0.6);
      for (const m of this.colliders) {
        if (m.material) m.material.opacity = 1 - t;
        setTargetGlowOpacity(m, 1 - t);
      }
      if (t >= 1) this.alive = false;
    }
  }

  dispose() {
    for (const m of this.colliders) {
      const group = m.userData._targetGlowGroup;
      if (group) {
        for (const child of group.children) {
          child.geometry?.dispose();
          child.material?.dispose();
        }
      }
      m.geometry?.dispose();
      m.material?.dispose();
    }
    this.colliders.length = 0;
  }
}
