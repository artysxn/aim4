// ---------------------------------------------------------------------------
// src/cs3d/blood.js
// The `csblood` tempent: FX_CS_BloodSpray in game/client/cstrike15/fx_cs_blood.cpp.
//
// The game dispatches a named particle system (blood_impact_heavy / medium /
// light / light_headshot) at the hit, aimed along −shotDir so the spray comes
// back out of the entry wound. We do not pack those .vpcf files, so this is
// the same ramps that file already documents as the fallback CPU spray:
// droplets along the normal, a couple of rising mist puffs, gravity 800.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { sourceToScene } from '../../shared/sim3d/units.js';
import { GRAVITY } from '../../shared/sim3d/constants.js';
import { bloodEffectName } from '../../shared/sim3d/flinch.js';

const MAX = 256;

const COUNT = {
  blood_impact_heavy: { spray: 16, mist: 4, speed: 55 },
  blood_impact_medium: { spray: 10, mist: 3, speed: 35 },
  blood_impact_light: { spray: 6, mist: 2, speed: 18 },
  blood_impact_light_headshot: { spray: 3, mist: 1, speed: 8 }
};

export class BloodSpray {
  constructor({ camera } = {}) {
    this.camera = camera || null;
    this.root = new THREE.Group();
    this.root.name = 'blood';
    this.list = [];
    this._dummy = new THREE.Object3D();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._mesh = null;
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  _ensure() {
    if (this._mesh) return this._mesh;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicNodeMaterial({
      color: 0x960000,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Per-instance colour: red spray vs darker mist.
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    mesh.instanceColor = colors;
    this._geo = geo;
    this._mat = mat;
    this._mesh = mesh;
    this.root.add(mesh);
    return mesh;
  }

  /**
   * One hit. `point` and `dir` are Source-frame; `dir` is the bullet's own
   * (TraceAttack then sprays along −dir).
   */
  spawn({ point, dir, magnitude = 10, damage = magnitude }) {
    if (!(magnitude > 0) || !point) return;
    const effect = bloodEffectName(magnitude);
    const spec = COUNT[effect] || COUNT.blood_impact_light;
    const [ox, oy, oz] = sourceToScene(point.x, point.y, point.z);
    // m_vNormal = vecDir * −1; offset = origin + normal.
    const dx = Number(dir?.x) || 0;
    const dy = Number(dir?.y) || 0;
    const dz = Number(dir?.z) || 1;
    const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
    const nx = -dx * inv;
    const ny = -dy * inv;
    const nz = -dz * inv;
    const [sx, sy, sz] = sourceToScene(nx, ny, nz);
    const nlen = Math.hypot(sx, sy, sz) || 1;
    const vx = sx / nlen;
    const vy = sy / nlen;
    const vz = sz / nlen;
    const origin = { x: ox + vx, y: oy + vy, z: oz + vz };
    const mag = Math.max(1, Number(damage) || magnitude);
    const t = Math.max(0, Math.min(1, mag / 50));
    const speed0 = spec.speed * (0.5 + t);
    for (let i = 0; i < spec.spray; i++) {
      if (this.list.length >= MAX) this.list.shift();
      const spread = 0.22;
      const wx = vx + (Math.random() * 2 - 1) * spread;
      const wy = vy + (Math.random() * 2 - 1) * spread;
      const wz = vz + (Math.random() * 2 - 1) * spread;
      const slen = Math.hypot(wx, wy, wz) || 1;
      const spd = speed0 * (0.55 + Math.random() * 0.7);
      this.list.push({
        x: origin.x,
        y: origin.y,
        z: origin.z,
        vx: (wx / slen) * spd,
        vy: (wy / slen) * spd,
        vz: (wz / slen) * spd,
        life: 0.35 + Math.random() * 0.35,
        age: 0,
        size: 1.4 + Math.random() * 1.8,
        grav: GRAVITY,
        r: 0.55 + Math.random() * 0.2,
        g: 0,
        b: 0.02
      });
    }
    for (let i = 0; i < spec.mist; i++) {
      if (this.list.length >= MAX) this.list.shift();
      this.list.push({
        x: origin.x + (Math.random() * 2 - 1) * 2,
        y: origin.y + (Math.random() * 2 - 1) * 2,
        z: origin.z + (Math.random() * 2 - 1) * 2,
        vx: (Math.random() * 2 - 1) * 4,
        vy: 6 + Math.random() * 4,
        vz: (Math.random() * 2 - 1) * 4,
        life: 1.6 + Math.random() * 1.2,
        age: 0,
        size: 4 + Math.random() * 5,
        grav: GRAVITY * 0.08,
        r: 0.28,
        g: 0.02,
        b: 0.02
      });
    }
  }

  update(dt, camera) {
    if (camera) this.camera = camera;
    const cam = this.camera;
    if (!this.list.length) {
      if (this._mesh) this._mesh.count = 0;
      return;
    }
    const mesh = this._ensure();
    const dummy = this._dummy;
    let n = 0;
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy -= p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const fade = 1 - p.age / p.life;
      const size = p.size * (0.55 + fade * 0.7);
      dummy.position.set(p.x, p.y, p.z);
      if (cam) dummy.quaternion.copy(cam.quaternion);
      dummy.scale.set(size, size, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      mesh.setColorAt(n, _c.setRGB(p.r * fade, p.g * fade, p.b * fade));
      this.list[n] = p;
      n++;
    }
    this.list.length = n;
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.list.length = 0;
    if (this._mesh) this._mesh.count = 0;
  }

  dispose() {
    this.clear();
    this._mesh?.removeFromParent();
    this._geo?.dispose();
    this._mat?.dispose();
    this._mesh = null;
  }
}

const _c = new THREE.Color();
