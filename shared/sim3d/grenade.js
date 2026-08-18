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

import { fr, fmul, v3, v3set, v3copy, v3dot, v3mulAdd, v3len } from './fp.js';
import { GRAVITY, TICK_DT } from './constants.js';

// ---- flight ---------------------------------------------------------------

/**
 * [measured] Grenades fall under a fraction of sv_gravity. Not fitted: the
 * projectile networks `m_flGravityScale` and it reads 0.4 on every grenade of
 * every type in the corpus.
 */
export const GRENADE_GRAVITY_SCALE = fr(0.4);

/**
 * [measured] Bounce damping, from the projectile's own `m_flElasticity`.
 * Exactly 0.4375 (7/16) on every type — NOT the 0.45 of CSGO lore, and not
 * per-type as decoys' reputation suggests.
 */
export const GRENADE_ELASTICITY = fr(0.4375);

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
 * [measured] What the game actually releases at full strength is 0.9 of that:
 * 675.0 u/s, exactly, on all 19 standing full-strength throws in the sample and
 * on all 215 full-strength throws once the thrower's motion is removed. Flat
 * across view pitch from -15 to +10 degrees, so there is no pitch term in the
 * speed the way CSGO's `(90 - pitch) * 6` had one.
 */
export const THROW_SPEED_SCALE = fr(0.9);

/**
 * [measured] How release speed follows the throw strength:
 *
 *   speed = THROW_VELOCITY * THROW_SPEED_SCALE * (0.3 + 0.7 * strength)
 *
 * Checked against the projectile's release speed at the strength the thrower
 * actually released at (`m_flThrowStrength`, readable per tick):
 *
 *   strength 1.000 -> predicted 675.00, observed 675.00   (n=215)
 *   strength 0.695 -> predicted 531.03, observed 531.04
 *   strength 0.500 -> predicted 438.75, observed 438.75   (n=14)
 *   strength 0.203 -> predicted 298.46, observed 299.13
 */
export const THROW_STRENGTH_FLOOR = fr(0.3);

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
 * [measured] How fast a held strength travels toward its target, per second.
 * Holding a button does not switch the strength instantly: it steps about 0.02
 * a tick (1.28/s) from wherever it was. Only visible if a player changes which
 * buttons are down mid-hold, which is why the number is loose — the three
 * targets above are the part that matters.
 */
export const THROW_STRENGTH_RATE = fr(1.28);

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
 * of 1.25. This is the whole of "jump throw": there is no separate jump case,
 * only a thrower who happens to be carrying 250-plus units a second when they
 * let go.
 */
export const VELOCITY_INHERIT = fr(1.25);

/**
 * [measured] How far in front of the eye the projectile appears, units.
 *
 * Median 15.4 with the first tick of flight undone, and the SIDEWAYS offset is
 * 0.00 to within a hundredth of a unit across the sample — so the release sits
 * dead on the view axis and 16 is the round number behind it.
 *
 * One detail the corpus cannot settle: whether the 16 runs along the view or
 * along the remapped throw direction, which differ by 10 degrees and so by 2.8
 * units of height. The measured vertical offset (median +0.6) sits between the
 * two predictions (0.0 and +2.8) and the spread is dominated by eye-height
 * error on mid-duck throwers, so it does not choose. This uses the remapped
 * direction, which is what Source's own ThrowGrenade does.
 */
export const RELEASE_FORWARD = fr(16);

/**
 * [measured] Source's throw-angle remap, and CS2 still runs it exactly.
 *
 *   throwPitch = -10 + viewPitch * (looking up ? 80/90 : 100/90)
 *
 * A grenade therefore leaves 10 degrees above where you are aiming when you
 * aim level, and the two branches are not symmetric. Median error against 24
 * standing throws: 0.000 degrees, p10 -0.000, p90 0.000. The yaw is not
 * remapped at all — the throw is along the view to within 0.36 degrees at p90.
 */
export const THROW_PITCH_OFFSET = fr(-10);
const PITCH_SCALE_UP = fr(80 / 90);
const PITCH_SCALE_DOWN = fr(100 / 90);

/**
 * The pitch a grenade actually leaves at, degrees, Source convention
 * (negative is up).
 */
export function throwPitch(viewPitch) {
  const p = fr(viewPitch);
  return fr(THROW_PITCH_OFFSET + fmul(p, p < 0 ? PITCH_SCALE_UP : PITCH_SCALE_DOWN));
}

/**
 * Release speed for a throw strength, units/second.
 * @param {number} strength 0..1 (`m_flThrowStrength`)
 * @param {number} [throwVelocity] the weapon's `m_flThrowVelocity`
 */
export function throwSpeed(strength, throwVelocity = THROW_VELOCITY) {
  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength;
  return fmul(fmul(throwVelocity, THROW_SPEED_SCALE), fr(THROW_STRENGTH_FLOOR + fmul(fr(1 - THROW_STRENGTH_FLOOR), s)));
}

const DEG = Math.PI / 180;

/**
 * Where a grenade starts and how fast, from the state at the moment of release.
 *
 * @param {object} o
 * @param {{x,y,z}} o.eye        the thrower's eye, Source frame
 * @param {number} o.yaw         view yaw, degrees
 * @param {number} o.pitch       view pitch, degrees (negative is up)
 * @param {{x,y,z}} [o.velocity] the thrower's velocity at release
 * @param {number} [o.strength]  0..1
 * @param {number} [o.throwVelocity]
 * @returns {{pos: {x,y,z}, vel: {x,y,z}, pitch: number, speed: number}}
 */
export function releaseState({ eye, yaw, pitch, velocity = null, strength = 1, throwVelocity = THROW_VELOCITY }) {
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
    pos: {
      x: fr(eye.x + fmul(fx, RELEASE_FORWARD)),
      y: fr(eye.y + fmul(fy, RELEASE_FORWARD)),
      z: fr(eye.z + fmul(fz, RELEASE_FORWARD))
    },
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
 *   entity, sky and grenadeclip, but NOT playerclip (see src/cs3d/hullWorld.js)
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
