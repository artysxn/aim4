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

/**
 * Counts (raw mouse units) required for a full 360° turn.
 *
 *   Counts per 360 = cm360 * DPI * 0.393701
 *
 * Derivation: DPI is counts per inch, and 1 cm = 0.393701 inch, so counts per
 * centimeter = DPI * 0.393701. Multiplying by the centimeters of travel for a
 * full turn (cm360) gives the counts per 360°.
 *
 * @param {number} cm360 centimeters of mouse travel per 360° (true sensitivity)
 * @param {number} dpi   mouse DPI / CPI
 */
export function countsPer360(cm360, dpi) {
  if (cm360 <= 0 || dpi <= 0) return 1;
  return cm360 * dpi * INCH_PER_CM;
}

/**
 * Radians of camera rotation to apply per single mouse count (pixel delta).
 *
 *   Radians per count = 2π / (Counts per 360)
 */
export function radiansPerCount(cm360, dpi) {
  return (Math.PI * 2) / countsPer360(cm360, dpi);
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
