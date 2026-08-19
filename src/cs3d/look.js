// ---------------------------------------------------------------------------
// src/cs3d/look.js
// The explorer's picture: colour grade, bloom, default light knobs, and the
// two-pass sky/world draw. The timeline 3D view and /<map> both go through
// this so a demo cannot drift from the map that already looks right.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { bloom, screenUV, texture } from 'three/webgpu';
import { installGrade, makeLut } from './grade.js';
import { mapBloomParams } from './lookBloom.js';

export { mapBloomParams };

export const LOOK_DEFAULTS = {
  sun: 5,
  bake: 0.9,
  sky: 0.1,
  brightness: 1,
  contrast: 1.12,
  saturation: 1.14,
  vibrance: 0.1,
  lift: 0.004
};

export const MAP_LOOK = {
  anubis: { bake: 2 }
};

export async function loadPostLut(pack, manifest) {
  if (!manifest.post?.lut || !manifest.post.lutDim) return null;
  try {
    const res = await fetch(`${pack.base}/${manifest.post.lut}${pack.v}`);
    if (!res.ok) return null;
    return { lut: makeLut(await res.arrayBuffer(), manifest.post.lutDim), dim: manifest.post.lutDim };
  } catch (e) {
    console.warn('cs3d: colour grade failed to load', e);
    return null;
  }
}

export function installMapGrade(renderer, params, post) {
  return installGrade(renderer, params, post);
}

/** The knobs that are lights (applied to the scene) rather than grade (uniforms). */
export const LIGHT_KEYS = new Set(['sun', 'bake', 'sky']);

/**
 * The look, as one object both entry points drive — the explorer's grade
 * panel and the timeline's 3D view — so the two can never render a map
 * differently. Same knobs, same semantics, same order of application.
 *
 * The semantics are the explorer's, exactly as it has always applied them,
 * because that is the picture the maps were dialled against:
 *
 *   sun    ABSOLUTE intensity, written to both the world's analytic sun (the
 *          lightmapped materials' uniform) and the props' DirectionalLight.
 *          The map's own `MapLighting.sunIntensity` (brightness × SUN_BOOST)
 *          is only the value they start at; the look replaces it. The panel
 *          labels this "sun ×" and its slider ends at 5 — as a multiplier
 *          over sunIntensity (~60 on Nuke) 5 would be 300, a white-out, and
 *          that is precisely the bug an earlier "faithful" reading produced.
 *   sky    ABSOLUTE `scene.environmentIntensity`; likewise replaces the value
 *          MapLighting works out (and works out again when the real skybox
 *          lands — hence `apply('sky')` after loadSkybox).
 *   bake   a MULTIPLIER over the material library's own lightmap intensity,
 *          cached the first time the library exists.
 *   brightness / contrast / saturation / vibrance / lift
 *          the grade uniforms (installGrade), written straight through.
 *
 * `set` before the pack or the lighting exist is fine: the value is kept and
 * `applyAll()` after `pack.load()` writes everything that has something to
 * land on. Same as the explorer's setupGradePanel-then-reapplyLight dance.
 */
export function createLook({ scene, getPack, getLighting, slug, knobs = null }) {
  const values = { ...LOOK_DEFAULTS, ...(MAP_LOOK[slug] || {}) };
  let bakeBase = null;
  let bakeLib = null;

  function apply(key) {
    const v = values[key];
    if (v === undefined) return;
    const pack = getPack?.();
    const lighting = getLighting?.();
    const mats = pack?.materials;
    if (key === 'sun') {
      if (mats?.sun) mats.sun.intensity.value = v;
      if (lighting?.sun) lighting.sun.intensity = v;
    } else if (key === 'bake') {
      if (!mats?.lightmapIntensity) return;
      // A new library (re-pack, re-mount) starts from its own value again.
      if (bakeLib !== mats) {
        bakeLib = mats;
        bakeBase = mats.lightmapIntensity.value;
      }
      mats.lightmapIntensity.value = bakeBase * v;
    } else if (key === 'sky') {
      if (scene) scene.environmentIntensity = v;
    } else if (knobs?.[key]) {
      knobs[key].value = v;
    }
  }

  return {
    values,
    /** The grade uniforms, once installGrade has made them. */
    setKnobs(k) {
      knobs = k;
    },
    /** Change one knob and apply it (no-op on targets that do not exist yet). */
    set(key, value) {
      values[key] = value;
      apply(key);
    },
    apply,
    /** Everything, in one order: lights first, then the grade. */
    applyAll() {
      for (const k of LIGHT_KEYS) apply(k);
      for (const k of Object.keys(values)) if (!LIGHT_KEYS.has(k)) apply(k);
    }
  };
}

/**
 * Effects bloom: the glow on fire and on a blast.
 *
 * Separate from the map's own bloom on purpose, because the map's is not up to
 * the job. Its strength comes out of the post-processing volume and describes a
 * SCREEN blend in CS2's compositor, not an add in three's; on Nuke it is 0.0112,
 * which is nothing, and a molotov drawn through it does not glow at all. The
 * threshold here is well above anything the world reaches in linear HDR — the
 * scene renders unmapped into the target, so ordinary lit surfaces sit under 1
 * and only the sun's disc and the effects' deliberate overbright go past 3 —
 * and nadeEffects writes fire and the HE flash far above it.
 *
 * `?fxbloom=` scales it, `?fxbloom=0` turns it off.
 */
const FX_BLOOM = { strength: 0.85, radius: 0.8, threshold: 3 };

/**
 * The map's bloom, without giving up the two-pass depth clear.
 * Same contract as the explorer: HDR target, then composite.
 * Strength/threshold mapping lives in lookBloom.js (CS2 LDR add vs compute).
 */
export function setupBloom(renderer, manifest, params = new URLSearchParams()) {
  const b = manifest.post?.bloom;
  const { strength, radius, threshold } = mapBloomParams(b);
  const fxRaw = params.get?.('fxbloom');
  const fxScale = fxRaw === null || fxRaw === undefined || fxRaw === '' ? 1 : Math.max(0, Number(fxRaw) || 0);
  const bloomOff = params.get?.('bloom') === '0';
  const mapStrength = strength;
  const fxStrength = FX_BLOOM.strength * fxScale;
  // Nothing to composite with every term at zero. The smoke no longer needs
  // this pass — it is ordinary scene geometry now (src/cs3d/smokeCards.js).
  const noop = { render: (draw) => draw(), resize() {}, enabled: false, setActive() {}, get active() { return false; } };
  if (!(mapStrength > 0) && !(fxStrength > 0)) return noop;
  let sceneRT = null;
  let composite = null;
  let bloomOut = null;
  let copyOut = null;
  try {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT = new THREE.RenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: renderer.samples
    });
    const src = texture(sceneRT.texture, screenUV);
    copyOut = src;
    bloomOut = src;
    if (mapStrength > 0) bloomOut = bloomOut.add(bloom(src, mapStrength, radius, threshold));
    if (fxStrength > 0) bloomOut = bloomOut.add(bloom(src, fxStrength, FX_BLOOM.radius, FX_BLOOM.threshold));
    composite = new THREE.PostProcessing(renderer, bloomOff ? copyOut : bloomOut);
    composite.update();
    renderer.toneMapping = THREE.NoToneMapping;
  } catch (e) {
    console.warn('cs3d: bloom unavailable, rendering direct', e);
    sceneRT?.dispose?.();
    return { render: (draw) => draw(), resize() {}, enabled: false, setActive() {}, get active() { return false; } };
  }
  let active = !bloomOff;
  const pass = {
    enabled: true,
    get active() {
      return active;
    },
    setActive(on) {
      on = !!on;
      if (on === active) return;
      active = on;
      // Same HDR target and the same NoToneMapping the world materials were
      // built with. Switching renderer.toneMapping recompiles every map
      // material and on WebGPU that invalidates the pass (black screen).
      composite.outputNode = active ? bloomOut : copyOut;
      composite.needsUpdate = true;
    },
    render(draw, stamp) {
      renderer.setRenderTarget(sceneRT);
      draw();
      const t = stamp ? performance.now() : 0;
      renderer.setRenderTarget(null);
      composite.render();
      if (stamp) stamp.bloom = active ? performance.now() - t : 0;
    },
    resize() {
      const s = renderer.getDrawingBufferSize(new THREE.Vector2());
      sceneRT.setSize(Math.max(1, s.x), Math.max(1, s.y));
    }
  };
  return pass;
}

/**
 * Two passes: 3D skybox, depth clear, then the map.
 * Source draws the sky first and clears depth so the world wins wherever it
 * exists. A single render lets the skybox ground punch through the floor.
 *
 * `twoPass: false` hides the 3D skybox for this frame and draws once, so the
 * equirect / dome is the sky. That is `r_skypass 0`.
 */
export function drawSkyWorld(renderer, scene, camera, pack, lighting, opts = {}) {
  const sky = pack?.sky3d;
  const world = pack?.world;
  const twoPass = opts.twoPass !== false;
  const stamp = opts.stamp;
  const mark = (name, fn) => {
    if (!stamp) return fn();
    const t = performance.now();
    fn();
    stamp[name] = performance.now() - t;
  };
  if (!sky || !world || !twoPass) {
    const skyWas = sky ? sky.visible : null;
    if (sky && !twoPass) sky.visible = false;
    mark('world', () => renderer.render(scene, camera));
    if (stamp) stamp.sky = 0;
    if (sky && skyWas !== null) sky.visible = skyWas;
    return;
  }
  const dome = lighting?.dome || null;
  const shadow = lighting?.sun?.castShadow ? lighting.sun.shadow : null;
  const wantShadow = shadow ? shadow.needsUpdate : false;
  if (shadow) shadow.needsUpdate = false;
  const skyWas = sky.visible;
  const domeWas = dome ? dome.visible : false;
  const worldFog = scene.fogNode;
  const skyFog = lighting?.fog?.skyNode || worldFog;

  world.visible = false;
  scene.fogNode = skyFog;
  mark('sky', () => {
    renderer.render(scene, camera);
    renderer.clearDepth();
  });
  scene.fogNode = worldFog;

  world.visible = true;
  sky.visible = false;
  if (dome) dome.visible = false;
  if (shadow) shadow.needsUpdate = wantShadow;
  const background = scene.background;
  scene.background = null;
  renderer.autoClear = false;
  mark('world', () => renderer.render(scene, camera));
  renderer.autoClear = true;
  scene.background = background;
  sky.visible = skyWas;
  if (dome) dome.visible = domeWas;
}

/**
 * @param {object} o
 * @param {() => void} [o.overlay]  drawn last, INSIDE the scene pass: the
 *   viewmodel, and anything else that wants its own camera over the world.
 *
 * Inside, not after. With bloom on, `pass.render` draws the world into an HDR
 * target and then composites it to the canvas; a `renderer.render()` issued
 * after that composite does not draw over it, it REPLACES the frame — the map
 * vanishes and only the overlay is left. (Without bloom the same call works,
 * which is why the explorer's viewmodel looked fine on some maps and blacked
 * the screen on the ones whose post-processing volume asks for bloom.) Drawn
 * here it lands in the same target as the world, so it takes the map's tone
 * mapping, grade and bloom with everything else, which is also what it should
 * have been doing all along.
 */
export function createMapRenderer({
  renderer,
  scene,
  getPack,
  getLighting,
  bloom,
  overlay,
  overlayAfter = false,
  afterComposite,
  getTwoPass,
  stamp
}) {
  const fallback = { render: (draw) => draw(), resize() {} };
  let told = false;
  const drawOverlay = () => {
    if (!overlay) return;
    const t = stamp ? performance.now() : 0;
    const drew = overlay();
    if (stamp) stamp.vm = performance.now() - t;
    if (!told) {
      told = true;
      console.log(`cs3d: overlay pass ran ${overlayAfter ? 'AFTER the composite (?vm=after)' : 'inside the scene pass'}${drew === false ? ' — nothing to draw' : ''}`);
    }
  };
  return {
    render(camera) {
      const pass = (typeof bloom === 'function' ? bloom() : bloom) || fallback;
      pass.render(() => {
        drawSkyWorld(renderer, scene, camera, getPack(), getLighting(), {
          twoPass: getTwoPass ? getTwoPass() : true,
          stamp
        });
        if (!overlayAfter) drawOverlay();
      }, stamp);
      // `?vm=after` puts it back where it was before the bloom fix: on the
      // canvas, after the composite. That path draws the viewmodel and wipes
      // the map, so it is a diagnostic and not a mode — if the gun appears
      // here and not inside the pass, the depth clear inside the HDR target is
      // what to look at next.
      if (overlayAfter) drawOverlay();
      afterComposite?.(camera);
    },
    resize() {
      const pass = (typeof bloom === 'function' ? bloom() : bloom) || fallback;
      pass.resize();
    }
  };
}
