// ---------------------------------------------------------------------------
// weapons/pistol.js — USP-style semi-automatic pistol (client-side).
//
// Unlike the rifle, the pistol has NO deterministic recoil pattern: bullets fly
// straight from the true aim. Recoil is expressed only as (1) a random bloom
// cone that grows per consecutive shot and (2) a viewmodel/camera kick. It is
// strictly semi-automatic — one click, one bullet (the WeaponController only
// fires it on the rising edge of the trigger). Pistols stay far more accurate
// while moving than the rifle.
// ---------------------------------------------------------------------------

import { degToRad, clamp } from '../utils/MathUtils.js';
import { CROUCH_SPEED, RUN_SPEED } from '../utils/SourceMovement.js';

export const MAG_SIZE = 12;
export const RELOAD_TIME = 1.6; // seconds — snappier than the rifle
// Minimum spacing between shots (semi-auto fire-rate cap; click faster = no-op).
export const SHOT_INTERVAL = 0.09;
// Gap with no shot before the consecutive-bloom counter resets to dead-accurate.
export const BURST_BREAK_MS = 280;
// Consecutive shots after which bloom stops growing.
export const SUSTAIN_CAP_SHOTS = 6;
// Unused by the semi-auto path (consecutive resets via BURST_BREAK_MS), but the
// controller reads it generically.
export const SUSTAIN_RECOVERY_PER_SHOT = 0.1;

// View-punch spring constants (the pistol snaps back fast between clicks).
export const PUNCH_TAU_SPRAY = 0.05;
export const PUNCH_TAU_RECOVER = 0.09;
export const VIEW_PUNCH_STRENGTH = 1.0;

// ---- Bloom (cone half-angle, radians) -------------------------------------
const CONSEC_STEP = degToRad(0.4); // added per consecutive shot (capped)
const MOVE_BLOOM = degToRad(0.9); // extra at full run — much tighter than the rifle's 3°
const LAND_BLOOM = degToRad(1.0); // brief penalty right after landing
const AIR_BLOOM = degToRad(5.0); // airborne: large

/** The pistol never bends the bullet — no recoil pattern. */
export function patternOffset() {
  return null;
}

/**
 * Random spread cone half-angle (radians) for this shot.
 * @param {{onGround:boolean, speedHoriz:number}} state movement state
 * @param {number} consec consecutive-shot count (0 = first shot, dead accurate)
 * @param {boolean} recentlyLanded true for a short window after touching ground
 */
export function bloomRad(state, consec, recentlyLanded = false) {
  if (!state.onGround) return AIR_BLOOM;
  let r = Math.min(Math.max(0, consec), SUSTAIN_CAP_SHOTS) * CONSEC_STEP;
  const moveT = clamp(
    (state.speedHoriz - CROUCH_SPEED) / Math.max(1e-6, RUN_SPEED - CROUCH_SPEED),
    0,
    1
  );
  r += moveT * MOVE_BLOOM;
  if (recentlyLanded) r += LAND_BLOOM;
  return r;
}

// Per-shot view-punch: a brisk vertical snap, slightly stronger as you spam.
// No yaw — there's no pattern to follow.
const PUNCH_BASE_DEG = 1.1;
const PUNCH_RAMP_DEG = 0.12;
export function viewPunchImpulse(consec) {
  const base = degToRad(PUNCH_BASE_DEG);
  const ramp = Math.min(Math.max(0, consec), SUSTAIN_CAP_SHOTS) * degToRad(PUNCH_RAMP_DEG);
  return { pitch: (base + ramp) * VIEW_PUNCH_STRENGTH, yaw: 0 };
}
