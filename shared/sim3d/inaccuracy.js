// ---------------------------------------------------------------------------
// shared/sim3d/inaccuracy.js
// The other half of where a bullet goes: the random cone around the aim.
//
// shared/sim3d/recoil.js is the deterministic half — the same table on every
// machine, learnable. This is the half that is not: a per-shot draw whose
// RADIUS is what the player's stance and their recent shooting have earned. A
// standing AK's first bullet leaves inside a 0.0064 rad cone; the same player
// running has 0.175, which is 27 times wider and the reason nobody sprays on
// the move.
//
// Three things here are counter-intuitive and all three are the game's:
//
//   TWO CONES, NOT ONE. `inaccuracy` is drawn ONCE per trigger pull and
//   `spread` once per PELLET. A rifle fires one pellet so the two just add,
//   but a shotgun's nine pellets share one inaccuracy offset and get nine
//   spread offsets — the whole pattern moves together and then scatters,
//   which is why a shotgun blast is a cluster in a random place rather than
//   nine independent draws.
//
//   UNIFORM IN RADIUS, NOT IN AREA. `radius = random() × inaccuracy`. There is
//   no square root. That makes the density fall off as 1/r, so most bullets
//   land near the middle of the cone and the edge is rare — a cone that
//   samples uniformly over its AREA (the obvious way, and what most
//   reimplementations do) feels far worse than the game at the same numbers.
//
//   THE PENALTY SNAPS UP AND EASES DOWN. Standing still after a run does not
//   restore accuracy immediately: the penalty decays toward the stance's floor
//   with a time constant that is the weapon's own recovery time, so an AK
//   takes about 0.37 s to be accurate again and a Deagle 0.81 s. Going the
//   other way — starting to move — is instant.
//
// The numbers are the weapon's, out of the pack's `accuracy` block, which is
// `m_flInaccuracy*` and `m_flSpread` straight from `scripts/weapons.vdata`.
//
// Headless, like the rest of shared/sim3d.
// ---------------------------------------------------------------------------

import { UniformRandomStream } from './recoil.js';
import { JUMP_IMPULSE } from './constants.js';

/** [docs] Below this fraction of max speed, moving costs nothing. */
const SPEED_DUCK_MODIFIER = 0.34;
/** [docs] Above 95% of max speed the movement penalty is at full. */
const SPEED_FULL = 0.95;
/**
 * [docs] The curve between them, for a player who is RUNNING.
 *
 * An exponent of 0.25 is very steep near zero: at half the ramp the penalty is
 * already 84% of full. Walking (shift) skips the curve entirely and takes the
 * penalty linearly, which is most of what walking buys.
 */
const MOVEMENT_CURVE_EXPONENT = 0.25;
/** [docs] Cap on the falling penalty, as a multiple of the jump-initial value. */
const MAX_FALLING_PENALTY = 2.0;

const remapClamped = (v, a, b, c, d) => {
  if (a === b) return v >= b ? d : c;
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return c + (d - c) * t;
};

const pick = (v, mode = 0, d = 0) => (Array.isArray(v) ? (v[mode] ?? v[0] ?? d) : (v ?? d));

/** The accuracy penalty, which is state, unlike everything else in the cone. */
export function createAccuracyState() {
  return {
    /** The decayed penalty. `getInaccuracy` adds the instantaneous terms. */
    penalty: 0,
    /** Shots fired since the trigger was released; drives the recovery ramp. */
    shotsFired: 0
  };
}

export function resetAccuracy(state) {
  state.penalty = 0;
  state.shotsFired = 0;
}

/**
 * How long the penalty takes to fall back, seconds.
 *
 * Two things about this are the game's and both matter. It always reads the
 * PRIMARY mode's numbers even when scoped. And it ramps between two values
 * across a spray: an AK recovers in 0.368 s for its first two bullets and
 * 0.506 s from its fifth on, interpolated in between — so a long spray leaves
 * you inaccurate for noticeably longer than a tap does.
 */
export function recoveryTime(accuracy, recoil, player = {}) {
  const stand = recoil?.recoveryTimeStand ?? 0.4;
  const crouch = recoil?.recoveryTimeCrouch ?? stand;
  if (player.onLadder) return stand;
  // In the air, four times the crouch value. Jumping and shooting is punished
  // twice over: once by the penalty itself and once by how long it lingers.
  if (player.onGround === false) return crouch * 4;
  const ducking = !!player.ducking;
  const base = ducking ? crouch : stand;
  const final = ducking ? recoil?.recoveryTimeCrouchFinal : recoil?.recoveryTimeStandFinal;
  if (final === undefined || final === null || final === -1) return base;
  return remapClamped(
    Math.trunc(player.recoilIndex || 0),
    recoil?.recoveryTransitionStartBullet ?? 0,
    recoil?.recoveryTransitionEndBullet ?? 0,
    base,
    final
  );
}

/**
 * Advance the penalty one tick.
 *
 * @param {object} state    from createAccuracyState
 * @param {object} weapon   a weapons-pack row (reads `accuracy` and `recoil`)
 * @param {object} player   { speed, maxSpeed, onGround, ducking, onLadder,
 *                            reloading, recoilIndex }
 * @param {number} dt       seconds
 * @param {number} [mode]
 */
export function updateAccuracy(state, weapon, player, dt, mode = 0) {
  const a = weapon?.accuracy;
  if (!a) return;
  // The FLOOR the penalty is heading for: whatever this stance costs.
  let target = 0;
  if (player.onLadder) {
    // Verbatim from the game, including the double count — a ladder is the
    // worst place in Counter-Strike to be holding a trigger and this is why.
    target += pick(a.ladder, mode) + pick(a.ladder, 0);
  } else if (player.onGround === false) {
    target += pick(a.stand, mode) + pick(a.jump, mode);
  } else if (player.ducking) {
    target += pick(a.crouch, mode);
  } else {
    target += pick(a.stand, mode);
  }
  if (player.reloading) target += a.reload || 0;

  if (target > state.penalty) {
    // Instantly. Start moving and the very next bullet pays for it.
    state.penalty = target;
    return;
  }
  const t = recoveryTime(a, weapon.recoil, player);
  if (!(t > 0)) {
    state.penalty = target;
    return;
  }
  state.penalty = target + (state.penalty - target) * Math.exp((-dt * Math.LN10) / t);
}

/** A shot's own contribution. Call it after the bullet has left. */
export function addFireInaccuracy(state, weapon, mode = 0) {
  const a = weapon?.accuracy;
  if (!a) return;
  state.penalty += pick(a.fire, mode);
  state.shotsFired += 1;
}

/**
 * The cone's half-angle right now, in radians of tangent.
 *
 * The penalty is state; the movement and air terms are not — they are computed
 * fresh every time and never decay, which is why standing still is instantly
 * better for the MOVING part and slowly better for the SHOOTING part.
 */
export function getInaccuracy(state, weapon, player, mode = 0) {
  const a = weapon?.accuracy;
  if (!a) return 0;
  let acc = state.penalty;

  const maxSpeed = weapon.maxSpeed || 250;
  const speed = player.speed || 0;
  let s = remapClamped(speed, maxSpeed * SPEED_DUCK_MODIFIER, maxSpeed * SPEED_FULL, 0, 1);
  if (s > 0) {
    // Walking takes the ramp LINEARLY. Running takes it to the quarter power,
    // which is nearly all of it as soon as you are moving at all.
    if (!player.walking) s = Math.pow(s, MOVEMENT_CURVE_EXPONENT);
    acc += s * pick(a.move, mode);
  }

  if (player.onGround === false) {
    const jumpInit = a.jumpInitial || 0;
    if (jumpInit > 0) {
      const sMax = Math.sqrt(JUMP_IMPULSE);
      const vz = Math.sqrt(Math.abs(player.velocityZ || 0));
      // Unclamped remap, then clamped by hand — so the apex of a jump (vz near
      // zero) really is the most accurate moment in the air.
      let air = ((vz - sMax * 0.25) / (sMax - sMax * 0.25)) * jumpInit;
      if (air < 0) air = 0;
      else if (air > MAX_FALLING_PENALTY * jumpInit) air = MAX_FALLING_PENALTY * jumpInit;
      acc += air;
    }
  }

  return Math.min(acc, 1);
}

/** The weapon's own irreducible cone, which no stance improves. */
export function getSpread(weapon, mode = 0) {
  return pick(weapon?.accuracy?.spread, mode, 0);
}

/**
 * `m_nSpreadSeed`. Zero on every rifle and pistol, and NOT zero on the four
 * shotguns (the XM1014's is 817955, the Mag-7's 19899236).
 *
 * A non-zero value fixes the pellet layout: a Mag-7 throws the same nine
 * pellets in the same arrangement every blast, which is exactly why its
 * pattern is a thing players learn. Re-rolling it per shot is a different
 * weapon.
 */
export function getSpreadSeed(weapon) {
  return weapon?.accuracy?.spreadSeed || 0;
}

/**
 * Sample the cone for one trigger pull.
 *
 * @param {object} o
 * @param {number} o.seed         the shot's shared seed; only the low 8 bits matter
 * @param {number} o.inaccuracy   from getInaccuracy
 * @param {number} o.spread       from getSpread
 * @param {number} [o.bullets]    pellets (a shotgun fires 9)
 * @returns {{x: number, y: number}[]} tangent offsets, right and up
 */
export function sampleCone({ seed = 0, inaccuracy = 0, spread = 0, bullets = 1, spreadSeed = 0 }) {
  const inacc = Math.min(1, inaccuracy);
  // The game seeds a fresh stream from the shot's own number so the client and
  // the server agree on where every pellet went. Only 256 distinct patterns
  // exist because of the mask — which is the game's, not a simplification.
  const rng = new UniformRandomStream((seed & 255) + 1);
  // ONE inaccuracy draw for the whole trigger pull, always on the shot's own
  // stream: this is the offset that moves a shotgun's whole cluster.
  const r0 = rng.float() * inacc;
  const t0 = rng.float(0, Math.PI * 2);
  const x0 = r0 * Math.cos(t0);
  const y0 = r0 * Math.sin(t0);

  // ...and one spread draw per pellet, on the WEAPON's stream when it has one.
  // That is the difference between a shotgun pattern you can learn and nine
  // independent bullets (see getSpreadSeed).
  const pel = spreadSeed ? new UniformRandomStream(spreadSeed) : rng;
  const out = [];
  for (let i = 0; i < bullets; i++) {
    const r1 = pel.float() * spread;
    const t1 = pel.float(0, Math.PI * 2);
    out.push({ x: x0 + r1 * Math.cos(t1), y: y0 + r1 * Math.sin(t1) });
  }
  return out;
}

/**
 * Turn view angles plus a cone offset into a direction, in the SOURCE frame.
 *
 * The offsets are TANGENTS, not angles — they scale the right and up vectors
 * of the unit forward and the result is renormalised, which is a slightly
 * different (and correct) thing from adding degrees to pitch and yaw.
 *
 * @param {number} pitchDeg  Source pitch, positive DOWN
 * @param {number} yawDeg    Source yaw, positive LEFT
 * @param {number} x         cone offset along the player's right
 * @param {number} y         cone offset along the player's up
 */
export function bulletDirection(pitchDeg, yawDeg, x = 0, y = 0) {
  const p = (pitchDeg * Math.PI) / 180;
  const yw = (yawDeg * Math.PI) / 180;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sy = Math.sin(yw);
  const cy = Math.cos(yw);
  const fx = cp * cy;
  const fy = cp * sy;
  const fz = -sp;
  // Source's AngleVectors with roll 0. `right` is the player's right, which is
  // NEGATIVE y at yaw 0 because Source's yaw grows to the left.
  const rx = sy;
  const ry = -cy;
  const rz = 0;
  const ux = sp * cy;
  const uy = sp * sy;
  const uz = cp;
  const dx = fx + x * rx + y * ux;
  const dy = fy + x * ry + y * uy;
  const dz = fz + x * rz + y * uz;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / len, y: dy / len, z: dz / len };
}
