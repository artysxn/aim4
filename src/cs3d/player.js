// ---------------------------------------------------------------------------
// src/cs3d/player.js
// The explorer's body: a noclip fly camera and a walking body that runs the
// Source ground/air movement model (the same numbers SourceMovement.js uses,
// here in native units at a fixed 64 Hz) against the map's collision BVH.
//
// The walking body is a capsule (radius 16, height 72 / 54 crouched) that
// collides-and-slides against the phys mesh. That is deliberately the cheap
// version of the plan's controller: the swept-AABB hull with the 18-unit step
// and the parity harness is CS3D-PLAN 3D-2; this exists so a map can be
// walked today. Where they differ, this one is wrong.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { HULL } from '../../shared/sim3d/units.js';

// Source movement constants, in units. Knife-out speeds (the explorer runs unarmed).
export const TICK = 1 / 64;
export const RUN_SPEED = 250; // knife
export const WALK_SPEED = 130; // shift, 0.52
export const CROUCH_SPEED = 85; // ctrl, 0.34
export const STOP_SPEED = 80;
export const ACCEL = 5.5;
export const FRICTION = 5.2;
export const GRAVITY = 800;
export const JUMP_VEL = 301.993377;
export const AIR_ACCEL = 12;
export const AIR_SPEED_CAP = 30;

const RADIUS = HULL.width / 2;
const FLY_SPEED = 700; // u/s, before shift/ctrl scaling

const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _tri = new THREE.Vector3();
const _cap = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _start = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmpVel = new THREE.Vector3();
const _probe = new THREE.Line3();
const _n = new THREE.Vector3();
/** Source categorizes "on ground" with a 2-unit downward trace. */
const GROUND_PROBE = 2;

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'fly'; // 'fly' | 'walk'
    // Feet position (bottom of hull) in walk mode; eye position derives from it.
    this.feet = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; // radians, three rotation.y
    this.pitch = 0;
    this.crouched = false;
    this.onGround = false;
    this.collider = null; // { geometry, bvh }
    this.acc = 0;
    this.input = { fwd: 0, side: 0, up: 0, jump: false, crouch: false, walk: false, fast: false };
    this.flyVel = new THREE.Vector3();
    this.eyeSmooth = HULL.standEye;
  }

  setCollider(collider) {
    this.collider = collider;
  }

  /** Put the body at feet position `pos` looking along `yaw` (radians). */
  teleport(pos, yaw = this.yaw, pitch = 0) {
    this.feet.copy(pos);
    this.vel.set(0, 0, 0);
    this.flyVel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = pitch;
    this.eyeSmooth = HULL.standEye;
    this.syncCamera();
  }

  get eyeHeight() {
    return this.crouched ? HULL.crouchEye : HULL.standEye;
  }

  get hullHeight() {
    return this.crouched ? HULL.crouchHeight : HULL.standHeight;
  }

  /** Eye position in the scene. */
  eye(out = new THREE.Vector3()) {
    return out.copy(this.feet).setY(this.feet.y + this.eyeSmooth);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'walk') {
      // The camera is where the eyes were: drop the feet under it.
      this.feet.copy(this.camera.position).setY(this.camera.position.y - HULL.standEye);
      this.vel.set(0, 0, 0);
      this.eyeSmooth = HULL.standEye;
    } else {
      this.flyVel.set(0, 0, 0);
    }
    this.mode = mode;
    this.syncCamera();
  }

  look(dx, dy, sensDegPerCount) {
    const k = (sensDegPerCount * Math.PI) / 180;
    this.yaw -= dx * k;
    this.pitch -= dy * k;
    const lim = Math.PI / 2 - 0.001;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  syncCamera() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (this.mode === 'walk') this.eye(this.camera.position);
  }

  /** Advance by frame time; walk mode steps at a fixed 64 Hz. */
  update(dt) {
    if (this.mode === 'fly') {
      this._fly(Math.min(dt, 0.1));
    } else {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= TICK) {
        this._walkTick(TICK);
        this.acc -= TICK;
      }
      // Eye height eases toward the crouch/stand target like the game's duck.
      const target = this.eyeHeight;
      this.eyeSmooth += (target - this.eyeSmooth) * Math.min(1, dt * 18);
    }
    this.syncCamera();
  }

  /** Horizontal wish direction from input + yaw. */
  _wishDir(out) {
    const f = this.input.fwd;
    const s = this.input.side;
    if (!f && !s) return out.set(0, 0, 0);
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
    out.set(-sy * f + cy * s, 0, -cy * f - sy * s);
    return out.normalize();
  }

  _fly(dt) {
    _m.makeRotationFromEuler(this.camera.rotation);
    const dir = _v.set(this.input.side, this.input.up, -this.input.fwd);
    let speed = FLY_SPEED;
    if (this.input.fast) speed *= 3.5; // shift
    if (this.input.crouch) speed *= 0.3; // ctrl
    if (dir.lengthSq() > 0) dir.normalize().applyMatrix4(_m).multiplyScalar(speed);
    // Snappy but not instant: 12/s exponential approach.
    const k = 1 - Math.exp(-12 * dt);
    this.flyVel.lerp(dir, k);
    this.camera.position.addScaledVector(this.flyVel, dt);
  }

  _walkTick(dt) {
    const wantCrouch = this.input.crouch;
    if (wantCrouch !== this.crouched) {
      if (wantCrouch || this._canStand()) this.crouched = wantCrouch;
    }
    const wish = this._wishDir(_v);
    const wishSpeed = this.crouched ? CROUCH_SPEED : this.input.walk ? WALK_SPEED : RUN_SPEED;

    if (this.onGround) {
      if (this.input.jump) {
        this.vel.y = JUMP_VEL;
        this.onGround = false;
        this.input.jump = false; // no auto-hop: one press, one jump
      } else {
        // Keep pressing into the floor a hair so the ground test holds every tick.
        this.vel.y = -GRAVITY * dt;
        this._friction(dt, wish.lengthSq() > 0 ? wishSpeed : 0);
        this._accelerate(wish, wishSpeed, ACCEL, dt);
      }
    }
    if (!this.onGround) {
      this._airAccelerate(wish, wishSpeed, dt);
      this.vel.y -= GRAVITY * dt;
    }
    const wasOnGround = this.onGround;
    const start = _start.copy(this.feet);
    this.feet.addScaledVector(this.vel, dt);
    this._collide(dt);

    if (wasOnGround && this.collider) {
      // Step up: blocked by something knee-high (stairs, curbs)? Try the
      // move again from stepHeight higher and settle back down.
      const wantX = this.vel.x * dt;
      const wantZ = this.vel.z * dt;
      const gotX = this.feet.x - start.x;
      const gotZ = this.feet.z - start.z;
      const want2 = wantX * wantX + wantZ * wantZ;
      if (want2 > 1e-4 && gotX * wantX + gotZ * wantZ < 0.7 * want2) {
        const blockedFeet = _tmp.copy(this.feet);
        const blockedVel = _tmpVel.copy(this.vel);
        const blockedGround = this.onGround;
        this.feet.set(start.x + wantX, start.y + HULL.stepHeight, start.z + wantZ);
        this._collide(dt);
        this.feet.y -= HULL.stepHeight;
        this._collide(dt);
        const upX = this.feet.x - start.x;
        const upZ = this.feet.z - start.z;
        if (!(upX * wantX + upZ * wantZ > gotX * wantX + gotZ * wantZ + 0.01)) {
          this.feet.copy(blockedFeet);
          this.vel.copy(blockedVel);
          this.onGround = blockedGround;
        }
      }
      // Stay on ground: walking off a step or down a slope should not launch
      // the body; probe stepHeight down and take the floor if it is there.
      if (!this.onGround && this.vel.y <= 0) {
        const airFeet = _tmp.copy(this.feet);
        this.feet.y -= HULL.stepHeight;
        this._collide(dt);
        if (!this.onGround) this.feet.copy(airFeet);
      }
    }
    if (this.feet.y < -20000) {
      // Fell out of the world (missing collision); put them back on top.
      this.feet.y = 0;
      this.vel.set(0, 0, 0);
    }
  }

  _friction(dt, activeWishSpeed) {
    const v = this.vel;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 0.1) {
      v.x = 0;
      v.z = 0;
      return;
    }
    let control = speed < STOP_SPEED ? STOP_SPEED : speed;
    if (activeWishSpeed > 0 && speed < activeWishSpeed) control = speed;
    const drop = control * FRICTION * dt;
    const k = Math.max(0, speed - drop) / speed;
    v.x *= k;
    v.z *= k;
  }

  _accelerate(wish, wishSpeed, accel, dt) {
    if (wishSpeed <= 0 || wish.lengthSq() === 0) return;
    const cur = this.vel.x * wish.x + this.vel.z * wish.z;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    let a = accel * dt * wishSpeed;
    if (a > add) a = add;
    this.vel.x += a * wish.x;
    this.vel.z += a * wish.z;
  }

  _airAccelerate(wish, wishSpeed, dt) {
    if (wishSpeed <= 0 || wish.lengthSq() === 0) return;
    const capped = Math.min(wishSpeed, AIR_SPEED_CAP);
    const cur = this.vel.x * wish.x + this.vel.z * wish.z;
    const add = capped - cur;
    if (add <= 0) return;
    let a = AIR_ACCEL * wishSpeed * dt;
    if (a > add) a = add;
    this.vel.x += a * wish.x;
    this.vel.z += a * wish.z;
  }

  /** Capsule segment for the current hull at `feet`. */
  _segment(seg, feet = this.feet, height = this.hullHeight) {
    seg.start.set(feet.x, feet.y + RADIUS, feet.z);
    seg.end.set(feet.x, feet.y + height - RADIUS, feet.z);
    return seg;
  }

  /** Push the capsule out of the BVH; sliding falls out of repeated pushes. */
  _collide(dt) {
    const c = this.collider;
    if (!c) {
      this.onGround = this.feet.y <= 0;
      if (this.onGround) this.feet.y = 0;
      return;
    }
    const before = _delta.copy(this.feet);
    const seg = this._segment(_seg);
    for (let iter = 0; iter < 3; iter++) {
      _box.makeEmpty();
      _box.expandByPoint(seg.start);
      _box.expandByPoint(seg.end);
      _box.min.addScalar(-RADIUS);
      _box.max.addScalar(RADIUS);
      let hit = false;
      c.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_box),
        intersectsTriangle: (tri) => {
          const d = tri.closestPointToSegment(seg, _tri, _cap);
          if (d < RADIUS) {
            const depth = RADIUS - d;
            // Segment through the triangle: no direction to push along, use the face normal.
            const dir = d > 1e-4 ? _cap.sub(_tri).normalize() : tri.getNormal(_cap);
            seg.start.addScaledVector(dir, depth);
            seg.end.addScaledVector(dir, depth);
            hit = true;
          }
        }
      });
      if (!hit) break;
    }
    this.feet.set(seg.start.x, seg.start.y - RADIUS, seg.start.z);
    const moved = _delta.subVectors(this.feet, before);
    if (moved.lengthSq() > 1e-8) {
      // Remove velocity into the surfaces we were pushed out of.
      const n = moved.normalize();
      const into = this.vel.dot(n);
      if (into < 0) this.vel.addScaledVector(n, -into);
    }
    // Source's CategorizePosition: ground is a walkable face within 2 units below.
    this.onGround = this._groundProbe();
    if (this.onGround && this.vel.y < 0) this.vel.y = 0;
  }

  /** Is there a walkable surface (normal.y > 0.7) within GROUND_PROBE units under the capsule? */
  _groundProbe() {
    const c = this.collider;
    if (!c) return this.feet.y <= 0;
    const seg = this._segment(_probe);
    seg.start.y -= GROUND_PROBE;
    seg.end.y -= GROUND_PROBE;
    _box.makeEmpty();
    _box.expandByPoint(seg.start);
    _box.expandByPoint(seg.end);
    _box.min.addScalar(-RADIUS);
    _box.max.addScalar(RADIUS);
    let found = false;
    c.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        if (tri.closestPointToSegment(seg, _tri, _cap) < RADIUS) {
          tri.getNormal(_n);
          // Only the bottom of the capsule counts, and only floors, not walls.
          if (_n.y > 0.7 && _tri.y < seg.start.y + 0.5) {
            found = true;
            return true;
          }
        }
        return false;
      }
    });
    return found;
  }

  /** Room to stand up from a crouch (nothing inside the standing capsule's extra span). */
  _canStand() {
    const c = this.collider;
    if (!c) return true;
    const seg = this._segment(_seg, this.feet, HULL.standHeight);
    _box.makeEmpty();
    _box.expandByPoint(seg.start);
    _box.expandByPoint(seg.end);
    _box.min.addScalar(-RADIUS);
    _box.max.addScalar(RADIUS);
    let blocked = false;
    c.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        if (tri.closestPointToSegment(seg, _tri, _cap) < RADIUS - 0.5) {
          blocked = true;
          return true;
        }
        return false;
      }
    });
    return !blocked;
  }
}
