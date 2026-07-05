// ---------------------------------------------------------------------------
// PlayerController.js
// First-person movement for the player: WASD strafing, crouch, and jump, driven
// shared Source-engine mover (utils/SourceMovement.js) so the player accelerates,
// decelerates and tops out exactly like a CS2 player (and exactly like the bots).
//
// It owns the camera *position* only while enabled; the InputManager still owns
// look (yaw/pitch). Movement-free scenarios (Gridshot / Arena) simply never
// enable it, so the camera stays pinned at the origin. Bounds confine the player
// to a per-scenario box (their cover area in Duels, the 5×5 m box in Range).
// ---------------------------------------------------------------------------

import { clamp, lerp } from '../utils/MathUtils.js';
import { resolveBoxCollisions, groundHeightAt } from '../utils/BoxCollision.js';
import {
  srcFriction,
  srcAccelerate,
  srcAirAccelerate,
  RUN_SPEED,
  WALK_SPEED,
  CROUCH_SPEED,
  STAND_EYE,
  CROUCH_EYE,
  GRAVITY,
  JUMP_VEL
} from '../utils/SourceMovement.js';

const DUCK_RATE = 7; // how fast the crouch amount approaches its target (per s)

export class PlayerController {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.camera = engine.camera;

    this.enabled = false;
    this.vel = { x: 0, z: 0 };
    this.pos = { x: 0, z: 0 };
    this.footY = 0;
    this.floorY = 0;
    this.velY = 0;
    this.onGround = true;
    this.crouchAmt = 0; // 0 = standing, 1 = fully ducked
    this.bounds = null; // { minX, maxX, minZ, maxZ } | null
    this.colliders = null; // cover/wall boxes for horizontal collision
  }

  getAccuracyState() {
    return {
      onGround: this.onGround,
      speedHoriz: Math.hypot(this.vel.x, this.vel.z)
    };
  }

  /** Disable + recenter. Called on camera reset / scenario unload. */
  reset() {
    this.enabled = false;
    this.vel.x = 0;
    this.vel.z = 0;
    this.pos.x = 0;
    this.pos.z = 0;
    this.footY = 0;
    this.floorY = 0;
    this.velY = 0;
    this.onGround = true;
    this.crouchAmt = 0;
    this.bounds = null;
    this.colliders = null;
  }

  /**
   * Place the player and take control of the camera position.
   * @param {{pos:[number,number,number], yaw?:number, bounds?:object}} opts
   */
  spawn({ pos, yaw = 0, bounds = null, colliders = null, spawnGrace = 0, floorY = 0 }) {
    this.pos.x = pos[0];
    this.pos.z = pos[2];
    this.floorY = floorY;
    this.colliders = colliders;
    const spawnY = pos[1] || 0;
    this.footY = colliders?.length
      ? Math.max(spawnY, groundHeightAt(pos[0], pos[2], colliders, spawnY, floorY))
      : spawnY;
    this.vel.x = 0;
    this.vel.z = 0;
    this.velY = 0;
    this.onGround = true;
    this.crouchAmt = 0;
    this.bounds = bounds;
    this.enabled = true;

    if (spawnGrace > 0) this.input.beginSpawnGrace(spawnGrace);

    // Sync look so the player starts facing the given yaw.
    this.input.yaw = yaw;
    this.input.pitch = 0;
    this.camera.rotation.y = yaw;
    this.camera.rotation.x = 0;
    this.camera.position.set(this.pos.x, this.footY + STAND_EYE, this.pos.z);
  }

  _supportY() {
    return groundHeightAt(this.pos.x, this.pos.z, this.colliders, this.footY, this.floorY);
  }

  update(dt) {
    if (!this.enabled) return;

    this.input.tickSpawnGrace(dt);

    // Crouch: ease the duck amount toward held state; lower speed + view height.
    const wantCrouch = this.input.crouchHeld ? 1 : 0;
    this.crouchAmt = clamp(this.crouchAmt + (wantCrouch - this.crouchAmt) * Math.min(1, DUCK_RATE * dt), 0, 1);
    // Weapon speed cap: the sniper runs at 200 u/s unscoped and 100 u/s scoped.
    const weaponCap = this.engine.weapon?.moveSpeedCap;
    const runCap = weaponCap != null ? Math.min(RUN_SPEED, weaponCap) : RUN_SPEED;
    const standCap = this.input.walkHeld ? Math.min(WALK_SPEED, runCap) : runCap;
    const maxSpeed = lerp(standCap, Math.min(CROUCH_SPEED, runCap), this.crouchAmt);

    // Build the wish direction in world space from WASD + current yaw.
    const { f, r } = this.input.moveAxis();
    const yaw = this.input.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // At yaw 0 the camera looks down -Z: forward = (-sin, -cos), right = (cos, -sin).
    let wx = -sin * f + cos * r;
    let wz = -cos * f - sin * r;
    const len = Math.hypot(wx, wz);
    if (len > 0) {
      wx /= len;
      wz /= len;
    }

    // Horizontal: ground uses friction + full acceleration; air keeps momentum
    // and only allows the clamped Source air-control nudge (no friction).
    if (this.onGround) {
      srcFriction(this.vel, dt, len > 0 ? maxSpeed : 0);
      if (len > 0) srcAccelerate(this.vel, wx, wz, maxSpeed, dt);
    } else if (len > 0) {
      srcAirAccelerate(this.vel, wx, wz, maxSpeed, dt);
    }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Drop off ledges before jump/gravity so we don't keep spawn height or jump mid-fall.
    let supportY = this._supportY();
    if (this.onGround && this.footY > supportY + 0.06) {
      this.onGround = false;
    }

    // Jump impulse only off the ground. Source applies gravity in two half-steps
    // around the move (StartGravity / FinishGravity); doing the same makes the
    // apex height exactly v²/2g regardless of frame rate.
    const consumedJump = this.input.jumpQueued;
    if (consumedJump && this.onGround) {
      this.velY = JUMP_VEL;
      this.onGround = false;
      this.crouchAmt = 0;
      this.engine.audio?.playLocalJump();
    }
    if (consumedJump) this.input.jumpQueued = false;

    const halfG = 0.5 * GRAVITY * dt;
    this.velY -= halfG;
    this.footY += this.velY * dt;
    this.velY -= halfG;

    supportY = this._supportY();
    if (this.footY <= supportY + 0.06) {
      if (this.velY <= 0) {
        this.footY = supportY;
        this.velY = 0;
        this.onGround = true;
      }
    } else {
      this.onGround = false;
    }

    // Confine to the scenario box; kill the velocity component on contact.
    const b = this.bounds;
    if (b) {
      if (this.pos.x < b.minX) {
        this.pos.x = b.minX;
        if (this.vel.x < 0) this.vel.x = 0;
      } else if (this.pos.x > b.maxX) {
        this.pos.x = b.maxX;
        if (this.vel.x > 0) this.vel.x = 0;
      }
      if (this.pos.z < b.minZ) {
        this.pos.z = b.minZ;
        if (this.vel.z < 0) this.vel.z = 0;
      } else if (this.pos.z > b.maxZ) {
        this.pos.z = b.maxZ;
        if (this.vel.z > 0) this.vel.z = 0;
      }
    }

    if (this.colliders?.length) {
      resolveBoxCollisions(this.pos, this.vel, this.footY, this.crouchAmt, this.colliders);
    }

    const eye = this.footY + lerp(STAND_EYE, CROUCH_EYE, this.crouchAmt);
    this.camera.position.set(this.pos.x, eye, this.pos.z);

    const speedHoriz = Math.hypot(this.vel.x, this.vel.z);
    this.engine.audio?.updateLocalFootsteps(dt, {
      onGround: this.onGround,
      crouchAmt: this.crouchAmt,
      walkHeld: this.input.walkHeld,
      spawnGrace: this.input.spawnGraceRemaining,
      speedHoriz
    });
  }
}
