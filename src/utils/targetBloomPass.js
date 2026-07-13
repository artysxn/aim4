// ---------------------------------------------------------------------------
// targetBloomPass.js — selective mesh-layer bloom (targets + optional skybox).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BLOOM_LAYER, SKY_BLOOM_LAYER } from './bloomLayers.js';

const TARGET_STRENGTH = 1.05;
const TARGET_RADIUS = 0.42;
const SKY_STRENGTH = 0.75;
const SKY_RADIUS = 0.55;

const ADDITIVE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const ADDITIVE_FRAG = /* glsl */`
uniform sampler2D tBloom;
void main() {
  gl_FragColor = vec4(texture2D(tBloom, vUv).rgb, 1.0);
}
`;

export class TargetBloomPass {
  constructor(renderer, scene, camera) {
    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;
    this._targetBloom = false;
    this._skyBloom = false;
    this._targetComposer = null;
    this._skyComposer = null;
    this._blendScene = null;
    this._blendCamera = null;
    this._blendMat = null;
    this._bloomMats = new Map();
    this._swapped = [];
    this._layerMask = 0;
  }

  _ensureBlendPass() {
    if (this._blendScene) return;
    const geo = new THREE.PlaneGeometry(2, 2);
    this._blendMat = new THREE.ShaderMaterial({
      uniforms: { tBloom: { value: null } },
      vertexShader: ADDITIVE_VERT,
      fragmentShader: ADDITIVE_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    const quad = new THREE.Mesh(geo, this._blendMat);
    this._blendScene = new THREE.Scene();
    this._blendScene.add(quad);
    this._blendCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  _ensureComposer(which) {
    const size = new THREE.Vector2();
    this._renderer.getSize(size);
    if (which === 'target' && !this._targetComposer) {
      this._targetComposer = new EffectComposer(this._renderer);
      this._targetComposer.renderToScreen = false;
      this._targetComposer.addPass(new RenderPass(this._scene, this._camera));
      this._targetComposer.addPass(
        new UnrealBloomPass(size, TARGET_STRENGTH, TARGET_RADIUS, 0)
      );
    }
    if (which === 'sky' && !this._skyComposer) {
      this._skyComposer = new EffectComposer(this._renderer);
      this._skyComposer.renderToScreen = false;
      this._skyComposer.addPass(new RenderPass(this._scene, this._camera));
      this._skyComposer.addPass(
        new UnrealBloomPass(size, SKY_STRENGTH, SKY_RADIUS, 0)
      );
    }
  }

  setSize(width, height) {
    this._targetComposer?.setSize(width, height);
    this._skyComposer?.setSize(width, height);
    this._targetComposer?.passes[1]?.setSize(width, height);
    this._skyComposer?.passes[1]?.setSize(width, height);
  }

  setOptions({ targetBloom = false, skyBloom = false } = {}) {
    this._targetBloom = !!targetBloom;
    this._skyBloom = !!skyBloom;
    if (this._targetBloom) this._ensureComposer('target');
    if (this._skyBloom) this._ensureComposer('sky');
  }

  _pushLayer(layer) {
    this._layerMask = this._camera.layers.mask;
    this._camera.layers.set(layer);
  }

  _popLayer() {
    this._camera.layers.mask = this._layerMask;
  }

  _bloomMaterialFor(mesh) {
    const hex = mesh.userData._glowColor ?? mesh.material?.color?.getHex?.() ?? 0xffffff;
    const strength = mesh.userData._glowStrength ?? 1;
    const key = `${hex}_${strength.toFixed(3)}`;
    if (!this._bloomMats.has(key)) {
      const c = new THREE.Color(hex);
      if (strength < 0.999) c.multiplyScalar(strength);
      this._bloomMats.set(
        key,
        new THREE.MeshBasicMaterial({ color: c, toneMapped: false })
      );
    }
    return this._bloomMats.get(key);
  }

  _swapTargetBloomMaterials() {
    this._swapped.length = 0;
    this._scene.traverse((obj) => {
      if (!obj.isMesh || !obj.layers.test(BLOOM_LAYER)) return;
      this._swapped.push({ obj, mat: obj.material });
      obj.material = this._bloomMaterialFor(obj);
    });
  }

  _restoreSwappedMaterials() {
    for (const { obj, mat } of this._swapped) obj.material = mat;
    this._swapped.length = 0;
  }

  _compositeBloom(composer) {
    this._ensureBlendPass();
    this._blendMat.uniforms.tBloom.value = composer.readBuffer.texture;
    const prevAutoClear = this._renderer.autoClear;
    this._renderer.autoClear = false;
    this._renderer.render(this._blendScene, this._blendCamera);
    this._renderer.autoClear = prevAutoClear;
  }

  _renderLayerBloom(layer, composer, swapMaterials) {
    this._pushLayer(layer);
    if (swapMaterials) this._swapTargetBloomMaterials();
    composer.render();
    if (swapMaterials) this._restoreSwappedMaterials();
    this._popLayer();
    this._compositeBloom(composer);
  }

  render() {
    this._renderer.render(this._scene, this._camera);

    if (this._targetBloom && this._targetComposer) {
      this._renderLayerBloom(BLOOM_LAYER, this._targetComposer, true);
    }
    if (this._skyBloom && this._skyComposer) {
      this._renderLayerBloom(SKY_BLOOM_LAYER, this._skyComposer, false);
    }
  }
}
