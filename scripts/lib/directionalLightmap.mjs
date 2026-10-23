// ---------------------------------------------------------------------------
// scripts/lib/directionalLightmap.mjs
// CS2's directional lightmap (`lightmaps/directional_irradiance.vtex_c`), from
// the PNG cs3d-import exports to the webp the pack ships.
//
// The game bakes two atlases for indirect light: `irradiance` (how much) and
// this one (from where). Without it a normal map only answers the sun, and
// every surface in shade is flat. Per texel, as Valve's own shader reads it
// (ComputeLightmapShading, via the ValveResourceFormat renderer):
//
//   R, G   the dominant direction of the incoming light, TANGENT space x/y,
//          packed ×0.5 + 0.5; z is rebuilt from them
//   B      the non-directional share of the irradiance, 0..1
//   A      unused here (1 in the BC1 the game ships)
//
// Same chart layout and UVs as the irradiance atlas; 4096² on every map, which
// is also the size the pack ships the irradiance at.
//
// Lossless and RGB only: it is data, not a picture, so webp's lossy chroma
// subsampling would average neighbouring directions into ones nobody baked
// (the same reason the normal maps and the shadow mask are lossless).
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import sharp from 'sharp';

/** Raw import name, beside irradiance.png and direct_light_shadows.png. */
export const DIRECTIONAL_PNG = 'directional_irradiance.png';
/** Pack file name. */
export const DIRECTIONAL_FILE = 'directional.webp';

/**
 * @param {string} pngFile  the 8-bit RGBA export (cs3d-tex mask2d)
 * @param {string} outFile  where the webp goes
 * @param {number} maxSize  cap, px (the irradiance's pack size)
 * @returns {Promise<{size: number, bytes: number, encoding: string, mean: number[]}>}
 */
export async function packDirectional(pngFile, outFile, maxSize) {
  const meta = await sharp(pngFile, { limitInputPixels: false }).metadata();
  const size = Math.min(maxSize, meta.width);
  let pipe = sharp(pngFile, { limitInputPixels: false }).removeAlpha();
  // Linear, not lanczos: a direction is not a colour, and ringing would invent
  // overshoot past the unit circle. Not hit at the default sizes (4096 → 4096).
  if (size !== meta.width) pipe = pipe.resize(size, size, { kernel: 'linear', fit: 'fill' });
  const raw = await pipe.raw().toBuffer({ resolveWithObject: true });
  const ch = raw.info.channels;
  const sums = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < raw.data.length; i += ch * 61) {
    for (let c = 0; c < 3; c++) sums[c] += raw.data[i + c] / 255;
    n++;
  }
  const buf = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: ch } })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
  await fsp.writeFile(outFile, buf);
  return {
    size,
    bytes: buf.length,
    encoding: 'tangent-xy-nondir',
    mean: sums.map((s) => Math.round((s / n) * 1000) / 1000)
  };
}
