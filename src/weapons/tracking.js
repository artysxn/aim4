// ---------------------------------------------------------------------------
// weapons/tracking.js — tracking duel beam (client-side).
// Full-auto at 600 RPM with no recoil pattern, bloom, or view punch.
// ---------------------------------------------------------------------------

export const RPM = 600;
export const SHOT_INTERVAL = 60 / RPM;
export const MAG_SIZE = 9999;
export const RELOAD_TIME = 0;
export const BURST_BREAK_MS = 999999;
export const SUSTAIN_CAP_SHOTS = 0;
export const SUSTAIN_RECOVERY_PER_SHOT = 1;
export const PUNCH_TAU_SPRAY = 0.1;
export const PUNCH_TAU_RECOVER = 0.25;
export const VIEW_PUNCH_STRENGTH = 0;

export function patternOffset() {
  return null;
}

export function bloomRad() {
  return 0;
}

export function viewPunchImpulse() {
  return { pitch: 0, yaw: 0 };
}
