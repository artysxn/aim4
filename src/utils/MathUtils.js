// ---------------------------------------------------------------------------
// MathUtils.js
// Pure helpers: sensitivity-to-radians conversion, FOV scaling, easing, random.
// No Three.js dependency so this stays trivially unit-testable.
// ---------------------------------------------------------------------------

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const degToRad = (d) => (d * Math.PI) / 180;
export const radToDeg = (r) => (r * 180) / Math.PI;
export const randRange = (min, max) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(randRange(min, max + 1));

// 1 inch = 2.54 cm  ->  cm to inches factor.
const INCH_PER_CM = 0.393701;

/** Reference sensitivity on the unified scale (35 × 1200 CPI equivalent). */
export const SENSITIVITY_REF = 2.58 / 3;
export const SENSITIVITY_DEFAULT = 2.5 / 3;

/** Legacy calibration: cm/360 × DPI product that maps to {@link SENSITIVITY_REF}. */
const LEGACY_SENS_PRODUCT = 35 * 1200;
const COUNTS_PER_360_AT_REF = LEGACY_SENS_PRODUCT * INCH_PER_CM;

/** Radians per mouse count at sensitivity 1.0 (linear scale). */
const RADIANS_PER_COUNT_AT_SENS_1 =
  (Math.PI * 2) / (COUNTS_PER_360_AT_REF * SENSITIVITY_REF);

/**
 * Raw mouse counts for a full 360° at the given unified sensitivity.
 * Turn speed is linear in sensitivity (half the value → half the speed).
 */
export function countsPer360FromSensitivity(sensitivity) {
  if (sensitivity <= 0) return COUNTS_PER_360_AT_REF;
  return (Math.PI * 2) / (RADIANS_PER_COUNT_AT_SENS_1 * sensitivity);
}

/**
 * Radians of camera rotation per raw mouse count (Pointer Lock movementX/Y).
 * Linear: radiansPerCount(s) = RADIANS_PER_COUNT_AT_SENS_1 × s.
 */
export function radiansPerCountFromSensitivity(sensitivity) {
  if (sensitivity <= 0) return RADIANS_PER_COUNT_AT_SENS_1 * SENSITIVITY_REF;
  return RADIANS_PER_COUNT_AT_SENS_1 * sensitivity;
}

/** Convert saved cm/360 + DPI settings to the unified sensitivity scale. */
export function sensitivityFromLegacy(cm360, dpi) {
  return (cm360 * dpi * SENSITIVITY_REF) / LEGACY_SENS_PRODUCT;
}

/**
 * Convert a desired *horizontal* FOV into the *vertical* FOV that Three.js'
 * PerspectiveCamera expects, given a render aspect ratio. This keeps the
 * horizontal FOV constant across stretched / non-native aspect ratios.
 *
 *   vFov = 2 * atan( tan(hFov / 2) / aspect )
 */
export function hFovToVFov(hFovDeg, aspect) {
  const h = degToRad(hFovDeg);
  const v = 2 * Math.atan(Math.tan(h / 2) / aspect);
  return radToDeg(v);
}

// Easing curves used by spawn / death animations.
export const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
