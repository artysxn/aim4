// ---------------------------------------------------------------------------
// utils/sourceMouse.js
// Source engine mouse-to-angle, ported exactly.
//
// From CInput::ScaleMouse and CInput::ApplyMouse (src/game/client/in_mouse.cpp).
// With acceleration off, which is the default and what almost everyone plays
// on, the whole thing is two multiplications:
//
//   yaw   -= m_yaw   * sensitivity * dx
//   pitch += m_pitch * sensitivity * dy
//
// in DEGREES, with pitch clamped to cl_pitchdown / cl_pitchup. That is the
// entire relationship between a mouse count and a view angle in CS2, and the
// reason a player's sensitivity number transfers between the game and here
// only if this file matches it exactly.
//
// The constant that matters is 0.022. `m_pitch` is a ConVar_ServerBounded: with
// sv_cheats off the engine forces it to exactly ±0.022 no matter what the
// player set, so on any real server 0.022 is not a default, it is the value.
// `m_yaw` is not bounded, but its default is the same 0.022 and changing it is
// vanishingly rare.
//
// Pure and framework-free so the numbers can be checked against the game
// without a browser: see sourceMouse.test.js.
// ---------------------------------------------------------------------------

/** m_yaw, m_pitch: degrees of view per mouse count at sensitivity 1. */
export const M_YAW_DEFAULT = 0.022;
export const M_PITCH_DEFAULT = 0.022;
/** `sensitivity` ConVar default, and its ConVar bounds. */
export const SENSITIVITY_DEFAULT = 2.5;
export const SENSITIVITY_MIN = 0.0001;
export const SENSITIVITY_MAX = 1000;
/** cl_pitchdown / cl_pitchup: how far the view may look down / up, in degrees. */
export const CL_PITCHDOWN = 89;
export const CL_PITCHUP = 89;

/** m_customaccel modes, exactly as the ConVar documents them. */
export const ACCEL_OFF = 0;
export const ACCEL_POW_SCALE = 1;
export const ACCEL_POW_SCALE_AXIS = 2;
export const ACCEL_POW_ONLY = 3;

export const ACCEL_SCALE_DEFAULT = 0.04;
export const ACCEL_MAX_DEFAULT = 0;
export const ACCEL_EXPONENT_DEFAULT = 1.05;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * CInput::ScaleMouse.
 *
 * Returns the scaled deltas, still in "mouse units" - ApplyMouse is what turns
 * them into degrees. Kept as two steps because the engine does: custom
 * acceleration mode 2 multiplies by m_yaw and m_pitch a SECOND time here, on
 * top of the ones ApplyMouse applies, and collapsing the two functions would
 * quietly lose that.
 *
 * @param {number} mx raw mouse delta x (counts)
 * @param {number} my raw mouse delta y (counts)
 * @param {object} cfg
 * @returns {{x: number, y: number}}
 */
export function scaleMouse(mx, my, cfg = {}) {
  const sensitivity = clamp(
    Number.isFinite(cfg.sensitivity) ? cfg.sensitivity : SENSITIVITY_DEFAULT,
    SENSITIVITY_MIN,
    SENSITIVITY_MAX
  );
  const mode = Number(cfg.customAccel) || ACCEL_OFF;
  const mYaw = Number.isFinite(cfg.mYaw) ? cfg.mYaw : M_YAW_DEFAULT;
  const mPitch = Number.isFinite(cfg.mPitch) ? cfg.mPitch : M_PITCH_DEFAULT;

  if (mode === ACCEL_POW_SCALE || mode === ACCEL_POW_SCALE_AXIS) {
    const scale = Number.isFinite(cfg.accelScale) ? cfg.accelScale : ACCEL_SCALE_DEFAULT;
    const max = Number.isFinite(cfg.accelMax) ? cfg.accelMax : ACCEL_MAX_DEFAULT;
    const exponent = Number.isFinite(cfg.accelExponent)
      ? cfg.accelExponent
      : ACCEL_EXPONENT_DEFAULT;
    const distance = Math.sqrt(mx * mx + my * my);
    let accelerated = Math.pow(distance, exponent) * scale + sensitivity;
    // `m_customaccel_max` of 0 means no limit, which is why the engine tests
    // against 0.0001 rather than against zero.
    if (max > 0.0001 && accelerated > max) accelerated = max;
    let x = mx * accelerated;
    let y = my * accelerated;
    if (mode === ACCEL_POW_SCALE_AXIS) {
      x *= mYaw;
      y *= mPitch;
    }
    return { x, y };
  }

  if (mode === ACCEL_POW_ONLY) {
    // The engine works from the SQUARED distance and halves the exponent,
    // which is the same curve without the square root. Kept in that form so
    // the floating point matches rather than merely agreeing to a few places.
    const distanceSquared = mx * mx + my * my;
    const exponent = Number.isFinite(cfg.accelExponent)
      ? cfg.accelExponent
      : ACCEL_EXPONENT_DEFAULT;
    const fExp = Math.max(0, (exponent - 1) / 2);
    const accelerated = Math.pow(distanceSquared, fExp) * sensitivity;
    return { x: mx * accelerated, y: my * accelerated };
  }

  return { x: mx * sensitivity, y: my * sensitivity };
}

/**
 * CInput::ApplyMouse, mouselook branch, in degrees.
 *
 * Yaw DECREASES with a rightward delta and pitch INCREASES with a downward one,
 * because Source's pitch is positive-downward. A renderer using the usual
 * positive-up convention negates it once, at the edge, rather than here.
 *
 * @returns {{yaw: number, pitch: number}} the new angles, degrees
 */
export function applyMouse(yaw, pitch, scaledX, scaledY, cfg = {}) {
  const mYaw = Number.isFinite(cfg.mYaw) ? cfg.mYaw : M_YAW_DEFAULT;
  const mPitch = Number.isFinite(cfg.mPitch) ? cfg.mPitch : M_PITCH_DEFAULT;
  const down = Number.isFinite(cfg.pitchDown) ? cfg.pitchDown : CL_PITCHDOWN;
  const up = Number.isFinite(cfg.pitchUp) ? cfg.pitchUp : CL_PITCHUP;

  const nextYaw = yaw - mYaw * scaledX;
  let nextPitch = pitch + mPitch * scaledY;
  if (nextPitch > down) nextPitch = down;
  if (nextPitch < -up) nextPitch = -up;
  return { yaw: nextYaw, pitch: nextPitch };
}

/**
 * Degrees of view per mouse count, with acceleration off.
 *
 * The number everything else is derived from: cm/360, counts per 360, and
 * whether a sensitivity entered here matches the same one in the game.
 */
export function degreesPerCount(sensitivity = SENSITIVITY_DEFAULT, mYaw = M_YAW_DEFAULT) {
  const s = clamp(Number(sensitivity) || 0, SENSITIVITY_MIN, SENSITIVITY_MAX);
  return mYaw * s;
}

/** Mouse counts for a full 360 degree turn. */
export function countsPer360(sensitivity = SENSITIVITY_DEFAULT, mYaw = M_YAW_DEFAULT) {
  const per = degreesPerCount(sensitivity, mYaw);
  return per > 0 ? 360 / per : Infinity;
}

/** Centimetres of mousepad for a full 360, at a given CPI. */
export function cm360(sensitivity = SENSITIVITY_DEFAULT, dpi = 800, mYaw = M_YAW_DEFAULT) {
  if (!(dpi > 0)) return Infinity;
  return (countsPer360(sensitivity, mYaw) / dpi) * 2.54;
}

/** The sensitivity that produces a given cm/360 at a CPI. The inverse of cm360. */
export function sensitivityForCm360(cm, dpi = 800, mYaw = M_YAW_DEFAULT) {
  if (!(cm > 0) || !(dpi > 0)) return SENSITIVITY_DEFAULT;
  const counts = (cm / 2.54) * dpi;
  return clamp(360 / (counts * mYaw), SENSITIVITY_MIN, SENSITIVITY_MAX);
}
