// ---------------------------------------------------------------------------
// shared/sim3d/motion.js
// The player movement tick: Source's CGameMovement pipeline in f32, in Source
// coordinates (z-up, units), against a pluggable collision world.
//
// The order of operations IS the physics here. FullWalkMove applies gravity in
// two half-tick pieces around the move (leapfrog), zeroes vertical velocity on
// ground BEFORE friction, and jumping applies the impulse and then immediately
// eats its own half-gravity — so a jump's first tick rises by
// (J − g·dt/2)·dt = 4.62098u, not J·dt = 4.71865u. That 0.098u difference is
// measurable in the demo corpus across thousands of jumps, which is how
// scripts/cs3d-oracle.mjs verifies not just the constants but this exact
// integrator order. Reorder anything in stepPlayer and the oracle drifts.
//
// What this file deliberately is NOT yet:
//   - the real duck state machine (constants.js DUCK explains why; duck here
//     is an instant hull/speed change, honest about being provisional),
//   - subtick input timing (inputs land on tick boundaries; a no-input tick
//     is bit-identical either way, which is what the oracle exercises),
//   - stamina (present but disabled until measured — STAMINA.ENABLED).
//
// The collision world is an interface so the same brain runs everywhere:
//   world.traceHull(start, end, halfWide, height) →
//     { fraction, endpos:{x,y,z}, normal:{x,y,z}|null, startSolid }
// flatWorld() below is the analytic implementation the oracle uses for pure
// dynamics; the BVH world over a map pack's phys.glb plugs in the same way.
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
  HULL_HALF_WIDE,
  HULL_STAND,
  HULL_DUCK,
  STEP_HEIGHT
} from './constants.js';

/** How far CategorizePosition looks down for ground under the feet. */
const GROUND_PROBE = fr(2);
/** Collide-and-slide gives up after this many plane bumps (Source: 4). */
const MAX_BUMPS = 4;
/** Speeds under this are snapped to zero on ground (Source WalkMove). */
const SPEED_EPSILON = fr(1);

export function createPlayerState(x = 0, y = 0, z = 0) {
  return {
    pos: v3(x, y, z),
    vel: v3(),
    onGround: false,
    ducking: false,
    /** Set by CategorizePosition when standing on a walkable plane. */
    groundNormal: v3(0, 0, 1)
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
  return { forward: 0, side: 0, yaw: 0, jump: false, duck: false, walk: false, maxSpeed: 250 };
}

// Scratch vectors: stepPlayer allocates nothing per tick.
const _fwd = v3();
const _right = v3();
const _wishVel = v3();
const _wishDir = v3();
const _end = v3();
const _origVel = v3();
const _clipped = v3();

/**
 * Advance one player one tick. Mutates `state`. FullWalkMove, in its order.
 */
export function stepPlayer(state, input, world, dt = TICK_DT) {
  const vel = state.vel;

  // Duck, provisional (see header): instant cap + hull swap.
  state.ducking = !!input.duck;
  const hull = state.ducking ? HULL_DUCK : HULL_STAND;

  // StartGravity: first half-tick. Applied on ground too — the ground branch
  // zeroes vel.z right after, which is exactly why the order is visible only
  // on the jump tick, where CheckJumpButton overwrites vel.z in between.
  vel.z = fr(vel.z - fmul(GRAVITY, fmul(0.5, dt)));

  // CheckJumpButton: only from the ground; sets the impulse absolutely, then
  // pre-pays the second gravity half so the airborne branch this same tick
  // integrates the already-decayed velocity.
  if (input.jump && state.onGround) {
    vel.z = fr(JUMP_IMPULSE - fmul(GRAVITY, fmul(0.5, dt)));
    state.onGround = false;
  }

  if (state.onGround) {
    vel.z = 0;
    friction(vel, dt);
  }
  checkVelocity(vel);

  // Wish velocity from view yaw + move fractions, ground-plane only.
  yawBasis(input.yaw, _fwd, _right);
  let maxSpeed = fr(input.maxSpeed);
  if (state.ducking) maxSpeed = fmul(maxSpeed, DUCK_SPEED_SCALE);
  else if (input.walk) maxSpeed = fmul(maxSpeed, WALK_SPEED_SCALE);
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

  if (state.onGround) {
    walkMove(state, _wishDir, wishSpeed, world, hull, dt);
  } else {
    airMove(state, _wishDir, wishSpeed, world, hull, dt);
  }

  categorizePosition(state, world, hull);
  checkVelocity(vel);

  // FinishGravity: second half-tick.
  vel.z = fr(vel.z - fmul(GRAVITY, fmul(0.5, dt)));
  if (state.onGround) vel.z = 0;

  return state;
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

/** Source Accelerate: grow projected speed toward wishSpeed at sv_accelerate. */
function accelerate(vel, wishDir, wishSpeed, accel, dt) {
  const currentspeed = v3dot(vel, wishDir);
  const addspeed = fr(wishSpeed - currentspeed);
  if (addspeed <= 0) return;
  let accelspeed = fmul(accel, fmul(dt, wishSpeed));
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

function walkMove(state, wishDir, wishSpeed, world, hull, dt) {
  const vel = state.vel;
  accelerate(vel, wishDir, wishSpeed, ACCEL, dt);
  vel.z = 0;
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
