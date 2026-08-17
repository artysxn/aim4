// Run: node shared/cs3d/rgbe.test.js
//
// The probe codec, from both ends. The encoder runs in the packer and the
// decoder in the browser, so the only thing standing between them is that
// these two agree — and the failure mode if they do not is not a crash, it is
// every player in the map lit at 2^k the right brightness.

import { encodeRgbe, decodeRgbeAdd, RGBE_BIAS } from './rgbe.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const dec = (buf, at = 0) => decodeRgbeAdd(buf, at, 1, [0, 0, 0]);

// ---- round trip across the range the probe atlas actually spans -----------
{
  const buf = new Uint8Array(4);
  // Nuke's grid runs 0 to ~6 in luminance with a max component near 13.
  for (const v of [1e-4, 0.01, 0.12, 0.43, 1, 2.5, 6.11, 13.4, 60]) {
    encodeRgbe(v, v * 0.5, v * 0.25, buf);
    const [r, g, b] = dec(buf);
    // 8 mantissa bits: within half a step of the shared exponent.
    const tol = v / 255 + 1e-9;
    assert(Math.abs(r - v) <= tol, `r round trip at ${v}: ${r} (tol ${tol})`);
    assert(Math.abs(g - v * 0.5) <= tol, `g round trip at ${v}: ${g}`);
    assert(Math.abs(b - v * 0.25) <= tol, `b round trip at ${v}: ${b}`);
  }
}

// ---- black is exact, and costs one recognisable byte ----------------------
{
  const buf = new Uint8Array(4).fill(9);
  encodeRgbe(0, 0, 0, buf);
  assert(buf[3] === 0, 'black encodes exponent 0');
  const [r, g, b] = dec(buf);
  assert(r === 0 && g === 0 && b === 0, 'black decodes to zero');
  // A zero exponent must contribute nothing even with junk in the mantissa.
  const junk = new Uint8Array([255, 255, 255, 0]);
  const out = decodeRgbeAdd(junk, 0, 1, [7, 7, 7]);
  assert(out[0] === 7 && out[1] === 7 && out[2] === 7, 'exponent 0 adds nothing');
}

// ---- garbage in stays black rather than becoming noise --------------------
{
  const buf = new Uint8Array(4);
  for (const bad of [-5, Number.NaN, -Infinity]) {
    encodeRgbe(bad, bad, bad, buf);
    assert(buf[3] === 0, `${bad} encodes as black`);
  }
  // A negative component beside a positive one clamps to zero, not to 255.
  encodeRgbe(1, -1, 0.5, buf);
  const [r, g, b] = dec(buf);
  assert(g === 0, `negative component clamps to 0, got ${g}`);
  assert(Math.abs(r - 1) < 0.01 && Math.abs(b - 0.5) < 0.01, 'its neighbours survive');
}

// ---- the accumulate form is what trilinear sampling needs -----------------
{
  // Eight cells of equal value, weights summing to 1, must reconstruct it.
  const cells = new Uint8Array(8 * 4);
  for (let i = 0; i < 8; i++) encodeRgbe(0.4, 0.6, 0.8, cells, i * 4);
  const out = [0, 0, 0];
  for (let i = 0; i < 8; i++) decodeRgbeAdd(cells, i * 4, 1 / 8, out);
  for (const [got, want] of [[out[0], 0.4], [out[1], 0.6], [out[2], 0.8]]) {
    assert(Math.abs(got - want) < 0.005, `weighted sum ${got} vs ${want}`);
  }
  // Half-weight between black and a value is half the value: a body walking
  // out of an unlit cell must brighten, not jump.
  const pair = new Uint8Array(8);
  encodeRgbe(0, 0, 0, pair, 0);
  encodeRgbe(2, 2, 2, pair, 4);
  const mid = [0, 0, 0];
  decodeRgbeAdd(pair, 0, 0.5, mid);
  decodeRgbeAdd(pair, 4, 0.5, mid);
  assert(Math.abs(mid[0] - 1) < 0.01, `midpoint ${mid[0]} vs 1`);
}

// ---- the bias is the importer's, and is not free to drift ----------------
{
  // tools/cs3d-tex and cs3d-pack's atlas sampler both read `2^(e - 136)`;
  // a change here silently rescales every probe in every pack.
  assert(RGBE_BIAS === 136, `RGBE_BIAS is ${RGBE_BIAS}, expected 136`);
  const buf = new Uint8Array([128, 128, 128, 136]);
  const [r] = dec(buf);
  assert(r === 128, `byte 128 at exponent ${RGBE_BIAS} decodes to 128, got ${r}`);
}

console.log('rgbe.test: ok');
