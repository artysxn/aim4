// ---------------------------------------------------------------------------
// scripts/lib/texAlpha.mjs
// Dropping a texture's alpha channel before sharp gets a chance to resize it.
// ---------------------------------------------------------------------------

import sharp from 'sharp';

/**
 * `img` with any alpha channel removed, as a fresh sharp pipeline over its raw
 * pixels. Consumes `img`; pass a pipeline nothing else is going to read.
 *
 * sharp runs its operations in a fixed pipeline order, not the order they are
 * called in, and resize premultiplies RGB by alpha and divides it back out
 * afterwards. `.removeAlpha().resize(...)` therefore removes nothing in time:
 * the resize still sees the alpha, and wherever it is 0 the divide cannot get
 * the colour back — those texels come out black.
 *
 * On a texture whose alpha is opacity that is invisible, which is why it hides
 * so well. Source 2 does not use it that way: g_tNormal's alpha is ROUGHNESS,
 * and g_tColor's is a mask. `ctm_sas_body`'s normal ships with alpha 0 across
 * the whole 2048² sheet, so the CT's torso packed as an all-zero normal map —
 * every shading normal facing away from every light, jacket and sleeves pure
 * black in the renderer while the legs beside them (alpha ≈ 150) came out fine.
 *
 * The map packer hit this first and fixed it there (cs3d-pack.mjs `_rgbOf`);
 * this is the same fix for the two pipelines that pack in-memory glTF textures.
 */
export async function dropAlpha(img) {
  const { data, info } = await img.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  if (info.channels < 4) return sharp(data, { raw });
  const n = info.width * info.height;
  const rgb = Buffer.allocUnsafe(n * 3);
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const p = i * info.channels;
    rgb[o] = data[p];
    rgb[o + 1] = data[p + 1];
    rgb[o + 2] = data[p + 2];
  }
  return sharp(rgb, { raw: { ...raw, channels: 3 } });
}

/**
 * The default roughness for a slot that has none: 180/255 ≈ 0.71, the value
 * `channelAt` fills in when the texture is absent altogether.
 */
export const ROUGHNESS_DEFAULT = 180;

/**
 * Is this extracted roughness channel empty rather than authored?
 *
 * VRF does not always carry roughness through, and it goes missing in a
 * different place for each shader: `csgo_character.vfx` keeps it in the normal
 * map's ALPHA, and `ctm_sas_body`'s comes out zero across every texel;
 * `csgo_weapon.vfx` keeps it in a `_rough` map's R. Read at face value either
 * one is roughness 0 — a perfect mirror — which put chrome on the CT's vest and
 * on all 66 weapons.
 *
 * A material can legitimately be fully rough, and a small dark patch is
 * ordinary; what cannot happen is an entire sheet at zero. So the test is
 * "nothing above ~1/255 anywhere", which no authored roughness map satisfies.
 */
export function roughnessIsEmpty(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 1) return false;
  return true;
}

/**
 * Is this normal map blank rather than authored?
 *
 * The rail under dropAlpha, and under whatever VRF does next: a tangent-space
 * normal is a unit vector encoded around (128, 128, 255), so its blue channel
 * is at least 128 everywhere and nothing legitimate is near zero. All-black is
 * not a flat surface, it is (−1, −1, −1) — a normal pointing into the mesh.
 */
export function normalIsBlank(rgb, channels = 3) {
  for (let i = 2; i < rgb.length; i += channels) if (rgb[i] > 8) return false;
  return true;
}
