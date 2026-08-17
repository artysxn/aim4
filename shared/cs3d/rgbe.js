// ---------------------------------------------------------------------------
// shared/cs3d/rgbe.js
// The HDR-in-four-bytes encoding the CS3D packs use for probe data: three
// mantissa bytes and one shared exponent, `value = byte × 2^(e − BIAS)`.
//
// It lives here because it is written by scripts/cs3d-pack.mjs (Node) and read
// by src/cs3d/mapLoader.js (browser), and a codec with an encoder and a decoder
// in two files is a codec with two different biases in it eventually. The bias
// is the importer's: tools/cs3d-tex writes the probe atlas this way and
// cs3d-pack's sampler reads it back with the same shift, so the grid it bakes
// stays in the same units as the per-vertex bake beside it.
//
// e = 0 means "black" and is exact: it is the one value where the mantissa is
// ignored, so an empty cell costs nothing to store and reads as zero light.
// ---------------------------------------------------------------------------

/** `value = byte × 2^(e − RGBE_BIAS)`. */
export const RGBE_BIAS = 136;

/** Bytes per encoded triple. */
export const RGBE_BYTES = 4;

/**
 * Write one RGB triple at `out[at .. at+3]`.
 * Values are clamped to the representable range rather than wrapping: a
 * negative or NaN component encodes as black instead of as noise.
 */
export function encodeRgbe(r, g, b, out, at = 0) {
  const m = Math.max(r > 0 ? r : 0, g > 0 ? g : 0, b > 0 ? b : 0);
  if (!(m > 1e-9)) {
    out[at] = 0;
    out[at + 1] = 0;
    out[at + 2] = 0;
    out[at + 3] = 0;
    return out;
  }
  let e = Math.ceil(RGBE_BIAS + Math.log2(m / 255));
  if (e < 1) e = 1;
  else if (e > 255) e = 255;
  const s = Math.pow(2, e - RGBE_BIAS);
  const q = (v) => {
    const n = Math.round(v / s);
    return n < 0 ? 0 : n > 255 ? 255 : n;
  };
  out[at] = q(r);
  out[at + 1] = q(g);
  out[at + 2] = q(b);
  out[at + 3] = e;
  return out;
}

/**
 * Read one RGB triple from `data[at .. at+3]` into `out`, ADDING it scaled by
 * `weight` — the accumulate form, because every caller is interpolating
 * between neighbouring cells. Pass weight 1 into a zeroed `out` for a plain
 * decode.
 */
export function decodeRgbeAdd(data, at, weight, out, outAt = 0) {
  const e = data[at + 3];
  if (!e) return out;
  const s = weight * Math.pow(2, e - RGBE_BIAS);
  out[outAt] += data[at] * s;
  out[outAt + 1] += data[at + 1] * s;
  out[outAt + 2] += data[at + 2] * s;
  return out;
}
