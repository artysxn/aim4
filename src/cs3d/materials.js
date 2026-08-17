// ---------------------------------------------------------------------------
// src/cs3d/materials.js
// Builds the three.js materials for a map pack and streams their textures in
// behind the geometry.
//
// Two rules shape this file, both learned the hard way on the WebGPU backend:
//
//   1. A material is built ONCE, with its final textures. Swapping a texture
//      into a live node material and flagging needsUpdate leaves the sampler
//      from the old texture bound (r169): a 1x1 nearest-filtered placeholder
//      then samples a 1024² mipmapped map without filtering, which is the
//      swirling moiré / flat-averaged surfaces / "caustics" of the first pass.
//      Until its textures land a material id shows an interim flat colour
//      (the manifest's average) and the mesh's material is swapped whole.
//
//   2. Textures come out of ONE file. tex.bin holds every webp back to back
//      and the manifest holds the offsets; the loader streams it and decodes
//      each image the moment its bytes are in (createImageBitmap, off the main
//      thread). One request instead of a thousand, and big surfaces first
//      because that is the order the pack wrote them in.
//
// Lighting per material:
//   - lightmapped world geometry: baked irradiance (lightmap.webp, RGBM) via
//     uv set 1, no sky-probe *diffuse* but the probe's reflection kept (see
//     SpecularOnlyEnvironmentNode) and no AO map (the bake has it); the sun
//     stays dynamic on top
//   - everything else (props): sky probe as before
//   - two-layer blend shaders: layer 2 mixed over layer 1 by the vertex paint
//     in COLOR_0.r, softened by the layers' height maps
//   - self-illuminated: masked by g_tSelfIllumMask, never the whole surface
//
// Nothing here turns fog off. The 3D skybox used to be exempt, which is why
// its hills read as crisp cut-outs pasted behind the map: the loader draws the
// skybox at its real x16 size and distance rather than as a miniature around
// the camera, so those hills are genuinely 40,000 units away and the map's own
// haze (src/cs3d/fog.js) should bury them exactly as much as the game does.
// The sky dome and the background are the only things with `fog = false`, and
// they are the fog's colour source.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import {
  IrradianceNode,
  attribute,
  clamp,
  dot,
  float,
  lights,
  max,
  mix,
  luminance,
  min,
  normalMap,
  normalize,
  smoothstep,
  texture,
  transformNormalToView,
  transformedNormalWorld,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexColor
} from 'three/webgpu';

/**
 * Baked irradiance → three irradiance units. The atlas stores outgoing light
 * for a white Lambert surface (radiance); three's indirect diffuse expects
 * π × radiance (see PhysicalLightingModel: irradiance × diffuse/π). The
 * remaining factor is a taste knob the lighting sets per map.
 */
const LM_TO_IRRADIANCE = Math.PI;

/**
 * MeshStandardNodeMaterial with two hooks:
 *   - `cs3d.lightmap` → the RGBM atlas becomes the material's whole light.
 *     CS2 bakes the sun into it (light_environment directlight=1, sharp
 *     shadows and all), so the scene's dynamic sun and the sky probe are
 *     both dropped for these; adding either would light the map twice.
 *   - `cs3d.blend` → colour/normal from two layers mixed by COLOR_0.r
 */
class Cs3dMaterial extends THREE.MeshStandardNodeMaterial {
  constructor(cs3d) {
    super();
    this.cs3d = cs3d;
    // Scene lights off for anything whose sun is baked. Charted geometry has
    // always done this; a prop joins it once the pack ships `_sun`, and that is
    // what takes the leaky runtime shadow map out of the picture. Without the
    // baked term a prop still needs the real light, or it loses the sun
    // entirely — hence the `sun` check rather than `probeAmbient` alone.
    if (cs3d.lightmap || (cs3d.probeAmbient && cs3d.sun) || (cs3d.sky && cs3d.sun)) {
      this.lightsNode = lights([]);
    }
  }

  setupLightMap(builder) {
    const lm = this.cs3d.lightmap;
    /**
     * The 3D skybox: distant scenery drawn at ×16 around the sky camera.
     *
     * It gets the analytic sun with NO occlusion term and keeps the sky probe
     * as its diffuse ambient. It cannot use the probe-ambient path: CS2's light
     * probe volumes cover the playable map, not the miniature, so every one of
     * its vertices falls outside every volume. The pack does not bake `_AMB` or
     * `_SUN` for it at all — and with a map-wide `probeAmbient` flag the loader
     * still asked for `_amb`, got nothing, and filled zeros. Zero ambient plus
     * an unshadowed sun is why the background buildings went black on the side
     * facing away from it while their roofs stayed lit.
     */
    if (!lm && this.cs3d.sky) {
      const ssun = this.cs3d.sun;
      const amb = this.cs3d.skyAmbient;
      if (!ssun) return super.setupLightMap(builder);
      const nDotL = max(dot(transformedNormalWorld, ssun.direction), float(0));
      let irr = ssun.color.mul(ssun.intensity).mul(nDotL);
      if (amb) irr = irr.add(amb.mul(float(LM_TO_IRRADIANCE)));
      return new IrradianceNode(irr);
    }
    // A prop with baked probe irradiance: CS2's own light for everything that
    // has no lightmap chart. It arrives per vertex in `_amb`, already the
    // ambient cube evaluated for that vertex's normal, so there is nothing to
    // do here but hand it over as the surface's indirect diffuse.
    //
    // This is what stops the sky probe being a diffuse light: a global
    // environment has no occlusion, so a crate indoors was getting the same
    // sky as one in the yard, tinted blue, and no single intensity was right
    // for both. The probe keeps its reflection (setupEnvironment) and loses its
    // diffuse — exactly the split lightmapped world geometry already uses.
    if (!lm && this.cs3d.probeAmbient) {
      let irr = attribute('_amb', 'vec3').mul(float(LM_TO_IRRADIANCE));
      // The sun, the same analytic term the charted world uses, gated by baked
      // per-vertex visibility instead of the mask atlas. A prop was previously
      // the only thing still lit by the real DirectionalLight, whose shadow map
      // leaks through thin geometry: indoor cables and conduit sampled lit and
      // glowed as `sun ×` came up while the wall behind them stayed dark.
      const psun = this.cs3d.sun;
      if (psun) {
        const nDotL = max(dot(transformedNormalWorld, psun.direction), float(0));
        irr = irr.add(psun.color.mul(psun.intensity).mul(nDotL).mul(attribute('_sun', 'float')));
      }
      return new IrradianceNode(irr);
    }
    if (!lm) return super.setupLightMap(builder);
    const t = texture(lm.texture, uv(1));
    // RGBM: rgb × a × range, then the per-map intensity. This atlas is the
    // INDIRECT term only.
    let irr = t.rgb.mul(t.a).mul(float(lm.range)).mul(lm.intensity).mul(float(LM_TO_IRRADIANCE));
    // The sun, analytically, exactly as the game does it: colour × N·L ×
    // baked visibility. CS2 keeps the sun out of the atlas and stores only its
    // shadow in direct_light_shadows, so a lightmapped surface with no sun
    // term here is lit by bounce light alone — which is what made every map
    // read as overcast the moment its textures finished loading.
    //
    // Baked, not a shadow map: the mask is 4096² over the whole world with the
    // penumbrae the bake computed, so it is both sharper and cheaper than the
    // dynamic cascade, and it costs one texture fetch.
    //
    // VISIBILITY, 1 = in daylight. The game's texture stores the opposite
    // (shadow), which cs3d-pack inverts on the way out; a pack from before that
    // fix renders every shadow in the map as a bright patch instead.
    const sun = this.cs3d.sun;
    if (sun) {
      const nDotL = max(dot(transformedNormalWorld, sun.direction), float(0));
      const vis = sun.mask ? texture(sun.mask, uv(1)).r : float(1);
      irr = irr.add(sun.color.mul(sun.intensity).mul(nDotL).mul(vis));
    }
    return new IrradianceNode(irr);
  }

  /**
   * Lightmapped surfaces keep the sky probe's REFLECTION and lose only its
   * diffuse light.
   *
   * The bake already holds the sky's diffuse contribution, so adding the
   * probe's on top doubles it — that part was right. But returning null drops
   * the probe entirely, and a metal has no diffuse at all: its whole
   * appearance is the reflection. So every metal surface with a lightmap
   * chart rendered pure black, which is what turned Nuke's painted door
   * frames, benches and roller doors into silhouettes.
   *
   * `EnvironmentNode.setup()` accumulates into two separate places on the
   * builder context — `radiance` for the reflection, `iblIrradiance` for the
   * diffuse — so swallowing the second one keeps the first.
   */
  setupEnvironment(builder) {
    const node = super.setupEnvironment(builder);
    // The 3D skybox supplies its own diffuse in setupLightMap, so the probe is
    // reflections-only for it too — otherwise it would take both.
    if (!node || !(this.cs3d.lightmap || this.cs3d.probeAmbient || this.cs3d.sky)) return node;
    return new SpecularOnlyEnvironmentNode(node.envNode);
  }
}

/** An EnvironmentNode that contributes reflections but no ambient diffuse. */
export class SpecularOnlyEnvironmentNode extends THREE.EnvironmentNode {
  setup(builder) {
    const ctx = builder.context;
    const real = ctx.iblIrradiance;
    ctx.iblIrradiance = DISCARD_ACCUMULATOR;
    try {
      return super.setup(builder);
    } finally {
      ctx.iblIrradiance = real;
    }
  }
}

const DISCARD_ACCUMULATOR = { addAssign() {} };

/** Camera-independent per-map lightmap intensity, shared by every material. */
export function makeLightmapUniform(v = 1) {
  return uniform(v);
}

function makeTexture(bitmap, { srgb, wrap = THREE.RepeatWrapping, anisotropy = 16, mips = true }) {
  const t = new THREE.Texture(bitmap);
  t.flipY = false; // glTF UV convention (the pack keeps VRF's)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = anisotropy;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class MaterialLibrary {
  /**
   * @param {object} manifest   pack manifest (v2)
   * @param {string} base       pack URL prefix (no trailing slash)
   * @param {THREE.WebGPURenderer} renderer
   * @param {string} versionQuery  "?v=..." cache buster
   * @param {{lightmapIntensity?: number}} [opts]
   */
  constructor(manifest, base, renderer, versionQuery = '', opts = {}) {
    this.manifest = manifest;
    this.base = base;
    this.renderer = renderer;
    this.versionQuery = versionQuery;
    // WebGPURenderer has no `.capabilities`; WebGPU guarantees 16.
    this.anisotropy = renderer?.capabilities?.getMaxAnisotropy
      ? Math.min(16, renderer.capabilities.getMaxAnisotropy())
      : 16;
    this.interim = new Map(); // id → flat-colour material shown until textures land
    this.final = new Map(); // id → textured material
    this.flat = null; // id → unlit grey, while the flat view is on (setFlat)
    this.users = new Map(); // id → Set<Object3D> whose .material we own
    this.textures = new Array(manifest.tex?.dir?.length || 0); // index → THREE.Texture
    this.pendingMats = new Map(); // texIndex → Set<matId> waiting on it
    this.loadedTex = 0;
    this.totalTex = manifest.tex?.dir?.length || 0;
    this.bytesLoaded = 0;
    this.bytesTotal = manifest.tex?.bytes || 0;
    this.onProgress = null;
    this.onMaterialReady = null; // (id, material) → void
    this.aborted = false;
    this.lightmap = null; // { texture, range, intensity(uniform) } once loaded
    this.lightmapIntensity = makeLightmapUniform(opts.lightmapIntensity ?? 1);
    /** The pack baked CS2's light probes into the vertices of chartless geometry. */
    this.probeAmbient = !!opts.probeAmbient;
    /** ...and its sun visibility, so a prop is shadowed by the bake, not the map. */
    this.sunVis = !!manifest.sunVis;
    /** Seconds since load, for the effect cards' drifting masks. */
    this.time = uniform(0);
    // The analytic sun lightmapped materials add on top of the baked indirect.
    // Uniforms, so MapLighting can set them before or after a material builds
    // without forcing a rebuild; `mask` is the one part that cannot change
    // after the fact, so materials built before it lands are rebuilt with it.
    this.sun = {
      color: uniform(new THREE.Color(1, 1, 1)),
      direction: uniform(new THREE.Vector3(0, 1, 0)), // toward the sun
      intensity: uniform(0),
      mask: null
    };
    /** The 3D skybox's own ambient; see setSkyAmbient. */
    this.skyAmbient = uniform(new THREE.Color(0, 0, 0));
    this._buildInterim();
  }

  _srgb(rgb) {
    return new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  }

  _factor(m) {
    return new THREE.Color(m.color?.[0] ?? 1, m.color?.[1] ?? 1, m.color?.[2] ?? 1);
  }

  /** Flat-colour stand-ins, one per material id, so the world is coloured before a single texture lands. */
  _buildInterim() {
    for (const m of this.manifest.materials) {
      const startColor = this._srgb(m.avg || [128, 128, 128]).multiply(this._factor(m));
      const mat = m.unlit
        ? new THREE.MeshBasicMaterial({ color: startColor })
        : new THREE.MeshStandardMaterial({ color: startColor, roughness: 1, metalness: 0 });
      mat.name = `m${m.id}`;
      mat.userData = { id: m.id, decal: !!m.decal, alphaMode: m.alphaMode, interim: true };
      if (m.doubleSided) mat.side = THREE.DoubleSide;
      if (m.water) {
        mat.color.copy(this._factor(m));
        mat.transparent = true;
        mat.opacity = m.opacity ?? 0.5;
        mat.roughness = m.roughness ?? 0.12;
      }
      // Glass carries no albedo, so its stand-in has no average colour to show;
      // left opaque it is a white slab across the window until the normal map
      // lands.
      if (m.glass) {
        mat.color.copy(this._factor(m));
        mat.transparent = true;
        mat.opacity = m.opacity ?? 0.22;
        mat.roughness = m.roughness ?? 0.05;
      }
      // A cut-out or blended surface shown before its mask arrives is a solid
      // slab in the middle of the map; wait for the texture instead.
      if (m.alphaMode !== 'OPAQUE' && m.base !== undefined) mat.visible = false;
      this.interim.set(m.id, mat);
    }
  }

  /** Drive the effect cards' drifting masks. @param {number} seconds */
  setTime(seconds) {
    this.time.value = seconds;
  }

  /** Current material for an id: the flat view's if it is on, else final, else interim. */
  get(id) {
    return this.flat?.get(id) || this.final.get(id) || this.interim.get(id) || null;
  }

  /**
   * Replace every material with one unlit colour, or restore the real ones.
   *
   * This is a swap rather than an edit of the live materials for the same
   * reason the streaming path is (rule 1 at the top of this file): a textured
   * node material cannot have its maps pulled out from under it. The flat
   * materials are built once, held, and handed to every object bound to an id
   * — including objects bound *after* the view is on, because `get()` and
   * `bind()` both read `this.flat` first, so a batch created by a group that
   * is still streaming comes up flat like the rest.
   *
   * Lambert, not Basic: the flat view keeps the live sun and its shadow map,
   * and an unlit material takes neither. Lambert is the cheapest thing that
   * does — diffuse only, no specular lobe, no environment — and it drops every
   * baked input with it, which is the other half of what this view is for.
   *
   * @param {Map<number, number|null>|null} colors  id → grey hex, or null for
   *   "do not draw this one" (the cut-outs and decals: a chainlink fence with
   *   its alpha thrown away is a solid slab across the map). Pass null for the
   *   whole map to restore the textured materials.
   */
  setFlat(colors) {
    if (this.flat) {
      for (const m of this.flat.values()) m.dispose();
      this.flat = null;
    }
    if (colors) {
      this.flat = new Map();
      for (const m of this.manifest.materials) {
        const grey = colors.get(m.id);
        const mat = new THREE.MeshLambertMaterial({ color: grey ?? 0x555555 });
        mat.name = `m${m.id}:flat`;
        // No fog and no tone mapping in this view, so a lit surface shows the
        // hex asked for — which is the whole point of shading by area.
        mat.fog = false;
        if (grey === null) mat.visible = false;
        if (m.doubleSided) mat.side = THREE.DoubleSide;
        mat.userData = { id: m.id, flat: true };
        this.flat.set(m.id, mat);
      }
    }
    for (const [id, set] of this.users) for (const o of set) o.material = this.get(id);
  }

  /** Material id from a pack mesh's material name ("m12"). */
  static idOf(mesh) {
    const name = mesh.material?.name || mesh.name || '';
    const m = /^m(\d+)$/.exec(name);
    return m ? Number(m[1]) : -1;
  }

  /**
   * Hand an object its material for `id` and remember it, so when the
   * textured material is built the object gets it too.
   */
  bind(id, obj) {
    let set = this.users.get(id);
    if (!set) this.users.set(id, (set = new Set()));
    set.add(obj);
    obj.material = this.get(id);
    return obj.material;
  }

  /** All materials currently in use (for callers that patch shaders). */
  list() {
    return [...new Set([...this.interim.values(), ...this.final.values()])];
  }

  // ---- streaming ----------------------------------------------------------

  /** Start the texture bundle, the lightmap and the sun's shadow mask. Idempotent. */
  streamAll() {
    if (this._started) return;
    this._started = true;
    this._loadLightmap().catch((e) => console.warn('cs3d: lightmap failed', e));
    this._loadShadowMask().catch((e) => console.warn('cs3d: shadow mask failed', e));
    // A bundle that fails outright (404, dropped connection) never reaches the
    // per-texture counter, so the count has to be closed out here. Otherwise
    // progress stops short of 100% forever — which now means the boot screen
    // never lifts, not just that a small bar sticks.
    this._streamBundle().catch((e) => {
      console.warn('cs3d: texture bundle failed', e);
      this.loadedTex = this.totalTex;
      this.onProgress?.();
    });
  }

  /**
   * Point the world's sun at a direction and colour. Uniforms, so this is free
   * to call at any time and as often as the lighting likes.
   * @param {{toSun: THREE.Vector3, color: THREE.Color, intensity: number}} o
   */
  setSun({ toSun, color, intensity }) {
    if (toSun) this.sun.direction.value.copy(toSun).normalize();
    if (color) this.sun.color.value.copy(color);
    if (Number.isFinite(intensity)) this.sun.intensity.value = intensity;
  }

  /**
   * Ambient for the 3D skybox: the sky's own irradiance, at full strength.
   *
   * It cannot share the sky probe. That probe is deliberately crushed to a
   * hundredth (SKY_PROBE_SCALE) because a global environment has no occlusion
   * and was washing the map's interiors blue — which leaves it at ~0.006, so
   * handing the miniature "sky probe diffuse" gave it no ambient at all and its
   * shaded faces stayed black. The miniature is distant open-air scenery: it
   * wants the sky as measured, not as tuned for indoor crates.
   * @param {THREE.Color} color  sky irradiance, linear
   */
  setSkyAmbient(color) {
    if (color) this.skyAmbient.value.copy(color);
  }

  async _loadShadowMask() {
    const sm = this.manifest.shadowMask;
    if (!sm?.file) return;
    const res = await fetch(`${this.base}/${sm.file}${this.versionQuery}`);
    if (!res.ok) throw new Error(`shadowmask ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob(), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none'
    });
    if (this.aborted) return;
    // Same sampling rules as the atlas: charts, so no mips and no wrap.
    this.sun.mask = makeTexture(bitmap, {
      srgb: false,
      wrap: THREE.ClampToEdgeWrapping,
      anisotropy: 1,
      mips: false
    });
    this._rebuildLightmapped();
  }

  /** Drop and rebuild every lightmapped material (a lighting input arrived late). */
  _rebuildLightmapped() {
    for (const [id, mat] of [...this.final]) {
      if (!this.manifest.materials[id]?.lightmapped) continue;
      this.final.delete(id);
      this._tryBuild(id);
      mat.dispose();
    }
  }

  /** Which texture indices a material waits for. */
  _texIndices(m) {
    const out = [];
    for (const k of ['base', 'normal', 'orm', 'emissiveMask']) if (m[k] !== undefined) out.push(m[k]);
    if (m.tintMask !== undefined) out.push(m.tintMask);
    if (m.effect?.maskTex !== undefined) out.push(m.effect.maskTex);
    if (m.blend) for (const k of ['base', 'normal', 'heights', 'mod']) if (m.blend[k] !== undefined) out.push(m.blend[k]);
    return out;
  }

  async _loadLightmap() {
    const lm = this.manifest.lightmap;
    if (!lm?.file) return;
    const res = await fetch(`${this.base}/${lm.file}${this.versionQuery}`);
    if (!res.ok) throw new Error(`lightmap ${res.status}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (this.aborted) return;
    // No mips: the atlas is charts; a mip would bleed neighbours together.
    const tex = makeTexture(bitmap, { srgb: false, wrap: THREE.ClampToEdgeWrapping, anisotropy: 1, mips: false });
    this.lightmap = { texture: tex, range: lm.range || 16, intensity: this.lightmapIntensity, mean: lm.mean };
    this._rebuildLightmapped();
  }

  async _streamBundle() {
    const dir = this.manifest.tex?.dir;
    if (!dir || !dir.length) return;
    // Materials whose every texture is in get built as soon as that happens.
    for (const m of this.manifest.materials) {
      const idxs = this._texIndices(m);
      if (!idxs.length) {
        this._tryBuild(m.id);
        continue;
      }
      for (const i of idxs) {
        let s = this.pendingMats.get(i);
        if (!s) this.pendingMats.set(i, (s = new Set()));
        s.add(m.id);
      }
    }
    const res = await fetch(`${this.base}/${this.manifest.tex.file}${this.versionQuery}`);
    if (!res.ok || !res.body) throw new Error(`tex.bin ${res.status}`);
    const total = Number(res.headers.get('content-length')) || this.bytesTotal;
    this.bytesTotal = total;
    const reader = res.body.getReader();
    // Received bytes, in order; an entry is queued for decoding the moment
    // its last byte is in. A small decode pool keeps memory bounded without
    // ever busy-waiting on the main thread.
    const chunks = [];
    let have = 0;
    let next = 0; // next dir entry whose bytes we wait for
    const ready = []; // entry indices ready to decode
    let inFlight = 0;
    const MAX_DECODE = 6;
    let finish;
    const allDone = new Promise((r) => (finish = r));
    let streamDone = false;
    let decoded = 0;
    const runNext = () => {
      while (inFlight < MAX_DECODE && ready.length) {
        const i = ready.shift();
        inFlight++;
        this._decodeEntry(i, chunks, dir[i])
          .catch((e) => console.warn(`cs3d: texture ${i} failed`, e))
          .finally(() => {
            inFlight--;
            decoded++;
            this.loadedTex++;
            this.onProgress?.();
            if (streamDone && !ready.length && inFlight === 0) finish();
            else runNext();
          });
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done || this.aborted) break;
      chunks.push({ start: have, buf: value });
      have += value.byteLength;
      this.bytesLoaded = have;
      while (next < dir.length && dir[next].off + dir[next].len <= have) ready.push(next++);
      runNext();
    }
    streamDone = true;
    if (next < dir.length) {
      console.warn(`cs3d: tex.bin ended early (${have} of ${total} bytes); ${dir.length - next} textures missing`);
      // Count them as done so the progress bar can finish.
      this.loadedTex += dir.length - next;
      next = dir.length;
    }
    if (!ready.length && inFlight === 0) finish();
    await allDone;
    this.onProgress?.();
  }

  /** Bytes [off, off+len) out of the received chunk list, as one Uint8Array. */
  _slice(chunks, off, len) {
    const out = new Uint8Array(len);
    let written = 0;
    for (const c of chunks) {
      const cEnd = c.start + c.buf.byteLength;
      if (cEnd <= off) continue;
      if (c.start >= off + len) break;
      const from = Math.max(off, c.start) - c.start;
      const to = Math.min(off + len, cEnd) - c.start;
      out.set(c.buf.subarray(from, to), Math.max(off, c.start) - off);
      written += to - from;
    }
    if (written !== len) throw new Error(`short slice ${written}/${len}`);
    return out;
  }

  async _decodeEntry(i, chunks, e) {
    const bytes = this._slice(chunks, e.off, e.len);
    const blob = new Blob([bytes], { type: 'image/webp' });
    // No premultiply: alpha is a cut-out mask, and premultiplying darkens the
    // rims of every leaf. No colour conversion: colour management is three's.
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (this.aborted) return;
    this.textures[i] = makeTexture(bitmap, { srgb: e.kind === 'base', anisotropy: this.anisotropy });
    const waiting = this.pendingMats.get(i);
    if (waiting) {
      this.pendingMats.delete(i);
      for (const id of waiting) this._tryBuild(id);
    }
  }

  /** Build the textured material for `id` if every texture it needs is decoded. */
  _tryBuild(id) {
    if (this.final.has(id) || this.aborted) return;
    const m = this.manifest.materials[id];
    if (!m) return;
    for (const i of this._texIndices(m)) if (!this.textures[i]) return;
    const mat = this._buildFinal(m);
    this.final.set(id, mat);
    const users = this.users.get(id);
    // `get`, not `mat`: with the flat view on, a material finishing its
    // textures must not put them back on screen.
    if (users) for (const o of users) o.material = this.get(id);
    this.onMaterialReady?.(id, mat);
  }

  _buildFinal(m) {
    const factor = this._factor(m);
    const base = m.base !== undefined ? this.textures[m.base] : null;
    const normal = m.normal !== undefined ? this.textures[m.normal] : null;
    const orm = m.orm !== undefined ? this.textures[m.orm] : null;
    let mat;
    if (m.effect) {
      mat = this._buildEffect(m, base);
    } else if (m.unlit) {
      mat = new THREE.MeshBasicMaterial({ color: factor, map: base || null });
    } else {
      const lightmapped = !!(m.lightmapped && this.lightmap);
      const blend = m.blend
        ? {
            base: m.blend.base !== undefined ? this.textures[m.blend.base] : null,
            normal: m.blend.normal !== undefined ? this.textures[m.blend.normal] : null,
            heights: m.blend.heights !== undefined ? this.textures[m.blend.heights] : null,
            mod: m.blend.mod !== undefined ? this.textures[m.blend.mod] : null,
            scale2: m.blend.scale2 || [1, 1],
            softness: m.blend.softness ?? 0.5,
            // Each layer's own albedo adjust, applied before the mix, with the
            // texture averages the contrast pivots on.
            cc1: m.cc1 || null,
            cc2: m.cc2 || null,
            avg1: m.avg,
            avg2: m.blend.base !== undefined ? this.manifest.tex?.dir?.[m.blend.base]?.avg : undefined,
            // csgo_environment: the game's tint, per layer, masked by height.g.
            envTint: m.envTint || null,
            mask1: m.envTint && m.tintMask !== undefined ? this.textures[m.tintMask] : null,
            mask2: m.envTint && m.blend.tintMask !== undefined ? this.textures[m.blend.tintMask] : null
          }
        : null;
      mat = new Cs3dMaterial({
        lightmap: lightmapped ? this.lightmap : null,
        blend,
        // Both paths now take the analytic sun: charted geometry gates it on
        // the mask atlas, chartless on its baked `_sun` vertex term. The 3D
        // skybox takes it unoccluded (see setupLightMap).
        sun: lightmapped || (this.probeAmbient && this.sunVis) || m.sky ? this.sun : null,
        // The miniature sits outside every light probe volume, so it keeps the
        // sky probe's diffuse instead of a baked `_amb` that does not exist.
        probeAmbient: !lightmapped && this.probeAmbient && !m.sky,
        sky: !!m.sky,
        skyAmbient: m.sky ? this.skyAmbient : null
      });
      // `factor` is only the tints the pack invents (water fog, glass, unlit
      // black). A vmat's own g_vColorTint is NOT here: it already rides on each
      // tile's batch colour, and applying it in both places multiplied it twice
      // and turned tinted metals black.
      mat.color.copy(factor);
      mat.map = base;
      mat.normalMap = normal;
      if (m.water) {
        // A glossy translucent sheet in the water's fog colour, reflecting
        // the sky probe; the pack skipped its textures on purpose. Water is
        // level, and the exported meshes carry per-face normals that would
        // facet the reflection, so the normal is pinned to world up.
        mat.roughness = m.roughness ?? 0.12;
        mat.metalness = 0;
        mat.normalNode = transformNormalToView(vec3(0, 1, 0));
      } else if (m.glass) {
        // A pane, not a surface: `csgo_glass` ships no albedo, so what makes it
        // read as glass is the probe's reflection over a nearly clear sheet.
        // Its ORM is the frame's, not the glass's — using it put the frame's
        // roughness and a metalness of 1 on the pane, which is why these went
        // to flat grey. The vmat's own roughness and a dielectric instead.
        mat.roughness = m.roughness ?? 0.05;
        mat.metalness = 0;
        mat.normalMap = normal;
      } else {
        // Roughness and metalness come entirely from the ORM (G and B); the
        // factors multiply it, so they stay at 1. Without an ORM the surface
        // is a plain rough dielectric, never chrome.
        mat.roughness = orm ? 1 : 0.85;
        mat.metalness = orm ? 1 : 0;
        mat.roughnessMap = orm;
        mat.metalnessMap = orm;
        // AO only where the light is dynamic. On a lightmapped surface the
        // bake already contains the occlusion, in the right places and at the
        // right strength; multiplying the texture's AO in on top darkened
        // exactly the creases the bake had darkened, which is the blotchy,
        // muddy shading in corners.
        mat.aoMap = lightmapped ? null : orm;
        if (orm) orm.channel = 0;
        mat.aoMapIntensity = 1;
      }
      if (m.emissive) this._wireEmissive(mat, m, base);
      if (blend && blend.base && base) this._wireBlend(mat, base, normal, blend);
      // One layer: colour correction and, on csgo_environment, the game's tint.
      else if (m.cc1 || m.envTint) this._wireEnvSingle(mat, base, m, m.envTint && m.tintMask !== undefined ? this.textures[m.tintMask] : null);
      // A dedicated tint mask (csgo_complex and friends). csgo_environment
      // handled its own tint above and must not take it a second time here.
      if (!m.envTint && m.tintMask !== undefined) this._wireTintMask(mat, this.textures[m.tintMask], base, m.tintMaskBright ?? 1);
    }
    mat.name = `m${m.id}`;
    mat.userData = { id: m.id, decal: !!m.decal, alphaMode: m.alphaMode, lightmapped: !!m.lightmapped };
    // Foliage cards, fences and grates are single-sided geometry that has to
    // be visible from behind; F_RENDER_BACKFACES in the vmat says which.
    //
    // A 3D skybox card is always two-sided regardless of what the vmat says.
    // It is scenery wrapped around the viewer, so whichever way its faces were
    // wound, half of it is being looked at from behind: Ancient's cloud layer
    // (`csgo_unlitgeneric`, a dome spanning y -1902..4138 with the camera
    // inside it) was culled away entirely, while the sun disc and the tree
    // cards beside it survived only because `effect` and `csgo_foliage` happen
    // to force DoubleSide already. Nothing up there is thick enough for
    // back-face culling to be saving anything.
    if (m.doubleSided || m.sky) mat.side = THREE.DoubleSide;
    if (m.alphaMode === 'BLEND') {
      mat.transparent = true;
      // Water keeps depth writes: its sheets overlap in places and, drawn
      // without depth, the overlaps blend twice into a checkerboard.
      mat.depthWrite = !!m.water;
      mat.opacity = m.opacity ?? 1;
    } else if (m.alphaMode === 'MASK') {
      // The cut-out threshold from g_flAlphaTestReference. This is what turns
      // a leaf card from a solid quad into leaves.
      mat.alphaTest = m.alphaCutoff ?? 0.5;
      mat.transparent = false;
      mat.depthWrite = true;
    }
    if (m.decal) {
      // Coplanar with the surface underneath; nudge toward the camera.
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      mat.polygonOffsetUnits = -2;
      mat.depthWrite = false;
    }
    return mat;
  }

  /**
   * Self-illumination, as `csgo_complex` means it:
   *
   *   emissive = tint × lerp(1, albedo, albedoFactor) × mask × intensity
   *
   * The mask is the whole point. F_SELF_ILLUM is set on a Nuke vending
   * machine, a lit office fixture and a control-room display alike, and the
   * only thing that says *which pixels* glow is `g_tSelfIllumMask`. Lighting
   * the whole surface instead is what turned the vending machine into a
   * featureless white box, and Train and Overpass have two dozen props each
   * that were doing the same thing.
   *
   * A pack from before the mask was exported has an emissive colour and no
   * mask; there the albedo alone still keeps a lit prop looking like itself
   * rather than like a light box.
   */
  _wireEmissive(mat, m, base) {
    const tint = new THREE.Color(...m.emissive);
    // No emissiveIntensity means a pack from before the vmat's self-illum
    // parameters were read, so its `emissive` is a flat white guess. Keep it
    // dim: a mildly warm prop is a much smaller error than a light box.
    const intensity = Number.isFinite(m.emissiveIntensity) ? m.emissiveIntensity : 0.35;
    const mask = m.emissiveMask !== undefined ? this.textures[m.emissiveMask] : null;
    const albedoFactor = Number.isFinite(m.emissiveAlbedo) ? m.emissiveAlbedo : 1;
    // Without an albedo map there is nothing to modulate, so the tint is it.
    const albedo = base ? mix(vec3(1), texture(base, uv(0)).rgb, float(albedoFactor)) : vec3(1);
    let node = vec3(tint.r, tint.g, tint.b).mul(albedo).mul(float(intensity));
    if (mask) node = node.mul(texture(mask, uv(0)).r);
    else if (!base) node = node.mul(0.5); // no mask and no albedo: a whole glowing surface, so tread lightly
    mat.emissiveNode = node;
  }

  /**
   * An atmosphere card: the sky's cloud layer, the sun's glow disc, chimney
   * steam. `csgo_effects` is unlit and its whole look is opacity — the colour
   * map's alpha times up to three masks that tile and drift independently,
   * scaled by g_flOpacityScale — over a colour lifted by g_flColorBoost. The
   * sun disc boosts by 156, which is what makes it a glow rather than a decal.
   *
   * These used to be dropped wholesale because drawing them opaque made white
   * slabs across the sky. Drawn as the vmat asks they are the clouds.
   */
  _buildEffect(m, base) {
    const e = m.effect;
    const mat = new THREE.MeshBasicNodeMaterial();
    const uv0 = uv(0);
    const tex = base ? texture(base, uv0) : vec4(1, 1, 1, 1);
    const tint = vec3(e.tint?.[0] ?? 1, e.tint?.[1] ?? 1, e.tint?.[2] ?? 1);
    mat.colorNode = tex.rgb.mul(tint).mul(float(e.boost ?? 1));
    let alpha = tex.a.mul(float(e.opacity ?? 1));
    const maskTex = e.maskTex !== undefined ? this.textures[e.maskTex] : null;
    if (maskTex && e.masks) {
      const chan = ['r', 'g', 'b'];
      e.masks.forEach((mk, i) => {
        const scale = vec2(mk.scale?.[0] || 1, mk.scale?.[1] || 1);
        const pan = vec2(mk.pan?.[0] || 0, mk.pan?.[1] || 0);
        alpha = alpha.mul(texture(maskTex, uv0.mul(scale).add(pan.mul(this.time)))[chan[i]]);
      });
    }
    mat.opacityNode = clamp(alpha, 0, 1);
    mat.transparent = true;
    mat.depthWrite = false;
    // Additive for the glows and the steam; the cloud layer blends normally.
    mat.blending = e.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    mat.side = THREE.DoubleSide;
    mat.fog = false;
    return mat;
  }

  /**
   * A prop's instance tint, applied only where `g_tTintMask` allows it.
   *
   * A rendercolor does not recolour a whole model. Dust 2's taxi is one vmat
   * with four instance tints, and the mask is what keeps the yellow on the body
   * panels and off the chrome trim, the bumpers and the window rubbers; Nuke's
   * doors and pipes are the same story. Tinting the whole surface painted the
   * trim with the body.
   *
   * The tint arrives per tile in COLOR_0.gba rather than through
   * `BatchedMesh.setColorAt`, because three multiplies the batch colour into
   * every fragment (`colorNode = batchColor.mul(colorNode)`) with no way to
   * mask it. The loader leaves setColorAt unused for these materials, so that
   * multiply is never compiled in and this is the only place the tint applies.
   */
  _wireTintMask(mat, maskTex, base, maskBright = 1) {
    if (!maskTex) return;
    const had = !!mat.colorNode;
    const src = had ? mat.colorNode : base ? texture(base, uv(0)) : vec4(1, 1, 1, 1);
    // The game's tint for this family: `1 - mask * (1 - tint)`, a straight
    // multiply where the mask says so. csgo_environment is NOT this — see
    // _envTintLayer — and never reaches here.
    const m = clamp(texture(maskTex, uv(0)).r.mul(float(maskBright)), 0, 1);
    const k = mix(vec3(1), vertexColor().gba, m);
    let rgb = src.rgb.mul(k);
    // A colourNode from the blend wiring already carries the material factor.
    if (!had) rgb = rgb.mul(vec3(mat.color.r, mat.color.g, mat.color.b));
    mat.colorNode = vec4(rgb, src.a);
  }

  /**
   * Two-layer blend: layer 2 over layer 1 by the vertex paint (COLOR_0.r),
   * with a per-texel threshold deciding where the transition bites first, so
   * the boundary follows the material rather than the (very coarse) paint.
   *
   * Two ways a vmat supplies that threshold. `g_tBlendModulation` gives it
   * directly in R — the paint has to exceed it for layer 2 to show — with a
   * per-texel width in G; this is what Dust 2 uses, and its paint only reaches
   * ~0.4, so the threshold is doing nearly all of the work. A height pair
   * instead derives it from which layer stands proud (dirt settles into the
   * crevices of the stone, not onto its bumps).
   */
  /**
   * `csgo_environment`'s per-layer albedo adjust: saturation, then contrast
   * about mid grey, then brightness.
   *
   * The environment shaders do not draw their albedo as authored — Inferno's
   * stone runs layer 1 at saturation 0.5. Nuke is almost entirely
   * `csgo_complex`, which has no such parameters, so this is a no-op there and
   * the map is unaffected.
   *
   * Applied to the linear sample, where Source applies it to the texture read.
   * If the correction reads too strong or too weak, that difference in space is
   * the first thing to suspect — contrast about 0.5 is not the same operation
   * either side of the transfer curve.
   */
  _correct(rgb, cc, avg) {
    if (!cc) return rgb;
    let c = rgb;
    // The game's MatrixColorCorrect2, in order: contrast about the TEXTURE'S
    // AVERAGE colour (not mid grey), then brightness, then saturation about
    // the luminance axis. `avg` is the pack's per-texture mean, sRGB bytes.
    if (cc.con !== 1) {
      const p = avg ? vec3(...avg.map((v) => Math.pow(v / 255, 2.2))) : vec3(0.18);
      c = c.sub(p).mul(float(cc.con)).add(p);
    }
    if (cc.bri !== 1) c = c.mul(float(cc.bri));
    if (cc.sat !== 1) c = mix(vec3(luminance(c)), c, float(cc.sat));
    return clamp(c, 0, 1);
  }

  /**
   * `csgo_environment`'s per-instance tint, one layer. Read off the game's own
   * shader (see cs3d-pack's classifyMaterial for the derivation):
   *
   *   mask   = saturate(((h.g - 0.5) * contrast + 0.5) * brightness)
   *   tn     = normalize(tint)                    hue only, unit length
   *   tinted = tn * min(luma(albedo) / luma(tn), 3 * luma(albedo) * max(tint))
   *   amount = g_flModelTintAmount * (1 - min(tint))
   *   out    = mix(albedo, tinted, amount * mask * g_bModelTint)
   *
   * The albedo is recoloured to the tint's hue at its OWN luminance; only a dark
   * tint pulls it darker, and then only to 3·luma·max(tint). Nothing here is a
   * multiply by the tint's brightness, which is what made every tinted surface
   * on Inferno too dark: terracotta plaster went blood-red, brown barrels went
   * near-black. The barrels also set g_bModelTint1 = 0 (tint off), and 37
   * Inferno vmats run amount 0; both were being tinted anyway.
   */
  _envTintLayer(albedo, tint, layer, maskNode, amount) {
    if (!layer || !layer.on) return albedo;
    const raw = maskNode ?? float(layer.const ?? 0.5);
    const mask = clamp(raw.sub(0.5).mul(float(layer.contrast)).add(0.5).mul(float(layer.bright)), 0, 1);
    const tn = normalize(max(tint, vec3(0.001)));
    const L = luminance(albedo);
    const hi = max(tint.x, max(tint.y, tint.z));
    const lo = min(tint.x, min(tint.y, tint.z));
    const tinted = tn.mul(min(L.div(luminance(tn)), L.mul(3).mul(hi)));
    const k = float(amount).mul(float(1).sub(lo)).mul(mask);
    return clamp(mix(albedo, tinted, k), 0, 1);
  }

  /**
   * A one-layer csgo_environment material: colour correction, then the
   * game's tint (per-texel, from COLOR_0.gba, masked by the height map's G).
   * The loader never sets a BatchedMesh colour for these, so this is the only
   * place the instance tint touches the surface.
   */
  _wireEnvSingle(mat, base, m, mask1) {
    if (!base) return;
    const src = texture(base, uv(0));
    let rgb = this._correct(src.rgb, m.cc1, m.avg);
    const et = m.envTint;
    if (et) {
      const maskNode = mask1 ? texture(mask1, uv(0)).r : null;
      rgb = this._envTintLayer(rgb, vertexColor().gba, et.l1, maskNode, et.amount);
    }
    mat.colorNode = vec4(rgb.mul(vec3(mat.color.r, mat.color.g, mat.color.b)), src.a);
  }

  _wireBlend(mat, base1, normal1, blend) {
    const uv0 = uv(0);
    const uv2 = uv0.mul(vec2(blend.scale2[0], blend.scale2[1]));
    const paint = vertexColor().r;
    const soft = Math.max(0.02, Math.min(0.95, blend.softness));
    let w = paint;
    if (blend.mod) {
      const m = texture(blend.mod, uv0);
      // G widens the transition where the artist wanted it soft; at its default
      // (1) this is just the vmat's own softness.
      const s = max(float(0.02), float(soft).mul(m.g.mul(2)));
      w = smoothstep(clamp(m.r.sub(s), 0, 1), clamp(m.r.add(s), 0, 1), paint);
    } else if (blend.heights) {
      const h = texture(blend.heights, uv0);
      // mask > 0.5 where layer 1 stands proud → needs more paint there.
      const mask = float(0.5).add(h.r.sub(h.g).mul(0.5));
      const s = float(soft);
      w = smoothstep(clamp(mask.sub(s), 0, 1), clamp(mask.add(s), 0, 1), paint);
    }
    const c1 = texture(base1, uv0);
    const c2 = texture(blend.base, uv2);
    // Each layer is corrected and tinted on its own, then the two are mixed:
    // that is the game's order, and it is what lets Inferno's "dirty" pass
    // (layer 2, tint-mask brightness 0.4) stay lightly tinted over plaster
    // that is fully tinted, exactly where the paint reveals it.
    let l1 = this._correct(c1.rgb, blend.cc1, blend.avg1);
    let l2 = this._correct(c2.rgb, blend.cc2, blend.avg2);
    const et = blend.envTint;
    if (et) {
      const tint = vertexColor().gba;
      l1 = this._envTintLayer(l1, tint, et.l1, blend.mask1 ? texture(blend.mask1, uv0).r : null, et.amount);
      l2 = this._envTintLayer(l2, tint, et.l2, blend.mask2 ? texture(blend.mask2, uv2).r : null, et.amount);
    }
    const rgb = mix(l1, l2, w);
    // Keep the material's own colour factor and layer 1's alpha for cut-outs.
    mat.colorNode = vec4(rgb.mul(vec3(mat.color.r, mat.color.g, mat.color.b)), c1.a);
    // For a non-environment blend with a dedicated tint mask, _wireTintMask
    // still runs after this and needs the same weight and layer-2 UV.
    mat._cs3dBlend = { w, uv2 };
    if (normal1 || blend.normal) {
      const n1 = normal1 ? texture(normal1, uv0) : vec4(0.5, 0.5, 1, 1);
      const n2 = blend.normal ? texture(blend.normal, uv2) : n1;
      mat.normalNode = normalMap(mix(n1, n2, w));
    }
  }

  dispose() {
    this.aborted = true;
    for (const t of this.textures) t?.dispose();
    this.lightmap?.texture.dispose();
    this.sun.mask?.dispose();
    for (const m of this.interim.values()) m.dispose();
    for (const m of this.final.values()) m.dispose();
    if (this.flat) for (const m of this.flat.values()) m.dispose();
  }
}
