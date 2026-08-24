// ---------------------------------------------------------------------------
// spriteCardGL.js
// CS2's sprite card on the trainer's WebGL renderer — the WebGL twin of
// src/cs3d/spriteCard.js, which is the same operator written in TSL for the map
// practice mode's WebGPU renderer.
//
// This exists because the effects are not something to approximate. A molotov
// drawn as procedural orange blobs is a different object from the one the game
// draws; what makes CS2's fire read as fire is not a shape anybody can guess,
// it is a fluid sim baked into a flipbook, warped between frames by a motion
// vector field and coloured through a ramp. All three are in the fx pack
// (server/data/cs3d/pack/fx, scripts/cs3d-fx.mjs) and all three work perfectly
// well in WebGL. Only the shading LANGUAGE was ever the obstacle, so only the
// shading language is rewritten here.
//
// Kept deliberately line-for-line with the TSL version: same uniform names,
// same `set / hide / sort / prepare / flush / setEnv` surface, same defaults,
// so the two can be diffed when either changes. What the fragment stage does,
// in the order it does it:
//
//   FLIPBOOK          a frame out of a packed atlas, addressed by cell and
//                     clamped MARGIN texels inside it so filtering and mips
//                     cannot drag the neighbouring frame in as a hard rim.
//   MOTION VECTORS    frame N warped forward and N+1 warped back before they
//                     are mixed, so the sheet flows instead of cross-fading.
//                     The single biggest difference between video and a
//                     slideshow.
//   1D COLOUR LOOKUP  fire's luminance indexes a ramp, mixed half and half with
//                     the sheet's own colour. `body` for the flame, `edge` for
//                     the coloured fringe — they are not interchangeable.
//   SPHERICAL NORMAL  the flat quad shades as if it were a ball of vapour,
//                     which is what stops a cloud reading as a stack of decals.
//
// The one thing not carried over is depth feathering. The TSL version compiles
// it out too (its `viewportLinearDepth` cannot bind under that renderer), and
// the trainer's forward path has no depth texture to read, so a sprite meets
// the floor on a hard line here exactly as it does there.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { packFetch, loadWithRetry } from '../cs3d/packFetch.js';

/** src/cs3d/spriteCard.js MV_SCALE — how far a motion vector may push a texel. */
export const MV_SCALE = 0.06;

/** Texels of a cell kept clear of its own border when sampling. */
const MARGIN = 2.5;

const SHEET_KEYS = ['smoke', 'smoke_mv', 'fire', 'fire_mv'];

// ---- loading ---------------------------------------------------------------

/**
 * Fetch the fx pack for the WebGL renderer: the sheets, their geometry and the
 * flame colour ramps. One call for the whole page.
 */
export async function loadFxPackGL(base, { version = '' } = {}) {
  const res = await packFetch(`${base}/fx.json${version}`, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`fx pack: fx.json ${res.status}`);
  const manifest = await res.json();

  const loader = new THREE.TextureLoader();
  const load = (file) =>
    loadWithRetry(loader, `${base}/${file}${version}`).catch(() => {
      throw new Error(`fx pack: ${file}`);
    });

  const sheets = {};
  await Promise.all(
    SHEET_KEYS.filter((k) => manifest.sheets?.[k]).map(async (key) => {
      const meta = manifest.sheets[key];
      const map = await load(meta.file);
      // Addressed by cell: it must not wrap, and row 0 must stay the first row
      // of the image the packer wrote.
      map.flipY = false;
      map.wrapS = THREE.ClampToEdgeWrapping;
      map.wrapT = THREE.ClampToEdgeWrapping;
      // A motion sheet is directions, not colour, and must not be decoded.
      map.colorSpace = key.endsWith('_mv') ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      map.generateMipmaps = true;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.magFilter = THREE.LinearFilter;
      map.anisotropy = 4;
      map.needsUpdate = true;
      sheets[key] = { ...meta, map };
    })
  );

  const ramps = {};
  for (const [kind, set] of Object.entries(manifest.ramps || {})) {
    ramps[kind] = {};
    for (const [which, stops] of Object.entries(set)) ramps[kind][which] = rampTexture(stops);
  }

  return { manifest, sheets, ramps };
}

/** A gradient's stops baked into a 256x1 lookup (spriteCard.js's own). */
export function rampTexture(stops, width = 256) {
  const data = new Uint8Array(width * 4);
  const list = [...stops].sort((a, b) => a.at - b.at);
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    let a = list[0];
    let b = list[list.length - 1];
    for (let k = 0; k < list.length - 1; k++) {
      if (t >= list[k].at && t <= list[k + 1].at) { a = list[k]; b = list[k + 1]; break; }
      if (t < list[0].at) { a = b = list[0]; break; }
      if (t > list[list.length - 1].at) { a = b = list[list.length - 1]; break; }
    }
    const span = b.at - a.at;
    const f = span > 1e-6 ? (t - a.at) / span : 0;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(a.rgb[c] + (b.rgb[c] - a.rgb[c]) * f);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---- the shader ------------------------------------------------------------

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iCard;
attribute vec4 iTint;
attribute vec3 iLitTop;
attribute vec3 iLitBot;

varying vec2 vQuad;
varying float vFrame;
varying float vAlpha;
varying vec3 vTint;
varying vec3 vLitTop;
varying vec3 vLitBot;

void main() {
  // A camera-facing quad, rolled about the view axis. Built in VIEW space
  // rather than by rotating a per-instance matrix: the whole point of a sprite
  // card is that it never turns away from the camera.
  vec4 centre = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iCard.z);
  float s = sin(iCard.z);
  vec2 q = position.xy * iCard.xy;
  vec2 rolled = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  vQuad = position.xy + 0.5;
  vFrame = iCard.w;
  vAlpha = iTint.w;
  vTint = iTint.xyz;
  vLitTop = iLitTop;
  vLitBot = iLitBot;
  gl_Position = projectionMatrix * vec4(centre.xy + rolled, centre.z, centre.w);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uSheet;
uniform vec2 uSheetGrid;
uniform vec2 uSeq;
uniform vec2 uMargin;
uniform vec3 uColor;
uniform float uAlphaScale;
uniform float uOverbright;
uniform float uSelfIllum;
uniform float uDiffuse;
uniform float uDesaturate;
uniform float uRampMix;
uniform float uSun;
uniform vec3 uLightDir;
uniform vec3 uViewUp;
uniform vec3 uLightColor;
#ifdef USE_MV
uniform sampler2D uMv;
uniform vec2 uMvGrid;
uniform float uMvFrames;
uniform float uMvScale;
#endif
#ifdef USE_RAMP
uniform sampler2D uRamp;
#endif

varying vec2 vQuad;
varying float vFrame;
varying float vAlpha;
varying vec3 vTint;
varying vec3 vLitTop;
varying vec3 vLitBot;

// Atlas UV for a flipbook index, clamped to its own cell. The clamp is the
// whole reason this is not two lines: bilinear filtering, the motion-vector
// warp and mip selection all push a sample over the border, and because every
// card leaks the same sliver in the same place it reads as a hard rectangle
// around every puff rather than as noise.
vec2 cellUv(float index, vec2 quadUv, vec2 grid, float start) {
  float cell = start + index;
  float col = mod(cell, grid.x);
  float row = floor(cell / grid.x);
  // Row 0 is the top of the atlas (flipY = false), so v runs down the cell.
  float u0 = clamp(quadUv.x, uMargin.x, 1.0 - uMargin.x);
  float v0 = clamp(1.0 - quadUv.y, uMargin.y, 1.0 - uMargin.y);
  return vec2((col + u0) / grid.x, (row + v0) / grid.y);
}

void main() {
  float t = mod(vFrame, uSeq.y);
  float i0 = floor(t);
  float i1 = mod(i0 + 1.0, uSeq.y);
  float blend = fract(t);

  vec4 s0;
  vec4 s1;
#ifdef USE_MV
  // The field is packed x in R, y in G around a neutral 0.5. Warp the earlier
  // frame forward by how far through the blend we are and the later frame back
  // by the remainder: every texel meets its own future instead of a stranger's.
  // Warped in QUAD space, before the cell mapping, so cellUv.s clamp covers
  // the warp too — warping the atlas UV afterwards steps straight over the
  // border the clamp just guarded.
  vec2 mvUv = cellUv(mod(i0, uMvFrames), vQuad, uMvGrid, 0.0);
  vec2 flow = (texture2D(uMv, mvUv).rg - 0.5) * uMvScale;
  s0 = texture2D(uSheet, cellUv(i0, vQuad - flow * blend, uSheetGrid, uSeq.x));
  s1 = texture2D(uSheet, cellUv(i1, vQuad + flow * (1.0 - blend), uSheetGrid, uSeq.x));
#else
  s0 = texture2D(uSheet, cellUv(i0, vQuad, uSheetGrid, uSeq.x));
  s1 = texture2D(uSheet, cellUv(i1, vQuad, uSheetGrid, uSeq.x));
#endif
  vec4 tex = mix(s0, s1, blend);

  // What the sheet contributes (m_nTextureChannels): a ramp lookup for fire,
  // a coverage mask for smoke, or straight colour.
#ifdef USE_RAMP
  vec3 base = mix(tex.rgb, texture2D(uRamp, vec2(tex.r, 0.5)).rgb, uRampMix);
#elif defined(ALPHA_ONLY)
  vec3 base = vec3(1.0);
#else
  vec3 base = tex.rgb;
#endif

  // A flat quad given a normal as if it were a sphere, then half-lambert:
  // vapour is not opaque and a hard terminator on a puff looks like a beach
  // ball.
  vec2 d = vQuad * 2.0 - 1.0;
  float r2 = min(dot(d, d), 1.0);
  vec3 nView = normalize(vec3(d, sqrt(max(0.0, 1.0 - r2))));
  float lambert = dot(nView, uLightDir) * 0.5 + 0.5;
  float up = dot(nView, uViewUp) * 0.5 + 0.5;
  vec3 env = mix(vLitBot, vLitTop, up);
  vec3 lit = env + uLightColor * lambert * uSun;
  // m_flSelfIllumAmount against m_flDiffuseAmount: smoke is half lit and
  // half emissive, fire is entirely emissive.
  vec3 shading = vec3(uSelfIllum) + lit * uDiffuse;

  vec3 rgb = base * vTint * uColor * shading * uOverbright;
  float grey = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(rgb, vec3(grey), uDesaturate);

  float a = clamp(tex.a * vAlpha * uAlphaScale, 0.0, 1.0);

  // Kill the card's own rim.
  //
  // cellUv keeps a sample inside its cell by clamping, which is right — it is
  // what stops the neighbouring frame leaking in. But a frame whose content
  // runs close to the cell border then has that border texel REPEATED across
  // the outer band of the quad, and because every card repeats the same texel
  // in the same place it reads as a hard rectangle around the sprite rather
  // than as noise. Fading coverage to nothing over the outermost few percent
  // of the quad removes it and costs nothing: a sprite's content is inside its
  // card, so there is nothing out there to lose.
  vec2 e = abs(vQuad * 2.0 - 1.0);
  a *= smoothstep(0.0, 0.06, 1.0 - max(e.x, e.y));

  if (a <= 0.002) discard;
  gl_FragColor = vec4(rgb, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---- the batch -------------------------------------------------------------

/**
 * One instanced draw of sprite cards.
 *
 * The caller owns the particles: it writes position, size, roll, flipbook
 * position, opacity and tint per instance and calls `flush()`. Nothing here
 * simulates anything — that stays in shared/sim3d, headless and testable.
 */
export class SpriteCardBatchGL {
  constructor({
    sheet,
    mv = null,
    ramp = null,
    count,
    color = [255, 255, 255],
    alphaScale = 1,
    overbright = 1,
    selfIllum = 1,
    diffuse = 0,
    sequence = 0,
    additive = false,
    bloomOnly = false,
    alphaOnly = false,
    rampMix = 0.5
  }) {
    this.count = count;
    this.sheet = sheet;

    this.pos = new Float32Array(count * 3);
    this.card = new Float32Array(count * 4);
    this.tint = new Float32Array(count * 4).fill(1);
    this.litTop = new Float32Array(count * 3).fill(1);
    this.litBot = new Float32Array(count * 3).fill(1);

    const plane = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.attributes.position = plane.attributes.position;
    geo.attributes.uv = plane.attributes.uv;
    geo.instanceCount = count;
    this._attr = {
      iPos: new THREE.InstancedBufferAttribute(this.pos, 3),
      iCard: new THREE.InstancedBufferAttribute(this.card, 4),
      iTint: new THREE.InstancedBufferAttribute(this.tint, 4),
      iLitTop: new THREE.InstancedBufferAttribute(this.litTop, 3),
      iLitBot: new THREE.InstancedBufferAttribute(this.litBot, 3)
    };
    for (const [name, a] of Object.entries(this._attr)) {
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
    }
    this.geometry = geo;

    const seq = sheet.sequences?.[sequence] ?? { start: 0, count: sheet.frames };
    const cellPx = sheet.cell || 128;
    this.uniforms = {
      uSheet: { value: sheet.map },
      uSheetGrid: { value: new THREE.Vector2(sheet.cols, sheet.rows) },
      uSeq: { value: new THREE.Vector2(seq.start, Math.max(1, seq.count)) },
      uMargin: { value: new THREE.Vector2(MARGIN / cellPx, MARGIN / cellPx) },
      uColor: {
        value: new THREE.Color().setRGB(
          color[0] / 255,
          color[1] / 255,
          color[2] / 255,
          THREE.SRGBColorSpace
        )
      },
      uAlphaScale: { value: alphaScale },
      uOverbright: { value: overbright },
      uSelfIllum: { value: selfIllum },
      uDiffuse: { value: diffuse },
      uDesaturate: { value: 0 },
      uRampMix: { value: rampMix },
      uSun: { value: 0.35 },
      uLightDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uViewUp: { value: new THREE.Vector3(0, 1, 0) },
      uLightColor: { value: new THREE.Color(1, 0.97, 0.92) }
    };
    if (mv) {
      this.uniforms.uMv = { value: mv.map };
      this.uniforms.uMvGrid = { value: new THREE.Vector2(mv.cols, mv.rows) };
      this.uniforms.uMvFrames = { value: mv.frames };
      this.uniforms.uMvScale = { value: MV_SCALE };
    }
    if (ramp) this.uniforms.uRamp = { value: ramp };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: {
        ...(mv ? { USE_MV: '' } : {}),
        ...(ramp ? { USE_RAMP: '' } : {}),
        ...(alphaOnly ? { ALPHA_ONLY: '' } : {})
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: true,
      fog: false
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // CS2 draws every one of these twice: the sprite, then the same sprite
    // overbright so the bloom pass has something to bleed. The glow goes last.
    this.mesh.renderOrder = bloomOnly ? 12 : 10;
    this.bloomOnly = bloomOnly;

    this._sortKey = new Float32Array(count);
    this._sortIdx = new Int32Array(count);
    this._sortTmp = new Float32Array(count * 4);
    this._lightWorld = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  }

  /** Write one instance. `w`/`h` are the sprite's FULL size in scene units. */
  set(i, x, y, z, w, h, rot, frame, alpha, tint) {
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.card[i * 4] = w;
    this.card[i * 4 + 1] = h;
    this.card[i * 4 + 2] = rot;
    this.card[i * 4 + 3] = frame;
    this.tint[i * 4 + 3] = alpha;
    if (tint) {
      this.tint[i * 4] = tint.r;
      this.tint[i * 4 + 1] = tint.g;
      this.tint[i * 4 + 2] = tint.b;
    }
  }

  /** Collapse an instance to nothing without disturbing the order. */
  hide(i) {
    this.card[i * 4] = 0;
    this.card[i * 4 + 1] = 0;
    this.tint[i * 4 + 3] = 0;
  }

  /** The environment irradiance reaching one particle from above and below. */
  setEnv(i, top, bot) {
    this.litTop[i * 3] = top.r;
    this.litTop[i * 3 + 1] = top.g;
    this.litTop[i * 3 + 2] = top.b;
    this.litBot[i * 3] = bot.r;
    this.litBot[i * 3 + 1] = bot.g;
    this.litBot[i * 3 + 2] = bot.b;
  }

  /**
   * Back to front from `eye`. Alpha blending is order-dependent: skip this and
   * a cloud shows seams wherever two sprites cross.
   */
  sort(eye) {
    const n = this.count;
    const key = this._sortKey;
    const idx = this._sortIdx;
    for (let i = 0; i < n; i++) {
      const dx = this.pos[i * 3] - eye.x;
      const dy = this.pos[i * 3 + 1] - eye.y;
      const dz = this.pos[i * 3 + 2] - eye.z;
      key[i] = dx * dx + dy * dy + dz * dz;
      idx[i] = i;
    }
    const order = Array.prototype.slice.call(idx, 0, n).sort((a, b) => key[b] - key[a]);
    const tmp = this._sortTmp;
    const permute = (src, stride) => {
      for (let i = 0; i < n; i++) {
        const from = order[i] * stride;
        for (let k = 0; k < stride; k++) tmp[i * stride + k] = src[from + k];
      }
      src.set(tmp.subarray(0, n * stride));
    };
    permute(this.pos, 3);
    permute(this.card, 4);
    permute(this.tint, 4);
    permute(this.litTop, 3);
    permute(this.litBot, 3);
  }

  /** Re-aim the light into view space and sort. Call once per frame. */
  prepare(camera) {
    if (!camera) return;
    this.sort(camera.position);
    this.uniforms.uLightDir.value
      .copy(this._lightWorld)
      .transformDirection(camera.matrixWorldInverse)
      .normalize();
    this.uniforms.uViewUp.value
      .set(0, 1, 0)
      .transformDirection(camera.matrixWorldInverse)
      .normalize();
  }

  /** Push the instance buffers to the GPU. */
  flush() {
    for (const a of Object.values(this._attr)) a.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
