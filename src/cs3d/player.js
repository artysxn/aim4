// ---------------------------------------------------------------------------
// src/cs3d/player.js
// The explorer's body: a noclip fly camera and a walking body that runs the
// real movement sim — shared/sim3d/motion.js, Source's CGameMovement pipeline
// in f32 at a fixed 64 Hz — against the map's collision BVH through
// src/cs3d/hullWorld.js (swept AABB, Source frame, DIST_EPSILON pull-back).
//
// Nothing about movement lives here any more: this file turns keys and mouse
// into the sim's per-tick input (forward/side/yaw/jump/duck/walk/maxSpeed),
// steps the sim, and puts the camera on the eyes. The same `stepPlayer` and
// the same tracer run headless in Node (shared/sim3d/hullTrace.test.js), which
// is what CS3D-PLAN §0 means by one brain, two bodies. Where the walk here
// differs from the game, the fix belongs in motion.js and its oracle, not in
// a special case in this file.
//
// Jump latching (sv_autobunnyhopping 0) and duck amount live in motion.js.
// The camera eye follows sim duckAmount.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { clamp, degToRad } from '../utils/MathUtils.js';
import { HULL, sourceYawFromCamera } from '../../shared/sim3d/units.js';
import { createPlayerState, createInput, stepPlayer, flatWorld } from '../../shared/sim3d/motion.js';
import { TICK_DT, EYE_STAND, EYE_DUCK } from '../../shared/sim3d/constants.js';
import { WEAPON_SPEED, DEFAULT_WEAPON_SPEED } from '../../shared/sim/constants.js';
import { createHullWorld } from './hullWorld.js';

export const TICK = TICK_DT;

const FLY_SPEED = 700; // u/s, before shift/ctrl scaling

/**
 * Weapons the explorer can hold, for their speed caps (Q cycles). The knife
 * is the default: the walking body runs at 250, as it did before the sim.
 */
export const EXPLORER_WEAPONS = ['knife', 'ak47', 'awp', 'glock', 'mp9', 'negev'];

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'fly'; // 'fly' | 'walk'
    // Feet position (bottom of hull) in walk mode, SCENE frame; the sim's own
    // state (`sim`, Source frame) is the truth and this mirrors it every tick.
    this.feet = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; // radians, three rotation.y
    this.pitch = 0;
    this.crouched = false;
    this.onGround = false;
    this.collider = null; // { geometry, bvh }
    this.world = null; // hullWorld tracer over the collider
    this.acc = 0;
    this.input = { fwd: 0, side: 0, up: 0, jump: false, crouch: false, walk: false, fast: false };
    this.flyVel = new THREE.Vector3();
    this.eyeSmooth = HULL.standEye;
    this.sim = createPlayerState();
    this.simInput = createInput();
    /** Seconds since the last CheckJumpButton takeoff. Infinity on ground / walk-off. */
    this.jumpAge = Infinity;
    /** Source-frame velocity at takeoff. Horizontal is the run; z is the impulse after gravity. */
    this.jumpVel = { x: 0, y: 0, z: 0 };
    /** Source-frame eye at takeoff: perfect jumpthrows latch 6 ticks past this. */
    this.jumpEye = { x: 0, y: 0, z: 64 };
    this.weaponName = EXPLORER_WEAPONS[0];
    this._flat = flatWorld(0);
  }

  get weapon() {
    return this.weaponName;
  }

  /**
   * Q: next weapon in the explorer's pocket, for its speed cap.
   *
   * From anything outside that pocket — the buy menu holds every gun in the
   * game — this lands on the first entry rather than nowhere, so Q is always
   * a way back to a known set.
   */
  cycleWeapon() {
    const i = EXPLORER_WEAPONS.indexOf(this.weaponName);
    this.weaponName = EXPLORER_WEAPONS[(i + 1) % EXPLORER_WEAPONS.length];
    return this.weaponName;
  }

  /**
   * Hold a named weapon. Any name goes: the speed cap reads WEAPON_SPEED, which
   * covers every gun, and falls back to DEFAULT_WEAPON_SPEED for a grenade or a
   * name it does not know — which is what CS2 does with one in hand anyway.
   */
  setWeapon(name) {
    const n = String(name || '').replace(/^weapon_/, '');
    if (n) this.weaponName = n;
    return this.weaponName;
  }

  get maxSpeed() {
    return WEAPON_SPEED[this.weapon] ?? DEFAULT_WEAPON_SPEED;
  }

  /**
   * @param {object} collider  from MapPack.onPhys
   * @param {object} [movers]  geometry that is not in the BVH because it moves
   *   — the door leaves (src/cs3d/interactives.js). A closed door is solid
   *   because of this and an open one is walk-through for the same reason.
   */
  setCollider(collider, movers = null) {
    this.collider = collider;
    this.movers = movers || this.movers || null;
    this.world = collider ? createHullWorld(collider, 'walk', this.movers) : null;
  }

  /** Put the body at feet position `pos` (scene) looking along `yaw` (radians). */
  teleport(pos, yaw = this.yaw, pitch = 0) {
    this.feet.copy(pos);
    this.vel.set(0, 0, 0);
    this.flyVel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = pitch;
    this.eyeSmooth = HULL.standEye;
    this._simFromFeet();
    this.syncCamera();
  }

  /** Scene feet → the sim's Source-frame origin, velocity zeroed. */
  _simFromFeet() {
    const s = this.sim;
    s.pos.x = Math.fround(this.feet.x);
    s.pos.y = Math.fround(-this.feet.z);
    s.pos.z = Math.fround(this.feet.y);
    s.vel.x = s.vel.y = s.vel.z = 0;
    s.onGround = false;
    this.acc = 0;
    this.jumpAge = Infinity;
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
      this._simFromFeet();
    } else {
      this.flyVel.set(0, 0, 0);
    }
    this.mode = mode;
    this.syncCamera();
  }

  /** InputManager._onMouseMove: counts × radians-per-count, written now. */
  look(dx, dy, radiansPerCount) {
    this.yaw -= dx * radiansPerCount;
    this.pitch -= dy * radiansPerCount;
    this.pitch = clamp(this.pitch, -degToRad(89), degToRad(89));
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
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
        this._walkTick();
        this.acc -= TICK;
      }
      const amount = this.sim.duckAmount || 0;
      this.eyeSmooth = EYE_STAND + (EYE_DUCK - EYE_STAND) * amount;
    }
    this.syncCamera();
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

  /** One 64 Hz tick of the movement sim from the current keys. */
  _walkTick() {
    const inp = this.simInput;
    const keys = this.input;
    inp.forward = keys.fwd;
    inp.side = keys.side;
    inp.yaw = sourceYawFromCamera(this.yaw);
    // Source pitch: degrees, positive DOWN. Only the ladder branch reads it,
    // and that is exactly the input that decides whether looking up climbs.
    inp.pitch = -this.pitch * (180 / Math.PI);
    inp.duck = keys.crouch;
    inp.walk = keys.walk;
    inp.maxSpeed = this.maxSpeed;
    inp.jump = !!keys.jump;
    const wasGround = this.sim.onGround;
    const preJumpEye = {
      x: this.sim.pos.x,
      y: this.sim.pos.y,
      z: this.sim.pos.z + this.eyeSmooth
    };

    stepPlayer(this.sim, inp, this.world || this._flat);

    const s = this.sim;
    if (wasGround && !s.onGround && inp.jump && s.vel.z > 140) {
      this.jumpAge = 0;
      this.jumpVel = { x: s.vel.x, y: s.vel.y, z: s.vel.z };
      this.jumpEye = preJumpEye;
    } else if (s.onGround) {
      this.jumpAge = Infinity;
    } else if (this.jumpAge < Infinity) {
      this.jumpAge += TICK_DT;
    }
    if (s.pos.z < -20000) {
      // Fell out of the world (missing collision); put them back on top.
      s.pos.z = 0;
      s.vel.x = s.vel.y = s.vel.z = 0;
    }
    // Mirror into the scene-frame fields the rest of the explorer reads.
    this.feet.set(s.pos.x, s.pos.z, -s.pos.y);
    this.vel.set(s.vel.x, s.vel.z, -s.vel.y);
    this.onGround = s.onGround;
    this.onLadder = s.onLadder;
    this.crouched = s.ducking;
  }
}
