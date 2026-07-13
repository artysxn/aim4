// ---------------------------------------------------------------------------
// targetBloomPass.js — UnrealBloom on mesh-masked passes (not scene luminance).
// Base scene renders normally; bloom passes black out non-masked meshes, render
// masked meshes bright, bloom, then additively composite the bloom halo only.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { UniformsUtils } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { BLOOM_LAYER, SKY_BLOOM_LAYER } from './bloomLayers.js';

const TARGET_STRENGTH = 1.15;
const TARGET_RADIUS = 0.45;
const SKY_STRENGTH = 0.85;
const SKY_RADIUS = 0.5;
const BLOOM_LIFT = 4.5;

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
    this._darkMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
    this._bloomMats = new Map();
    this._swapped = [];
  }

  _ensureBlendPass() {
    if (this._blendScene) return;
    const geo = new THREE.PlaneGeometry(2, 2);
    this._blendMat = new THREE.ShaderMaterial({
      uniforms: UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
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

  _makeComposer(strength, radius) {
    const composer = new EffectComposer(this._renderer);
    composer.renderToScreen = false;
    composer.addPass(new RenderPass(this._scene, this._camera));
    const size = new THREE.Vector2();
    this._renderer.getSize(size);
    const bloomPass = new UnrealBloomPass(size, strength, radius, 0);
    composer.addPass(bloomPass);
    composer.setPixelRatio(this._renderer.getPixelRatio());
    composer.bloomPass = bloomPass;
    return composer;
  }

  _ensureComposer(which) {
    if (which === 'target' && !this._targetComposer) {
      this._targetComposer = this._makeComposer(TARGET_STRENGTH, TARGET_RADIUS);
    }
    if (which === 'sky' && !this._skyComposer) {
      this._skyComposer = this._makeComposer(SKY_STRENGTH, SKY_RADIUS);
    }
  }

  setSize(width, height) {
    const pr = this._renderer.getPixelRatio();
    for (const composer of [this._targetComposer, this._skyComposer]) {
      if (!composer) continue;
      composer.setSize(width, height);
      composer.setPixelRatio(pr);
      composer.bloomPass?.setSize(width * pr, height * pr);
    }
  }

  setOptions({ targetBloom = false, skyBloom = false } = {}) {
    this._targetBloom = !!targetBloom;
    this._skyBloom = !!skyBloom;
    if (this._targetBloom) this._ensureComposer('target');
    if (this._skyBloom) this._ensureComposer('sky');
  }

  _isBloomMesh(obj, layer) {
    return obj.isMesh && obj.layers.test(layer);
  }

  _bloomMaterialFor(mesh) {
    const hex = mesh.userData._glowColor ?? mesh.material?.color?.getHex?.() ?? 0xffffff;
    const strength = mesh.userData._glowStrength ?? 1;
    const key = `${hex}_${strength.toFixed(3)}`;
    if (!this._bloomMats.has(key)) {
      const c = new THREE.Color(hex);
      c.multiplyScalar(BLOOM_LIFT * strength);
      this._bloomMats.set(
        key,
        new THREE.MeshBasicMaterial({ color: c, toneMapped: false })
      );
    }
    return this._bloomMats.get(key);
  }

  _maskScene(layer, keepBloomMaterial = false) {
    this._swapped.length = 0;
    this._scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      this._swapped.push({ obj, mat: obj.material });
      if (this._isBloomMesh(obj, layer)) {
        if (!keepBloomMaterial) obj.material = this._bloomMaterialFor(obj);
      } else {
        obj.material = this._darkMat;
      }
    });
  }

  _restoreScene() {
    for (const { obj, mat } of this._swapped) obj.material = mat;
    this._swapped.length = 0;
  }

  /** Bloom-only mip composite from UnrealBloomPass (not the masked scene buffer). */
  _bloomTexture(composer) {
    return composer.bloomPass.renderTargetsHorizontal[0].texture;
  }

  _compositeBloom(composer) {
    this._ensureBlendPass();
    this._blendMat.uniforms.tDiffuse.value = this._bloomTexture(composer);
    const prevRT = this._renderer.getRenderTarget();
    const prevAutoClear = this._renderer.autoClear;
    this._renderer.setRenderTarget(null);
    this._renderer.autoClear = false;
    this._renderer.render(this._blendScene, this._blendCamera);
    this._renderer.autoClear = prevAutoClear;
    this._renderer.setRenderTarget(prevRT);
  }

  _renderMaskedBloom(layer, composer, keepBloomMaterial = false) {
    this._maskScene(layer, keepBloomMaterial);
    composer.render();
    this._restoreScene();
    this._compositeBloom(composer);
  }

  render() {
    this._renderer.render(this._scene, this._camera);

    if (this._targetBloom && this._targetComposer) {
      this._renderMaskedBloom(BLOOM_LAYER, this._targetComposer, false);
    }
    if (this._skyBloom && this._skyComposer) {
      this._renderMaskedBloom(SKY_BLOOM_LAYER, this._skyComposer, true);
    }
  }
}
