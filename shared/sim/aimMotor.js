// ---------------------------------------------------------------------------
// shared/sim/aimMotor.js
// The crosshair: a humanized, pro-capped motor that is structurally not an
// aimbot.
//
// The policy never outputs an angle. It outputs who to try to kill and how to
// stand, and this file turns that into crosshair motion under constraints that
// no amount of training can widen. That is the anti-aimbot guarantee in SIM-PLAN
// 8, and it is architectural rather than a promise: evolution can select which
// fights a bot takes, never how fast its hand is.
//
// Five stages, per 8.1:
//
//   reaction   a target that just became actionable is not shot at instantly
//   rotation   yaw slews at a capped rate, with endpoint error that grows with
//              the angle travelled (a Fitts-style speed/accuracy tradeoff)
//   tracking   on target, error is an Ornstein-Uhlenbeck wobble, because humans
//              do not hold zero error, they hover around it
//   trigger    fire when the predicted error is inside the target, subject to
//              cycle time, movement inaccuracy, and burst discipline
//   recoil     abstracted as per-burst sigma growth rather than a literal
//              pattern, because a 2D sim cannot honestly represent a spray
//
// Every random draw comes from the engine PRNG, so a seeded round reproduces
// its own gunfights exactly.
// ---------------------------------------------------------------------------

import { TICK_DT } from './constants.js';
import { simWeapon, weaponSpread } from './weapons.js';

/** Shortest signed angle from a to b, in degrees. */
export function angleDelta(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/**
 * Angular radius of a body at a distance, in degrees.
 *
 * A player is about 32 units wide, so what "on target" means shrinks with
 * range: the same crosshair error that is a hit at 300 units is a miss at
 * 2,000. This one function is why range matters at all in the model.
 */
export function targetAngularRadius(distance, group = 'chest') {
  const halfWidth = group === 'head' ? 6 : 16;
  return (Math.atan2(halfWidth, Math.max(1, distance)) * 180) / Math.PI;
}

/**
 * Per-bot motor state. Kept separate from the body so the engine can own
 * bodies and the motor can own hands.
 */
export function createMotor(profile) {
  return {
    profile,
    yaw: 0,
    /** Slew rate, deg/s, so acceleration is bounded rather than instant. */
    yawRate: 0,
    /** OU tracking error, degrees. */
    wobble: 0,
    /** Target we are currently committed to, and when we noticed it. */
    targetId: null,
    reactionReadyTick: Infinity,
    /** Shots fired in the current burst, for recoil bloom. */
    burst: 0,
    lastFireTick: -Infinity,
    lastSeenTick: -Infinity
  };
}

/**
 * A target has become actionable: start the reaction clock.
 *
 * Pre-aiming is the whole reason the DECISION to pre-aim matters more than raw
 * reflexes (8.1). A crosshair already within ten degrees of where the enemy
 * appears buys 40 ms; being surprised from an unexpected angle costs 80. That
 * spread is larger than the difference between a good and a bad reaction time,
 * which is why the plan prices pre-aim rather than treating it as flavour.
 */
export function acquire(motor, { targetId, targetYaw, tick, rng, preAimed = null }) {
  if (motor.targetId === targetId) return;
  motor.targetId = targetId;
  motor.burst = 0;

  const p = motor.profile;
  const base = rng.logNormalFromP90(p.reactionMedian, p.reactionMedian * 1.6);

  const off = preAimed === null ? Math.abs(angleDelta(motor.yaw, targetYaw)) : preAimed;
  let seconds = base;
  if (off <= 10) seconds -= 0.04;
  else if (off > 60) seconds += 0.08;

  motor.reactionReadyTick = tick + Math.max(0, seconds) / TICK_DT;
}

/** The target is gone: stop tracking it, and let the burst reset. */
export function release(motor) {
  motor.targetId = null;
  motor.reactionReadyTick = Infinity;
  motor.burst = 0;
}

/** Hardest a spray ever gets, as a multiple of the standing cone. */
export const MAX_BLOOM = 4;

/**
 * Recoil bloom: the first few bullets are tight, then the cone opens up.
 *
 * Abstracted rather than a literal spray pattern, because a 2D sim has no
 * vertical axis to pull down and pretending otherwise would be a fidelity lie.
 *
 * Two caps, and both are load-bearing. The burst counter is clamped to the
 * magazine, because a gun that has fired thirty rounds is reloading rather than
 * still blooming, and the multiplier is clamped to MAX_BLOOM, because an
 * unbounded cone means a bot that holds the trigger through a long engagement
 * ends up unable to hit anything at any range. Both of those were happening
 * before the cap: a continuous fight drove the burst into the hundreds and the
 * hit rate to noise.
 */
export function recoilBloom(motor, info) {
  const fired = Math.min(motor.burst, info.magSize || 30);
  if (fired <= 4) return 1;
  const raw = 1 + (fired - 4) * (1.2 - motor.profile.sprayDiscipline) * 0.25;
  return Math.min(MAX_BLOOM, raw);
}

/**
 * One motor tick. Moves the crosshair and reports whether it may fire.
 *
 * @param {object} motor
 * @param {object} args
 * @param {number} args.tick
 * @param {number} args.targetYaw     where the target actually is
 * @param {number} args.distance      world units
 * @param {number} args.moveSpeed     the shooter's speed, units/s
 * @param {string} args.weapon
 * @param {import('./rng.js').Rng} args.rng
 * @param {boolean} [args.canFire]    cycle ready, ammo, posture allows
 * @returns {{yaw: number, onTarget: boolean, fire: boolean, error: number}}
 */
export function stepMotor(motor, { tick, targetYaw, distance, moveSpeed, weapon, rng, canFire = true }) {
  const p = motor.profile;
  const info = simWeapon(weapon);

  // ---- rotation, rate limited ----
  // The cap is the wall. A policy that wants to snap 180 degrees in a tick
  // cannot: it gets `maxTurnRate` degrees, and no trait, mimic fit, or user
  // knob can raise that past the envelope (skill.js).
  const delta = angleDelta(motor.yaw, targetYaw);
  const maxStep = p.maxTurnRate * TICK_DT;
  const step = Math.max(-maxStep, Math.min(maxStep, delta));
  const travelled = Math.abs(step);
  motor.yaw += step;
  motor.yawRate = travelled / TICK_DT;

  const settling = Math.abs(delta) > maxStep;

  // ---- endpoint error, Fitts-style ----
  // Error grows with how far the hand had to travel. A small adjustment is
  // precise; a wide flick is not, which is exactly why pre-aiming and holding
  // an angle are worth what the duel model says they are worth.
  if (settling) {
    // Mid-flick: the wobble is dominated by the movement itself.
    motor.wobble = rng.normal(0, p.flickSigmaScale * (0.4 + travelled / 45));
  } else {
    // ---- tracking, Ornstein-Uhlenbeck ----
    // Mean-reverting noise rather than fresh noise every tick: a human hand
    // drifts and corrects, it does not teleport around the target. Independent
    // draws per tick would average out over a burst and make tracking far too
    // good.
    const theta = 12; // reversion rate, per second
    const sigma = p.trackSigmaScale * (0.35 + moveSpeed / 400);
    motor.wobble += -theta * motor.wobble * TICK_DT + sigma * Math.sqrt(TICK_DT) * rng.normal();
  }

  const bloom = recoilBloom(motor, info);

  const error = Math.abs(motor.wobble) * bloom;
  const radius = targetAngularRadius(distance);

  // Movement inaccuracy: firing while running is not a coin flip on the shot,
  // it is a wider cone. The motor models it as a larger effective error rather
  // than a hit-chance multiplier, so it composes with distance correctly.
  const moveFactor = 1 + Math.max(0, moveSpeed - 40) / 120;
  const effective = error * moveFactor;

  const reacted = tick >= motor.reactionReadyTick;
  const onTarget = !settling && effective < radius * p.triggerConfidence;

  const cycleTicks = (info.cycleSeconds || 0.1) / TICK_DT;
  const cycled = tick - motor.lastFireTick >= cycleTicks;

  const fire = Boolean(canFire && reacted && onTarget && cycled && motor.targetId !== null);
  if (fire) {
    motor.lastFireTick = tick;
    motor.burst += 1;
  } else if (tick - motor.lastFireTick > 0.35 / TICK_DT) {
    // A pause resets the burst, which is what letting the spray reset is.
    motor.burst = 0;
  }

  return { yaw: motor.yaw, onTarget, fire, error: effective };
}

/**
 * Where a fired bullet actually lands, as a hit group or a miss.
 *
 * Separate from the trigger, and deliberately NOT resolved against the same
 * number the trigger checked. If it were, a bot would only ever fire when it
 * was going to hit, and its accuracy would come out at 100% at every range,
 * which is both wrong and exactly the shape an aimbot has.
 *
 * A bullet's deviation is the crosshair error plus the weapon's own spread,
 * drawn fresh, widened by recoil bloom and by movement. So a shot can be taken
 * in good faith and still miss, which is what shooting is.
 *
 * @param {object} motor
 * @param {object} args
 * @param {number} args.distance
 * @param {import('./rng.js').Rng} args.rng
 * @param {string} [args.weapon]
 * @param {number} [args.moveSpeed]
 */
export function resolveShot(motor, { distance, rng, weapon = 'ak47', moveSpeed = 0 }) {
  const p = motor.profile;
  const radius = targetAngularRadius(distance);

  const bloom = recoilBloom(motor, simWeapon(weapon));
  const moveFactor = 1 + Math.max(0, moveSpeed - 40) / 120;
  const spread = weaponSpread(weapon) * bloom * moveFactor;

  const deviation = rng.normal(motor.wobble, spread);
  if (Math.abs(deviation) > radius) return { hit: false, group: null, deviation };

  // Inside the body. Where in it depends on how centred the bullet was and on
  // the shooter's tendency to aim high.
  const centred = 1 - Math.abs(deviation) / radius;
  const headChance = Math.min(0.9, p.hsBias * centred);
  const roll = rng.next();
  if (roll < headChance) return { hit: true, group: 'head', deviation };
  if (roll < headChance + 0.5) return { hit: true, group: 'chest', deviation };
  if (roll < headChance + 0.72) return { hit: true, group: 'stomach', deviation };
  if (roll < headChance + 0.88) return { hit: true, group: 'arm', deviation };
  return { hit: true, group: 'leg', deviation };
}
