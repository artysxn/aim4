// ---------------------------------------------------------------------------
// shared/sim3d/motion.js
// The player movement tick: Source's CGameMovement pipeline in f32, in Source
// coordinates (z-up, units), against a pluggable collision world.
//
// The order of operations IS the physics here. FullWalkMove applies gravity in
// two half-tick pieces around the move (leapfrog). CheckJumpButton then adds
// (standing) or sets (ducking) sv_jump_impulse, scales by stamina, and calls
// FinishGravity; FullWalkMove's FinishGravity still runs on the jump tick.
//
// Duck, stamina, jump, walk-cap and ground accel follow CCSGameMovement
// (cstrike15 leak). AirMove/WalkMove collision still call the base Source
// pipeline in this file. Water jump and bot auto-crouch-jump are out of scope.
//
// The collision world is an interface so the same brain runs everywhere:
//   world.traceHull(start, end, halfWide, height) →
//     { fraction, endpos:{x,y,z}, normal:{x,y,z}|null, startSolid }
// flatWorld() below is the analytic implementation the oracle uses for pure
// dynamics; shared/sim3d/hullTrace.js is the swept-hull implementation over
// triangles (a map pack's phys.glb through src/cs3d/hullWorld.js in the
// browser, any triangle list in Node) and plugs in the same way.
// ---------------------------------------------------------------------------

import { fr, fmul, fdiv, v3, v3set, v3copy, v3dot, v3mulAdd, v3len, v3scale, v3normalize, yawBasis } from './fp.js';
import {
  TICK_DT,
  GRAVITY,
  JUMP_IMPULSE,
  NON_JUMP_VELOCITY,
  ACCEL,
  FRICTION,
  STOP_SPEED,
  MAX_VELOCITY,
  GROUND_NORMAL_MIN,
  AIR_ACCEL,
  AIR_SPEED_CAP,
  DUCK_SPEED_SCALE,
  WALK_SPEED_SCALE,
  CLIMB_MODIFIER,
  ACCEL_SPEED_REF,
  ACCELERATE_USE_WEAPON_SPEED,
  WALK_DELAY_CAP_SLACK,
  BUNNYJUMP_MAX_SPEED_FACTOR,
  VELOCITY_MODIFIER_RECOVERY,
  DUCK,
  STAMINA,
  HULL_HALF_WIDE,
  HULL_STAND,
  HULL_DUCK,
  STEP_HEIGHT
} from './constants.js';

/** How far CategorizePosition looks down for ground under the feet. */
const GROUND_PROBE = fr(2);

// ---- ladders ---------------------------------------------------------------
// A climb volume takes the body off gravity entirely and steers it by where it
// is LOOKING, which is why this is the one thing in the pipeline that needs
// view pitch and not just yaw.
//
// Faithful in shape, simplified in one place, and the simplification is named:
// Source builds a "perp" from the ladder plane and applies sv_ladder_dampen to
// the component along it, so strafing on a ladder slides you sideways along
// the rungs slowly. Here the sideways input is damped by the same cvar's value
// but applied to the plain right vector, which is the same motion for a flat
// ladder face and differs only on one set at an angle to its own volume.

/** [docs] Source MAX_CLIMB_SPEED. */
export const CLIMB_SPEED = fr(200);
/** [docs] sv_ladder_scale_speed. */
export const LADDER_SPEED_SCALE = fr(0.78);
/** [docs] sv_ladder_dampen: how much of a sideways input survives on a ladder. */
export const LADDER_DAMPEN = fr(0.2);
/** [docs] Jumping off a ladder pushes away from its face at this speed. */
export const LADDER_JUMP_AWAY = fr(270);
/** Ticks after letting go before the same ladder can be grabbed again. */
const LADDER_REGRAB = 8;
/** Collide-and-slide gives up after this many plane bumps (Source: 4). */
const MAX_BUMPS = 4;
/** Speeds under this are snapped to zero on ground (Source WalkMove). */
const SPEED_EPSILON = fr(1);

export function createPlayerState(x = 0, y = 0, z = 0) {
  return {
    pos: v3(x, y, z),
    vel: v3(),
    onGround: false,
    /** FL_DUCKING: fully ducked (hull swap is `ducked`; jump SET vs ADD). */
    ducking: false,
    /** m_bDucked: collision uses the duck hull. */
    ducked: false,
    /** m_flDuckAmount in [0, 1]. */
    duckAmount: 0,
    /** m_flDuckSpeed, starts at CS_PLAYER_DUCK_SPEED_IDEAL. */
    duckSpeed: DUCK.SPEED_IDEAL,
    /** m_bDucking: in the duck/unduck animation. */
    inDuckTransition: false,
    /** gpGlobals-style sim time, seconds. */
    time: 0,
    /** m_flLastDuckTime. */
    lastDuckTime: fr(-1e9),
    lastFullCrouchX: fr(x),
    lastFullCrouchY: fr(y),
    duckHeld: false,
    jumpHeld: false,
    stamina: 0,
    fallVelocity: 0,
    velocityModifier: fr(1),
    walking: false,
    /** Set by CategorizePosition when standing on a walkable plane. */
    groundNormal: v3(0, 0, 1),
    /** On a climb volume: no gravity, steered by the view (see ladderMove). */
    onLadder: false,
    /** Ticks left before a ladder just let go of can be grabbed again. */
    ladderRegrab: 0
  };
}

/**
 * One tick of input, already resolved from keys/binds:
 *   forward, side ∈ [-1, 1]   (+forward = W, +side = D)
 *   yaw                        view yaw, degrees, Source frame
 *   jump, duck, walk           booleans
 *   maxSpeed                   active weapon's run speed, u/s (weapons.js)
 */
export function createInput() {
  // `pitch` is Source's: degrees, POSITIVE looking down. Only ladders read it —
  // everything else moves in the ground plane — and a world with no ladder
  // probe never touches it, which is why adding it changes no oracle result.
  return { forward: 0, side: 0, yaw: 0, pitch: 0, jump: false, duck: false, walk: false, maxSpeed: 250, scoped: false };
}

// Scratch vectors: stepPlayer allocates nothing per tick.
const _fwd = v3();
const _right = v3();
const _wishVel = v3();
const _wishDir = v3();
const _end = v3();
const _origVel = v3();
const _clipped = v3();

function fclamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function approach(target, value, speed) {
  const delta = fr(target - value);
  if (delta > speed) return fr(value + speed);
  if (delta < -speed) return fr(value - speed);
  return fr(target);
}

function staminaSpeedScale(stamina) {
  if (!(stamina > 0)) return fr(1);
  let s = fclamp(fr(1 - fdiv(stamina, STAMINA.RANGE)), 0, 1);
  return fmul(s, s);
}

function duckSpeedModifier(amount) {
  return fr(fmul(DUCK_SPEED_SCALE, amount) + fr(1 - amount));
}

function duckingEnabled(state) {
  if (state.duckSpeed < DUCK.ENABLED_MIN_SPEED) return false;
  if (!state.ducking && state.time < fr(state.lastDuckTime + DUCK.TIME_BETWEEN)) return false;
  return true;
}

function canUnduck(state, world) {
  const pos = state.pos;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (state.onGround) {
    // VEC_DUCK_HULL_MIN - VEC_HULL_MIN is 0 with origin-at-feet hulls.
  } else {
    const half = fmul(fr(0.5), fr(HULL_STAND - HULL_DUCK));
    dz = fr(-half);
  }
  const dest = v3set(_end, fr(pos.x + dx), fr(pos.y + dy), fr(pos.z + dz));
  const t = world.traceHull(pos, dest, HULL_HALF_WIDE, HULL_STAND);
  if (t.startSolid || t.fraction !== 1) return false;
  return true;
}

function finishDuck(state) {
  const pos = state.pos;
  if (!state.onGround) {
    const half = fmul(fr(0.5), fr(HULL_STAND - HULL_DUCK));
    pos.z = fr(pos.z + half);
  }
  state.inDuckTransition = false;
  state.ducked = true;
  state.ducking = true;
  state.lastDuckTime = state.time;
  state.duckAmount = fr(1);
}

function finishUnDuck(state) {
  const pos = state.pos;
  if (!state.onGround) {
    const half = fmul(fr(0.5), fr(HULL_STAND - HULL_DUCK));
    pos.z = fr(pos.z - half);
  }
  state.ducking = false;
  state.ducked = false;
  state.inDuckTransition = false;
  state.duckAmount = 0;
}

function applyDuck(state, duckButton, world, dt) {
  const onGround = state.onGround;
  if (state.duckSpeed == null) state.duckSpeed = DUCK.SPEED_IDEAL;
  if (state.duckAmount == null) state.duckAmount = 0;
  if (state.lastDuckTime == null) state.lastDuckTime = fr(-1e9);

  state.duckSpeed = approach(DUCK.SPEED_IDEAL, state.duckSpeed, fmul(dt, DUCK.RECOVERY_PER_SEC));
  if (state.duckSpeed >= DUCK.SPEED_IDEAL) {
    state.lastFullCrouchX = state.pos.x;
    state.lastFullCrouchY = state.pos.y;
  } else if (state.duckAmount <= 0 || state.duckAmount >= 1) {
    const dx = fr(state.pos.x - state.lastFullCrouchX);
    const dy = fr(state.pos.y - state.lastFullCrouchY);
    const dist2 = fr(fmul(dx, dx) + fmul(dy, dy));
    const need = fmul(DUCK.EXTRA_RECOVERY_DIST, DUCK.EXTRA_RECOVERY_DIST);
    if (dist2 > need) {
      state.duckSpeed = approach(DUCK.SPEED_IDEAL, state.duckSpeed, fmul(dt, DUCK.EXTRA_RECOVERY_PER_SEC));
    }
  }

  if (!duckButton && state.duckAmount > 0) state.inDuckTransition = true;
  else if (duckButton && state.duckAmount < 1) state.inDuckTransition = true;

  if (duckButton && state.inDuckTransition) {
    const duckSpeed = fmul(state.duckSpeed, DUCK.IN_SCALE);
    state.duckAmount = approach(fr(1), state.duckAmount, fmul(dt, duckSpeed));
    if (state.duckAmount >= 1 || !onGround) finishDuck(state);
  }

  if (!duckButton && state.inDuckTransition) {
    if (canUnduck(state, world)) {
      const duckSpeed = state.duckSpeed < DUCK.UNDUCK_MIN_SPEED ? DUCK.UNDUCK_MIN_SPEED : state.duckSpeed;
      state.duckAmount = approach(0, state.duckAmount, fmul(dt, duckSpeed));
      state.ducked = false;
      if (state.duckAmount <= 0 || !onGround) finishUnDuck(state);
      else if (state.duckAmount <= fr(0.75) && state.ducking) state.ducking = false;
    } else {
      state.duckAmount = fr(1);
      state.ducked = true;
      state.inDuckTransition = false;
      state.ducking = true;
    }
  }
}

function preventBunnyJumping(vel, weaponMax) {
  const maxScaled = fmul(BUNNYJUMP_MAX_SPEED_FACTOR, weaponMax);
  if (!(maxScaled > 0)) return;
  const spd = v3len(vel);
  if (spd <= maxScaled) return;
  const fraction = fdiv(maxScaled, spd);
  vel.x = fmul(vel.x, fraction);
  vel.y = fmul(vel.y, fraction);
  vel.z = fmul(vel.z, fraction);
}

function finishGravity(vel, dt) {
  vel.z = fr(vel.z - fmul(GRAVITY, fmul(0.5, dt)));
}

function checkJumpButton(state, jump, dt, weaponMax) {
  const vel = state.vel;
  if (!jump) {
    state.jumpHeld = false;
    return false;
  }
  if (!state.onGround) {
    state.jumpHeld = true;
    return false;
  }
  if (state.jumpHeld) return false;

  preventBunnyJumping(vel, weaponMax);
  const startz = vel.z;
  state.onGround = false;

  const duckJump = state.inDuckTransition || state.ducking;
  if (duckJump) vel.z = JUMP_IMPULSE;
  else vel.z = fr(vel.z + JUMP_IMPULSE);

  if (state.stamina > 0) {
    vel.z = fmul(vel.z, fclamp(fr(1 - fdiv(state.stamina, STAMINA.RANGE)), 0, 1));
  }

  finishGravity(vel, dt);
  const impulse = fr(vel.z - startz);
  state.stamina = fclamp(fr(state.stamina + fmul(STAMINA.JUMP_COST, impulse)), 0, STAMINA.MAX);
  state.jumpHeld = true;
  return true;
}

function onLand(state, fallVel) {
  state.stamina = fclamp(fr(state.stamina + fmul(STAMINA.LAND_COST, fallVel)), 0, STAMINA.MAX);
}

/**
 * Advance one player one tick. Mutates `state`.
 * PlayerMove order: CheckParameters, ReduceTimers, Duck, Ladder, FullWalkMove.
 */
export function stepPlayer(state, input, world, dt = TICK_DT) {
  const vel = state.vel;
  if (state.duckSpeed == null) state.duckSpeed = DUCK.SPEED_IDEAL;
  if (state.velocityModifier == null) state.velocityModifier = fr(1);
  if (state.stamina == null) state.stamina = 0;
  if (state.time == null) state.time = 0;
  state.time = fr(state.time + dt);

  const weaponMax = fr(input.maxSpeed);
  let duckButton = !!input.duck;
  if (!!duckButton !== !!state.duckHeld) {
    const next = fr(state.duckSpeed - DUCK.SPAM_PENALTY);
    state.duckSpeed = next > 0 ? next : 0;
  }
  state.duckHeld = duckButton;
  if (!duckingEnabled(state)) duckButton = false;

  let maxSpeed = weaponMax;
  const duckingNow = duckButton || state.inDuckTransition || state.ducking;
  let walkButton = !!input.walk;
  if (duckingNow) walkButton = false;
  if (walkButton) {
    const current = v3len(vel);
    const walkCap = fmul(maxSpeed, WALK_SPEED_SCALE);
    if (current < fr(walkCap + WALK_DELAY_CAP_SLACK)) {
      maxSpeed = walkCap;
      state.walking = true;
    } else {
      state.walking = false;
    }
  } else {
    state.walking = false;
  }

  if (state.onGround) maxSpeed = fmul(maxSpeed, state.velocityModifier);
  maxSpeed = fmul(maxSpeed, staminaSpeedScale(state.stamina));

  if (state.stamina > 0) {
    state.stamina = fr(state.stamina - fmul(dt, STAMINA.RECOVERY_RATE));
    if (state.stamina < 0) state.stamina = 0;
  }

  applyDuck(state, duckButton, world, dt);
  if (duckButton || state.inDuckTransition || state.ducking) {
    maxSpeed = fmul(maxSpeed, duckSpeedModifier(state.duckAmount));
  }

  const hull = state.ducked ? HULL_DUCK : HULL_STAND;

  if (state.ladderRegrab > 0) state.ladderRegrab--;
  let ladder =
    world.ladderAt && state.ladderRegrab <= 0 ? world.ladderAt(state.pos, HULL_HALF_WIDE, hull) : null;
  if (ladder && ladder.normal && ladder.normal.z === 1) ladder = null;
  if (ladder) {
    ladderMove(state, input, world, hull, ladder, dt, duckButton, walkButton);
    checkVelocity(vel);
    return state;
  }
  state.onLadder = false;

  if (!state.onGround) state.fallVelocity = fr(-vel.z);

  vel.z = fr(vel.z - fmul(GRAVITY, fmul(0.5, dt)));

  if (input.jump) checkJumpButton(state, true, dt, weaponMax);
  else state.jumpHeld = false;

  if (state.onGround) {
    vel.z = 0;
    state.fallVelocity = 0;
    friction(vel, dt);
  }
  checkVelocity(vel);

  yawBasis(input.yaw, _fwd, _right);
  const fmove = fmul(input.forward, maxSpeed);
  const smove = fmul(input.side, maxSpeed);
  v3set(
    _wishVel,
    fr(fmul(_fwd.x, fmove) + fmul(_right.x, smove)),
    fr(fmul(_fwd.y, fmove) + fmul(_right.y, smove)),
    0
  );
  v3copy(_wishDir, _wishVel);
  let wishSpeed = v3normalize(_wishDir);
  if (wishSpeed > maxSpeed) wishSpeed = maxSpeed;

  const accelCtx = {
    ducking: duckButton || state.inDuckTransition || state.ducking,
    walking: !!input.walk && !(duckButton || state.inDuckTransition || state.ducking),
    weaponMax,
    scoped: !!input.scoped,
    maxSpeed
  };

  if (state.onGround) {
    walkMove(state, _wishDir, wishSpeed, world, hull, dt, accelCtx);
  } else {
    airMove(state, _wishDir, wishSpeed, world, hull, dt);
  }

  categorizePosition(state, world, hull);
  checkVelocity(vel);

  finishGravity(vel, dt);
  if (state.onGround) vel.z = 0;

  if (state.onGround && state.fallVelocity > 0) {
    onLand(state, state.fallVelocity);
    state.fallVelocity = 0;
  }

  if (state.onGround && state.velocityModifier < 1) {
    state.velocityModifier = fclamp(
      fr(state.velocityModifier + fmul(dt, VELOCITY_MODIFIER_RECOVERY)),
      0,
      fr(1)
    );
  }

  return state;
}

/**
 * Source's forward vector from view angles, Source frame. Pitch is positive
 * DOWN, which is why the z term is negated.
 */
function viewForward(yawDeg, pitchDeg, out) {
  const y = fmul(yawDeg, fr(Math.PI / 180));
  const p = fmul(pitchDeg, fr(Math.PI / 180));
  const cp = fr(Math.cos(p));
  return v3set(out, fmul(cp, fr(Math.cos(y))), fmul(cp, fr(Math.sin(y))), fr(-Math.sin(p)));
}

const _ladderWish = v3();
const _ladderTmp = v3();

/**
 * Source LadderMove. No gravity, no friction, no ground: the wish velocity is
 * built from the FULL view direction (pitch included, which is what makes
 * looking up climb and looking down descend), flattened into the ladder's
 * plane so a body cannot push through the rungs, and capped at the climb
 * speed. Letting go of every key leaves it hanging still.
 *
 * Jump pushes off along the ladder's outward normal and locks the grab out for
 * a few ticks, or the same volume catches the body again on the next one.
 */
function ladderMove(state, input, world, hull, ladder, dt, duckButton = false, walkButton = false) {
  const vel = state.vel;
  state.onLadder = true;
  state.onGround = false;

  if (input.jump) {
    v3set(
      vel,
      fmul(ladder.normal.x, LADDER_JUMP_AWAY),
      fmul(ladder.normal.y, LADDER_JUMP_AWAY),
      fmul(ladder.normal.z, LADDER_JUMP_AWAY)
    );
    state.onLadder = false;
    state.ladderRegrab = LADDER_REGRAB;
    tryPlayerMove(state, world, hull, dt);
    return;
  }

  let climb = fmul(CLIMB_SPEED, LADDER_SPEED_SCALE);
  if (duckButton || walkButton) climb = fmul(climb, CLIMB_MODIFIER);
  const lateral = duckButton ? fr(1) : fr(0.5);
  viewForward(input.yaw, input.pitch || 0, _fwd);
  yawBasis(input.yaw, _ladderTmp, _right);
  const fmove = fmul(input.forward, climb);
  const smove = fmul(input.side, fmul(climb, lateral));
  v3set(
    _ladderWish,
    fr(fmul(_fwd.x, fmove) + fmul(_right.x, smove)),
    fr(fmul(_fwd.y, fmove) + fmul(_right.y, smove)),
    fr(fmul(_fwd.z, fmove) + fmul(_right.z, smove))
  );
  // Into the ladder is not a direction you can go; along it is.
  const into = v3dot(_ladderWish, ladder.normal);
  if (into < 0) {
    _ladderWish.x = fr(_ladderWish.x - fmul(ladder.normal.x, into));
    _ladderWish.y = fr(_ladderWish.y - fmul(ladder.normal.y, into));
    _ladderWish.z = fr(_ladderWish.z - fmul(ladder.normal.z, into));
  }
  const speed = v3len(_ladderWish);
  if (speed > climb) v3scale(_ladderWish, _ladderWish, fdiv(climb, speed));
  v3copy(vel, _ladderWish);
  tryPlayerMove(state, world, hull, dt);
}

/**
 * Source Friction: bleed speed by control·friction·dt, where control is
 * boosted to sv_stopspeed at low speed — that boost is the crisp CS stop.
 */
function friction(vel, dt) {
  const speed = v3len(vel);
  if (speed < 0.0001) return;
  const control = speed < STOP_SPEED ? STOP_SPEED : speed;
  const drop = fmul(control, fmul(FRICTION, dt));
  let newspeed = fr(speed - drop);
  if (newspeed < 0) newspeed = 0;
  if (newspeed !== speed) {
    newspeed = fdiv(newspeed, speed);
    vel.x = fmul(vel.x, newspeed);
    vel.y = fmul(vel.y, newspeed);
    vel.z = fmul(vel.z, newspeed);
  }
}

/** CCSGameMovement::Accelerate (sv_accelerate_use_weapon_speed path, exponent time 0). */
function accelerate(vel, wishDir, wishSpeed, dt, ctx) {
  const currentspeed = v3dot(vel, wishDir);
  const addspeed = fr(wishSpeed - currentspeed);
  if (addspeed <= 0) return;

  const bIsDucking = !!ctx.ducking;
  const bIsWalking = !!ctx.walking && !bIsDucking;
  let fAccelerationScale = wishSpeed > ACCEL_SPEED_REF ? wishSpeed : ACCEL_SPEED_REF;
  let flGoalSpeed = fAccelerationScale;
  const weaponMax = ctx.weaponMax;
  const bIsSlowSniperScoped =
    !!ctx.scoped && fmul(weaponMax, WALK_SPEED_SCALE) < fr(110);

  if (ACCELERATE_USE_WEAPON_SPEED) {
    const wscale = weaponMax < ACCEL_SPEED_REF ? fdiv(weaponMax, ACCEL_SPEED_REF) : fr(1);
    flGoalSpeed = fmul(flGoalSpeed, wscale);
    if ((!bIsDucking && !bIsWalking) || ((bIsWalking || bIsDucking) && bIsSlowSniperScoped)) {
      fAccelerationScale = fmul(fAccelerationScale, wscale);
    }
  }

  if (bIsDucking) {
    if (!bIsSlowSniperScoped) fAccelerationScale = fmul(fAccelerationScale, DUCK_SPEED_SCALE);
    flGoalSpeed = fmul(flGoalSpeed, DUCK_SPEED_SCALE);
  }
  if (bIsWalking) {
    if (!bIsSlowSniperScoped) fAccelerationScale = fmul(fAccelerationScale, WALK_SPEED_SCALE);
    flGoalSpeed = fmul(flGoalSpeed, WALK_SPEED_SCALE);
  }

  let storedAccel = ACCEL;
  const goalMinus5 = fr(flGoalSpeed - 5);
  if (bIsWalking && currentspeed > goalMinus5) {
    const numer = currentspeed - goalMinus5 > 0 ? fr(currentspeed - goalMinus5) : 0;
    const denom = flGoalSpeed - goalMinus5 > 0 ? fr(flGoalSpeed - goalMinus5) : 0;
    const t = denom > 0 ? fclamp(fr(1 - fdiv(numer, denom)), 0, 1) : 0;
    storedAccel = fmul(storedAccel, t);
  }

  let accelspeed = fmul(storedAccel, fmul(dt, fAccelerationScale));
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x = fr(vel.x + fmul(accelspeed, wishDir.x));
  vel.y = fr(vel.y + fmul(accelspeed, wishDir.y));
  vel.z = fr(vel.z + fmul(accelspeed, wishDir.z));
}

/**
 * Source AirAccelerate: the projection cap shrinks to 30 u/s but the increment
 * still scales with the full wish speed — the asymmetry air-strafing lives in.
 */
function airAccelerate(vel, wishDir, wishSpeed, dt) {
  const wishspd = wishSpeed > AIR_SPEED_CAP ? AIR_SPEED_CAP : wishSpeed;
  const currentspeed = v3dot(vel, wishDir);
  const addspeed = fr(wishspd - currentspeed);
  if (addspeed <= 0) return;
  let accelspeed = fmul(AIR_ACCEL, fmul(wishSpeed, dt));
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x = fr(vel.x + fmul(accelspeed, wishDir.x));
  vel.y = fr(vel.y + fmul(accelspeed, wishDir.y));
  vel.z = fr(vel.z + fmul(accelspeed, wishDir.z));
}

function walkMove(state, wishDir, wishSpeed, world, hull, dt, ctx) {
  const vel = state.vel;
  vel.z = 0;
  accelerate(vel, wishDir, wishSpeed, dt, ctx);
  vel.z = 0;
  const spd = v3len(vel);
  const cap = ctx.maxSpeed;
  if (spd > cap && cap > 0) {
    const ratio = fdiv(cap, spd);
    vel.x = fmul(vel.x, ratio);
    vel.y = fmul(vel.y, ratio);
    vel.z = fmul(vel.z, ratio);
  }
  if (v3len(vel) < SPEED_EPSILON) {
    v3set(vel, 0, 0, 0);
    return;
  }
  stepMove(state, world, hull, dt);
}

function airMove(state, wishDir, wishSpeed, world, hull, dt) {
  airAccelerate(state.vel, wishDir, wishSpeed, dt);
  tryPlayerMove(state, world, hull, dt);
}

/**
 * Source StepMove: attempt the move flat; if a wall ate part of it, rewind,
 * climb STEP_HEIGHT, move again, drop back down, and keep whichever attempt
 * travelled farther horizontally. This is stairs, curbs and ramps-as-stairs.
 */
function stepMove(state, world, hull, dt) {
  const startPos = v3();
  const startVel = v3();
  v3copy(startPos, state.pos);
  v3copy(startVel, state.vel);

  // Attempt 1: straight.
  tryPlayerMove(state, world, hull, dt);
  const downPos = v3();
  const downVel = v3();
  v3copy(downPos, state.pos);
  v3copy(downVel, state.vel);

  // Attempt 2: up, across, down.
  v3copy(state.pos, startPos);
  v3copy(state.vel, startVel);
  let t = world.traceHull(state.pos, v3set(_end, state.pos.x, state.pos.y, fr(state.pos.z + STEP_HEIGHT)), HULL_HALF_WIDE, hull);
  v3copy(state.pos, t.endpos);
  tryPlayerMove(state, world, hull, dt);
  t = world.traceHull(state.pos, v3set(_end, state.pos.x, state.pos.y, fr(state.pos.z - STEP_HEIGHT)), HULL_HALF_WIDE, hull);
  // Stepping onto a non-walkable slope is not a step; take the flat result.
  if (!t.startSolid && t.normal && t.normal.z < GROUND_NORMAL_MIN) {
    v3copy(state.pos, downPos);
    v3copy(state.vel, downVel);
    return;
  }
  v3copy(state.pos, t.endpos);

  const flat = dist2d(startPos, downPos);
  const stepped = dist2d(startPos, state.pos);
  if (flat > stepped) {
    v3copy(state.pos, downPos);
    v3copy(state.vel, downVel);
  } else {
    // Source keeps the stepped position but the flat move's vertical speed.
    state.vel.z = downVel.z;
  }
}

function dist2d(a, b) {
  const dx = fr(b.x - a.x);
  const dy = fr(b.y - a.y);
  return fr(fmul(dx, dx) + fmul(dy, dy));
}

/**
 * Source TryPlayerMove: collide-and-slide. Up to four plane bumps; velocity is
 * clipped against each plane hit; wedged between two planes, slide along their
 * crease; moving back into the original direction means stop dead.
 */
function tryPlayerMove(state, world, hull, dt) {
  const vel = state.vel;
  v3copy(_origVel, vel);
  let timeLeft = dt;
  const planes = [];

  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    if (vel.x === 0 && vel.y === 0 && vel.z === 0) break;
    v3mulAdd(_end, state.pos, vel, timeLeft);
    const t = world.traceHull(state.pos, _end, HULL_HALF_WIDE, hull);

    if (t.startSolid) {
      // Stuck in a solid: kill velocity, stay put. (Unstuck logic is a later
      // concern; demos never start solid, and the BVH world reports it.)
      v3set(vel, 0, 0, 0);
      return;
    }
    v3copy(state.pos, t.endpos);
    if (t.fraction === 1) break;

    timeLeft = fr(timeLeft - fmul(timeLeft, t.fraction));
    planes.push({ x: t.normal.x, y: t.normal.y, z: t.normal.z });

    if (planes.length === 1) {
      clipVelocity(vel, planes[0], _clipped);
      v3copy(vel, _clipped);
    } else {
      // Try clipping against each plane; accept the first that doesn't push
      // into another. Failing that, slide the crease of the last two.
      let ok = false;
      for (let i = 0; i < planes.length && !ok; i++) {
        clipVelocity(vel, planes[i], _clipped);
        ok = true;
        for (let j = 0; j < planes.length; j++) {
          if (j !== i && v3dot(_clipped, planes[j]) < 0) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        v3copy(vel, _clipped);
      } else if (planes.length === 2) {
        const a = planes[0];
        const b = planes[1];
        const dir = v3(
          fr(fmul(a.y, b.z) - fmul(a.z, b.y)),
          fr(fmul(a.z, b.x) - fmul(a.x, b.z)),
          fr(fmul(a.x, b.y) - fmul(a.y, b.x))
        );
        v3normalize(dir);
        const d = v3dot(dir, vel);
        v3scale(vel, dir, d);
      } else {
        v3set(vel, 0, 0, 0);
        return;
      }
    }

    // Reversing against the original intent means wedged: stop.
    if (v3dot(vel, _origVel) <= 0) {
      v3set(vel, 0, 0, 0);
      return;
    }
  }
}

/**
 * Source ClipVelocity with overbounce 1: remove the into-plane component,
 * then sweep once more for float dust left pointing into the plane.
 */
function clipVelocity(vel, normal, out) {
  const backoff = v3dot(vel, normal);
  out.x = fr(vel.x - fmul(normal.x, backoff));
  out.y = fr(vel.y - fmul(normal.y, backoff));
  out.z = fr(vel.z - fmul(normal.z, backoff));
  const adjust = v3dot(out, normal);
  if (adjust < 0) {
    out.x = fr(out.x - fmul(normal.x, adjust));
    out.y = fr(out.y - fmul(normal.y, adjust));
    out.z = fr(out.z - fmul(normal.z, adjust));
  }
}

/**
 * Source CategorizePosition: rising faster than NON_JUMP_VELOCITY can never
 * be grounded; otherwise probe 2u down and stand on any walkable plane,
 * snapping the origin onto it so slopes don't accumulate hover.
 */
function categorizePosition(state, world, hull) {
  if (state.vel.z > NON_JUMP_VELOCITY) {
    state.onGround = false;
    return;
  }
  const t = world.traceHull(
    state.pos,
    v3set(_end, state.pos.x, state.pos.y, fr(state.pos.z - GROUND_PROBE)),
    HULL_HALF_WIDE,
    hull
  );
  if (t.fraction < 1 && t.normal && t.normal.z >= GROUND_NORMAL_MIN) {
    state.onGround = true;
    v3copy(state.groundNormal, t.normal);
    v3copy(state.pos, t.endpos);
  } else {
    state.onGround = false;
  }
}

/** Per-axis sv_maxvelocity clamp. */
function checkVelocity(vel) {
  if (vel.x > MAX_VELOCITY) vel.x = MAX_VELOCITY;
  else if (vel.x < -MAX_VELOCITY) vel.x = -MAX_VELOCITY;
  if (vel.y > MAX_VELOCITY) vel.y = MAX_VELOCITY;
  else if (vel.y < -MAX_VELOCITY) vel.y = -MAX_VELOCITY;
  if (vel.z > MAX_VELOCITY) vel.z = MAX_VELOCITY;
  else if (vel.z < -MAX_VELOCITY) vel.z = -MAX_VELOCITY;
}

// ---------------------------------------------------------------------------
// Analytic worlds. The oracle validates dynamics against these; the map BVH
// world implements the same one-method interface next.
// ---------------------------------------------------------------------------

const NO_HIT = Object.freeze({ fraction: 1, normal: null, startSolid: false });

/**
 * An infinite floor at z = groundZ. Exact fractions, no BVH — pure dynamics.
 */
export function flatWorld(groundZ = 0) {
  const g = fr(groundZ);
  const up = Object.freeze({ x: 0, y: 0, z: 1 });
  return {
    traceHull(start, end, halfWide, height) {
      if (start.z < g) {
        return { fraction: 0, endpos: { x: start.x, y: start.y, z: start.z }, normal: up, startSolid: true };
      }
      if (end.z >= g || end.z >= start.z) {
        return { ...NO_HIT, endpos: { x: end.x, y: end.y, z: end.z } };
      }
      const fraction = fdiv(fr(start.z - g), fr(start.z - end.z));
      return {
        fraction,
        endpos: {
          x: fr(start.x + fmul(fr(end.x - start.x), fraction)),
          y: fr(start.y + fmul(fr(end.y - start.y), fraction)),
          z: g
        },
        normal: up,
        startSolid: false
      };
    }
  };
}

/** No geometry at all: for ballistic segments the oracle replays in free air. */
export function emptyWorld() {
  return {
    traceHull(start, end) {
      return { ...NO_HIT, endpos: { x: end.x, y: end.y, z: end.z } };
    }
  };
}
