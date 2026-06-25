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

// Overall strength of the fixed pattern. Lower this to make the spray tamer.
const PATTERN_SCALE = 1.0;

export const PATTERN = PATTERN_DEG.map(([yaw, pitch]) => ({
  yaw: degToRad(yaw) * PATTERN_SCALE,
  pitch: degToRad(pitch) * PATTERN_SCALE
}));

/** Cumulative pattern offset for a 0-based shot index (clamped to the mag). */
export function patternOffset(shotIndex) {
  const i = clamp(shotIndex, 0, PATTERN.length - 1) | 0;
  return PATTERN[i];
}

// Bloom tuning (cone half-angle in radians).
// Standing still, shot 1 is dead-on (0 bloom); a sustained standing spray grows
// to only ~0.35° (~10 cm at duel range) — barely noticeable but present.
const STAND_BLOOM = 0;
const SUSTAIN_STEP = degToRad(0.02); // added per sustained shot (capped)
const SUSTAIN_CAP_SHOTS = 18;
const MOVE_BLOOM = degToRad(3.0); // extra at full run speed
const LAND_BLOOM = degToRad(2.0); // extra for a short window after landing
const AIR_BLOOM = degToRad(6.0); // airborne: large, low chance to connect

/**
 * Random spread cone half-angle (radians) for this shot.
 * @param {{onGround:boolean, speedHoriz:number}} state movement state
 * @param {number} shotIndex 0-based index within the current burst
 * @param {boolean} recentlyLanded true for a short window after touching ground
 */
export function bloomRad(state, shotIndex, recentlyLanded = false) {
  if (!state.onGround) return AIR_BLOOM;
  let r = STAND_BLOOM;
  r += Math.min(shotIndex, SUSTAIN_CAP_SHOTS) * SUSTAIN_STEP;
  const moveT = clamp(
    (state.speedHoriz - CROUCH_SPEED) / Math.max(1e-6, RUN_SPEED - CROUCH_SPEED),
    0,
    1
  );
  r += moveT * MOVE_BLOOM;
  if (recentlyLanded) r += LAND_BLOOM;
  return r;
}

// View-punch impulse (radians of upward camera kick) for a shot. Grows as the
// spray is held so a long burst climbs hard; decay between bullets is partial
// (see Viewmodel PUNCH_TAU_SPRAY) so the view never fully resets mid-spray.
const VIEW_PUNCH_SCALE = 6.5;
export function viewPunchImpulse(shotIndex) {
  const base = degToRad(0.95);
  const ramp = Math.min(shotIndex, 18) * degToRad(0.09);
  return (base + ramp) * VIEW_PUNCH_SCALE;
}
