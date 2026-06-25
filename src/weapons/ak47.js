// ---------------------------------------------------------------------------
// weapons/ak47.js — CS2-style AK-47 firing model (client-side).
//
// Two layers, exactly like CS2:
//   1. Deterministic recoil PATTERN — a fixed per-shot angular offset applied to
//      the bullet direction. Bullet 1 is dead-on; the pattern climbs (reverse-7).
//   2. Dynamic BLOOM — a small random cone added on top, driven by movement
//      velocity, airborne state and how long you've been firing. Tiny while
//      standing (a few cm at duel range), large while moving/jumping.
//
// View punch (the transient upward camera jolt) is handled separately by the
// WeaponController so it can be toggled off without changing where bullets go.
// ---------------------------------------------------------------------------

import { degToRad, clamp } from '../utils/MathUtils.js';
import { CROUCH_SPEED, RUN_SPEED } from '../utils/SourceMovement.js';

export const RPM = 600;
export const SHOT_INTERVAL = 60 / RPM; // 0.1 s between shots
export const MAG_SIZE = 30;
export const RELOAD_TIME = 2.0; // seconds

// Cumulative recoil offsets {yaw°, pitch°} per bullet (index 0 = first shot).
// +pitch = climb up, +yaw = drift right. Forms the AK "reverse-7": straight up,
// up-and-right, a hard sweep left, then a swing back right. Authored to feel
// like CS2 rather than copied frame-exact (the real values are undisclosed).
const PATTERN_DEG = [
  [0.0, 0.0], [0.1, 1.2], [-0.1, 2.5], [0.2, 3.8], [0.0, 5.0],
  [0.3, 6.1], [0.8, 7.0], [1.4, 7.7], [2.1, 8.2], [2.8, 8.6],
  [3.3, 8.9], [3.0, 9.1], [2.0, 9.2], [0.7, 9.3], [-0.8, 9.3],
  [-2.3, 9.2], [-3.6, 9.1], [-4.5, 9.0], [-5.0, 8.9], [-5.1, 8.8],
  [-4.6, 8.8], [-3.6, 8.7], [-2.3, 8.7], [-1.0, 8.7], [0.2, 8.7],
  [1.2, 8.7], [1.8, 8.7], [2.0, 8.7], [1.7, 8.7], [1.2, 8.7]
];

/** Visual view-punch / camera kick only (does not move bullets). */
export const VIEW_PUNCH_STRENGTH = 0.82; // 18% weaker
/** Bullet spray pattern + sustain bloom (deterministic recoil + random cone). */
export const SPRAY_STRENGTH = 0.68; // 32% weaker

const PATTERN_SCALE = 0.9 * SPRAY_STRENGTH;
const PUNCH_SCALE = 2.8 * VIEW_PUNCH_STRENGTH;
const PUNCH_BASE_DEG = 0.7 * VIEW_PUNCH_STRENGTH;
const PUNCH_RAMP_DEG = 0.05 * VIEW_PUNCH_STRENGTH;
const PUNCH_RAMP_MAX_SHOTS = 12;
const PUNCH_YAW_SCALE = 0.4 * VIEW_PUNCH_STRENGTH;
export const PUNCH_TAU_SPRAY = 0.1;
export const PUNCH_TAU_RECOVER = 0.25 / 1.5; // linear view-punch reset after releasing fire

export const PATTERN = PATTERN_DEG.map(([yaw, pitch]) => ({
  yaw: degToRad(yaw) * PATTERN_SCALE,
  pitch: degToRad(pitch) * PATTERN_SCALE
}));

/**
 * Per-burst intensity ramp (0-based shot index). First bullets in a spray are
 * slightly softer before settling to full strength from bullet 4 onward.
 */
export function sprayIntensity(shotIndex) {
  if (shotIndex <= 1) return 0.90; // bullets 1–2
  if (shotIndex === 2) return 0.95; // bullet 3
  return 1.0; // bullet 4+
}

/** Cumulative pattern offset for a 0-based shot index (clamped to the mag). */
export function patternOffset(shotIndex) {
  const i = clamp(shotIndex, 0, PATTERN.length - 1) | 0;
  const p = PATTERN[i];
  const f = sprayIntensity(shotIndex);
  if (f === 1) return p;
  return { yaw: p.yaw * f, pitch: p.pitch * f };
}

// Bloom tuning (cone half-angle in radians).
// Standing still, shot 1 is dead-on (0 bloom); a sustained standing spray grows
// a very slight random cone on top of the deterministic pattern.
const STAND_BLOOM = 0;
const SUSTAIN_STEP = degToRad(0.02) * SPRAY_STRENGTH * 3;
const SPRAY_OVERLAY_BLOOM = degToRad(0.035) * SPRAY_STRENGTH;
export const SUSTAIN_CAP_SHOTS = 18;
/** Idle time to recover one sustain step (linear bloom decay toward standing accuracy). */
export const SUSTAIN_RECOVERY_PER_SHOT = 0.07;
const MOVE_BLOOM = degToRad(3.0); // extra at full run speed
const LAND_BLOOM = degToRad(2.0); // extra for a short window after landing
const AIR_BLOOM = degToRad(6.0); // airborne: large, low chance to connect

/** Gap without a shot before the spray pattern resets (tap cadence at 600 RPM still chains). */
export const BURST_BREAK_MS = SHOT_INTERVAL * 1000 * 2.5;

/**
 * Random spread cone half-angle (radians) for this shot.
 * @param {{onGround:boolean, speedHoriz:number}} state movement state
 * @param {number} sustainLevel effective sustained shots (decays linearly while idle)
 * @param {boolean} recentlyLanded true for a short window after touching ground
 */
export function bloomRad(state, sustainLevel, recentlyLanded = false) {
  if (!state.onGround) return AIR_BLOOM;
  let r = STAND_BLOOM;
  const sustain = Math.min(Math.max(0, sustainLevel), SUSTAIN_CAP_SHOTS);
  r += sustain * SUSTAIN_STEP;
  if (sustain > 0) r += SPRAY_OVERLAY_BLOOM;
  const moveT = clamp(
    (state.speedHoriz - CROUCH_SPEED) / Math.max(1e-6, RUN_SPEED - CROUCH_SPEED),
    0,
    1
  );
  r += moveT * MOVE_BLOOM;
  if (recentlyLanded) r += LAND_BLOOM;
  return r;
}

// View-punch impulse per shot: pitch kick + slight yaw following the pattern
// step. Grows as the spray is held; decay between bullets is partial.
export function viewPunchImpulse(shotIndex) {
  const f = sprayIntensity(shotIndex);
  const base = degToRad(PUNCH_BASE_DEG);
  const ramp = Math.min(shotIndex, PUNCH_RAMP_MAX_SHOTS) * degToRad(PUNCH_RAMP_DEG);
  const pitch = (base + ramp) * PUNCH_SCALE * f;

  const cur = patternOffset(shotIndex);
  const prev = shotIndex > 0 ? patternOffset(shotIndex - 1) : { yaw: 0, pitch: 0 };
  const yaw = (cur.yaw - prev.yaw) * PUNCH_YAW_SCALE;

  return { pitch, yaw };
}
