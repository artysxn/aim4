// ---------------------------------------------------------------------------
// src/cs3d/smokeLpv.js
// The light volume a smoke is shaded by: bounce in rgb, SUN VISIBILITY in alpha.
//
// This is the piece that makes a cloud belong to the map. CS2 builds the same
// thing — a 32³ grid of light cells over the smoke, alpha read straight out of
// the map's `direct_light_shadows` — and its march multiplies the sun term by
// that alpha. The effect is that the shadow of whatever is between the cloud
// and the sun lands ON the cloud: throw one under the lip of a roof and the
// roof's edge cuts across it.
//
// The pack does carry a shadow mask, but it is indexed by LIGHTMAP UV, so it
// can only answer "is this bit of FLOOR in shadow" — a 2D question, and it
// needs a raycast to find the floor first. Tracing the map's collision at the
// sun answers the 3D one directly and costs about the same. Around six hundred
// traces build a cloud's volume, so it is spread over a handful of frames
// rather than taken as one thirty-millisecond hitch on the pop.
//
// Until it finishes the smoke renders with `uUseLpv = 0`: full sun, flat
// ambient. That is the wrong answer for four frames and the right shape of
// wrong — it is exactly what the old sprite cloud did for its whole life.
// ---------------------------------------------------------------------------

import { sourceToScene } from '../../shared/sim3d/units.js';

/**
 * Cells a side. Deliberately far below the density volume's 32: sun visibility
 * over a cloud is a low-frequency thing — one edge, softly — and the trilinear
 * filter on the way out is what gives that edge its softness. Sixteen would be
 * 4096 traces and a visible hitch for an edge nobody could tell from this one.
 */
export const LPV_VOX = 12;

/** How far a sun ray is traced before it is called clear, units. */
const SUN_REACH = 6000;

/**
 * How much of the sun a cell in full shadow keeps.
 *
 * Not zero. A shadowed cell still sees sky from every direction the occluder
 * does not cover, and the bounce term alone does not carry that — CS2 gets it
 * from the same lightmap the rest of the map is lit by. At 0 a cloud that
 * straddles a shadow line splits into a white half and a black half.
 */
const SHADOW_FLOOR = 0.22;

/**
 * How much of the probe's irradiance a smoke takes.
 *
 * Larger than it looks like it should be: the cube holds irradiance for a
 * surface BRDF and the march's bounce term is halved again (`BOUNCE_SCALE`)
 * before it reaches the frame. Swept in-frame on Nuke — below about 3 a sunlit
 * cloud reads as wet ash, above about 6 the shaded side stops being shaded.
 */
const ENV_SCALE = 4.5;

const _cube = new Float32Array(18);
const _start = { x: 0, y: 0, z: 0 };
const _end = { x: 0, y: 0, z: 0 };

/** float32 → IEEE half, for the RGBA16F the march samples. */
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function toHalf(v) {
  _f32[0] = v;
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  const frac = x & 0x7fffff;
  if (exp <= 0) return exp < -10 ? sign : sign | ((frac | 0x800000) >>> (14 - exp));
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (frac >>> 13);
}

/**
 * Start a build. Call `step(budget)` until it returns true, then read `data`.
 *
 * @param {object} o
 * @param {{cx,cy,cz,s}} o.box        the smoke's box, scene units
 * @param {{x,y,z}} o.toSun           scene-space, unit; where the sun is
 * @param {object|null} o.world       hullWorld tracer, Source frame
 * @param {object|null} o.probes      the map's ProbeGrid
 * @param {{r,g,b}|null} o.ambient    fallback when there is no probe grid
 * @param {(x,y,z)=>boolean} [o.wanted]  skip cells the cloud cannot reach
 */
export function buildSmokeLpv({ box, toSun, world = null, probes = null, ambient = null, wanted = null }) {
  const n = LPV_VOX;
  const data = new Uint16Array(n * n * n * 4);
  const half = box.s / 2;
  const cell = box.s / n;
  // Source frame, because that is what the tracer speaks.
  const sunX = toSun ? toSun.x : 0;
  const sunY = toSun ? -toSun.z : 0;
  const sunZ = toSun ? toSun.y : 1;
  const len = Math.hypot(sunX, sunY, sunZ) || 1;
  const sx = (sunX / len) * SUN_REACH;
  const sy = (sunY / len) * SUN_REACH;
  const sz = (sunZ / len) * SUN_REACH;
  const amb = ambient || { r: 0.35, g: 0.35, b: 0.35 };

  let i = 0;
  const total = n * n * n;

  return {
    data,
    size: n,
    get done() {
      return i >= total;
    },
    /**
     * Trace up to `budget` cells. Returns true once the volume is complete.
     * Cells the cloud cannot reach are filled with lit ambient and cost nothing.
     */
    step(budget = 512) {
      let spent = 0;
      while (i < total && spent < budget) {
        const ix = i % n;
        const iy = Math.floor(i / n) % n;
        const iz = Math.floor(i / (n * n));
        i++;
        // Cell centre, scene frame.
        const x = box.cx - half + (ix + 0.5) * cell;
        const y = box.cy - half + (iy + 0.5) * cell;
        const z = box.cz - half + (iz + 0.5) * cell;

        let vis = 1;
        const near = !wanted || wanted(x, y, z);
        if (near && world) {
          // Source frame. `traceHull` takes the BOTTOM of the hull, so drop the
          // start by half the probe's height to centre it on the cell.
          _start.x = x;
          _start.y = -z;
          _start.z = y - 1;
          _end.x = _start.x + sx;
          _end.y = _start.y + sy;
          _end.z = _start.z + sz;
          // A thin hull rather than a bare ray: a zero-width ray threads the
          // gap between two triangles that share an edge and reports sun where
          // there is none, which speckles the cloud.
          const t = world.traceHull(_start, _end, 1, 2);
          if (t.startSolid || t.fraction < 1) vis = SHADOW_FLOOR;
          spent++;
        }

        let r = amb.r;
        let g = amb.g;
        let b = amb.b;
        if (probes) {
          probes.sample(x, y, z, _cube);
          // The cube's +y and −y faces (scene axis order, mapLoader's ProbeGrid
          // layout). A cloud is lit from above and fills from below, so the two
          // averaged is the irradiance it actually sits in.
          r = (_cube[6] + _cube[9]) * 0.5 * ENV_SCALE;
          g = (_cube[7] + _cube[10]) * 0.5 * ENV_SCALE;
          b = (_cube[8] + _cube[11]) * 0.5 * ENV_SCALE;
          if (near) spent++;
        }

        const o = ((iz * n + iy) * n + ix) * 4;
        data[o] = toHalf(r);
        data[o + 1] = toHalf(g);
        data[o + 2] = toHalf(b);
        data[o + 3] = toHalf(vis);
      }
      return i >= total;
    }
  };
}

/**
 * A `wanted` test for `buildSmokeLpv`: within `pad` of any filled cell.
 *
 * The cloud fills a fraction of its box, and a cell nowhere near it is never
 * sampled by the march. Skipping those is most of what makes the build cheap.
 */
export function nearFill(vol, pad = 96) {
  const pts = vol.cells.map((c) => {
    const [x, y, z] = sourceToScene(c.x, c.y, c.z);
    return { x, y, z };
  });
  const r2 = pad * pad;
  return (x, y, z) => {
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - x;
      const dy = pts[i].y - y;
      const dz = pts[i].z - z;
      if (dx * dx + dy * dy + dz * dz < r2) return true;
    }
    return false;
  };
}
