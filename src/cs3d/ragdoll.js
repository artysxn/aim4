// ---------------------------------------------------------------------------
// src/cs3d/ragdoll.js
// Client ragdoll for a PlayerBody, the same job C_CSRagdoll::CreateCSRagdoll
// does in game/client/cstrike15/c_cs_player.cpp: freeze the live pose, then
// let the skeleton fall under gravity with the bullet force on the hit bone.
//
// We do not have VPhysics. The approximation is Verlet particles on the
// bones, distance-constrained to their parents, colliding with a ground
// plane at the body's feet. Gravity is sv_gravity (800). The impulse is
// TraceAttack's phys_playerscale / phys_headshotscale force.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { GRAVITY } from '../../shared/sim3d/constants.js';
import { ragdollImpulse } from '../../shared/sim3d/flinch.js';

const _rest = new THREE.Vector3();
const _now = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();

const SOLVER_ITERS = 8;
const DAMPING = 0.97;
const IMPULSE_SCALE = 0.22;

function massOf(name) {
  const n = String(name || '');
  if (n === 'pelvis' || n.includes('hip')) return 14;
  if (n.startsWith('spine')) return 9;
  if (n.startsWith('head')) return 4;
  if (n.includes('neck')) return 3;
  if (n.includes('thigh') || n.includes('leg_upper') || n.includes('upleg')) return 7;
  if (n.includes('calf') || n.includes('leg_lower') || n.includes('knee')) return 4;
  if (n.includes('foot') || n.includes('ankle')) return 2;
  if (n.includes('upperarm') || n.includes('arm_upper') || n.includes('clavicle')) return 3.5;
  if (n.includes('forearm') || n.includes('arm_lower') || n.includes('elbow')) return 2.5;
  if (n.includes('hand') || n.includes('wrist')) return 1.2;
  if (n.includes('finger') || n.includes('toe')) return 0.4;
  return 2;
}

function collectBones(root) {
  const bones = [];
  root.traverse((o) => {
    if (o.isBone) bones.push(o);
  });
  return bones;
}

/**
 * @param {import('three').Object3D} root  the skinned model (PlayerBody.model)
 * @param {object} o
 * @param {number} o.groundY  scene Y of the floor under the feet
 * @param {{x,y,z}} [o.force]  scene-frame impulse
 * @param {{x,y,z}} [o.hitPos]  scene-frame hit, to pick the force bone
 */
export function createBoneRagdoll(root, { groundY, force = null, hitPos = null } = {}) {
  const bones = collectBones(root);
  if (bones.length < 4) return null;
  const bind = bones.map((b) => ({
    bone: b,
    pos: b.position.clone(),
    quat: b.quaternion.clone()
  }));

  const particles = [];
  const indexOf = new Map();
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    b.updateWorldMatrix(true, false);
    const e = b.matrixWorld.elements;
    const x = e[12];
    const y = e[13];
    const z = e[14];
    indexOf.set(b, i);
    particles.push({
      bone: b,
      x,
      y,
      z,
      px: x,
      py: y,
      pz: z,
      mass: massOf(b.name),
      pinned: false
    });
  }

  const constraints = [];
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    const p = b.parent;
    if (!p || !indexOf.has(p)) continue;
    const a = indexOf.get(p);
    const pa = particles[a];
    const pb = particles[i];
    const rest = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
    if (rest < 0.4) continue;
    constraints.push({ a, b: i, rest });
  }
  if (!constraints.length) return null;

  const floor = Number.isFinite(groundY) ? groundY : particles[0].y - 4;
  if (force && (force.x || force.y || force.z)) {
    let best = 0;
    let bestD = Infinity;
    if (hitPos) {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const d = (p.x - hitPos.x) ** 2 + (p.y - hitPos.y) ** 2 + (p.z - hitPos.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    } else {
      // Head-ish default, same as a force bone of 0 in the leak falling through.
      const hi = particles.findIndex((p) => String(p.bone.name).startsWith('head'));
      if (hi >= 0) best = hi;
    }
    const p = particles[best];
    const inv = IMPULSE_SCALE / Math.max(0.4, p.mass);
    p.px -= force.x * inv;
    p.py -= force.y * inv;
    p.pz -= force.z * inv;
  }

  let alive = true;

  function solve() {
    for (let n = 0; n < SOLVER_ITERS; n++) {
      for (const c of constraints) {
        const pa = particles[c.a];
        const pb = particles[c.b];
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dz = pb.z - pa.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 1e-5) continue;
        const diff = (dist - c.rest) / dist;
        const w = pa.mass + pb.mass;
        const sa = (pb.mass / w) * diff;
        const sb = (pa.mass / w) * diff;
        pa.x += dx * sa;
        pa.y += dy * sa;
        pa.z += dz * sa;
        pb.x -= dx * sb;
        pb.y -= dy * sb;
        pb.z -= dz * sb;
      }
      for (const p of particles) {
        if (p.y < floor) {
          p.y = floor;
          p.py = p.y;
          p.px = p.x + (p.px - p.x) * 0.4;
          p.pz = p.z + (p.pz - p.z) * 0.4;
        }
      }
    }
  }

  function write() {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const b = p.bone;
      const parent = b.parent;
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      _now.set(p.x, p.y, p.z);
      _inv.copy(parent.matrixWorld).invert();
      _now.applyMatrix4(_inv);
      b.position.copy(_now);
      _rest.copy(bind[i].pos);
      _now.copy(b.position);
      if (_rest.lengthSq() > 1e-6 && _now.lengthSq() > 1e-6) {
        _rest.normalize();
        _now.normalize();
        _q.setFromUnitVectors(_rest, _now);
        b.quaternion.copy(bind[i].quat).premultiply(_q);
      } else {
        b.quaternion.copy(bind[i].quat);
      }
    }
  }

  return {
    get active() {
      return alive;
    },
    step(dt) {
      if (!alive) return;
      const h = Math.min(0.05, Math.max(0, dt));
      if (!(h > 0)) {
        write();
        return;
      }
      const g = GRAVITY * h * h;
      for (const p of particles) {
        const vx = (p.x - p.px) * DAMPING;
        const vy = (p.y - p.py) * DAMPING;
        const vz = (p.z - p.pz) * DAMPING;
        p.px = p.x;
        p.py = p.y;
        p.pz = p.z;
        p.x += vx;
        p.y += vy - g;
        p.z += vz;
      }
      solve();
      write();
    },
    restore() {
      for (const b of bind) {
        b.bone.position.copy(b.pos);
        b.bone.quaternion.copy(b.quat);
      }
      alive = false;
    }
  };
}

export { ragdollImpulse };
