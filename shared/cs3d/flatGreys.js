// ---------------------------------------------------------------------------
// shared/cs3d/flatGreys.js
// The flat view's shading rule: a map's materials, in greys, by how much of the
// world each one covers.
//
// Two readers, and they have to agree. The map explorer computes this live when
// you press V (src/cs3d/fpsView.js), and scripts/gen-trainer-map.mjs bakes the
// same greys into the aim trainer's ported maps at build time so a ported map
// looks like the explorer's flat view rather than merely similar to it. Hence
// one module, and no `three` import so a build script can read it.
//
// Why area and not triangle count. The obvious proxy is wrong here: Nuke's
// `metal_pipe_001` carries 255k triangles strung around the map and covers less
// ground than the two triangles under the hangar. Shading by triangle count
// paints the pipes black and the floor white, which is backwards. So area is
// measured in world space per material and the ramp runs over the log of it.
//
// Log, and over the full range rather than a percentile window. The areas span
// eleven and 29 million square units on Nuke — six orders of magnitude — so a
// linear fit puts everything but the ground in one shade. An early version also
// quantized to five steps, which is what made the merely-large surfaces
// indistinguishable from the enormous ones: 65 materials came out the same
// grey. The ramp is continuous and anchored at the true extremes, so the
// largest surface in the map is the darkest thing in it and the smallest is the
// brightest, with everything in between placed by its own size.
// ---------------------------------------------------------------------------

/**
 * The ramp ends, as 8-bit grey: smallest surface in the map → largest surface.
 *
 * The dark end is nowhere near black on purpose. The biggest materials are the
 * ground, the roofs and the outside walls, which is most of any screenful, so
 * whatever value the ramp ends at is what most of the view will be — and the
 * lighting can only take it down from there. A first cut ended at 0x1a and put
 * 83% of the frame under 40/255: a correct ramp nobody could read.
 */
export const GREY_SMALLEST = 0xf0;
export const GREY_LARGEST = 0x42;

/** Darker than the darkest surface in shadow, so the horizon reads as backdrop. */
export const SKY_GREY = 0x161616;

/**
 * Materials the flat view drops instead of flattening. Cut-outs (MASK), the
 * blended and glass surfaces (BLEND), the decals and the effect cards all get
 * their look from a texture's alpha, and an opaque grey stand-in for one is a
 * slab rather than a fence.
 */
export const isDetail = (m) => !!m.decal || !!m.effect || m.alphaMode !== 'OPAQUE';

/** Ramp position (0 smallest, 1 largest) → a grey hex. */
export function greyAt(t) {
  const v = Math.round(GREY_SMALLEST + (GREY_LARGEST - GREY_SMALLEST) * t);
  return (v << 16) | (v << 8) | v;
}

/**
 * A grey per material id, from the log of its world-space area, spread over the
 * whole ramp between the map's smallest and largest surface.
 *
 * @param {Array<{id: number}>} materials  the manifest's material rows
 * @param {(id: number) => number} areaOf  world-space area for a material id
 * @returns {Map<number, number|null>} id → grey hex, or null for "not drawn"
 */
export function greyRamp(materials, areaOf) {
  const out = new Map();
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of materials) {
    if (isDetail(m)) {
      out.set(m.id, null);
      continue;
    }
    const a = areaOf(m.id) || 0;
    if (a <= 0) continue;
    const l = Math.log(a);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  const span = hi - lo;
  for (const m of materials) {
    if (out.has(m.id)) continue;
    const a = areaOf(m.id) || 0;
    // No area yet: its tiles have not streamed in. Mid ramp rather than an
    // extreme, so a half-loaded map does not read as all-ground or all-prop.
    const t = a > 0 && span > 1e-6 ? Math.min(1, Math.max(0, (Math.log(a) - lo) / span)) : 0.5;
    out.set(m.id, greyAt(t));
  }
  return out;
}

/**
 * World-space surface area of a triangle soup.
 *
 * Positions must already be in world space; `index` may be null for a
 * non-indexed soup.
 *
 * @param {ArrayLike<number>} positions  xyz triples
 * @param {ArrayLike<number>|null} index
 */
export function surfaceArea(positions, index = null) {
  const n = index ? index.length : positions.length / 3;
  let sum = 0;
  for (let i = 0; i < n; i += 3) {
    const a = (index ? index[i] : i) * 3;
    const b = (index ? index[i + 1] : i + 1) * 3;
    const c = (index ? index[i + 2] : i + 2) * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    sum += Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  return sum * 0.5;
}
