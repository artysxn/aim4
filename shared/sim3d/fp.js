// ---------------------------------------------------------------------------
// shared/sim3d/fp.js
// Float32 arithmetic for the 3D sim, the way the CS2 binary does it.
//
// CS2 computes movement in single precision; JS Numbers are doubles. Running
// the same algorithm in double precision diverges from tick one, and
// collide-and-slide amplifies the difference — a plane-clip decision that
// flips near a wedge changes the trajectory macroscopically, not by an ulp.
// So every store in the sim goes through Math.fround, which is exactly one
// IEEE-754 round-to-nearest-float32 and compiles to a single machine op.
//
// The discipline: fround after EVERY arithmetic op, mirroring scalar SSE
// where each add/mul rounds to float32 before the next. Helpers below encode
// that so sim code reads like math while staying bit-honest.
//
// Residual risk, documented rather than hidden: Math.sin/cos are computed in
// double then rounded, and neither libm nor V8 pins the last ulp, so angle →
// direction can differ from MSVC's SinCos in the final bit. That is the one
// place bit-exactness is not provable from JS; everything algebraic is.
// ---------------------------------------------------------------------------

export const fr = Math.fround;

/** a + b, rounded to f32. */
export const fadd = (a, b) => fr(a + b);
/** a - b, rounded to f32. */
export const fsub = (a, b) => fr(a - b);
/** a * b, rounded to f32. */
export const fmul = (a, b) => fr(a * b);
/** a / b, rounded to f32. */
export const fdiv = (a, b) => fr(a / b);

/** New zero vector. Plain fields, not Float32Array: monomorphic and flat. */
export const v3 = (x = 0, y = 0, z = 0) => ({ x: fr(x), y: fr(y), z: fr(z) });

export function v3set(out, x, y, z) {
  out.x = fr(x);
  out.y = fr(y);
  out.z = fr(z);
  return out;
}

export function v3copy(out, a) {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

/**
 * Dot product with per-op rounding: fr(fr(fr(ax·bx) + fr(ay·by)) + fr(az·bz)),
 * the exact association scalar SSE produces for a three-term dot.
 */
export function v3dot(a, b) {
  return fr(fr(fmul(a.x, b.x) + fmul(a.y, b.y)) + fmul(a.z, b.z));
}

/** out = a + b·s, each component rounded like a scalar FMA-free target. */
export function v3mulAdd(out, a, b, s) {
  out.x = fr(a.x + fmul(b.x, s));
  out.y = fr(a.y + fmul(b.y, s));
  out.z = fr(a.z + fmul(b.z, s));
  return out;
}

export function v3scale(out, a, s) {
  out.x = fmul(a.x, s);
  out.y = fmul(a.y, s);
  out.z = fmul(a.z, s);
  return out;
}

/** Length via double sqrt of an f32 sum, rounded on store — what sqrtss does. */
export function v3len(a) {
  return fr(Math.sqrt(v3dot(a, a)));
}

export function v3len2d(a) {
  return fr(Math.sqrt(fr(fmul(a.x, a.x) + fmul(a.y, a.y))));
}

/**
 * Normalize in place, returning the pre-normalization length. Source's
 * VectorNormalize: divide by length, not multiply by reciprocal.
 */
export function v3normalize(a) {
  const l = v3len(a);
  if (l > 0) {
    a.x = fdiv(a.x, l);
    a.y = fdiv(a.y, l);
    a.z = fdiv(a.z, l);
  }
  return l;
}

const DEG2RAD = Math.PI / 180;

/**
 * Source view yaw (degrees) → f32 forward/right basis on the ground plane.
 * Angles stay z-up Source frame: forward = (cos, sin, 0), right = (sin, -cos, 0).
 */
export function yawBasis(yawDeg, forward, right) {
  const r = yawDeg * DEG2RAD;
  const c = fr(Math.cos(r));
  const s = fr(Math.sin(r));
  v3set(forward, c, s, 0);
  v3set(right, s, -c, 0);
}
