// ---------------------------------------------------------------------------
// shared/sim3d/grenade.js
// Grenades: the throw, the flight, the bounce, the fuse. Source frame, f32,
// same trace interface as motion.js.
//
// Almost nothing here is guessed, and that is unusual. A CS2 demo networks the
// projectile's own state, so the constants below were not fitted from
// trajectories — they were read off the entity that flew them:
//
//   m_vInitialVelocity   the exact release velocity vector, per throw
//   m_flGravityScale     0.4        (f32 0.4000000059604645, every projectile)
//   m_flElasticity       0.4375     (= 7/16, every projectile)
//   m_flCreateTime /     the server's own scheduled detonation
//   m_flDetonateTime
//   m_flThrowStrength    the throw strength the player released at
//
// Pairing m_vInitialVelocity with the thrower's view angles and velocity turns
// the throw model into algebra rather than regression. In particular the
// sideways component of the release velocity can only have come from the
// thrower's own motion, which gives one exact estimate of the inheritance
// coefficient per throw (see VELOCITY_INHERIT).
//
// Measurements below are from 639 pro throws across three demos, 2026-08-18;
// `scripts/cs3d-oracle.mjs` is where they get re-checked against new corpora.
// ---------------------------------------------------------------------------

import { fr, fmul, fdiv, v3, v3set, v3copy, v3dot, v3mulAdd, v3len } from './fp.js';
import { GRAVITY, JUMP_IMPULSE, TICK_DT } from './constants.js';

// ---- flight ---------------------------------------------------------------

/**
 * [measured] Grenades fall under a fraction of sv_gravity. Not fitted: the
 * projectile networks `m_flGravityScale` and it reads 0.4 on every grenade of
 * every type in the corpus.
 */
export const GRENADE_GRAVITY_SCALE = fr(0.4);

/**
 * [measured] Bounce damping, from the projectile's own `m_flElasticity`.
 * Exactly 0.4375 (7/16) on every type. CS:GO `GetGrenadeElasticity()` is 0.45;
 * CS2 networks 0.4375 and the nade oracle's bounce ratios land on that, not 0.45.
 */
export const GRENADE_ELASTICITY = fr(0.4375);

/**
 * [docs] CS:GO `GetGrenadeFriction()` = 0.2. `ResolveFlyCollisionCustom` never
 * multiplies by it (that is `ResolveFlyCollisionSlide`). Bounce is reflect then
 * scale the whole vector by elasticity; applying this here would skid nades
 * shorter than CS2 recordings.
 */
export const GRENADE_FRICTION = fr(0.2);

/**
 * [docs] Source's grenade bounce, from `ResolveFlyCollisionCustom`: reflect the
 * velocity through the plane with a backoff of 2.0 — a PERFECT reflection —
 * and then scale the WHOLE vector by the elasticity. Tangential speed is
 * damped by the same factor as normal speed; there is no separate friction
 * term. This constant is the reflection backoff, and 2.0 is what makes it a
 * mirror rather than a partial one.
 */
const BOUNCE_BACKOFF = fr(2);

/** [docs] Grenades trace as a small point hull; the model's size is cosmetic. */
export const GRENADE_RADIUS = fr(2);

/**
 * [docs] Below this speed, on ground flat enough to hold it, the grenade rests.
 * Source tests the squared speed against 30*30 after the bounce has already
 * been damped.
 */
export const REST_SPEED = fr(30);

/** [docs] A surface holds a resting grenade when its normal.z is at least this. */
const REST_NORMAL_Z = fr(0.7);

// ---- the throw ------------------------------------------------------------

/**
 * [docs] `m_flThrowVelocity` from the game's own weapon table
 * (scripts/weapons.vdata): 750 for all six grenades.
 */
export const THROW_VELOCITY = fr(750);

/**
 * [docs] `ThrowGrenade`: `flVel = clamp(kBaseVelocity * 0.9, 15, 750)`.
 * 750 × 0.9 is 675. Pitch no longer scales speed (the old CSS `(90-pitch)*6`).
 */
export const THROW_SPEED_SCALE = fr(0.9);
const THROW_SPEED_MIN = fr(15);
const THROW_SPEED_MAX = fr(750);

/**
 * [docs] `GRENADE_SECONDARY_DAMPENING`. `flVel *= Lerp(strength, 0.3, 1.0)`,
 * so a full throw stays 675 and a right-click underhand is 202.5.
 *
 *   strength 1.000 -> 675.00   (n=215 CS2 throws)
 *   strength 0.500 -> 438.75
 *   strength 0.000 -> 202.50
 */
export const GRENADE_SECONDARY_DAMPENING = fr(0.3);
export const THROW_STRENGTH_FLOOR = GRENADE_SECONDARY_DAMPENING;

/** [docs] `GRENADE_SECONDARY_LOWER`: underhand drops the spawn origin this many units. */
export const GRENADE_SECONDARY_LOWER = fr(12);

/**
 * [measured] The three strengths the mouse produces. `m_flThrowStrength` is a
 * continuous field — 42 distinct values appear in one match — but it is
 * overwhelmingly at one of these three: across the sampled ticks, 1.0 and 0.5
 * and 0.0 account for all but a few hundred of them, and the rest are the
 * transition between two of them while a button is held.
 *
 *   primary (left)          1.0   ->  675.00 u/s
 *   both buttons            0.5   ->  438.75 u/s
 *   secondary (right)       0.0   ->  202.50 u/s
 */
export const THROW_STRENGTH = Object.freeze({ full: fr(1), medium: fr(0.5), short: fr(0) });

/**
 * [docs] `GRENADE_SECONDARY_TRANSITION`: `Approach(ideal, strength, dt * 1.3)`.
 * CS2 demos step about 0.02 a tick (1.28/s); the leak is 1.3.
 */
export const GRENADE_SECONDARY_TRANSITION = fr(1.3);
export const THROW_STRENGTH_RATE = GRENADE_SECONDARY_TRANSITION;

/**
 * [measured] How much of the thrower's own velocity the grenade inherits.
 *
 * Solved, not fitted. The release velocity along the view's RIGHT axis cannot
 * come from the throw (which is along the view), so
 *
 *   k = (v0 . right) / (playerVelocity . right)
 *
 * is one exact estimate per throw. Over the throws where the thrower had real
 * sideways motion: median 1.250, p25 1.197, p75 1.251, and 11 of 17 within 0.05
 * of 1.25. Ordinary airborne throws inherit this of the thrower's *live*
 * velocity. A jumpthrow inside the perfect window does not (see below).
 */
export const VELOCITY_INHERIT = fr(1.25);

/**
 * [measured] Seconds between the button coming up and the projectile existing.
 * weapon_fire to the projectile's first tick: median 6 ticks over 37 throws.
 * A jump+release on the same tick therefore spawns 6 ticks into the jump,
 * which is the latch a perfect jumpthrow is frozen to (eye and velocity).
 */
export const THROW_RELEASE_TICKS = 6;

/**
 * [measured] CS2's jumpthrow window. Jump, then release within this many
 * seconds, and the grenade is a perfect jumpthrow: eye and velocity latch to
 * the jump+throw-together spawn (THROW_RELEASE_TICKS into the jump), not the
 * live decaying rise at the later projectile spawn. The user-facing rule is
 * 199 ms from jump to button-up. 200 ms is the next tick and is *not* in
 * the window.
 */
export const PERFECT_JUMPTHROW_WINDOW = fr(0.199);

/**
 * Extra world-z a perfect jumpthrow inherits: 1.25 × player vz at the latch.
 * That vz is JUMP_IMPULSE minus gravity over THROW_RELEASE_TICKS, matching
 * ThrowGrenade(GetAbsVelocity()) for a jump+release on the same tick.
 */
export const PERFECT_JUMPTHROW_INHERIT_Z = fr(
  VELOCITY_INHERIT * (JUMP_IMPULSE - GRAVITY * THROW_RELEASE_TICKS * TICK_DT)
);

/** True when a button-up this many seconds after takeoff is a perfect jumpthrow. */
export function isPerfectJumpThrow(secondsSinceJump) {
  return secondsSinceJump >= 0 && secondsSinceJump <= PERFECT_JUMPTHROW_WINDOW;
}

/**
 * Player velocity THROW_RELEASE_TICKS after takeoff. `jump` is the snapshot
 * after the jump tick (FinishGravity already applied once); remaining ticks
 * only lose gravity. No jump snapshot: the same number from JUMP_IMPULSE.
 */
export function latchedJumpVelocity(jump = null, ticks = THROW_RELEASE_TICKS) {
  const n = ticks < 1 ? 1 : ticks;
  const vx = jump ? fr(jump.x) : 0;
  const vy = jump ? fr(jump.y) : 0;
  const z0 = jump && Number.isFinite(jump.z) ? fr(jump.z) : fr(JUMP_IMPULSE - fmul(GRAVITY, TICK_DT));
  return { x: vx, y: vy, z: fr(z0 - fmul(GRAVITY, fmul(fr(n - 1), TICK_DT))) };
}

/**
 * Eye and thrower velocity a perfect jumpthrow flies from: the ballistic
 * state THROW_RELEASE_TICKS after takeoff. Spawning at the ground eye with
 * a leftover vz read off sparse demo chords made lineups land short and low.
 *
 * @param {object} o
 * @param {{x,y,z}} o.eye   Source-frame eye at takeoff (before the jump tick)
 * @param {{x,y,z}|null} [o.vel]  Source-frame velocity after the jump tick
 */
export function perfectJumpThrowState({ eye, vel = null, ticks = THROW_RELEASE_TICKS }) {
  const n = ticks < 1 ? 1 : ticks;
  const dt = fmul(fr(n), TICK_DT);
  const velocity = latchedJumpVelocity(vel, n);
  const rise = fr(fmul(JUMP_IMPULSE, dt) - fmul(fmul(fr(0.5), GRAVITY), fmul(dt, dt)));
  return {
    eye: {
      x: fr((eye?.x || 0) + fmul(velocity.x, dt)),
      y: fr((eye?.y || 0) + fmul(velocity.y, dt)),
      z: fr((eye?.z || 0) + rise)
    },
    velocity
  };
}

/**
 * Thrower velocity to feed `releaseState`. Inside the perfect window the
 * horizontal part is the takeoff snapshot (standing: ~0, a W-jump: the run)
 * and z is the latch (6 ticks of jump gravity), so 1.25 × z equals
 * PERFECT_JUMPTHROW_INHERIT_Z. Outside the window the live velocity is used
 * unchanged — gravity has been eating the jump.
 *
 * @param {object} o
 * @param {{x,y,z}} o.live              Source-frame velocity at projectile spawn
 * @param {{x,y,z}|null} [o.jump]       Source-frame velocity at takeoff
 * @param {number} o.secondsSinceJump   at button-up, not at spawn
 * @param {boolean} [o.jumpHeldOnGround] same-tick jumpthrow: still grounded,
 *   jump will fire this movement tick
 */
export function throwerVelocity({ live, jump = null, secondsSinceJump, jumpHeldOnGround = false }) {
  if (!(jumpHeldOnGround || isPerfectJumpThrow(secondsSinceJump))) return live;
  return latchedJumpVelocity(jump);
}

/**
 * [docs] Unobstructed spawn: hull traces 22 along throw forward, then pulls
 * back 6, so the default is 16 out. A wall closer than 22 clips it.
 */
export const RELEASE_TRACE = fr(22);
export const RELEASE_PULLBACK = fr(6);
export const RELEASE_FORWARD = fr(16);

/**
 * [docs] `ThrowGrenade`: 10° up at the horizon, fading to 0 at ±90.
 *
 *   angThrow[PITCH] -= 10 * (90 - |pitch|) / 90
 *
 * Equivalent to `-10 + pitch * (up ? 80/90 : 100/90)`. Yaw is not remapped.
 */
export const THROW_PITCH_BOOST = fr(10);
export const THROW_PITCH_OFFSET = fr(-10);

/**
 * The pitch a grenade actually leaves at, degrees, Source convention
 * (negative is up, +90 is look down).
 */
export function throwPitch(viewPitch) {
  const p = fr(viewPitch);
  const mag = p < 0 ? fr(-p) : p;
  return fr(p - fmul(THROW_PITCH_BOOST, fdiv(fr(90 - mag), 90)));
}

/**
 * Release speed for a throw strength, units/second.
 * `clamp(throwVelocity * 0.9, 15, 750) * Lerp(strength, 0.3, 1)`.
 * @param {number} strength 0..1 (`m_flThrowStrength`)
 * @param {number} [throwVelocity] the weapon's `m_flThrowVelocity`
 */
export function throwSpeed(strength, throwVelocity = THROW_VELOCITY) {
  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength;
  let flVel = fmul(throwVelocity, THROW_SPEED_SCALE);
  if (flVel < THROW_SPEED_MIN) flVel = THROW_SPEED_MIN;
  else if (flVel > THROW_SPEED_MAX) flVel = THROW_SPEED_MAX;
  return fmul(flVel, fr(THROW_STRENGTH_FLOOR + fmul(fr(1 - THROW_STRENGTH_FLOOR), s)));
}

const DEG = Math.PI / 180;

function clamp01(strength) {
  return strength < 0 ? 0 : strength > 1 ? 1 : strength;
}

/**
 * Spawn origin: eye, plus `Lerp(strength, -12, 0)` on z, then hull-trace 22
 * along throw forward and pull back 6. No world: the unobstructed 16.
 */
function releasePos(eye, fx, fy, fz, strength, world) {
  const zOff = fmul(GRENADE_SECONDARY_LOWER, fr(clamp01(strength) - 1));
  const sx = fr(eye.x);
  const sy = fr(eye.y);
  const sz = fr(eye.z + zOff);
  if (world && typeof world.traceHull === 'function') {
    const t = world.traceHull(
      { x: sx, y: sy, z: sz },
      { x: fr(sx + fmul(fx, RELEASE_TRACE)), y: fr(sy + fmul(fy, RELEASE_TRACE)), z: fr(sz + fmul(fz, RELEASE_TRACE)) },
      GRENADE_RADIUS,
      GRENADE_RADIUS
    );
    const end = t.endpos;
    return {
      x: fr(end.x - fmul(fx, RELEASE_PULLBACK)),
      y: fr(end.y - fmul(fy, RELEASE_PULLBACK)),
      z: fr(end.z - fmul(fz, RELEASE_PULLBACK))
    };
  }
  return {
    x: fr(sx + fmul(fx, RELEASE_FORWARD)),
    y: fr(sy + fmul(fy, RELEASE_FORWARD)),
    z: fr(sz + fmul(fz, RELEASE_FORWARD))
  };
}

/**
 * Where a grenade starts and how fast, from the state at the moment of release.
 *
 * `vecThrow = vForward * flVel + playerAbsVelocity * 1.25`
 *
 * @param {object} o
 * @param {{x,y,z}} o.eye        the thrower's eye, Source frame
 * @param {number} o.yaw         view yaw, degrees
 * @param {number} o.pitch       view pitch, degrees (negative is up)
 * @param {{x,y,z}} [o.velocity] the thrower's velocity at release.
 *   For a perfect jumpthrow this is the 6-tick latch (throwerVelocity /
 *   perfectJumpThrowState), not the live decaying rise.
 * @param {number} [o.strength]  0..1
 * @param {number} [o.throwVelocity]
 * @param {{traceHull: Function}|null} [o.world]  nade hull; clips the 22-unit spawn
 * @returns {{pos: {x,y,z}, vel: {x,y,z}, pitch: number, speed: number}}
 */
export function releaseState({
  eye,
  yaw,
  pitch,
  velocity = null,
  strength = 1,
  throwVelocity = THROW_VELOCITY,
  world = null
}) {
  const tp = throwPitch(pitch);
  const speed = throwSpeed(strength, throwVelocity);
  const cp = Math.cos(tp * DEG);
  const sp = Math.sin(tp * DEG);
  const cy = Math.cos(yaw * DEG);
  const sy = Math.sin(yaw * DEG);
  // Source forward from (pitch, yaw), z up and pitch positive downward.
  const fx = fr(cp * cy);
  const fy = fr(cp * sy);
  const fz = fr(-sp);
  const k = velocity ? VELOCITY_INHERIT : 0;
  return {
    pos: releasePos(eye, fx, fy, fz, strength, world),
    vel: {
      x: fr(fmul(fx, speed) + (velocity ? fmul(fr(velocity.x), k) : 0)),
      y: fr(fmul(fy, speed) + (velocity ? fmul(fr(velocity.y), k) : 0)),
      z: fr(fmul(fz, speed) + (velocity ? fmul(fr(velocity.z), k) : 0))
    },
    pitch: tp,
    speed
  };
}

// ---- fuses and what ends a flight -----------------------------------------

/**
 * How each type stops flying, and when.
 *
 * `fuse` is seconds from the projectile being created — NOT from the mouse
 * click, which is about 8 ticks earlier while the throw animation runs. It is
 * the server's own `m_flDetonateTime - m_flCreateTime`, and it is single-valued
 * to four decimal places over the whole sample:
 *
 *   hegrenade   1.5000  (n=119)     flashbang  1.5000  (n=162)
 *   molotov / incgrenade  2.0000  (n=147)
 *
 * Smoke and decoy carry no usable `m_flDetonateTime` at all (the field holds
 * uninitialised negative game time), which is the data saying out loud that
 * they are not on a timer: they go off when they stop moving.
 *
 *   'fuse'    a timer, wherever it happens to be. HE and flashbang.
 *   'impact'  the first thing it touches, with `fuse` as the airtime cap.
 *             Fire grenades: 2.0 s is what a molotov that never lands gets.
 *   'rest'    when it stops moving. Smoke and decoy.
 */
export const GRENADE_SPEC = Object.freeze({
  hegrenade: { detonate: 'fuse', fuse: fr(1.5) },
  flashbang: { detonate: 'fuse', fuse: fr(1.5) },
  molotov: { detonate: 'ground', fuse: fr(2) },
  incgrenade: { detonate: 'ground', fuse: fr(2) },
  smokegrenade: { detonate: 'rest', fuse: null },
  decoy: { detonate: 'rest', fuse: null }
});

/** The six thrown types, in buy-menu order. */
export const GRENADE_TYPES = Object.freeze([
  'hegrenade',
  'flashbang',
  'smokegrenade',
  'molotov',
  'incgrenade',
  'decoy'
]);

export function isFireGrenade(type) {
  return type === 'molotov' || type === 'incgrenade';
}

// ---- the projectile -------------------------------------------------------

/**
 * @param {{x,y,z}} pos
 * @param {{x,y,z}} vel
 * @param {string} [type]
 */
export function createGrenade(pos, vel, type = 'hegrenade') {
  return {
    type,
    spec: GRENADE_SPEC[type] || GRENADE_SPEC.hegrenade,
    pos: v3(pos.x, pos.y, pos.z),
    vel: v3(vel.x, vel.y, vel.z),
    /** Seconds since release. */
    age: 0,
    resting: false,
    bounces: 0,
    /** Set on the tick it goes off; the surface normal it went off against. */
    detonated: false,
    detonateNormal: null,
    /** Set by the tick it first touched the world at all. */
    hit: false,
    /**
     * Set by the first touch of a surface walkable enough to burn on. This is
     * what a fire grenade waits for; a wall sets `hit` and not this one.
     */
    hitGround: false,
    /**
     * The surface of the last thing it touched. Kept on the grenade rather
     * than in a module temporary: a fuse type detonates on a tick where it
     * touched nothing, and a shared temporary would hand it whichever OTHER
     * grenade bounced most recently.
     */
    lastNormal: null
  };
}

const _end = v3();

/**
 * One tick of flight.
 *
 * Gravity is applied leapfrog — half before the move, half after — so a pure
 * arc integrates identically to the player's airborne tick and the oracle can
 * share its parabola math.
 *
 * @param {object} g            from createGrenade
 * @param {{traceHull: Function}} world  the GRENADE collision set: solid,
 *   entity and grenadeclip, but NOT playerclip or sky (see src/cs3d/hullWorld.js)
 * @param {number} [dt]
 * @returns {object} the same grenade, advanced
 */
export function stepGrenade(g, world, dt = TICK_DT) {
  if (g.detonated) return g;
  g.age = fr(g.age + dt);

  if (!g.resting) {
    const grav = fmul(GRAVITY, GRENADE_GRAVITY_SCALE);
    g.vel.z = fr(g.vel.z - fmul(grav, fmul(0.5, dt)));
    v3mulAdd(_end, g.pos, g.vel, dt);
    const t = world.traceHull(g.pos, _end, GRENADE_RADIUS, GRENADE_RADIUS);
    v3copy(g.pos, t.endpos);
    if (t.fraction < 1 && t.normal) {
      g.hit = true;
      if (t.normal.z >= REST_NORMAL_Z) g.hitGround = true;
      if (g.lastNormal) {
        g.lastNormal.x = t.normal.x;
        g.lastNormal.y = t.normal.y;
        g.lastNormal.z = t.normal.z;
      } else {
        g.lastNormal = { x: t.normal.x, y: t.normal.y, z: t.normal.z };
      }
      bounce(g, t.normal);
    }
    g.vel.z = fr(g.vel.z - fmul(grav, fmul(0.5, dt)));
  }

  const spec = g.spec;
  if (spec.detonate === 'fuse') {
    if (g.age >= spec.fuse) detonate(g, g.lastNormal);
  } else if (spec.detonate === 'ground') {
    // Walls bounce it, floors burn it. The fuse is only the cap on one that
    // never finds a floor — thrown off a ledge, or out of the map.
    if (g.hitGround) detonate(g, g.lastNormal);
    else if (spec.fuse != null && g.age >= spec.fuse) detonate(g, null);
  } else if (spec.detonate === 'rest') {
    if (g.resting) detonate(g, g.lastNormal);
  }
  return g;
}

function detonate(g, normal) {
  g.detonated = true;
  g.detonateNormal = normal ? { x: normal.x, y: normal.y, z: normal.z } : null;
  v3set(g.vel, 0, 0, 0);
}

/**
 * Source's `ResolveFlyCollisionCustom`: reflect through the plane at full
 * backoff, then damp the WHOLE vector by the elasticity. Doing it the other way
 * round — reflecting at (1 + e) and then scaling — damps the normal component
 * twice and the tangential once, which is a grenade that skids further than it
 * should and drops shorter than it should.
 */
function bounce(g, normal) {
  const into = v3dot(g.vel, normal);
  if (into < 0) {
    const backoff = fmul(into, BOUNCE_BACKOFF);
    g.vel.x = fr(g.vel.x - fmul(normal.x, backoff));
    g.vel.y = fr(g.vel.y - fmul(normal.y, backoff));
    g.vel.z = fr(g.vel.z - fmul(normal.z, backoff));
  }
  g.vel.x = fmul(g.vel.x, GRENADE_ELASTICITY);
  g.vel.y = fmul(g.vel.y, GRENADE_ELASTICITY);
  g.vel.z = fmul(g.vel.z, GRENADE_ELASTICITY);
  g.bounces += 1;
  if (normal.z >= REST_NORMAL_Z && v3len(g.vel) < REST_SPEED) {
    v3set(g.vel, 0, 0, 0);
    g.resting = true;
  }
}
