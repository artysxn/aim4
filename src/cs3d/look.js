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

/**
 * The same starting knobs the explorer's grade panel applies after the pack
 * lands. Multipliers over the map's own sun / bake / sky, not absolutes.
 */
export function applyLookDefaults({ lighting, pack, knobs, slug }) {
  const perMap = MAP_LOOK[slug] || {};
  const sunMult = perMap.sun ?? LOOK_DEFAULTS.sun;
  const bakeMult = perMap.bake ?? LOOK_DEFAULTS.bake;
  const skyMult = perMap.sky ?? LOOK_DEFAULTS.sky;

  const sunBase = lighting?.sunIntensity ?? 1;
  const sunV = sunBase * sunMult;
  if (pack?.materials?.sun) pack.materials.sun.intensity.value = sunV;
  if (lighting?.sun) lighting.sun.intensity = sunV;

  if (pack?.materials?.lightmapIntensity) {
    const bakeBase = pack.materials.lightmapIntensity.value;
    pack.materials.lightmapIntensity.value = bakeBase * bakeMult;
  }

  const skyBase = lighting?.envIntensity ?? lighting?.scene?.environmentIntensity ?? 1;
  if (lighting?.scene) lighting.scene.environmentIntensity = skyBase * skyMult;

  if (knobs) {
    knobs.brightness.value = perMap.brightness ?? LOOK_DEFAULTS.brightness;
    knobs.contrast.value = perMap.contrast ?? LOOK_DEFAULTS.contrast;
    knobs.saturation.value = perMap.saturation ?? LOOK_DEFAULTS.saturation;
    knobs.vibrance.value = perMap.vibrance ?? LOOK_DEFAULTS.vibrance;
    knobs.lift.value = perMap.lift ?? LOOK_DEFAULTS.lift;
  }
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
