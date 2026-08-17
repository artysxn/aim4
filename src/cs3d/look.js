// ---------------------------------------------------------------------------
// src/cs3d/look.js
// The explorer's picture: colour grade, bloom, default light knobs, and the
// two-pass sky/world draw. The timeline 3D view and /<map> both go through
// this so a demo cannot drift from the map that already looks right.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { bloom, screenUV, texture } from 'three/webgpu';
import { installGrade, makeLut } from './grade.js';

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
 * The map's bloom, without giving up the two-pass depth clear.
 * Same contract as the explorer: HDR target, then composite.
 */
export function setupBloom(renderer, manifest, params = new URLSearchParams()) {
  const b = manifest.post?.bloom;
  const strength = b ? b.screenStrength || b.strength || 0 : 0;
  if (!(strength > 0) || params.get?.('bloom') === '0') {
    return { render: (draw) => draw(), resize() {}, enabled: false };
  }
  let sceneRT = null;
  let composite = null;
  try {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT = new THREE.RenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: renderer.samples
    });
    const src = texture(sceneRT.texture, screenUV);
    const bl = bloom(src, strength, b.computeRadius ?? 0, b.threshold ?? 1);
    composite = new THREE.PostProcessing(renderer, src.add(bl));
    composite.update();
    renderer.toneMapping = THREE.NoToneMapping;
  } catch (e) {
    console.warn('cs3d: bloom unavailable, rendering direct', e);
    sceneRT?.dispose?.();
    return { render: (draw) => draw(), resize() {}, enabled: false };
  }
  return {
    enabled: true,
    render(draw) {
      renderer.setRenderTarget(sceneRT);
      draw();
      renderer.setRenderTarget(null);
      composite.render();
    },
    resize() {
      const s = renderer.getDrawingBufferSize(new THREE.Vector2());
      sceneRT.setSize(Math.max(1, s.x), Math.max(1, s.y));
    }
  };
}

/**
 * Two passes: 3D skybox, depth clear, then the map.
 * Source draws the sky first and clears depth so the world wins wherever it
 * exists. A single render lets the skybox ground punch through the floor.
 */
export function drawSkyWorld(renderer, scene, camera, pack, lighting) {
  const sky = pack?.sky3d;
  const world = pack?.world;
  if (!sky || !world) {
    renderer.render(scene, camera);
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
  renderer.render(scene, camera);
  renderer.clearDepth();
  scene.fogNode = worldFog;

  world.visible = true;
  sky.visible = false;
  if (dome) dome.visible = false;
  if (shadow) shadow.needsUpdate = wantShadow;
  const background = scene.background;
  scene.background = null;
  renderer.autoClear = false;
  renderer.render(scene, camera);
  renderer.autoClear = true;
  scene.background = background;
  sky.visible = skyWas;
  if (dome) dome.visible = domeWas;
}

export function createMapRenderer({ renderer, scene, getPack, getLighting, bloom }) {
  const pass = bloom || { render: (draw) => draw(), resize() {} };
  return {
    render(camera) {
      pass.render(() => drawSkyWorld(renderer, scene, camera, getPack(), getLighting()));
    },
    resize() {
      pass.resize();
    }
  };
}
