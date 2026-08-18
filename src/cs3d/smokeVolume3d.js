// ---------------------------------------------------------------------------
// src/cs3d/smokeVolume3d.js
// A CS2 smoke as CS2 draws it: one raymarched volume, not a pile of sprites.
//
// WHY THIS REPLACED THE SPRITE CARDS, and it is worth being exact about,
// because the symptom was a cloud strobing hard between white and grey and the
// obvious explanation was not the right one.
//
// A cloud of a few hundred camera-facing quads has to be sorted back to front
// every frame, because alpha blending is not commutative — that much is normal,
// and it only costs a little popping where two quads cross. What made it a
// STROBE is that `SpriteCardBatch.sort` permutes the instance buffers, and
// among them `iLitTop`/`iLitBot`: the map's probe irradiance where that puff
// stands. Those were written ONCE, at spawn, per cell. The pose loop rewrote
// position, size and tint by cell index every frame and never rewrote them. So
// from the first re-sort onwards every puff was lit by some other puff's probe,
// and the assignment reshuffled every time the camera moved — a whole cloud
// swapping its lighting around, sixty times a second.
//
// That could have been patched. It was not worth patching: per-particle probe
// lighting is a stand-in for what the game actually does, and what the game
// actually does is integrate one volume. So this is that instead.
//
// WHAT IT IS. `explosion_smokegrenade_voxel` is not the smoke. The smoke is a
// box the size of the cloud, with the pixel shader marching a ray through a
// 3D density texture from the front of the box to the back and accumulating
// as it goes. Everything below — the entry offset, the step scheme, the
// alpha shaping, the HE displacement, the lighting — is that shader,
// transcribed. Two things in it are what the eye actually reads:
//
//   BALL SHADING     `sphereN = normalize(uvw - 0.5)`: every sample knows which
//                    way it faces out of the cloud, so the march shades the
//                    volume as a sphere. Dotted with the sun through
//                    LIGHT_SUN_RAMP1/2 that gives the bright rim on the sun
//                    side falling off to a dark far side. A smoke lit flat is
//                    the single biggest tell that it is not part of the scene.
//
//   THE LPV          A 3D texture over the same box, one texel per light cell:
//                    rgb is the map's bounce at that cell and ALPHA IS SUN
//                    VISIBILITY. That alpha is what puts the shadow of a roof
//                    across the middle of a cloud — the voxels under the roof
//                    lose the sun term while the ones beside them keep it. It
//                    is built in smokeLpv.js by tracing each cell at the sun.
//
// The numbers in CS2M/CS2N/CS2L below are the shipped constants, not fits.
//
// WALLS. CS2 clips the march against the scene depth buffer. We cannot sample
// this renderer's 4x MSAA depth (see spriteCard.js), so a half-res non-MSAA
// colour pass writes linear view-Z and the march stops there. The box draws
// back-face, depth-test off: occlusion is the shader, not the rasterizer.
// The volume is composited AFTER bloom so it does not pick up the fire glow.
//
// WHAT THIS DOES NOT CARRY. The game's 128³ noise texture, native voxel TexA,
// MBOIT, and the capture dither t0.bin are not in this repo. The march uses
// the baked Worley, the flood-fill density, and an IGN stand-in for t0, with
// the shipped entry law, 6-unit steps, haze, step-repeat and 4-step resolve.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import {
  Break,
  Discard,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  cameraViewMatrix,
  ceil,
  clamp,
  exp,
  float,
  fract,
  log,
  max,
  min,
  mix,
  normalize,
  pow,
  screenCoordinate,
  screenUV,
  smoothstep,
  step,
  texture,
  texture3D,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
  positionWorld
} from 'three/webgpu';
import { LPV_VOX } from './smokeLpv.js';
import { smokeDepthLive, smokeDepthTexture } from './smokeDepth.js';

// ---- the shipped constants -------------------------------------------------
// `Yl` (march + lighting) and `l1` (noise) out of the decompiled smoke shader,
// verbatim. Rounded only where the decompile carries a float32's full decimal
// expansion of a number that is plainly 0.05.
//
/** Ray-march and displacement. CS2's `CS2M_*` / `Yl`, the terms this march reads. */
const CS2M = Object.freeze({
  ENTRY_PUSH: 6,
  STEP_RATE: 0.25,
  MIN_STEPS: 2,
  DENSITY_CUTOFF: 0.01,
  DENSITY_RESCALE: 1.0101009607315063,
  NEAR_BOOST_SCALE: 0.1,
  SCENE_BACKOFF: 2,
  // Dithered entry + 6-unit steps. CS2's `CS2ENTRY_ON` default.
  ENTRY_BASE: 4,
  ENTRY_JITTER_BIAS: 150,
  ENTRY_JITTER_SCALE: 0.05,
  ENTRY_JITTER_RAMP: [0.7, 0.1],
  ENTRY_TIME_SCROLL: 0.618034,
  STEP_WORLD: 6,
  JITTER_GAIN: 0.8,
  STEP_COUNT_SLOP: 10,
  MARCH_STEP_REPEAT_RATE: 0.25,
  // The HE. Every one of these is read in the displacement loop below.
  HE_MAX_DIST: 250,
  HE_AGE_MARGIN: 0.4,
  HE_FLASH_POW: 128,
  HE_FLASH_RAMP: [0, 2],
  HE_PULL_RAMP: [100, 250],
  HE_PULL_SPEED: 1250,
  HE_SHADOW_RAMP: [200, 240],
  HE_SHADOW_PUSH: 250,
  HE_SHADOW_AGE_RAMP: [0.5, 5],
  HE_SHADOW_AGE_POW: 1.8,
  HE_COLOR_MIX: 0.6,
  // Dissolve at the start of life.
  DISSOLVE_E0: [0, 0.8],
  DISSOLVE_E1: [0.2, 1],
  DISSOLVE_Z_STRETCH: 1.2,
  // Lighting.
  SUN_GRADIENT_GAIN: 0.8,
  SUN_GRADIENT_BIAS: 0.2,
  SUN_GRADIENT_POW: 2,
  BOUNCE_SCALE: 0.5,
  // CS2SHADE. The simple sun-gradient path reads as a glowing ball; these
  // ramps plus a noise-perturbed normal are what put dark crevices on the
  // billows and a sun side that is not emissive.
  LIGHT_SUN_RAMP1: [0.8, 0.2],
  LIGHT_SUN_RAMP2: [1.4, -0.5],
  LIGHT_SUN_POW: 1.5,
  LIGHT_SUN_COL_SCALE: 0.5,
  LIGHT_BOUNCE_ACAP: 0.25,
  LIGHT_BOUNCE_SUN: [0.25, 0.75],
  LIGHT_NEAR_RANGE: 200,
  LIGHT_NEAR_INV: 0.005,
  NOISE_GRAD_TAP: 0.012,
  LUMA: [0.2125, 0.7154, 0.0721],
  TINT_GUARD: 0.001,
  // Alpha shaping, haze, resolve, early out.
  ALPHA_SHAPE: [0, 0.2],
  ALPHA_KNEE_ACC: [1.5, 0.5],
  ALPHA_KNEE_SCALE: 0.85,
  EARLY_OUT: 0.991,
  DISCARD_EPS: 1e-6,
  HAZE_GAIN_BIAS: 0.3,
  HAZE_GAIN_SCALE: 5,
  HAZE_CONTACT_Z_SCALE: 2,
  HAZE_CONTACT_Z_CAP: 20,
  HAZE_STEP_WEIGHT: 6,
  HAZE_ALPHA_GATE: 1e-6,
  HAZE_CB_GAIN: 0.06,
  HAZE_CB_CONTACT_RANGE: 16,
  HAZE_BIAS: 0.2,
  RESOLVE_STEPS: 4,
  A_MIN: 1e-6,
  A_MAX: 0.9999,
  OPAQUE_SNAP: 0.9999
});

/** Noise. CS2's `CS2N_*` / the `NOISE_*` half of `Yl`. */
const CS2N = Object.freeze({
  WORLD_SCALE: 0.01,
  DRIFT_LOW: 0.05,
  DRIFT_HIGH: 0.03,
  SCALE_LOW: 2.3,
  SCALE_HIGH: 6,
  WEIGHT_LOW: 0.6,
  WEIGHT_HIGH: 0.28,
  BIAS: 0.12,
  TIME_SCALE: 1.5,
  OCT1_WEIGHT: 0.5,
  OCT2_WEIGHT: 0.35,
  OCT1_SCALE: 3,
  OCT2_SCALE: 7,
  REMAP_TOP: 1.05,
  UV_SCALE: 0.07
});

/** Gains from the shipped shade combo (`c1` in the decompile). */
const CS2L = Object.freeze({
  PERT_GAIN: 0.5,
  SUN_NORMAL_MIX: 0.5,
  BOUNCE_GAIN: 0.6,
  SUN_GAIN: 0.35
});

/** Half-res composite: 120 steps through a 960 box is enough, and the shader stays a loop. */
const STEPS_MAX = 120;

/** How many HE blasts one smoke tracks at once. CS2's `uHE` is five. */
export const HE_SLOTS = 5;

/** Voxels a side in the density texture. CS2 ships 32³ and so does this. */
export const VOX = 32;

/**
 * Widest a cloud's box may get, scene units, and the narrowest.
 *
 * CS2 fixes the box at 640 (32 cells of 20 units) because its smoke is always
 * the same volume. Ours flood-fills, so a cloud poured down a corridor is a
 * different shape from one in the open, and sizing the box to the fill spends
 * the 32³ on the smoke instead of on empty air around it.
 */
const BOX_MIN = 384;
const BOX_MAX = 960;

/** How wide one fill cell stamps into the density volume, in lattice pitches. */
const SPLAT_RADIUS = 1.6;
/** ...and how hard, so overlapping stamps saturate instead of beating. */
const SPLAT_PEAK = 0.85;

/**
 * Slack between the outermost fill cell and the wall of the box, in lattice
 * pitches. A cell's stamp reaches `SPLAT_RADIUS` past its own seat, so anything
 * less than that clips the cloud flat against the box and the march reads a
 * sheared edge; the extra is a voxel of rounding room on top.
 */
export const BOX_PAD_CELLS = SPLAT_RADIUS + 0.6;

// ---- the noise volume ------------------------------------------------------

/** Voxels a side. Same as the capture the decompile samples (`smoke_noise128`). */
const NOISE_VOX = 128;
/** Worley cells in the volume, per channel. Uncorrelated so the remap has two frequencies. */
const NOISE_CELLS = [8, 16];

let _noiseTex = null;

/**
 * The two Worley octaves the march reads, baked once into an RG volume.
 *
 * The shader CS2 falls back to when its own 128³ is not bound evaluates
 * `cs2Worley` twice per march STEP — 54 hashed cell distances a step, times
 * ninety-odd steps, times every pixel the cloud covers. That is not a shader,
 * it is a heater. The field is static apart from a slow drift the march applies
 * to the lookup coordinate, so it bakes exactly.
 *
 * Once, during map load (`warmSmokeNoise` from NadeEffects.loadFx). Feature
 * points are hashed per cell, not per voxel, so 128³ is a couple of hundred
 * milliseconds rather than a hitch on the first throw.
 */
export function warmSmokeNoise() {
  ditherVolume();
  return noiseVolume();
}

function noiseVolume() {
  if (_noiseTex) return _noiseTex;
  const n = NOISE_VOX;
  const data = new Uint8Array(n * n * n * 2);
  const hash3 = (x, y, z, period, out) => {
    const px = ((x % period) + period) % period;
    const py = ((y % period) + period) % period;
    const pz = ((z % period) + period) % period;
    let hx = frac((px * 0.1031 + py * 0.11369 + pz * 0.13787) * 1.0);
    let hy = frac((px * 0.11369 + py * 0.13787 + pz * 0.1031) * 1.0);
    let hz = frac((px * 0.13787 + py * 0.1031 + pz * 0.11369) * 1.0);
    const d = hx * (hy + 19.19) + hy * (hz + 19.19) + hz * (hx + 19.19);
    hx = frac(hx + d);
    hy = frac(hy + d);
    hz = frac(hz + d);
    out[0] = hx;
    out[1] = hy;
    out[2] = hz;
  };
  const fp = [0, 0, 0];
  for (let o = 0; o < 2; o++) {
    const cells = NOISE_CELLS[o];
    const pts = new Float32Array(cells * cells * cells * 3);
    for (let iz = 0; iz < cells; iz++) {
      for (let iy = 0; iy < cells; iy++) {
        for (let ix = 0; ix < cells; ix++) {
          hash3(ix, iy, iz, cells, fp);
          const i = (iz * cells + iy) * cells + ix;
          pts[i * 3] = ix + fp[0];
          pts[i * 3 + 1] = iy + fp[1];
          pts[i * 3 + 2] = iz + fp[2];
        }
      }
    }
    const at = (ix, iy, iz) => {
      const x = ((ix % cells) + cells) % cells;
      const y = ((iy % cells) + cells) % cells;
      const z = ((iz % cells) + cells) % cells;
      return ((z * cells + y) * cells + x) * 3;
    };
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const cx = (x / n) * cells;
          const cy = (y / n) * cells;
          const cz = (z / n) * cells;
          const ix = Math.floor(cx);
          const iy = Math.floor(cy);
          const iz = Math.floor(cz);
          let best = 4;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const j = at(ix + dx, iy + dy, iz + dz);
                let ex = pts[j] + (ix + dx - (((ix + dx) % cells) + cells) % cells) - cx;
                let ey = pts[j + 1] + (iy + dy - (((iy + dy) % cells) + cells) % cells) - cy;
                let ez = pts[j + 2] + (iz + dz - (((iz + dz) % cells) + cells) % cells) - cz;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < best) best = d2;
              }
            }
          }
          data[((z * n + y) * n + x) * 2 + o] = Math.round(Math.min(1, best) * 255);
        }
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  _noiseTex = tex;
  return tex;
}

function frac(v) {
  return v - Math.floor(v);
}

const DITHER_SIZE = 256;
let _ditherTex = null;

/**
 * Stand-in for CS2's 256² t0 dither. The real capture is not in this repo;
 * IGN at integer coords is what the march uses for the shipped entry law
 * (max(tmin, 4) + jitter * 6 * 0.8 * distanceRamp).
 */
function ditherVolume() {
  if (_ditherTex) return _ditherTex;
  const n = DITHER_SIZE;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = Math.round(frac(52.9829189 * frac(x * 0.06711056 + y * 0.00583715)) * 255);
      const o = (y * n + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _ditherTex = tex;
  return tex;
}

// ---- the material ----------------------------------------------------------

/**
 * Build the march. One material for every cloud: three r169 keeps the sampler
 * it compiled against (see cs3d-pack-v2-state), so the density and LPV bytes
 * are copied into the textures this graph was built with, never swapped.
 */
function buildMaterial(u) {
  const density = texture3D(u.densityTex);
  const lpv = texture3D(u.lpvTex);
  const noise = texture3D(noiseVolume());
  const dither = texture(ditherVolume());
  const sceneDepthTex = texture(smokeDepthTexture());

  /** Shipped `cs2NoiseRemap`. POW is 1 and CONTRAST is 0, so this is a scale. */
  const noiseRemap = Fn(([rg]) => {
    const pw = max(rg, vec2(0));
    const cc = pw.mul(CS2N.REMAP_TOP);
    return cc.y.mul(0.95).add(cc.x).mul(4.6);
  });

  /**
   * `smokeTint`: apply the team/map colour without changing how bright the
   * sample is. CS2 divides the tinted colour's luma back out, so the tint only
   * ever moves hue — which is why a CT smoke does not read as darker than a T
   * one — and `uTintMix` fades the whole thing out as the cloud greys with age.
   */
  const smokeTint = Fn(([c]) => {
    const luma = vec3(...CS2M.LUMA);
    const tinted = c.mul(u.color);
    const keep = c.dot(luma).div(tinted.add(vec3(CS2M.TINT_GUARD)).dot(luma));
    return mix(c, tinted.mul(keep), u.tintMix);
  });

  /**
   * CS2SHADE, trimmed: noise-perturbed normal, the two sun ramps, bounce and
   * sun gains. The simple `sunGrad * sunColor` path is what made our cloud
   * read as a glowing ball.
   */
  const lighting = Fn(([shadeN, uvw, n, heF, alphaMix]) => {
    const l4 = lpv.uv(uvw);
    const bounce = mix(u.ambientColor, l4.rgb, u.useLpv);
    const sd = shadeN.dot(normalize(u.lightDir));
    const se1 = clamp(sd.mul(CS2M.LIGHT_SUN_RAMP1[0]).add(CS2M.LIGHT_SUN_RAMP1[1]), 0, 1);
    const se2 = clamp(sd.mul(CS2M.LIGHT_SUN_RAMP2[0]).add(CS2M.LIGHT_SUN_RAMP2[1]), 0, 1);
    const sunS = pow(se1, float(CS2M.LIGHT_SUN_POW))
      .add(se2.mul(se2).mul(se2))
      .mul(mix(float(1), l4.a, u.useLpv))
      .toVar();
    const bw = float(1)
      .sub(min(alphaMix, CS2M.LIGHT_BOUNCE_ACAP))
      .mul(n)
      .mul(sunS.mul(CS2M.LIGHT_BOUNCE_SUN[0]).add(CS2M.LIGHT_BOUNCE_SUN[1]));
    const col = bounce
      .mul(bw)
      .mul(CS2L.BOUNCE_GAIN)
      .add(clamp(u.sunColor, 0, 1).mul(sunS).mul(CS2M.LIGHT_SUN_COL_SCALE).mul(CS2L.SUN_GAIN))
      .toVar();
    col.assign(smokeTint(col));
    return mix(col, col.mul(heF), float(CS2M.HE_COLOR_MIX));
  });

  const march = Fn(() => {
    const ro = cameraPosition;
    const rd = positionWorld.sub(ro).normalize().toVar();
    const boxMax = u.boxMin.add(u.boxSize);

    // Slab test. `rd` is never axis-aligned enough for the reciprocal to blow
    // up in practice, and the max/min pair handles the sign either way.
    const inv = vec3(1).div(rd);
    const ta = u.boxMin.sub(ro).mul(inv);
    const tb = boxMax.sub(ro).mul(inv);
    const tmin = min(ta, tb);
    const tmax = max(ta, tb);
    const t0 = max(max(tmin.x, tmin.y), tmin.z).toVar();
    const t1 = min(min(tmax.x, tmax.y), tmax.z).toVar();

    const out = vec4(0).toVar();
    If(t1.lessThan(max(t0, 0)), () => {
      Discard();
    });

    // Shipped entry: max(tmin, 4) + blue-noise jitter along a 6-unit step,
    // scaled down when the box is close so the silhouette does not crawl.
    const tminRaw = t0;
    const jScale = clamp(tminRaw.add(CS2M.ENTRY_JITTER_BIAS).mul(CS2M.ENTRY_JITTER_SCALE), 0, 1)
      .mul(CS2M.ENTRY_JITTER_RAMP[0])
      .add(CS2M.ENTRY_JITTER_RAMP[1]);
    const ditherUv = fract(screenCoordinate.xy.div(DITHER_SIZE));
    const j = fract(dither.uv(ditherUv).r.add(u.time.mul(CS2M.ENTRY_TIME_SCROLL)));
    t0.assign(
      max(tminRaw, float(CS2M.ENTRY_BASE)).add(
        j.mul(CS2M.STEP_WORLD).mul(CS2M.JITTER_GAIN).mul(jScale)
      )
    );
    If(t0.greaterThanEqual(t1), () => {
      Discard();
    });

    const sceneZ = smokeDepthLive.greaterThan(0.5).select(sceneDepthTex.uv(screenUV).r, float(1e5));
    const cosAxis = max(cameraViewMatrix.mul(vec4(rd, 0)).z.negate(), 1e-4);
    const sceneRayDist = sceneZ.div(cosAxis);
    const tExit = max(min(t1, sceneRayDist.sub(CS2M.SCENE_BACKOFF)), t0);
    const originY = u.boxMin.y.add(u.boxSize.y.mul(0.5));
    const rayEnd = ro.add(rd.mul(tExit));

    const steps = min(
      max(ceil(tExit.sub(t0).div(CS2M.STEP_WORLD)).add(CS2M.STEP_COUNT_SLOP), 1),
      float(STEPS_MAX)
    ).toVar();
    const stepLen = float(CS2M.STEP_WORLD);
    const stepV = rd.mul(stepLen);
    const p = ro.add(rd.mul(t0)).toVar();
    const tMarch = t0.toVar();
    const tailPass = float(0).toVar();

    const accum = vec4(0).toVar();
    const haze = float(0).toVar();
    const growRamp = clamp(u.grow.mul(2).sub(0.5), 0, 1);

    Loop({ start: 0, end: STEPS_MAX, type: 'int', condition: '<' }, ({ i }) => {
      If(tailPass.lessThan(0.5).and(float(i).greaterThanEqual(steps)), () => {
        tailPass.assign(1);
      });
      If(tailPass.greaterThan(0.5), () => {
        p.assign(rayEnd);
        tMarch.subAssign(stepLen);
      });

          // -- the HE. Verbatim from the shipped march. ----------------------
          //
          // Two separate effects and they are easy to conflate. `pull` DRAGS
          // THE SAMPLE POINT towards the blast — the ray reads the density
          // that used to be there, so the smoke visibly rushes inward — and it
          // is gated by `step(age * 1250, dist)`, an expanding front at 1250
          // units a second: nothing beyond the front has been reached yet.
          // `heFactor` is the HOLE, and it heals on its own through `recover`,
          // a smoothstep over half a second to five seconds raised to 1.8, so
          // the gap is a gap for most of its life and then closes.
          const heFactor = float(1).toVar();
          const heSample = p.toVar();
          Loop({ start: 0, end: HE_SLOTS, type: 'int', condition: '<', name: 'h' }, ({ h }) => {
            If(h.greaterThanEqual(u.heCount), () => {
              Break();
            });
            const he = u.he.element(h);
            const heAge = he.w;
            // A blast older than the smoke did not go off in this smoke.
            If(heAge.lessThan(u.smokeAge.sub(CS2M.HE_AGE_MARGIN)), () => {
              const heDist = heSample.distance(he.xyz);
              If(heDist.lessThan(CS2M.HE_MAX_DIST), () => {
                const initial = pow(smoothstep(...CS2M.HE_FLASH_RAMP, heAge).oneMinus(), float(CS2M.HE_FLASH_POW));
                const pull = smoothstep(...CS2M.HE_PULL_RAMP, heDist)
                  .oneMinus()
                  .mul(step(heAge.mul(CS2M.HE_PULL_SPEED), heDist))
                  .mul(initial.oneMinus());
                heSample.assign(mix(heSample, he.xyz, pull));
                const recover = pow(smoothstep(...CS2M.HE_SHADOW_AGE_RAMP, heAge), float(CS2M.HE_SHADOW_AGE_POW));
                heFactor.assign(
                  min(
                    heFactor,
                    clamp(
                      smoothstep(...CS2M.HE_SHADOW_RAMP, heDist.add(initial.mul(CS2M.HE_SHADOW_PUSH))).add(recover),
                      0,
                      1
                    )
                  )
                );
              });
            });
          });

          const ps = heSample;
          const uvw = clamp(ps.sub(u.boxMin).div(u.boxSize), 0, 1);

          // -- density ------------------------------------------------------
          // R is the cell, G is how deep the flood fill had to go to reach it.
          // `uGrow` sweeps 0 to 1 over the first second and the cell appears as
          // it passes: the cloud unfolds from the canister outwards instead of
          // fading up everywhere at once.
          const m = density.uv(uvw);
          const grown = m.g.lessThanEqual(0.002).select(
            float(1),
            smoothstep(u.grow.sub(0.02), u.grow.add(0.08), m.g).oneMinus()
          );
          const dens = clamp(m.r.mul(grown), 0, 1).mul(mix(float(0.02), float(1), heFactor));

          If(dens.greaterThan(CS2M.DENSITY_CUTOFF), () => {
            const a = max(dens.sub(CS2M.DENSITY_CUTOFF), 0)
              .mul(CS2M.DENSITY_RESCALE)
              .mul(growRamp)
              .mul(u.alphaFade)
              .toVar();
            // Near boost: a cloud you are standing in front of thickens, which
            // is what stops a smoke you are pressed against reading as thin.
            a.assign(
              clamp(
                a.add(clamp(cameraPosition.distance(ps).mul(CS2M.NEAR_BOOST_SCALE), 0, 1).oneMinus().mul(a)),
                0,
                1
              )
            );

            // -- noise ------------------------------------------------------
            // Shipped combo: two octaves through `cs2NoiseRemap`, scrolled so
            // the cloud reads as rising. The remap saturates the field into
            // billows; `1-w` on raw Worley is what made ours look like clay.
            const T = u.time.mul(CS2N.TIME_SCALE);
            const uvwC = vec3(uvw.x, uvw.z, uvw.y).sub(0.5);
            const q = uvwC.mul(7);
            const scroll = vec3(T.mul(0.2), T.mul(0.2), T.mul(0.45));
            const c1 = abs(q.mul(CS2N.OCT1_SCALE)).sub(scroll).mul(CS2N.UV_SCALE);
            const c2 = q.mul(CS2N.OCT2_SCALE).mul(CS2N.UV_SCALE);
            const n1 = noiseRemap(noise.uv(c1).rg);
            const n2 = noiseRemap(noise.uv(c2).rg);
            const distCam = cameraPosition.distance(ps);
            const r53w = min(distCam.mul(0.005), 1).mul(cosAxis).mul(CS2N.OCT2_WEIGHT);
            const n = clamp(
              float(CS2N.OCT1_WEIGHT)
                .mul(clamp(n1, 0, 1).sub(0.95))
                .add(0.95)
                .add(r53w.mul(clamp(n2, 0, 1).sub(0.95))),
              0,
              1
            );

            // -- the dissolve ------------------------------------------------
            // The cloud's BIRTH, and it is not a fade-up: a solid ball opens
            // outward from the canister, and everything outside it is not there
            // yet. `uFade` runs 0 to 1 over the first two seconds. `rc.y` is
            // stretched by 1.2 so the ball opens along the floor before it
            // opens upward, which is how a canister actually empties.
            If(u.fade.lessThan(1), () => {
              const f = clamp(u.fade, 0.0001, 0.9999);
              const e0 = smoothstep(...CS2M.DISSOLVE_E0, f);
              const e1 = smoothstep(...CS2M.DISSOLVE_E1, f);
              const rc = uvw.sub(u.popUvw).mul(vec3(1, CS2M.DISSOLVE_Z_STRETCH, 1));
              // Written out rather than handed to `smoothstep`, because for most
              // of the cloud's first two seconds CS2 passes it edge0 > edge1 —
              // the ball is solid INSIDE `e1` and cut off outside `e0`, which is
              // what makes it open outwards. HLSL evaluates that as the same
              // saturate((x-e0)/(e1-e0)); WGSL calls low >= high undefined, so
              // the ratio is spelled out and the degenerate case is branched.
              const den = e1.sub(e0);
              const flat = den.abs().lessThan(1e-6);
              const t = clamp(rc.length().clamp(0, 1).sub(e0).div(flat.select(float(1), den)), 0, 1);
              a.mulAssign(flat.select(f, t.mul(t).mul(t.mul(-2).add(3))));
            });

            // -- alpha shaping --------------------------------------------------
            // The knee tightens as the ray fills up, so the front of a cloud
            // stays soft while the depth behind it saturates instead of both
            // going flat together.
            const aKnee = float(CS2M.ALPHA_SHAPE[1]).div(
              float(CS2M.ALPHA_KNEE_ACC[0]).mul(accum.a).add(CS2M.ALPHA_KNEE_ACC[1]).mul(CS2M.ALPHA_KNEE_SCALE)
            );
            const alphaMix = mix(a.sub(n.oneMinus()), a.add(n), a).mul(u.alphaBirthDeath);
            const aOut = smoothstep(float(CS2M.ALPHA_SHAPE[0]), aKnee, clamp(alphaMix, 0, 1));

            // The epsilon is not decoration: `normalize(vec3(0))` is NaN in
            // WGSL, and a NaN here poisons the whole ray's accumulation, not
            // just the sample that produced it.
            const sphereN = normalize(uvw.sub(vec3(0.4999, 0.5, 0.5)));
            const n1x = noiseRemap(noise.uv(c1.add(vec3(CS2M.NOISE_GRAD_TAP, 0, 0))).rg);
            const n1y = noiseRemap(noise.uv(c1.add(vec3(0, CS2M.NOISE_GRAD_TAP, 0))).rg);
            const g1 = normalize(vec3(n1.sub(n1x), n1.sub(n1y), 0.8));
            const shadeN = normalize(mix(sphereN, g1, CS2L.SUN_NORMAL_MIX));
            const col = lighting(shadeN, uvw, n, heFactor, alphaMix);
            const sample4 = vec4(clamp(col, 0, 1).mul(aOut), aOut);

            const repLen = tailPass.greaterThan(0.5).select(tExit.sub(tMarch), stepLen);
            const kRep = repLen.mul(CS2M.MARCH_STEP_REPEAT_RATE).toVar();

            If(alphaMix.greaterThanEqual(CS2M.HAZE_ALPHA_GATE), () => {
              const hg = clamp(alphaMix.add(CS2M.HAZE_GAIN_BIAS).mul(CS2M.HAZE_GAIN_SCALE), 0, 1);
              const hGain = hg.mul(hg).mul(hg.mul(-2).add(3));
              const distToEnd = ps.distance(rayEnd);
              const hContact = min(
                abs(rayEnd.y.sub(originY)).mul(CS2M.HAZE_CONTACT_Z_SCALE),
                CS2M.HAZE_CONTACT_Z_CAP
              );
              const hFade = clamp(
                float(CS2M.HAZE_CB_CONTACT_RANGE)
                  .sub(max(distToEnd.sub(hContact), 0))
                  .div(CS2M.HAZE_CB_CONTACT_RANGE),
                0,
                1
              );
              haze.addAssign(
                hGain.mul(a).mul(hFade).mul(CS2M.HAZE_CB_GAIN).mul(CS2M.HAZE_STEP_WEIGHT).mul(kRep)
              );
            });

            // Step-repeat: 6-unit steps accumulate 1.5x so optical depth
            // matches the 4-unit combo the density was authored against.
            // Two premultiplied adds cover that 1.5 (and a shorter tail);
            // a 16-iter inner Loop compiled into a 2s hitch on every pop.
            const k1 = min(kRep, 1);
            accum.addAssign(sample4.mul(k1.mul(accum.a.oneMinus())));
            accum.addAssign(sample4.mul(max(kRep.sub(1), 0).mul(accum.a.oneMinus())));
            If(accum.a.greaterThan(CS2M.EARLY_OUT), () => {
              accum.assign(vec4(accum.rgb, 1));
              Break();
            });
          });

          If(tailPass.greaterThan(0.5), () => {
            Break();
          });
          p.addAssign(stepV);
          tMarch.addAssign(stepLen);
          If(tMarch.greaterThanEqual(tExit), () => {
            tailPass.assign(1);
          });
        });

        const hazeOut = clamp(haze.sub(float(CS2M.HAZE_BIAS).mul(accum.a)), 0, 1);
        const o3 = vec4(accum.rgb.mul(hazeOut.oneMinus()), hazeOut.add(accum.a)).toVar();
        If(o3.a.lessThan(CS2M.DISCARD_EPS), () => {
          Discard();
        });
        const b0 = float(0).toVar();
        Loop({ start: 1, end: CS2M.RESOLVE_STEPS + 1, type: 'int', condition: '<' }, ({ i }) => {
          const ra = clamp(o3.a.mul(float(i).div(CS2M.RESOLVE_STEPS)), CS2M.A_MIN, CS2M.A_MAX);
          b0.subAssign(log(float(1).sub(ra)));
        });
        const alphaOut = float(1).sub(exp(b0.negate())).toVar();
        If(alphaOut.greaterThanEqual(CS2M.OPAQUE_SNAP), () => {
          alphaOut.assign(1);
        });
        out.assign(vec4(o3.rgb.mul(alphaOut.div(clamp(o3.a, CS2M.A_MIN, CS2M.A_MAX))), alphaOut));
    return out;
  });

  const mat = new THREE.NodeMaterial();
  mat.colorNode = march();
  mat.transparent = true;
  mat.depthWrite = false;
  // Premultiplied, because the march accumulates that way — `sample4.rgb` is
  // already scaled by its own alpha. Blending it as straight alpha would
  // multiply by the coverage twice and the cloud would come out sooty.
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // Back-face, depth-test off: CS2's draw. Walls are the march's job (scene
  // depth), so flipping cull face would compile a second pipeline on walk-in.
  mat.side = THREE.BackSide;
  mat.depthTest = false;
  mat.toneMapped = true;
  // No fog, which is the shipped shader's choice and not an oversight: the
  // march carries no fog uniforms at all, because CS2 composites the cloud OVER
  // an already-fogged scene. Fogging it here would be wrong twice — the haze
  // would be applied on top of haze the scene behind it already has, and the
  // output is premultiplied, so a mix towards the fog colour at low alpha lifts
  // the edge of every cloud into a halo.
  mat.fog = false;
  return mat;
}

// ---- the mesh --------------------------------------------------------------

const _boxGeo = new THREE.BoxGeometry(1, 1, 1);

function makeDensityGpu() {
  const data = new Uint8Array(VOX * VOX * VOX * 2);
  const tex = new THREE.Data3DTexture(data, VOX, VOX, VOX);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return { data, tex };
}

function makeLpvGpu() {
  const l = LPV_VOX;
  const data = new Uint16Array(l * l * l * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 0x3c00; // half 1.0
  const tex = new THREE.Data3DTexture(data, l, l, l);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return { data, tex };
}

/** One compiled march. Every cloud copies into these textures on draw. */
let _gpu = null;
function sharedGpu() {
  if (_gpu) return _gpu;
  const density = makeDensityGpu();
  const lpv = makeLpvGpu();
  const u = {
    densityTex: density.tex,
    lpvTex: lpv.tex,
    boxMin: uniform(new THREE.Vector3()),
    boxSize: uniform(new THREE.Vector3(BOX_MIN, BOX_MIN, BOX_MIN)),
    popUvw: uniform(new THREE.Vector3(0.5, 0.5, 0.5)),
    color: uniform(new THREE.Color(1, 1, 1)),
    lightDir: uniform(new THREE.Vector3(0.35, 0.82, 0.34).normalize()),
    ambientColor: uniform(new THREE.Color(0.72, 0.76, 0.78)),
    sunColor: uniform(new THREE.Color(1, 0.96, 0.88)),
    time: uniform(0),
    grow: uniform(1),
    fade: uniform(1),
    alphaFade: uniform(1),
    alphaBirthDeath: uniform(1),
    tintMix: uniform(0.5),
    smokeAge: uniform(0),
    useLpv: uniform(0),
    heCount: uniform(0, 'int'),
    he: uniformArray(Array.from({ length: HE_SLOTS }, () => new THREE.Vector4()), 'vec4')
  };
  const mat = buildMaterial(u);
  _gpu = { density, lpv, u, mat };
  return _gpu;
}

/**
 * Compile the two cull-face pipelines after `renderer.init()`, so the first
 * grenade is not the compile. Front+depth for standing outside a cloud;
 * back-face, depth-test off for standing in one.
 */
export async function prewarmSmoke(renderer, camera, renderTarget = null) {
  warmSmokeNoise();
  smokeDepthTexture();
  const g = sharedGpu();
  const mesh = new THREE.Mesh(_boxGeo, g.mat);
  mesh.frustumCulled = false;
  const scn = new THREE.Scene();
  scn.add(mesh);
  camera.updateMatrixWorld();
  const prev = renderer.getRenderTarget();
  try {
    if (typeof renderer.compileAsync !== 'function') return;
    if (renderTarget) renderer.setRenderTarget(renderTarget);
    await renderer.compileAsync(scn, camera);
  } catch (e) {
    console.warn('cs3d: smoke pipeline prewarm failed', e);
  } finally {
    renderer.setRenderTarget(prev);
    mesh.removeFromParent();
  }
}

/**
 * One cloud: a box, a density volume, an LPV. The march is shared; this holds
 * the CPU buffers and copies them in on draw.
 */
export class SmokeVolume3D {
  constructor() {
    const n = VOX;
    /** R: how much of the cell is there. G: flood-fill depth, normalised. */
    this.densityData = new Uint8Array(n * n * n * 2);
    const l = LPV_VOX;
    this.lpvData = new Uint16Array(l * l * l * 4);
    for (let i = 3; i < this.lpvData.length; i += 4) this.lpvData[i] = 0x3c00; // half 1.0

    this.boxMin = new THREE.Vector3();
    this.boxSize = new THREE.Vector3(BOX_MIN, BOX_MIN, BOX_MIN);
    this.popUvw = new THREE.Vector3(0.5, 0.5, 0.5);
    this.color = new THREE.Color(1, 1, 1);
    this.lightDir = new THREE.Vector3(0.35, 0.82, 0.34).normalize();
    this.ambientColor = new THREE.Color(0.72, 0.76, 0.78);
    this.sunColor = new THREE.Color(1, 0.96, 0.88);
    this.time = 0;
    this.grow = 1;
    this.fade = 1;
    this.alphaFade = 1;
    this.alphaBirthDeath = 1;
    this.tintMix = 0.5;
    this.smokeAge = 0;
    this.useLpv = 0;
    this.heCount = 0;
    this.he = Array.from({ length: HE_SLOTS }, () => new THREE.Vector4());
    this.mesh = null;
    this._built = false;
    this.box = null;
  }

  /** Deferred so a cloud thrown before the first frame does not build twice. */
  _build() {
    if (this._built) return;
    const g = sharedGpu();
    this.mesh = new THREE.Mesh(_boxGeo, g.mat);
    this.mesh.frustumCulled = false;
    // After the world, before the fire and the HE flash.
    this.mesh.renderOrder = 6;
    this.mesh.onBeforeRender = () => this._bind();
    this._built = true;
  }

  /**
   * Copy this cloud into the shared GPU state. Called from `onBeforeRender` so
   * two live smokes each get their own density on their own draw.
   */
  _bind() {
    const g = sharedGpu();
    g.density.data.set(this.densityData);
    g.density.tex.needsUpdate = true;
    g.lpv.data.set(this.lpvData);
    g.lpv.tex.needsUpdate = true;
    const u = g.u;
    u.boxMin.value.copy(this.boxMin);
    u.boxSize.value.copy(this.boxSize);
    u.popUvw.value.copy(this.popUvw);
    u.color.value.copy(this.color);
    u.lightDir.value.copy(this.lightDir);
    u.ambientColor.value.copy(this.ambientColor);
    u.sunColor.value.copy(this.sunColor);
    u.time.value = this.time;
    u.grow.value = this.grow;
    u.fade.value = this.fade;
    u.alphaFade.value = this.alphaFade;
    u.alphaBirthDeath.value = this.alphaBirthDeath;
    u.tintMix.value = this.tintMix;
    u.smokeAge.value = this.smokeAge;
    u.useLpv.value = this.useLpv;
    u.heCount.value = this.heCount;
    for (let i = 0; i < HE_SLOTS; i++) u.he.array[i].copy(this.he[i]);
  }

  /**
   * Place the box. `center` and `size` are scene units; the box is cubic so the
   * `sphereN` the lighting reads is a sphere and not an ellipsoid.
   *
   * `inner` is the half-extent of the cloud rather than of the box (the box
   * carries padding the fill does not). Kept on `this.box` for callers.
   */
  setBox(cx, cy, cz, size, inner = size / 2) {
    const s = Math.min(BOX_MAX, Math.max(BOX_MIN, size));
    this.boxSize.set(s, s, s);
    this.boxMin.set(cx - s / 2, cy - s / 2, cz - s / 2);
    this._build();
    this.mesh.scale.set(s, s, s);
    this.mesh.position.set(cx, cy, cz);
    this.box = { cx, cy, cz, s, inner: Math.min(inner, s / 2) };
  }

  /**
   * Where the canister went off, in scene units. The dissolve ball opens from
   * this point; lighting still reads the fill-centred box as a sphere.
   */
  setPop(x, y, z) {
    const s = this.boxSize.x;
    if (!(s > 0)) return;
    this.popUvw.set((x - this.boxMin.x) / s, (y - this.boxMin.y) / s, (z - this.boxMin.z) / s);
  }

  /**
   * Splat the flood fill into the density volume.
   *
   * Once per cloud, not per frame: `uGrow` animates the unfolding and
   * `uAlphaFade` the death, so the field itself only changes when the fill
   * does — which is only when an HE knits a hole back in.
   *
   * Each cell is stamped over the voxels it covers with a smooth radial
   * falloff, and the stamps ADD rather than compete. That distinction is the
   * whole quality of the field. Taking the max leaves a dip everywhere two
   * cells meet — the fill's lattice is 32 units and the voxels are half that,
   * so a voxel halfway between two cells is 16 from each and neither stamp is
   * near its peak there; measured, the middle of a cloud came out at 148/255
   * and the cloud read as a lumpy shell rather than a body. Summing and
   * saturating gives what an occupancy grid should give: solid wherever cells
   * overlap, falling off only at the boundary where there is nothing next door.
   *
   * @param {{cells: {x,y,z,d}[], cell: number}} vol  Source frame, from smokeVolume.js
   * @param {(i: number) => number} [weightOf]  0..1 per cell; the HE knit-back
   */
  setDensity(vol, weightOf = null) {
    const n = VOX;
    const data = this.densityData;
    data.fill(0);
    // Which cell owns each voxel's fill-depth: the one whose own stamp is
    // strongest there, which is the nearest. Kept apart from the summed
    // density, because the sum saturates and could not be compared.
    const best = (this._best ||= new Uint8Array(n * n * n));
    best.fill(0);
    const { cx, cy, cz, s } = this.box;
    const voxel = s / n;
    // 1.6 pitches, at 0.85 of full strength. Swept against the baked field: at
    // one pitch the interior still ripples 44/255 at the lattice's own period,
    // because a voxel between two cells catches both stamps well down their
    // falloff. Wider stamps at lower strength put the interior deep enough into
    // saturation that the lattice disappears, and cost twelve units of extra
    // reach at the boundary. Past about two pitches the ripple comes back, in
    // the gap between the SECOND ring of neighbours.
    const rv = (vol.cell * SPLAT_RADIUS) / voxel;
    const maxD = Math.max(1e-6, vol.cells.reduce((m, c) => Math.max(m, c.d), 0));

    for (let idx = 0; idx < vol.cells.length; idx++) {
      const c = vol.cells[idx];
      const w = weightOf ? weightOf(idx) : 1;
      if (!(w > 0)) continue;
      // Source (x, y, z) → scene (x, z, −y); inlined, this runs a few hundred
      // thousand times a throw.
      const gx = (c.x - (cx - s / 2)) / voxel;
      const gy = (c.z - (cy - s / 2)) / voxel;
      const gz = (-c.y - (cz - s / 2)) / voxel;
      // G is the fill's own ordering, so the reveal follows the fill. Never 0:
      // the march reads 0 as "no cell here" and skips the grow ramp entirely.
      const depth = Math.min(255, Math.round((c.d / maxD) * 254) + 1);

      const x0 = Math.max(0, Math.ceil(gx - rv));
      const x1 = Math.min(n - 1, Math.floor(gx + rv));
      const y0 = Math.max(0, Math.ceil(gy - rv));
      const y1 = Math.min(n - 1, Math.floor(gy + rv));
      const z0 = Math.max(0, Math.ceil(gz - rv));
      const z1 = Math.min(n - 1, Math.floor(gz + rv));
      for (let z = z0; z <= z1; z++) {
        const dz = (z - gz) / rv;
        for (let y = y0; y <= y1; y++) {
          const dy = (y - gy) / rv;
          const dzy = dz * dz + dy * dy;
          if (dzy > 1) continue;
          const row = (z * n + y) * n;
          for (let x = x0; x <= x1; x++) {
            const dx = (x - gx) / rv;
            const d2 = dzy + dx * dx;
            if (d2 > 1) continue;
            // Smoothstep falloff, so a cell's edge does not read as a sphere.
            const t = 1 - Math.sqrt(d2);
            const v = t * t * (3 - 2 * t) * 255 * SPLAT_PEAK * w;
            const o = (row + x) * 2;
            const sum = data[o] + v;
            data[o] = sum > 255 ? 255 : sum;
            if (v > best[row + x]) {
              best[row + x] = v;
              data[o + 1] = depth;
            }
          }
        }
      }
    }
  }

  /**
   * Install the finished light volume: `LPV_VOX³` RGBA half-floats laid out
   * x-fastest, exactly as smokeLpv.js writes them. Copied in, because the
   * material samples this texture and not a replacement for it.
   */
  setLpv(data) {
    if (!data || data.length !== this.lpvData.length) return;
    this.lpvData.set(data);
    this.useLpv = 1;
  }

  /** The sun and the map's bounce, as the march wants them. */
  setLight(light, ambient) {
    if (light?.toSun) this.lightDir.copy(light.toSun).normalize();
    // Colour only. `MapLighting.worldSun().intensity` is an analytic scale for
    // lightmapped PBR — 60 on Nuke — and feeding it to a term that is already
    // clamped to 1 does nothing but blow the cloud out.
    if (light?.color) this.sunColor.copy(light.color);
    if (ambient) this.ambientColor.copy(ambient);
  }

  /** Up to five live blasts, scene-space, with their ages. */
  setHE(list) {
    const n = Math.min(HE_SLOTS, list.length);
    for (let i = 0; i < n; i++) {
      const h = list[i];
      this.he[i].set(h.x, h.y, h.z, h.age);
    }
    this.heCount = n;
  }

  /**
   * Per frame. Everything here is one of the game's own curves over the age —
   * see SMOKE_CURVES in nadeEffects.js, which is where they are computed.
   */
  setFrame({ age, time, grow, fade, alphaFade, alphaBirthDeath, tintMix, tint }) {
    this.smokeAge = age;
    this.time = time;
    this.grow = grow;
    this.fade = fade;
    this.alphaFade = alphaFade;
    this.alphaBirthDeath = alphaBirthDeath;
    this.tintMix = tintMix;
    if (tint) this.color.copy(tint);
  }

  dispose() {
    this.mesh?.removeFromParent();
    this.mesh = null;
  }
}
