// ---------------------------------------------------------------------------
// shared/sim/movement2d.js
// Source ground movement on the 2D radar plane, in units, at a fixed timestep.
//
// This is a port of PM_Friction / PM_Accelerate, not a new movement model. The
// functions in src/utils/SourceMovement.js are the same routines expressed in
// metres on an {x, z} vector, because that is the trainer's world. The sim's
// world is the radar plane: units, {x, y}, and the same numbers the demo parser
// writes. Converting between the two every tick is precisely the kind of skew
// that makes a simulation quietly stop matching the demos it was fitted on, so
// there are two expressions of one model and movement2d.test.js asserts they
// produce the same trajectory to within float noise.
//
// Requirement D depends on this file being boring: same accel, same friction,
// same stopspeed, same caps. A bot ramping out of cover has to look like a
// player ramping out of cover, and that is entirely a property of these forty
// lines.
//
// Collision is the creator's disc: radius 16, move-then-slide, keep whichever
// axis is clear. Bots hug corners instead of sticking to them.
//
// DOM-free and allocation-free in the hot path: every function mutates the
// vectors it is given.
// ---------------------------------------------------------------------------

import {
  BODY_RADIUS,
  SV_ACCELERATE,
  SV_FRICTION,
  SV_STOPSPEED,
  TICK_DT
} from './constants.js';

/**
 * PM_Friction, in units. Bleeds horizontal speed every tick, harder below
 * sv_stopspeed so a body comes to a crisp halt rather than sliding.
 *
 * @param {{x: number, y: number}} vel   mutated
 * @param {number} dt                    seconds
 * @param {number} [activeWishSpeed]     when moving under a cap below stopspeed
 *   (crouch walk), skip the stopspeed boost so friction does not erase the
 *   acceleration that is trying to get the body moving at all.
 */
export function friction(vel, dt, activeWishSpeed = 0) {
  const speed = Math.hypot(vel.x, vel.y);
  if (speed < 1e-6) {
    vel.x = 0;
    vel.y = 0;
    return;
  }
  let control = speed < SV_STOPSPEED ? SV_STOPSPEED : speed;
  if (activeWishSpeed > 0 && speed < activeWishSpeed) control = speed;
  const drop = control * SV_FRICTION * dt;
  const scale = Math.max(0, speed - drop) / speed;
  vel.x *= scale;
  vel.y *= scale;
}

/**
 * PM_Accelerate, in units. Adds speed along a unit wish direction, capped so
 * the projected speed never exceeds wishSpeed. This is the Source ramp-up.
 *
 * @param {{x: number, y: number}} vel  mutated
 * @param {number} wishX  unit vector
 * @param {number} wishY
 * Note what is capped: the PROJECTION of velocity onto the wish direction, not
 * its magnitude. A body turning while at speed therefore carries a
 * perpendicular component the cap cannot see, and its total speed sits a little
 * above `wishSpeed` until friction takes it back. That is not a bug to clamp
 * away: it is the mechanism behind every Source movement trick, it is what the
 * trainer's integrator does, and clamping it here would make the sim's
 * cornering visibly slower than a real player's.
 *
 * @param {number} wishSpeed  units/s
 * @param {number} dt  seconds
 */
export function accelerate(vel, wishX, wishY, wishSpeed, dt) {
  const current = vel.x * wishX + vel.y * wishY;
  const add = wishSpeed - current;
  if (add <= 0) return;
  let accel = SV_ACCELERATE * dt * wishSpeed;
  if (accel > add) accel = add;
  vel.x += accel * wishX;
  vel.y += accel * wishY;
}

/**
 * One ground tick: friction, then acceleration. Position is not touched, so
 * callers can integrate through their own collision.
 *
 * @param {{x: number, y: number}} vel  mutated
 * @param {{x: number, y: number}|null} wish  unit direction, or null for no input
 * @param {number} wishSpeed  the gait/weapon cap in units/s
 * @param {number} dt
 */
export function stepVelocity(vel, wish, wishSpeed, dt) {
  friction(vel, dt, wish ? wishSpeed : 0);
  if (wish) accelerate(vel, wish.x, wish.y, wishSpeed, dt);
}

/**
 * Move a disc by (dx, dy) against a solidity test, sliding along whatever it
 * hits. The axis that is blocked loses its velocity; the other one survives.
 *
 * `isSolid(x, y)` answers for a point. The disc is sampled at its four extremes,
 * which is what the creator does and is enough at r=16 against a 1024-cell mask:
 * a gap narrower than the body cannot be entered, and a corner is brushed
 * rather than caught.
 *
 * @param {{x: number, y: number}} pos  mutated
 * @param {{x: number, y: number}} vel  mutated when an axis is blocked
 * @param {number} dx
 * @param {number} dy
 * @param {(x: number, y: number) => boolean} isSolid
 * @returns {boolean} true when the body moved at all
 */
export function slideMove(pos, vel, dx, dy, isSolid) {
  if (!dx && !dy) return false;
  const blocked = (x, y) =>
    isSolid(x, y) ||
    isSolid(x + BODY_RADIUS, y) ||
    isSolid(x - BODY_RADIUS, y) ||
    isSolid(x, y + BODY_RADIUS) ||
    isSolid(x, y - BODY_RADIUS);

  const nx = pos.x + dx;
  const ny = pos.y + dy;
  if (!blocked(nx, ny)) {
    pos.x = nx;
    pos.y = ny;
    return true;
  }
  // One axis at a time. `dx !== 0` matters: without it, a body walking straight
  // into a wall takes the x branch (where nx === pos.x, so nothing is blocked
  // and nothing moves) and reports success, which reads to a caller as "the
  // path is clear" when the body is in fact stuck against geometry. That is
  // exactly the signal the follow controller uses to fire a local interrupt.
  if (dx !== 0 && !blocked(nx, pos.y)) {
    pos.x = nx;
    vel.y = 0;
    return true;
  }
  if (dy !== 0 && !blocked(pos.x, ny)) {
    pos.y = ny;
    vel.x = 0;
    return true;
  }
  vel.x = 0;
  vel.y = 0;
  return false;
}

/**
 * A full ground tick with collision: velocity, then position.
 *
 * @param {{pos: {x: number, y: number}, vel: {x: number, y: number}}} body  mutated
 * @param {{x: number, y: number}|null} wish
 * @param {number} wishSpeed
 * @param {number} dt
 * @param {(x: number, y: number) => boolean} [isSolid]  omit for no collision
 */
export function stepBody(body, wish, wishSpeed, dt, isSolid) {
  stepVelocity(body.vel, wish, wishSpeed, dt);
  const dx = body.vel.x * dt;
  const dy = body.vel.y * dt;
  if (!isSolid) {
    body.pos.x += dx;
    body.pos.y += dy;
    return;
  }
  slideMove(body.pos, body.vel, dx, dy, isSolid);
}

/**
 * Normalize a direction. Returns null for a zero vector so callers can pass the
 * result straight through as "no input".
 *
 * @returns {{x: number, y: number}|null}
 */
export function unit(x, y) {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return null;
  return { x: x / len, y: y / len };
}

/**
 * How far a body travels before a counter-strafe brings it to rest, in units.
 *
 * Worth deriving rather than guessing, because the obvious guess (`speed * a
 * constant`) is wrong by a factor of three at rifle speed and produces a bot
 * that brakes far too early, accelerates again because it is now slow enough
 * that the estimate says it can, and tap-dances its way to the spot. That looks
 * exactly like a bad bot and it is entirely an artefact of the estimate.
 *
 * Counter-strafing decelerates from two sources at once, and over the range
 * that matters both are close to constant:
 *
 *   accelerate() pushes against the motion at SV_ACCELERATE * cap per second,
 *   because the projection of velocity onto the reverse direction is negative,
 *   so the cap is never the binding constraint while braking.
 *
 *   friction() removes SV_FRICTION * max(speed, SV_STOPSPEED) per second.
 *
 * Taking friction at the current speed gives a slight underestimate as the body
 * slows, which is the safe direction: braking a fraction late costs a unit of
 * overshoot, braking early costs the chatter this function exists to avoid.
 */
export function stopDistance(speed, cap) {
  if (speed <= 0) return 0;
  const decel = SV_ACCELERATE * cap + SV_FRICTION * Math.max(speed, SV_STOPSPEED);
  return (speed * speed) / (2 * decel);
}

/**
 * The wish direction to reach a target, counter-strafing to brake so the body
 * arrives stationary. This is SourceMover1D.seek generalized to two dimensions
 * and given a real stopping distance, and it is what makes a bot stop on a peek
 * spot the way a player does rather than sliding through it.
 *
 * Returns null once it has arrived and settled, which the caller reads as "no
 * input".
 *
 * @param {{x: number, y: number}} pos
 * @param {{x: number, y: number}} vel
 * @param {{x: number, y: number}} target
 * @param {number} [cap]  the gait's speed cap, which sets the braking force
 * @param {number} [arriveRadius]  units within which the target counts as reached
 * @returns {{x: number, y: number}|null}
 */
export function seekDirection(pos, vel, target, cap = 215, arriveRadius = 2) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  const speed = Math.hypot(vel.x, vel.y);

  // One tick of counter-press adds this much speed in the opposite direction.
  // Pressing when the body is slower than that does not stop it, it turns it
  // around, and the body then oscillates across the target forever with a
  // velocity that never decays. Below the threshold, release and let friction
  // finish: it removes SV_FRICTION * SV_STOPSPEED per second at low speed and
  // snaps to exactly zero, which is what a released key actually does.
  const oneTickPress = SV_ACCELERATE * cap * TICK_DT;
  const brake = () => (speed > oneTickPress ? unit(-vel.x, -vel.y) : null);

  if (dist <= arriveRadius) return brake();

  const toward = unit(dx, dy);
  if (!toward) return null;

  const closing = speed > 1 && vel.x * toward.x + vel.y * toward.y > 0;
  if (closing && dist <= stopDistance(speed, cap)) return brake();
  return toward;
}
