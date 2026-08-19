// ---------------------------------------------------------------------------
// src/cs3d/spriteCard.js
// CS2's sprite card, in TSL: the renderer behind every grenade effect the game
// draws. `C_OP_RenderSprites` is one operator with a lot of knobs, and the
// reason a CS2 smoke reads as a cloud while a pile of tinted spheres reads as
// a pile of tinted spheres is four of them working together.
//
//   FLIPBOOK          The sprite is a frame out of a sheet that is a fluid sim,
//                     not a shape. server/data/cs3d/pack/fx (scripts/cs3d-fx.mjs)
//                     carries the game's own: 128 smoke frames, 131 fire.
//
//   MOTION VECTORS    `SPRITECARD_TEXTURE_ANIMMOTIONVEC`. Cross-fading frame N
//                     into N+1 double-exposes — you see both frames at once and
//                     the smoke shimmers. Instead a second sheet stores, per
//                     texel, where that texel MOVED between the two frames, so
//                     frame N is warped forward and N+1 warped back before they
//                     are mixed. The result flows. This is the single biggest
//                     difference between a sheet that looks like video and one
//                     that looks like a slideshow.
//
//   DEPTH FEATHERING  `PARTICLE_DEPTH_FEATHERING_ON`. A camera-facing quad cuts
//                     the floor along a hard straight line, and nothing says
//                     "billboard" louder. Fading the sprite out as it nears the
//                     geometry behind it (30 units for smoke, 20 for an HE)
//                     hides the intersection completely.
//
//   1D COLOUR LOOKUP  `SPRITECARD_TEXTURE_1D_COLOR_LOOKUP`. Fire is not painted:
//                     the sim's luminance is mapped through a ramp, mixed half
//                     and half with the sheet's own colour. There are TWO ramps
//                     per grenade and they are not interchangeable: the body's
//                     runs black → dark red → orange → cream → white, and the
//                     edge's runs through violet for a molotov and cyan for an
//                     incendiary. The edge ramp is the fringe, and reaching for
//                     it as the body paints the whole flame magenta. Both come
//                     out of the particle systems via scripts/cs3d-fx.mjs.
//
// On top of those: `m_flOverbrightFactor` with a bloom-only second pass (how
// fire glows), `m_flSelfIllumAmount` against `m_flDiffuseAmount` (smoke is half
// lit and half emissive, fire is all emissive), and a spherical impostor normal
// so a smoke sprite shades like a ball of vapour instead of a flat decal.
//
// Everything is one instanced draw per layer. Particles are sorted back to
// front on the CPU because alpha blending is not commutative and a smoke made
// of unsorted quads has visible seams where they cross.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { packFetch, loadWithRetry } from './packFetch.js';
import {
  Fn,
  attribute,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  float,
  mix,
  modelWorldMatrix,
  positionGeometry,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
  viewportLinearDepth
} from 'three/webgpu';

/**
 * How far a motion vector can push a texel, in frame-UV. The sheets store a
 * direction in two channels around a neutral 0.5 and the shader scales it; the
 * scale itself is a shader constant on the game's side and is not in any file
 * we can read, so this is `[guessed]` — fitted by eye against the game until
 * the blend stopped sliding. It is small on purpose: too much and the frames
 * smear past each other, too little and the cross-fade shows through.
 */
export const MV_SCALE = 0.06;

/**
 * Texels of a cell kept clear of its own border when sampling. Wide enough to
 * cover bilinear filtering, the motion-vector warp and a few mip levels of
 * averaging, all of which otherwise pull in the neighbouring frame and draw a
 * one-pixel outline around every sprite.
 */
const MARGIN = 2.5;

/** Layout of a sheet as scripts/cs3d-fx.mjs writes it. */
const SHEET_KEYS = ['smoke', 'smoke_mv', 'fire', 'fire_mv'];

// ---- loading ---------------------------------------------------------------

/**
 * Fetch the fx pack: the sheets, their geometry, and the flame colour ramps.
 * One call for the whole page; every effect shares these textures.
 *
 * @param {string} base  pack URL prefix, e.g. `${assetBase()}/fx`
 */
export async function loadFxPack(base, { version = '' } = {}) {
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
      // The atlas is addressed by cell, so it must not wrap and must not be
      // flipped: row 0 is the first row of the image, the way it was packed.
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

  // Two ramps per grenade type: `body` for the flame, `edge` for the coloured
  // fringe around it. See scripts/cs3d-fx.mjs for why mixing them up matters.
  const ramps = {};
  for (const [kind, set] of Object.entries(manifest.ramps || {})) {
    ramps[kind] = {};
    for (const [which, stops] of Object.entries(set)) ramps[kind][which] = rampTexture(stops);
  }

  return { manifest, sheets, ramps };
}

/**
 * A gradient's stops baked into a 256x1 lookup. The stops are sparse and
 * unevenly spaced (CS2's molotov ramp puts five of its nine in the top third),
 * so this interpolates rather than sampling them directly.
 */
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

// ---- the batch -------------------------------------------------------------

/**
 * One instanced draw of sprite cards.
 *
 * The caller owns the particles: it writes position, size, roll, flipbook
 * position, opacity and tint per instance and calls `flush()`. Nothing here
 * simulates anything — that stays in shared/sim3d, headless and testable.
 */
export class SpriteCardBatch {
  /**
   * @param {object} o
   * @param {object} o.sheet     colour sheet from `loadFxPack`
   * @param {object} [o.mv]      motion-vector sheet; without one the flipbook
   *                             cross-fades, which is visibly worse
   * @param {THREE.Texture} [o.ramp]  1D colour lookup; without one the sheet's
   *                             own colour is used
   * @param {number} o.count     how many instances to make room for
   * @param {number[]} [o.color]  `m_vecColorScale`, 0..255
   * @param {number} [o.alphaScale]   `m_flAlphaScale`
   * @param {number} [o.overbright]   `m_flOverbrightFactor`
   * @param {number} [o.selfIllum]    `m_flSelfIllumAmount`
   * @param {number} [o.diffuse]      `m_flDiffuseAmount`
   * @param {number} [o.feather]      `m_flFeatheringMaxDist`, source units
   * @param {number} [o.sequence]     which sequence of the sheet to play
   * @param {boolean} [o.additive]    `PARTICLE_OUTPUT_BLEND_MODE_ADD`
   * @param {boolean} [o.alphaOnly]   `SPRITECARD_TEXTURE_CHANNEL_MIX_A`: take
   *                             coverage from the sheet and colour from `color`
   * @param {boolean} [o.bloomOnly]   `m_bOnlyRenderInEffectsBloomPass`
   */
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
    feather = 20,
    sequence = 0,
    additive = false,
    bloomOnly = false,
    alphaOnly = false,
    rampMix = 0.5
  }) {
    this.count = count;
    this.sheet = sheet;

    // Per-instance state, written by the caller and uploaded on flush().
    //
    // Packed, and not for tidiness: WebGPU guarantees only `maxVertexBuffers`
    // = 8, three binds one buffer per geometry attribute, and `position` and
    // `uv` already take two. One field per attribute came to ten and the
    // pipeline silently failed to build — no exception, no console error, the
    // effect simply never drew. Five instanced buffers leaves a spare.
    //
    //   iPos     x, y, z
    //   iCard    half-width, half-height, roll, flipbook position
    //   iTint    tint r, g, b, opacity
    //   iLitTop  environment irradiance reaching the top of this puff
    //   iLitBot  ...and its underside. Sampled from the map's probe grid when
    //            the effect spawns: a cloud shaded by one scene-wide ambient is
    //            the flat grey blob, and this is what gives each ball its own
    //            form and puts a smoke in shadow into shadow.
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
    this.uniforms = {
      color: uniform(new THREE.Color().setRGB(color[0] / 255, color[1] / 255, color[2] / 255, THREE.SRGBColorSpace)),
      alphaScale: uniform(alphaScale),
      overbright: uniform(overbright),
      selfIllum: uniform(selfIllum),
      diffuse: uniform(diffuse),
      feather: uniform(feather),
      desaturate: uniform(0),
      mvScale: uniform(MV_SCALE),
      rampMix: uniform(rampMix),
      lightDir: uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize()),
      viewUp: uniform(new THREE.Vector3(0, 1, 0)),
      sun: uniform(0.35),
      lightColor: uniform(new THREE.Color(1, 0.97, 0.92)),
      ambient: uniform(new THREE.Color(0.42, 0.47, 0.55))
    };

    this.material = this._material({ sheet, mv, ramp, seq, additive, feather, alphaOnly });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // CS2 draws every one of these twice: the sprite, then the same sprite
    // again overbright with `m_bOnlyRenderInEffectsBloomPass` so the bloom pass
    // has something to bleed. The glow layer goes last and adds.
    this.mesh.renderOrder = bloomOnly ? 12 : 10;
    this.bloomOnly = bloomOnly;

    /** Scratch for `sort`, allocated once. */
    this._sortKey = new Float32Array(count);
    this._sortIdx = new Int32Array(count);
    this._sortTmp = new Float32Array(count * 4);
    this._lightWorld = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  }

  _material({ sheet, mv, ramp, seq, additive, feather, alphaOnly }) {
    const u = this.uniforms;
    const cols = float(sheet.cols);
    const rows = float(sheet.rows);
    const seqStart = float(seq.start);
    const seqCount = float(Math.max(1, seq.count));

    const iPos = attribute('iPos', 'vec3');
    const iCard = attribute('iCard', 'vec4');
    const iSize = iCard.xy;
    const iRot = iCard.z;
    const iFrame = iCard.w;
    const iTint = attribute('iTint', 'vec3');
    const iLitTop = attribute('iLitTop', 'vec3');
    const iLitBot = attribute('iLitBot', 'vec3');

    // -- vertex: a camera-facing quad, rolled about the view axis ------------
    // Built in view space rather than by rotating the instance matrix, because
    // the whole point of a sprite card is that it never turns away from the
    // camera and a per-instance matrix would have to be rebuilt every frame.
    const centre = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(iPos, 1)));
    const c = iRot.cos();
    const s = iRot.sin();
    const q = positionGeometry.xy.mul(iSize);
    const rolled = vec2(q.x.mul(c).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(c)));
    const viewNode = vec3(centre.xy.add(rolled), centre.z);

    const material = new THREE.NodeMaterial();
    material.vertexNode = cameraProjectionMatrix.mul(vec4(viewNode, 1));

    // How far inside its cell a sample has to stay, as a fraction of the cell.
    // MARGIN texels at the sheet's own resolution; the frames are already
    // inset by more than this (a 128px smoke cell holds a 112px frame), so
    // nothing that is actually drawn gets clipped.
    const marginU = float(MARGIN / (sheet.cell || 128));
    const marginV = float(MARGIN / (sheet.cell || 128));

    // Everything the fragment stage needs, interpolated across the quad. These
    // have to be explicit varyings: with a custom `vertexNode` the built-in
    // `positionView` still tracks the untransformed plane, so the depth used
    // for feathering would be the geometry's, not the sprite's.
    const viewPos = viewNode.varying('vSpriteView');
    const quad = positionGeometry.xy.add(0.5).varying('vSpriteQuad');
    const frameOf = iFrame.varying('vSpriteFrame');
    const alphaOf = iTint.w.varying('vSpriteAlpha');
    const tintOf = iTint.xyz.varying('vSpriteTint');
    const litTopOf = iLitTop.varying('vSpriteLitTop');
    const litBotOf = iLitBot.varying('vSpriteLitBot');

    // -- fragment ------------------------------------------------------------
    /**
     * Atlas UV for a flipbook index within the sequence, clamped to its own
     * cell.
     *
     * The clamp is the whole reason this is not two lines. A cell is one frame
     * of a packed sheet with its neighbours pressed right up against it, and
     * three things push a sample over the border: bilinear filtering at the
     * edge texel, the motion-vector warp below (which moves the sample by
     * design), and mip selection, which at the mip levels a distant smoke uses
     * is averaging across several cells at once. Any of them leaks a sliver of
     * the next frame in, and because every card in a cloud leaks the same
     * sliver at the same place it reads as a hard one-pixel rectangle around
     * every puff rather than as noise. Staying `MARGIN` texels inside the cell
     * costs a hair of the frame and removes the outline.
     */
    const cellUv = Fn(([index, quadUv, nCols, nRows, start]) => {
      const cell = start.add(index);
      const col = cell.mod(nCols);
      const row = cell.div(nCols).floor();
      // Row 0 is the top of the atlas (the sheets are loaded flipY = false),
      // so the quad's v runs down the cell, not up it.
      // The quad's own coordinates already run 0..1, so they need no clamping;
      // what needs it is the result, and it is clamped per axis with floats
      // rather than by handing a vec2 a pair of scalars.
      const u0 = quadUv.x.clamp(marginU, marginU.oneMinus());
      const v0 = quadUv.y.oneMinus().clamp(marginV, marginV.oneMinus());
      return vec2(col.add(u0).div(nCols), row.add(v0).div(nRows));
    });

    const shade = Fn(() => {
      const uvQuad = quad;
      const t = frameOf.mod(seqCount);
      const i0 = t.floor();
      const i1 = i0.add(1).mod(seqCount);
      const blend = t.fract();

      let sample0;
      let sample1;
      if (mv) {
        // Motion-vector blending. The vector field is packed x in R, y in G
        // around a neutral 0.5 (scripts/cs3d-fx.mjs repacks it out of Valve's
        // G/A so nothing downstream mistakes y for transparency). Warp the
        // earlier frame forward by how far through the blend we are, and the
        // later frame back by the remainder, then mix: every texel meets its
        // own future instead of a stranger's.
        const mvCols = float(mv.cols);
        const mvRows = float(mv.rows);
        const mvCount = float(mv.frames);
        const mvUv = cellUv(i0.mod(mvCount), uvQuad, mvCols, mvRows, float(0));
        const flow = texture(mv.map, mvUv).rg.sub(0.5).mul(u.mvScale);
        // Warp in QUAD space, before the cell mapping, so the one clamp inside
        // `cellUv` covers the warp as well. Warping the atlas UV afterwards
        // would step straight over the cell border the clamp just guarded.
        sample0 = texture(sheet.map, cellUv(i0, uvQuad.sub(flow.mul(blend)), cols, rows, seqStart));
        sample1 = texture(sheet.map, cellUv(i1, uvQuad.add(flow.mul(blend.oneMinus())), cols, rows, seqStart));
      } else {
        sample0 = texture(sheet.map, cellUv(i0, uvQuad, cols, rows, seqStart));
        sample1 = texture(sheet.map, cellUv(i1, uvQuad, cols, rows, seqStart));
      }
      const tex = mix(sample0, sample1, blend);

      // What the sheet actually contributes, which is `m_nTextureChannels`.
      //
      //   ramp        the sheet is a desaturated sim and its luminance indexes
      //               a 1D colour lookup. This is fire.
      //   alphaOnly   `SPRITECARD_TEXTURE_CHANNEL_MIX_A`: the sheet is a
      //               COVERAGE MASK and nothing else — the colour is the flat
      //               `m_vecColorScale`, shaded per pixel. This is smoke, and
      //               reading its RGB as albedo as well (the obvious thing, and
      //               what this did first) double-darkens the cloud and bakes
      //               the sheet's own per-puff shading into it, which is what
      //               makes it read as a heap of cotton balls.
      //   otherwise   the sheet is straight colour.
      // `m_flTextureBlend` on the lookup is 0.5: the ramp does not replace the
      // sheet's colour, it is mixed half and half with it, which keeps the
      // sim's own variation instead of flattening every texel of a given
      // brightness to one colour.
      const base = ramp
        ? mix(tex.rgb, texture(ramp, vec2(tex.r, 0.5)).rgb, u.rampMix)
        : alphaOnly
          ? vec3(1)
          : tex.rgb;

      // A sprite card is flat, so give it a normal as if it were a sphere: the
      // quad's own coordinates are the x/y of a unit hemisphere facing the
      // camera. That is what stops a smoke cloud reading as a stack of decals.
      const d = uvQuad.mul(2).sub(1);
      const r2 = d.dot(d).min(1);
      const nView = vec3(d, r2.oneMinus().sqrt()).normalize();
      // The light arrives as a view-space direction (SpriteCardBatch.prepare
      // re-aims it every frame) so nothing here has to invert a camera matrix.
      // Half-lambert, not lambert: vapour is not opaque, and a hard terminator
      // on a smoke sprite looks like a beach ball.
      const lambert = nView.dot(u.lightDir).mul(0.5).add(0.5);
      // The environment, sampled per particle rather than per scene. `iLitTop`
      // and `iLitBot` are the map's probe irradiance above and below this puff
      // (NadeEffects fills them at spawn); blending them by how far the
      // impostor normal points up gives every ball its own top-lit, dark-
      // bellied shading, and a cloud in shadow comes out in shadow. They
      // default to 1, in which case this is just the scene ambient.
      const up = nView.dot(u.viewUp).mul(0.5).add(0.5);
      // Absolute, not a modulation of the scene ambient: NadeEffects writes the
      // scene ambient into both attributes when a map has no probe grid, so
      // this covers the no-probe case without a second code path.
      const env = mix(litBotOf, litTopOf, up);
      const lit = env.add(u.lightColor.mul(lambert).mul(u.sun));
      // `m_flSelfIllumAmount` against `m_flDiffuseAmount`: smoke is half lit
      // and half emissive (0.5/0.5), fire is entirely emissive (1/0).
      const shading = vec3(u.selfIllum).add(lit.mul(u.diffuse));

      let rgb = base.mul(tintOf).mul(u.color).mul(shading).mul(u.overbright);
      // Smoke greys out as it ages (`m_flDesaturation` runs 0.25 -> 0.75 over
      // sixteen seconds), which is most of why an old smoke looks flat and dead.
      const grey = rgb.r.mul(0.2126).add(rgb.g.mul(0.7152)).add(rgb.b.mul(0.0722));
      rgb = mix(rgb, vec3(grey), u.desaturate);

      // Depth feathering, when the renderer can give us the scene's depth.
      //
      // `viewportLinearDepth` cannot, under this renderer, and fails twice: it
      // binds the depth texture with a filtering sampler (WebGPU requires a
      // non-filtering or comparison sampler for `TextureSampleType::Depth`),
      // and it copies the depth buffer through `copyTextureToTexture`, which
      // rejects a 4x MSAA source against a 1x destination — and the scene is
      // MSAA because the renderer is built with `antialias: true`. The second
      // failure invalidates the whole command buffer, so the frame does not
      // just lose its feathering, it loses the map. Hence the build-time
      // branch: `feather: 0` compiles the depth read out entirely rather than
      // leaving a broken pipeline in the scene.
      const soft = feather > 0
        ? clamp(
            cameraNear
              .add(viewportLinearDepth.mul(cameraFar.sub(cameraNear)))
              .sub(viewPos.z.negate())
              .div(u.feather.max(0.001)),
            0,
            1
          )
        : float(1);

      const a = tex.a.mul(alphaOf).mul(u.alphaScale).mul(soft).clamp(0, 1);
      return vec4(rgb, a);
    });

    const out = shade();
    material.colorNode = out;
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    material.side = THREE.DoubleSide;
    material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.toneMapped = true;
    return material;
  }

  /** Write one instance. `size` is the sprite's full width/height in units. */
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

  /**
   * Back to front from `eye`. Alpha blending is order-dependent: skip this and
   * a cloud shows seams wherever two sprites cross. Sorts an index array and
   * permutes the instance buffers, which for a few hundred particles costs
   * less than the overdraw it fixes.
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
    // Typed arrays sort numerically only; this needs an index permutation, so
    // it goes through a plain array. Farthest first.
    const order = Array.prototype.slice.call(idx).sort((a, b) => key[b] - key[a]);
    let moved = false;
    for (let i = 0; i < n; i++) if (order[i] !== i) { moved = true; break; }
    if (!moved) return;
    const tmp = this._sortTmp;
    const permute = (src, stride) => {
      for (let i = 0; i < n; i++) for (let c = 0; c < stride; c++) tmp[i * stride + c] = src[order[i] * stride + c];
      src.set(tmp.subarray(0, n * stride));
    };
    permute(this.pos, 3);
    permute(this.card, 4);
    permute(this.tint, 4);
    // WRITE-ONCE PER-INSTANCE DATA DOES NOT SURVIVE THIS. `pos`, `card` and
    // `tint` are safe because every caller rewrites them by index every frame,
    // so a permutation is undone before it is ever drawn. `litTop`/`litBot` are
    // set by `setEnv` and typically set ONCE, and permuting those hands each
    // particle a neighbour's lighting — reshuffled every time the camera moves.
    // That is what made the old sprite smoke strobe (see smokeVolume3d.js).
    // Either give every instance the same env, or re-`setEnv` in the pose loop.
    permute(this.litTop, 3);
    permute(this.litBot, 3);
  }

  /**
   * Everything that depends on where the camera is: sort back to front, and
   * re-aim the light into view space (the shading normal is a view-space
   * hemisphere, so the light has to meet it there).
   */
  prepare(camera) {
    if (!camera) return;
    this.sort(camera.position);
    this.uniforms.lightDir.value
      .copy(this._lightWorld)
      .transformDirection(camera.matrixWorldInverse)
      .normalize();
    // World up, in view space: the impostor normal lives there, and it needs to
    // know which way is up to pick between the top and bottom irradiance.
    this.uniforms.viewUp.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse).normalize();
  }

  /**
   * The environment irradiance at one particle: what reaches it from above and
   * from below. Both default to white, which leaves the scene ambient alone.
   */
  setEnv(i, top, bot) {
    this.litTop[i * 3] = top.r;
    this.litTop[i * 3 + 1] = top.g;
    this.litTop[i * 3 + 2] = top.b;
    this.litBot[i * 3] = bot.r;
    this.litBot[i * 3 + 1] = bot.g;
    this.litBot[i * 3 + 2] = bot.b;
  }

  /** Push the instance buffers to the GPU. */
  flush() {
    for (const a of Object.values(this._attr)) a.needsUpdate = true;
  }

  /**
   * Point the shading at the map's own sun, so smoke sits in the scene.
   *
   * The sun's COLOUR is used and its intensity is not. `MapLighting.worldSun()`
   * reports 60 on Nuke — that is the analytic scale the lightmapped materials
   * want, normalised against their own BRDF, and feeding it to a half-lambert
   * makes the shading term about fifteen instead of about one, which turns
   * every smoke into a white cut-out. The colour already arrives near unit
   * length, which is the scale this wants.
   */
  setLight(light) {
    if (!light) return;
    if (light.toSun) this._lightWorld.copy(light.toSun).normalize();
    if (light.color) this.uniforms.lightColor.value.copy(light.color);
    if (light.ambient) this.uniforms.ambient.value.copy(light.ambient);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
