// ---------------------------------------------------------------------------
// SourceMovement.js
// A faithful port of the Source-engine (CS2 / CS:GO) ground-movement model.
// Friction + acceleration are exactly the PM_Friction / PM_Accelerate routines
// from the Source SDK, expressed in SI units. The SAME functions drive both the
// player (2D, x/z) and every bot (1D strafe via SourceMover1D), so "enemies move
// with the same engine you do" is literally true — there is one implementation.
//
//   sv_maxspeed   215 u/s   (running, AK / rifle — same for tap and spray)
//   walk (shift)  112 u/s   (52% slow-walk cap)
//   crouch walk   73 u/s    (ducked move cap)
//   sv_accelerate 5.5
//   sv_friction   5.2
//   sv_stopspeed  80 u/s
//   1 unit        = 0.0254 m  (Source player hull: 72 u ≈ 1.83 m → 1 u = 1 inch)
// ---------------------------------------------------------------------------

export const UNIT = 0.0254; // metres per Source unit

export const RUN_SPEED = 215 * UNIT; // 5.461 m/s
export const WALK_SPEED = 112 * UNIT; // 2.845 m/s (shift-held slow walk)
export const CROUCH_SPEED = 73 * UNIT; // 1.854 m/s
export const STOP_SPEED = 80 * UNIT; // 2.032 m/s
export const ACCEL = 5.5; // sv_accelerate
export const FRICTION = 5.2; // sv_friction

export const STAND_EYE = 1.6; // m, standing view height (≈ 63 u)
export const CROUCH_EYE = 1.15; // m, ducked view height (≈ 45 u)

// sv_gravity + standing jump impulse (CS2 / CS:GO defaults, converted to metres).
export const GRAVITY = 800 * UNIT; // 20.32 m/s²
export const JUMP_VEL = 301.993377 * UNIT; // ~7.67 m/s (sqrt(2 · 800 · 57) u/s)

// Air movement. sv_airaccelerate governs in-air control, but Source clamps the
// *wish speed* used for the cap to 30 u/s (GetAirSpeedCap) — this is exactly why
// you can air-strafe / keep momentum but can't just run at full speed in the air.
export const AIR_ACCEL = 12; // sv_airaccelerate
export const AIR_SPEED_CAP = 30 * UNIT; // 0.762 m/s

/**
 * PM_Friction. Bleeds horizontal speed every tick — strong below sv_stopspeed so
 * the player/bot comes to a crisp halt rather than sliding. Mutates `vel` ({x,z}).
 */
export function srcFriction(vel, dt) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 1e-4) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = speed < STOP_SPEED ? STOP_SPEED : speed;
  const drop = control * FRICTION * dt;
  const newspeed = Math.max(0, speed - drop) / speed;
  vel.x *= newspeed;
  vel.z *= newspeed;
}

/**
 * PM_Accelerate. Adds speed along the (unit) wish direction, capped so the
 * projected speed never exceeds wishSpeed. This is what gives the characteristic
 * Source "ramp-up" out of cover. Mutates `vel` ({x,z}).
 */
export function srcAccelerate(vel, wishX, wishZ, wishSpeed, dt) {
  const currentspeed = vel.x * wishX + vel.z * wishZ;
  const addspeed = wishSpeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = ACCEL * dt * wishSpeed;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x += accelspeed * wishX;
  vel.z += accelspeed * wishZ;
}

/**
 * PM_AirAccelerate. In-air control: the projected speed is only allowed to grow
 * up to AIR_SPEED_CAP along the wish direction, but the increment scales with the
 * full wish speed × sv_airaccelerate. This is the Source air model — momentum is
 * preserved (no air friction) and you can only nudge velocity sideways, so jumps
 * carry your speed instead of letting you sprint/turn freely mid-air.
 * Mutates `vel` ({x,z}).
 */
export function srcAirAccelerate(vel, wishX, wishZ, wishSpeed, dt) {
  const wishspd = Math.min(wishSpeed, AIR_SPEED_CAP);
  const currentspeed = vel.x * wishX + vel.z * wishZ;
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = AIR_ACCEL * wishSpeed * dt;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x += accelspeed * wishX;
  vel.z += accelspeed * wishZ;
}

/**
 * One-dimensional Source mover for bots that only strafe left/right. Position
 * `s` is along the bot's lateral axis (metres); velocity rides the shared
 * friction/accelerate routines so a 1D strafe ramps + stops identically to the
 * 2D player. `seek()` adds counter-strafe braking for a sharp CS-style stop.
 */
export class SourceMover1D {
  constructor() {
    this._v = { x: 0, z: 0 }; // only .x is used; .z stays 0 for the shared funcs
    this.s = 0;
  }
  get v() {
    return this._v.x;
  }
  set v(val) {
    this._v.x = val;
  }
  reset(s = 0) {
    this.s = s;
    this._v.x = 0;
    this._v.z = 0;
  }

  /** Advance one tick with a wish direction of -1, 0 or +1. */
  step(dt, wishDir, maxSpeed) {
    srcFriction(this._v, dt);
    if (wishDir !== 0) srcAccelerate(this._v, wishDir > 0 ? 1 : -1, 0, maxSpeed, dt);
    this.s += this._v.x * dt;
  }

  /**
   * Drive toward `target`, counter-strafing (pressing the opposite key) to brake
   * when close + fast, exactly like a player A/D counter-strafe. Returns true the
   * tick it has settled on target.
   */
  seek(dt, target, maxSpeed) {
    const d = target - this.s;
    const moving = Math.sign(this._v.x);
    if (Math.abs(d) < 0.04) {
      if (Math.abs(this._v.x) > 0.2) {
        this.step(dt, -moving, maxSpeed); // kill residual velocity
        return false;
      }
      this._v.x = 0;
      this.s = target;
      return true;
    }
    const wishDir = Math.sign(d);
    const brakeDist = Math.abs(this._v.x) * 0.16; // heuristic stopping distance
    if (moving === wishDir && Math.abs(d) < brakeDist) {
      this.step(dt, -wishDir, maxSpeed); // counter-strafe brake
    } else {
      this.step(dt, wishDir, maxSpeed);
    }
    return false;
  }
}
