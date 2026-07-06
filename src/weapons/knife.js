// ---------------------------------------------------------------------------
// weapons/knife.js — CS2-style melee (client-side).
//
// Quick slash (LMB) and heavy slash (RMB). Inspect with F. Faster movement
// than the AWP. No ammo or reload.
// ---------------------------------------------------------------------------

import { degToRad } from '../utils/MathUtils.js';
import { UNIT } from '../utils/SourceMovement.js';

export const MAG_SIZE = 1;
export const RELOAD_TIME = 0;
export const SHOT_INTERVAL = 0.4; // quick slash cooldown (s)
export const HEAVY_SHOT_INTERVAL = 1.0; // heavy slash cooldown (s)
export const BURST_BREAK_MS = 600;
export const SUSTAIN_CAP_SHOTS = 1;
export const SUSTAIN_RECOVERY_PER_SHOT = 0.1;

export const PUNCH_TAU_SPRAY = 0.06;
export const PUNCH_TAU_RECOVER = 0.12;
export const VIEW_PUNCH_STRENGTH = 0.35;

export const MELEE = true;
export const MELEE_RANGE = 1.85; // metres — short forward trace
export const RUN_SPEED = 250 * UNIT; // 250 u/s
export const DEPLOY_MS = 520;
export const INSPECT_MS = 3200;

export function patternOffset() {
  return null;
}

export function bloomRad() {
  return degToRad(0.8);
}

export function viewPunchImpulse() {
  return { pitch: degToRad(0.6), yaw: 0 };
}
