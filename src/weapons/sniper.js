// ---------------------------------------------------------------------------
// weapons/sniper.js — AWP-style bolt-action sniper (client-side).
//
// Copies the CS AWP model: bolt-action (1.463 s cycle), two scope levels
// (hFOV 40 → 10), and CS's default zoomed sensitivity (zoom_sensitivity_ratio
// 1.0 ⇒ scoped look speed scales with the linear FOV ratio, i.e. 2.25× slower
// at zoom 1 and 9× slower at zoom 2 on a 90° hipfire FOV). Movement is capped
// at 100 u/s scoped, 52 u/s scoped+shift, 32 u/s scoped+crouch, and 200 u/s
// unscoped. Firing while scoped unscopes
// for the bolt cycle, then re-scopes to the same level. There is a short
// "settle" window right after scoping in during which shots are not perfectly
// accurate — the scope hairlines blur to indicate it, exactly like moving does.
//
// The scope state itself (zoom level, cycle/rescope timers, sens + FOV + move
// caps) lives in the WeaponController; this module only supplies the tuning.
// ---------------------------------------------------------------------------

import { degToRad, clamp } from '../utils/MathUtils.js';
import { UNIT } from '../utils/SourceMovement.js';

export const MAG_SIZE = 10;
export const RELOAD_TIME = 3.7; // seconds — CS AWP
// Bolt cycle: minimum spacing between shots (41 RPM).
export const SHOT_INTERVAL = 1.463;
// Consecutive-shot bookkeeping is meaningless for a bolt gun; keep the counter
// resetting between shots so nothing accumulates.
export const BURST_BREAK_MS = SHOT_INTERVAL * 1000 * 1.5;
export const SUSTAIN_CAP_SHOTS = 1;
export const SUSTAIN_RECOVERY_PER_SHOT = 0.1;

// View-punch: one big vertical jolt per shot, slow recovery (bolt cycle).
export const PUNCH_TAU_SPRAY = 0.09;
export const PUNCH_TAU_RECOVER = 0.28;
export const VIEW_PUNCH_STRENGTH = 1.0;

// Scope tuning (consumed by WeaponController / Crosshair / ReplayPlayer).
export const ZOOM = {
  fovs: [40, 10], // horizontal FOV per zoom level (CS AWP: 40°, 10°)
  scopedSpeed: 100 * UNIT, // movement cap while scoped (100 u/s)
  scopedWalkSpeed: 52 * UNIT, // shift-held while scoped (52 u/s)
  scopedCrouchSpeed: 32 * UNIT, // crouched while scoped (32 u/s)
  runSpeed: 200 * UNIT, // AWP unscoped max speed (200 u/s)
  cycleMs: 350, // held right-click: ms between zoom steps
  minScopeInMs: 350, // minimum ms between any scope-in / zoom step
  rescopeMs: 1250, // unscoped after the shot; re-scope when the bolt closes
  settleTime: 0.35 // s after a scope-in before full accuracy
};

/** No deterministic recoil pattern — a bolt gun fires one aimed bullet. */
export function patternOffset() {
  return null;
}

// ---- Bloom (cone half-angle, radians) --------------------------------------
// Unscoped the AWP is a shotgun-sized cone; scoped + still + settled it is a
// laser. Scoping in and moving both open the cone (and blur the scope lines).
const UNSCOPED_BLOOM = degToRad(4.5);
const SCOPED_BASE = degToRad(0.03);
const SETTLE_BLOOM = degToRad(1.6); // extra right after scoping, decays over settleTime
const MOVE_BLOOM = degToRad(3.4); // extra at the scoped-move speed cap
const LAND_BLOOM = degToRad(3.0);
const AIR_BLOOM = degToRad(9.0);

// CS-style accuracy threshold: fully accurate below ~34% of max speed.
const ACCURATE_SPEED_FRAC = 0.34;

/**
 * Random spread cone half-angle (radians) for this shot.
 * @param {{onGround:boolean, speedHoriz:number, scopeLevel?:number, scopeSettle?:number}} state
 *   movement state, extended by the WeaponController with the live scope level
 *   and the 0..1 settle progress since the last scope-in.
 */
export function bloomRad(state, _level, recentlyLanded = false) {
  if (!state.onGround) return AIR_BLOOM;
  const scoped = (state.scopeLevel || 0) > 0;
  if (!scoped) return UNSCOPED_BLOOM + (recentlyLanded ? LAND_BLOOM : 0);

  let r = SCOPED_BASE;
  const settle = clamp(state.scopeSettle ?? 1, 0, 1);
  r += (1 - settle) * SETTLE_BLOOM;
  const moveT = clamp(
    (state.speedHoriz / ZOOM.scopedSpeed - ACCURATE_SPEED_FRAC) / (1 - ACCURATE_SPEED_FRAC),
    0,
    1
  );
  r += moveT * MOVE_BLOOM;
  if (recentlyLanded) r += LAND_BLOOM;
  return r;
}

// One heavy kick per shot; no yaw (no pattern to follow).
const PUNCH_PITCH_DEG = 3.2;
export function viewPunchImpulse() {
  return { pitch: degToRad(PUNCH_PITCH_DEG) * VIEW_PUNCH_STRENGTH, yaw: 0 };
}
