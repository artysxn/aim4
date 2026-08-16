// ---------------------------------------------------------------------------
// src/cs3d/sky.js
// Lighting for a map, built from the map's own `light_environment` entity
// and its baked data:
//
//   1. The map's real skybox (scripts/cs3d-sky.mjs) as background, and,
//      prefiltered through PMREM, as `scene.environment`: the ambient for
//      everything that has no lightmap chart (props). A procedural dome
//      stands in until it loads, or for a pack without one.
//   2. The baked irradiance atlas (pack lightmap.webp) is the ambient for
//      world geometry — the materials read it themselves; this file only
//      owns the intensity knob and calibrates the sky probe to it, so a
//      prop standing on a lightmapped floor is lit like the floor.
//   3. A directional sun with an orthographic shadow camera that follows
//      the player.
//
// Absolute light levels differ 3× between maps (Anubis' sun is 6.35, Nuke's
// 2.4) and the game's tonemapper auto-exposes them away. So does this: the
// renderer's exposure is set from the sun and the atlas mean so a sunlit
// surface lands just above 1.0 before Khronos PBR Neutral compresses it.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { clamp, dot, max, mix, normalize, positionLocal, pow, uniform } from 'three/webgpu';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { MapFog } from './fog.js';

/** Half-width, in units, of the region the sun's shadow map covers. */
const SHADOW_EXTENT = 2200;
const _v = new THREE.Vector3();

const DOME_RADIUS = 40000;
/**
 * Where the atlas' brightest 2% (sunlit stone facing the sun) should land in
 * linear output before tonemapping. Just above 1: Neutral is linear to ~0.8
 * and rolls off gently after, so only the very brightest surfaces compress
 * and the sun/shade contrast the bake carries survives.
 */
const EXPOSURE_TARGET = 1.15;
/** Sun intensity = light_environment brightness × this. */
const SUN_SCALE = 1.0;
/**
 * Extra sun on top of what `light_environment` authored, applied to the lights
 * only and never to the exposure calibration (see below). Dialled in against
 * the game with the `sun x` slider: the bakes are indirect-only, so the maps
 * read flat and low-contrast outdoors at 1. Settled at 3, then raised to 5 —
 * 3 still read dim once the map colour grade was ruled out as a way to lift it.
 */
const SUN_BOOST = 5.0;
/** Ambient for lightmapped surfaces = baked irradiance × this. */
const LIGHTMAP_SCALE = 1.0;
/** Bounds on the sky-probe intensity when calibrating it to the atlas mean. */
const ENV_MIN = 0.15;
const ENV_MAX = 3.0;
/**
 * Where the visible sky should land in linear output after exposure, before
 * tonemapping. The world's exposure is set from the baked atlas, which says
 * nothing about how bright the sky above it was authored: Inferno's sky came
 * out at 0.15 that way, a dark teal lid over a normally lit map. So the sky is
 * calibrated separately, against its own measured brightness.
 */
const SKY_TARGET = 1.0;
/** How far the calibration is allowed to move the authored sky brightness. */
const SKY_GAIN_MIN = 0.5;
const SKY_GAIN_MAX = 6;

/**
 * The procedural sky, as a node material: a power curve from horizon to
 * zenith (much closer to a real sky than a linear ramp, which read as flat
 * grey paper), ground below, sun disc and halo on top.
 *
 * TSL rather than GLSL because the WebGPU backend cannot compile a raw
 * ShaderMaterial at all — it logs "Material ShaderMaterial is not
 * compatible" and draws nothing, which made both this dome and the ambient
 * probe built from it dead weight on the backend we actually ship.
 *
 * @param {{zenith, horizon, ground, sunColor, toSun: THREE.Vector3, sunSize: number}} o
 */
function makeDomeMaterial({ zenith, horizon, ground, sunColor, toSun, sunSize }) {
  const u = {
    zenith: uniform(zenith.clone()),
    horizon: uniform(horizon.clone()),
    ground: uniform(ground.clone()),
    sunColor: uniform(sunColor.clone()),
    // Direction TOWARD the sun.
    sunDir: uniform(toSun.clone()),
    sunSize: uniform(sunSize)
  };
  // The dome is a sphere centred on its own origin, so the local position is
  // the view direction.
  const d = normalize(positionLocal);
  const above = mix(u.horizon, u.zenith, pow(clamp(d.y, 0, 1), 0.42));
  // Below the horizon `above` is already the horizon colour, so one more mix
  // toward the ground covers both halves without a branch.
  const base = mix(above, u.ground, pow(clamp(d.y.mul(-3), 0, 1), 0.6));
  const c = max(dot(d, u.sunDir), 0);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = base.add(u.sunColor.mul(pow(c, u.sunSize).mul(14).add(pow(c, 8).mul(0.22))));
  mat.side = THREE.BackSide;
  mat.depthWrite = false;
  mat.fog = false;
  return { mat, u };
}

/** Push a colour toward saturation; the entity colours are washed out as authored. */
function saturate(c, amount) {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(hsl.h, Math.min(1, hsl.s * amount), hsl.l);
}

/** Relative luminance of a linear RGB triple. */
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Turn an equirect HDR by `rad` about the world up axis, in place.
 *
 * env_sky carries a yaw, and six of the ten maps set one — Inferno 245°,
 * Vertigo 247.5°, Overpass 125°, Ancient 65°, Anubis 270°, Train 47°. Ignore
 * it and the sun painted into the sky texture sits somewhere other than where
 * `light_environment` puts the real one, which reads as a scene lit from the
 * wrong side by a sky that does not match it.
 *
 * three has `Scene.backgroundRotation`/`environmentRotation` for exactly this,
 * but r169's WebGPU renderer never reads either — they are declared on Scene
 * and used nowhere in the backend. On an equirect a yaw is a horizontal wrap
 * of the pixels anyway, so this does it to the data, before PMREM sees it, and
 * the background and the probe both come out turned.
 */
function rotateEquirectYaw(tex, rad) {
  const img = tex.image;
  const data = img?.data;
  if (!data) return;
  const w = img.width;
  const h = img.height;
  const stride = data.length / (w * h);
  // sample(u) becomes original(u + rad/2π), i.e. the row slides by that many texels.
  let shift = Math.round((rad / (Math.PI * 2)) * w) % w;
  if (shift < 0) shift += w;
  if (!shift) return;
  const row = data.slice(0, w * stride);
  for (let y = 0; y < h; y++) {
    const base = y * w * stride;
    row.set(data.subarray(base, base + w * stride));
    for (let x = 0; x < w; x++) {
      const src = ((x + shift) % w) * stride;
      const dst = base + x * stride;
      for (let c = 0; c < stride; c++) data[dst + c] = row[src + c];
    }
  }
  tex.needsUpdate = true;
}

/**
 * What the sky looks like, from the RGBELoader's float/half data: the mean of
 * the upper hemisphere (what an upward-facing surface sees, which calibrates
 * the probe) plus the zenith and horizon bands, which are the two colours the
 * fog reads. All linear.
 */
function measureSky(tex) {
  const img = tex.image;
  const data = img?.data;
  if (!data) return null;
  const w = img.width;
  const h = img.height;
  const half = tex.type === THREE.HalfFloatType;
  const stride = data.length / (w * h);
  const step = Math.max(1, Math.floor(w / 256));
  const at = (o) => (half ? THREE.DataUtils.fromHalfFloat(data[o]) : data[o]);
  /** Solid-angle-weighted mean over the row range [y0, y1). */
  const band = (y0, y1) => {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sw = 0;
    for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1 | 0); y += step) {
      const wgt = Math.cos((0.5 - (y + 0.5) / h) * Math.PI);
      for (let x = 0; x < w; x += step) {
        const o = (y * w + x) * stride;
        sr += at(o) * wgt;
        sg += at(o + 1) * wgt;
        sb += at(o + 2) * wgt;
        sw += wgt;
      }
    }
    return sw ? new THREE.Color(sr / sw, sg / sw, sb / sw) : null;
  };
  // Row 0 is up (tools/cs3d-tex writes the cube out that way).
  const mean = band(0, h / 2);
  if (!mean) return null;
  return {
    mean: [mean.r, mean.g, mean.b],
    zenith: band(0, h * 0.2) || mean.clone(),
    // Straddling the horizon on purpose: it is the band that fills most of a
    // first-person view and the one distance haze takes its colour from.
    horizon: band(h * 0.4, h * 0.6) || mean.clone()
  };
}

export class MapLighting {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} manifest   pack manifest (sun, exposure, lightmap, skyBrightness)
   * @param {{shadows?: boolean, renderer?: THREE.WebGPURenderer}} opts
   */
  constructor(scene, camera, manifest, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = opts.renderer || null;
    this.manifest = manifest || {};
    const sun = this.manifest.sun;

    const sunColor = new THREE.Color(...(sun?.color || [1, 0.94, 0.85]));
    const skyRaw = new THREE.Color(...(sun?.skyColor || [0.51, 0.8, 1.0]));
    const dir = new THREE.Vector3(...(sun?.dir || [0.4, -0.7, 0.5])).normalize();
    // A sun that points up (a bad export could) still has to light something.
    if (dir.y > -0.05) dir.set(dir.x, -0.5, dir.z).normalize();
    this.sunDir = dir;
    this.toSun = dir.clone().multiplyScalar(-1);
    this.sunColor = sunColor;

    // The fallback dome only stands in until the map's own sky lands, and it
    // is also the first colour the fog reads, so it is a plausible sky rather
    // than a stylised one: 1.35× saturation here used to push a merely blue
    // skycolor into something poster-like.
    const zenith = saturate(skyRaw.clone(), 1.1).multiplyScalar(0.9);
    const horizon = skyRaw.clone().lerp(new THREE.Color(1, 1, 1), 0.62);
    const ground = new THREE.Color(0x554e42);

    // Map units throughout: the sun is the entity's brightness (it lights the
    // props; the world has it baked), the ambient is the bake, and exposure
    // reconciles them with the screen.
    this.brightness = Number.isFinite(sun?.brightness) ? sun.brightness : 3;
    const lm = this.manifest.lightmap;
    // Shade level: what a prop in the shade should get from the sky probe.
    // The atlas median is that (half the map is in shade on any sunny map);
    // without an atlas, a guess that puts shade around a third of sunlight.
    this.ambientLum = lm?.p50 ? lm.p50 : lm?.mean ? lum(...lm.mean) : Math.max(0.05, 0.11 * this.brightness);
    this.lightmapIntensity = LIGHTMAP_SCALE;
    /**
     * Whether the pack ships the sun's baked shadow mask. With it, the world
     * is lit the way the game lights it — the atlas is indirect, the sun is
     * analytic, `shadowmask.webp` says where it reaches — and the sun's
     * strength is `light_environment`'s own brightness, the same number the
     * dynamic sun over props uses, so world and props agree.
     *
     * Without it (a pack from before this existed) the old behaviour stands:
     * the atlas is treated as the whole story and the world gets no sun,
     * because a sun with no mask would light every surface equally, indoors
     * included.
     */
    this.bakedSun = !!this.manifest.shadowMask;
    const sunBase = this.bakedSun
      ? Math.max(0.2, this.brightness * SUN_SCALE)
      : lm?.p90 && lm?.p50
        ? Math.max(0.2, (Math.PI * (lm.p90 - lm.p50)) / 0.9)
        : Math.max(0.2, this.brightness * SUN_SCALE);
    // Exposure anchors on the brightest thing in the map: a surface facing the
    // unshadowed sun. In atlas units that is the indirect bright tail plus the
    // sun's own contribution (an irradiance, so ÷π to compare with the atlas).
    //
    // The pre-mask formula anchored on √(p90·p98) of the atlas alone, on the
    // assumption that its bright tail WAS sunlit stone. It is not — it is
    // bright bounce — so that anchor sat far too low and dragged everything,
    // the sky included, down with it.
    const sunAtlas = this.bakedSun ? (sunBase * lum(sunColor.r, sunColor.g, sunColor.b)) / Math.PI : 0;
    const brightLum = this.bakedSun
      ? (lm?.p90 ?? this.ambientLum) + sunAtlas
      : lm?.p98 && lm?.p90
        ? Math.sqrt(lm.p90 * lm.p98)
        : lm?.p98
          ? lm.p98
          : sunBase / Math.PI + this.ambientLum;
    this.exposure = Math.min(4, Math.max(0.15, EXPOSURE_TARGET / (0.9 * brightLum)));
    // The sun that actually lights the world is boosted past what the map
    // authored, and deliberately AFTER exposure is worked out, not before.
    // Exposure is calibrated against the map's own numbers — feeding it the
    // boosted sun would darken everything by the same factor and cancel the
    // change out. Applying it only to the lights widens the gap between what
    // the sun reaches and what it does not, which is the contrast the maps were
    // missing outdoors. This is exactly what the `sun ×` slider does.
    this.sunIntensity = sunBase * SUN_BOOST;
    if (this.renderer) this.renderer.toneMappingExposure = this.exposure;
    // Until the real sky is measured, the probe carries the same ambient
    // level as the bake (the procedural dome's zenith is roughly 1.0).
    this.envIntensity = Math.min(ENV_MAX, Math.max(ENV_MIN, this.ambientLum / 0.75));
    // The sky as the map authored it: env_sky's brightnessscale times the sky
    // material's own exposure bias (stops). It is only the starting point —
    // loadSkybox measures what the texture actually holds and corrects this
    // against SKY_TARGET, because the two numbers disagree wildly in practice
    // (Inferno authors 0.5 over a texture that is already dim).
    this.bgIntensity =
      (Number.isFinite(this.manifest.skyBrightness) ? this.manifest.skyBrightness : 1) *
      Math.pow(2, Number.isFinite(this.manifest.sky?.exposureBias) ? this.manifest.sky.exposureBias : 0);
    /** env_sky's yaw, in radians about scene up. */
    this.skyYaw = ((Number.isFinite(this.manifest.skyYaw) ? this.manifest.skyYaw : 0) * Math.PI) / 180;

    // ---- sky dome ----------------------------------------------------------
    this.domeMat = makeDomeMaterial({ zenith, horizon, ground, sunColor, toSun: this.toSun, sunSize: 900 }).mat;
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 40, 20), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    // ---- ambient: the sky itself, prefiltered -------------------------------
    if (this.renderer) this._buildEnvironment(zenith, horizon, ground, sunColor);
    else scene.add((this.hemi = new THREE.HemisphereLight(zenith, ground, 0.8)));

    // ---- sun ---------------------------------------------------------------
    // One directional light with an orthographic shadow camera that follows
    // the player. Cascaded shadow maps would be sharper, but the CSM addon
    // patches shaders through onBeforeCompile, which the WebGPU backend's node
    // materials never call — it silently does nothing there. One well-fitted
    // cascade is the honest version; with the baked lightmaps carrying the
    // ambient, the dynamic sun only has to get the contact shadows right.
    this.sun = new THREE.DirectionalLight(sunColor, this.sunIntensity);
    this.sun.position.set(0, 0, 0);
    scene.add(this.sun, this.sun.target);
    if (opts.shadows !== false) {
      this.sun.castShadow = true;
      const s = this.sun.shadow;
      s.mapSize.set(4096, 4096);
      s.camera.left = -SHADOW_EXTENT;
      s.camera.right = SHADOW_EXTENT;
      s.camera.top = SHADOW_EXTENT;
      s.camera.bottom = -SHADOW_EXTENT;
      s.camera.near = 1;
      s.camera.far = 2 * SHADOW_EXTENT + 6000;
      s.bias = -0.0006;
      s.normalBias = 2.5; // units
      s.camera.updateProjectionMatrix();
      // The map is static and the sun does not move: the shadow pass only
      // has to run again when the shadow volume has moved with the player or
      // the world has changed (tiles streaming in). That halves the CPU cost
      // of a frame; the pass draws the whole map otherwise.
      s.autoUpdate = false;
      s.needsUpdate = true;
    }
    this._shadowAt = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._shadowDirty = true;

    // ---- atmosphere ---------------------------------------------------------
    // The map's own env_cubemap_fog / env_gradient_fog (see fog.js). What was
    // here before — THREE.Fog from 9000 to 60000 units — never touched
    // anything: the largest of these maps is about 4500 units across, so
    // nothing was ever far enough away to pick up a single percent of it.
    this.fog = new MapFog(this.manifest);
    this.fog.setSky({ horizon, zenith, sunColor, toSun: this.toSun });
    if (this.fog.node) scene.fogNode = this.fog.node;
    scene.fog = null;
    this.update();
  }

  /**
   * Render the dome into a prefiltered cube map and hand it to the scene as
   * `environment`. One render, once; from then on it is free.
   */
  _buildEnvironment(zenith, horizon, ground, sunColor) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    // Its own material, not the dome's: a tight sun disc aliases badly once
    // prefiltered, so the probe's is widened.
    const { mat } = makeDomeMaterial({ zenith, horizon, ground, sunColor, toSun: this.toSun, sunSize: 60 });
    const probe = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat);
    envScene.add(probe);
    try {
      const rt = pmrem.fromScene(envScene, 0.04, 0.1, 100);
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = this.envIntensity;
      this.envRT = rt;
    } catch (e) {
      console.warn('cs3d: PMREM failed, falling back to hemisphere', e);
      this.scene.add((this.hemi = new THREE.HemisphereLight(zenith, ground, 0.8)));
    }
    probe.geometry.dispose();
    mat.dispose();
    pmrem.dispose();
  }

  /**
   * Swap the procedural dome for the map's real skybox (an equirect Radiance
   * image exported from the game by scripts/cs3d-sky.mjs). The same image
   * becomes the scene's environment, calibrated so its ambient matches the
   * baked atlas: props then sit in the same light as the floor under them.
   */
  async loadSkybox(base, sky, versionQuery = '') {
    const url = sky?.equirect;
    if (!url || !this.renderer) return false;
    const tex = await new Promise((resolve, reject) => {
      new RGBELoader().load(`${base}/${url}${versionQuery}`, resolve, undefined, reject);
    }).catch((e) => {
      console.warn('cs3d: skybox load failed, keeping procedural sky', e);
      return null;
    });
    if (!tex) return false;
    // Already resampled into scene axes by tools/cs3d-tex; env_sky's yaw is
    // the part that is left, and it is applied to the pixels before PMREM so
    // background and probe agree.
    if (this.skyYaw) rotateEquirectYaw(tex, this.skyYaw);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    this.skyTex = tex;

    const measured = measureSky(tex);
    if (measured) {
      const skyLum = Math.max(1e-3, lum(...measured.mean));
      // A white upward-facing surface under this probe gets radiance ≈ mean ×
      // intensity; make that the bake's mean.
      this.envIntensity = Math.min(ENV_MAX, Math.max(ENV_MIN, this.ambientLum / skyLum));
      // What the authored brightness would actually put on screen, and how far
      // off SKY_TARGET that is. Bounded, so a map that means to have a dim sky
      // keeps a dim one — it just stops being black.
      const onScreen = Math.max(1e-4, this.exposure * this.bgIntensity * skyLum);
      const gain = Math.min(SKY_GAIN_MAX, Math.max(SKY_GAIN_MIN, SKY_TARGET / onScreen));
      this.bgIntensity *= gain;
      // The haze is the sky, so it moves with it.
      this.fog?.setSky({
        horizon: measured.horizon.clone().multiplyScalar(this.bgIntensity),
        zenith: measured.zenith.clone().multiplyScalar(this.bgIntensity),
        // The sun lobe is already painted into the texture the horizon band
        // was measured from; a second one on top would double it.
        sunColor: new THREE.Color(0, 0, 0)
      });
    }

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = this.envIntensity;

    this.scene.background = tex;
    this.scene.backgroundIntensity = this.bgIntensity;
    this.dome.visible = false;
    this.hemi?.removeFromParent();
    this.hemi = null;
    return true;
  }

  /**
   * The sun as lightmapped world materials need it, or null when the pack has
   * no baked shadow mask (see `bakedSun`) and the world must stay on the atlas
   * alone. Same colour and strength as the dynamic sun over props, so a crate
   * and the ground it stands on are lit by one light.
   */
  worldSun() {
    if (!this.bakedSun) return null;
    return { toSun: this.toSun, color: this.sunColor, intensity: this.sunIntensity };
  }

  /** Kept for callers that patch materials per mesh; nothing to do here. */
  setupMaterial() {}

  /** The world changed (tiles arrived, a material got its textures): redraw the shadow map. */
  markShadowDirty() {
    this._shadowDirty = true;
  }

  update() {
    // Dome follows the camera so its horizon never drifts.
    this.dome.position.copy(this.camera.position);
    // Keep the shadow volume centred on the camera. It moves in 256-unit
    // steps (a fraction of its 4400-unit width) so the map is redrawn into
    // it only every so often, and the steps are whole texels so shadow
    // edges never crawl.
    if (this.sun) {
      const step = 256;
      const target = _v.copy(this.camera.position);
      target.x = Math.round(target.x / step) * step;
      target.y = Math.round(target.y / step) * step;
      target.z = Math.round(target.z / step) * step;
      if (!target.equals(this._shadowAt) || this._shadowDirty) {
        this._shadowAt.copy(target);
        this._shadowDirty = false;
        this.sun.target.position.copy(target);
        this.sun.position.copy(target).addScaledVector(this.sunDir, -(SHADOW_EXTENT + 3000));
        this.sun.target.updateMatrixWorld();
        this.sun.updateMatrixWorld();
        if (this.sun.castShadow) this.sun.shadow.needsUpdate = true;
      }
    }
  }

  resize() {}

  dispose() {
    this.envRT?.dispose();
    this.skyTex?.dispose();
    this.scene.environment = null;
    this.scene.background = null;
    this.scene.fogNode = null;
    this.dome.geometry.dispose();
    this.domeMat.dispose();
  }
}
