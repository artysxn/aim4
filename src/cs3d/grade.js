// ---------------------------------------------------------------------------
// src/cs3d/grade.js
// The colour grade on the way to the screen.
//
// CS2 does not put linear light on your monitor: a post-processing volume
// auto-exposes the scene, runs it through a filmic curve with real contrast in
// it, and applies the map's colour LUT. Khronos PBR Neutral on its own — which
// is what this renderer had — is the opposite of that. It is designed to leave
// colours alone, so it is almost linear up to 0.8 and then desaturates as it
// rolls off. The result is a picture that is flat in the midtones and washed
// in the highlights at the same time: shadows without weight, skies without
// colour.
//
// So: an S-curve about middle grey and a small saturation lift, then Neutral's
// highlight compression on top of that. It is applied inside the tone mapping
// function three already calls per pixel, so it costs no extra pass and no
// extra render target.
//
// `?contrast=`, `?saturation=` and `?lift=` override the constants, so the
// grade can be dialled in against the game without an edit-rebuild cycle.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { Fn, clamp, float, luminance, max, min, mix, pow, texture3D, uniform, vec3 } from 'three/webgpu';

/**
 * The map's colour-correction volume as a 3D texture.
 *
 * The pack ships it as raw RGBA bytes rather than an image precisely so it can
 * go straight to the GPU: it is a lookup table, and any image codec between
 * here and there is a chance to reinterpret values that must survive exactly.
 * @param {ArrayBuffer} bytes
 * @param {number} dim
 */
export function makeLut(bytes, dim) {
  const tex = new THREE.Data3DTexture(new Uint8Array(bytes), dim, dim, dim);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Scene-linear value that stays put under the curve (18% grey, scene-referred). */
const PIVOT = 0.18;
/** >1 steepens the S. CS2's curve is around here; past ~1.2 shadows block up. */
const CONTRAST = 1.12;
/** Neutral desaturates as it compresses; this puts most of that back. */
const SATURATION = 1.14;
/** Black lift, in scene-linear units. Small: CS2's shadows are not milky. */
const LIFT = 0.004;
/** Linear gain before the curve. 1 = the renderer's own exposure, untouched. */
const BRIGHTNESS = 1;
/** Extra saturation, weighted toward pixels that are already close to grey. */
const VIBRANCE = 0;

const num = (v, d) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Register the graded tone mapping on a renderer and select it.
 *
 * Wraps three's own Neutral curve rather than reimplementing it: the library
 * hands back the registered TSL function, so the highlight rolloff stays
 * exactly the one three ships and only the grade in front of it is ours.
 *
 * When the map ships its own colour-correction LUT (`post_processing_volume` →
 * a .vpost in pak01, 32³ RGBA), that LUT *is* the map's look and the S-curve
 * below stops being a stand-in for it and starts double-grading. So with a LUT
 * present the contrast/saturation/lift default to neutral and the curve becomes
 * plain Neutral → LUT, which is the order Source 2 applies them in.
 *
 * The maps' own filmic parameters are read but not used as a curve: every one
 * measured so far sets `m_flShoulderStrength = 0`, which makes Hable's
 * expression evaluate negative across the whole range (Dust 2 and Nuke both).
 * They disable the filmic curve and let the LUT carry it.
 *
 * Every knob is a uniform, not a constant, so the grade panel can move them
 * while the map is running: baking them in would recompile every material in
 * the world on each drag.
 *
 * @param {THREE.WebGPURenderer} renderer  already `init()`ed
 * @param {URLSearchParams} [params]
 * @param {{lut: THREE.Data3DTexture, dim: number}} [post]  the map's grade
 * @returns {object|null} the live knobs, or null when the curve is not in use
 */
export function installGrade(renderer, params, post) {
  const library = renderer?.nodes?.library;
  const neutral = library?.getToneMappingFunction?.(THREE.NeutralToneMapping);
  if (!neutral || library.toneMappingNodes?.has(THREE.CustomToneMapping)) return null;
  const lut = post?.lut || null;
  const dim = post?.dim || 0;

  // The S-curve stays even when the map ships a LUT. That looked like
  // double-grading until the LUTs were measured against an identity volume:
  // Nuke's deviates by 12.4/255 on average and Dust 2's by 6.3, neither shifts
  // a hue, and pure red and pure blue come back unchanged. They are near
  // neutral, so they are not the map's look — the contrast and saturation are
  // still ours to supply, and dropping them only made the picture flatter.
  const knobs = {
    brightness: uniform(Math.max(0, num(params?.get('brightness'), BRIGHTNESS))),
    contrast: uniform(Math.max(0.1, num(params?.get('contrast'), CONTRAST))),
    saturation: uniform(Math.max(0, num(params?.get('saturation'), SATURATION))),
    vibrance: uniform(num(params?.get('vibrance'), VIBRANCE)),
    lift: uniform(Math.max(0, num(params?.get('lift'), LIFT)))
  };
  const { brightness, contrast, saturation, vibrance, lift } = knobs;
  const pivot = float(PIVOT);

  const graded = Fn(([color, exposure]) => {
    const c = color.mul(exposure).mul(brightness).add(lift);
    // Contrast as a power about the pivot, driven by luminance and applied as
    // a ratio, so it steepens the tone curve without dragging hues around the
    // way a per-channel power does.
    const l = max(luminance(c), float(1e-5));
    const shaped = pow(l.div(pivot), contrast).mul(pivot);
    const contrasted = c.mul(shaped.div(l));
    // Saturation about the *new* luminance, so the lift does not grey it out.
    // Vibrance rides on top of it but weighted by how grey the pixel already
    // is, so it lifts dull concrete and haze without pushing the reds and the
    // hazard stripes — which are already saturated — into clipping.
    const l2 = luminance(contrasted);
    const chroma = clamp(max(max(contrasted.r, contrasted.g), contrasted.b).sub(min(min(contrasted.r, contrasted.g), contrasted.b)), 0, 1);
    const saturated = mix(vec3(l2), contrasted, saturation.add(vibrance.mul(chroma.oneMinus())));
    // Exposure is already applied; hand Neutral a factor of 1.
    const mapped = neutral(max(saturated, vec3(0)), float(1));
    if (!lut) return mapped;
    // The LUT is a lookup, so it has to be sampled at texel centres: a 32³
    // volume addressed 0..1 would read half a texel off at both ends and skew
    // every colour slightly toward the edge entries.
    const s = float((dim - 1) / dim);
    const o = float(1 / (2 * dim));
    return texture3D(lut, clamp(mapped, 0, 1).mul(s).add(o)).rgb;
  }).setLayout({
    name: 'cs3dGrade',
    type: 'vec3',
    inputs: [
      { name: 'color', type: 'vec3' },
      { name: 'exposure', type: 'float' }
    ]
  });

  library.addToneMapping(graded, THREE.CustomToneMapping);
  renderer.toneMapping = THREE.CustomToneMapping;
  return knobs;
}
