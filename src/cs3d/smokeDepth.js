// ---------------------------------------------------------------------------
// src/cs3d/smokeDepth.js
// Linear view-Z of the world, in a colour target the smoke march can sample.
//
// CS2 clips the volume against the scene depth buffer so a cloud stops at a
// wall. This renderer cannot read its own depth: it is 4x MSAA, and a
// filtering sample of a depth texture invalidates the WebGPU command buffer
// (see spriteCard.js). So this pass redraws the map into a non-MSAA colour
// RT, writing `positionView.z` (positive, along the camera forward). The
// march compares its sample's view-Z to that and stops.
//
// Half resolution: the clip only needs to hide walls, and a full-res redraw
// of the map every throw was a hitch. The texture object is created once and
// never swapped (three r169 compiles the march against that sampler).
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { positionView, uniform, vec4 } from 'three/webgpu';

const FAR_Z = 1e5;
export const SMOKE_PASS_SCALE = 0.5;
const _size = new THREE.Vector2();
const _prevClear = new THREE.Color();
const _farClear = new THREE.Color(FAR_Z, FAR_Z, FAR_Z);

let _rt = null;
let _mat = null;

/** 1 while a capture ran this frame. The march treats 0 as "no geometry". */
export const smokeDepthLive = uniform(0);

export function smokePassSize(renderer) {
  renderer.getDrawingBufferSize(_size);
  return {
    w: Math.max(1, (_size.x * SMOKE_PASS_SCALE) | 0),
    h: Math.max(1, (_size.y * SMOKE_PASS_SCALE) | 0)
  };
}

function ensureRT() {
  if (_rt) return _rt;
  _rt = new THREE.RenderTarget(2, 2, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    samples: 0,
    depthBuffer: true,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false
  });
  _rt.texture.generateMipmaps = false;
  _rt.texture.minFilter = THREE.NearestFilter;
  _rt.texture.magFilter = THREE.NearestFilter;
  _mat = new THREE.NodeMaterial();
  const z = positionView.z.negate();
  _mat.colorNode = vec4(z, z, z, 1);
  _mat.side = THREE.DoubleSide;
  _mat.toneMapped = false;
  _mat.fog = false;
  _mat.transparent = false;
  _mat.depthWrite = true;
  _mat.depthTest = true;
  return _rt;
}

/** The colour target the march samples. Stable object, created on first call. */
export function smokeDepthTexture() {
  return ensureRT().texture;
}

/** No live smoke this frame: the march must not clip against last frame's walls. */
export function skipSmokeDepth() {
  smokeDepthLive.value = 0;
}

/**
 * Compile the view-Z override against the map's BatchedMeshes once, after the
 * pack is up, so the first grenade is not a 2s pipeline build.
 */
export async function prewarmSmokeDepth(renderer, scene, camera, hide = []) {
  ensureRT();
  const hidden = [];
  for (const o of hide) {
    if (o && o.visible) {
      hidden.push(o);
      o.visible = false;
    }
  }
  const prevMat = scene.overrideMaterial;
  scene.overrideMaterial = _mat;
  try {
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(scene, camera);
    }
  } catch (e) {
    console.warn('cs3d: smoke depth prewarm failed', e);
  } finally {
    scene.overrideMaterial = prevMat;
    for (const o of hidden) o.visible = true;
  }
}

/**
 * Draw the world (minus `hide`) into the depth target.
 *
 * @param {object[]} [hide]  the nade root (or the march clips on its own box)
 *   and the 3D sky / dome (or they fill the buffer with a far wall).
 */
export function captureSmokeDepth(renderer, scene, camera, hide = []) {
  const rt = ensureRT();
  const { w, h } = smokePassSize(renderer);
  if (rt.width !== w || rt.height !== h) rt.setSize(w, h);

  const hidden = [];
  for (const o of hide) {
    if (o && o.visible) {
      hidden.push(o);
      o.visible = false;
    }
  }

  const prevMat = scene.overrideMaterial;
  const prevFog = scene.fogNode;
  const prevBg = scene.background;
  const prevTarget = renderer.getRenderTarget();
  const prevAlpha = renderer.getClearAlpha();
  renderer.getClearColor(_prevClear);
  const prevTone = renderer.toneMapping;
  const prevAuto = renderer.autoClear;

  scene.overrideMaterial = _mat;
  scene.fogNode = null;
  scene.background = null;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = true;
  renderer.setClearColor(_farClear, 1);
  smokeDepthLive.value = 0;
  try {
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    smokeDepthLive.value = 1;
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(_prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.toneMapping = prevTone;
    scene.overrideMaterial = prevMat;
    scene.fogNode = prevFog;
    scene.background = prevBg;
    for (const o of hidden) o.visible = true;
  }
}
