// ---------------------------------------------------------------------------
// targetBloomPass.js — UnrealBloom on mesh-masked passes (dot targets only).
// Base scene renders normally; bloom pass blacks out non-masked meshes, renders
// masked meshes bright, blooms, then additively composites the bloom halo only.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { UniformsUtils } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { BLOOM_LAYER } from './bloomLayers.js';

const TARGET_STRENGTH = 1.15;
const TARGET_RADIUS = 0.45;
const BLOOM_LIFT = 4.5;
const BLACK_CLEAR = new THREE.Color(0x000000);

export class TargetBloomPass {
  constructor(renderer, scene, camera) {
    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;
    this._targetBloom = false;
    this._targetComposer = null;
    this._blendScene = null;
    this._blendCamera = null;
    this._blendMat = null;
    this._darkMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      toneMapped: false,
      fog: false
    });
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

  _makeComposer() {
    const composer = new EffectComposer(this._renderer);
    composer.renderToScreen = false;
    composer.addPass(new RenderPass(this._scene, this._camera, null, BLACK_CLEAR, 1));
    const size = new THREE.Vector2();
    this._renderer.getSize(size);
    const bloomPass = new UnrealBloomPass(size, TARGET_STRENGTH, TARGET_RADIUS, 0);
    composer.addPass(bloomPass);
    composer.setPixelRatio(this._renderer.getPixelRatio());
    composer.bloomPass = bloomPass;
    return composer;
  }

  _ensureComposer() {
    if (!this._targetComposer) this._targetComposer = this._makeComposer();
  }

  setSize(width, height) {
    if (!this._targetComposer) return;
    const pr = this._renderer.getPixelRatio();
    this._targetComposer.setSize(width, height);
    this._targetComposer.setPixelRatio(pr);
    this._targetComposer.bloomPass?.setSize(width * pr, height * pr);
  }

  setOptions({ targetBloom = false } = {}) {
    this._targetBloom = !!targetBloom;
    if (this._targetBloom) this._ensureComposer();
  }

  _isBloomMesh(obj) {
    return obj.isMesh && obj.layers.isEnabled(BLOOM_LAYER);
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
        new THREE.MeshBasicMaterial({ color: c, toneMapped: false, fog: false })
      );
    }
    return this._bloomMats.get(key);
  }

  _maskScene() {
    this._swapped.length = 0;
    this._scene.traverse((obj) => {
      if (obj.isLine || obj.isLineSegments || obj.isPoints || obj.isSprite) {
        this._swapped.push({ obj, vis: obj.visible, kind: 'vis' });
        obj.visible = false;
        return;
      }
      if (!obj.isMesh) return;
      this._swapped.push({ obj, mat: obj.material, kind: 'mat' });
      obj.material = this._isBloomMesh(obj)
        ? this._bloomMaterialFor(obj)
        : this._darkMat;
    });
  }

  _restoreScene() {
    for (const item of this._swapped) {
      if (item.kind === 'vis') item.obj.visible = item.vis;
      else item.obj.material = item.mat;
    }
    this._swapped.length = 0;
  }

  _bloomTexture() {
    // readBuffer holds the masked bloom image after UnrealBloomPass (full resolution).
    return this._targetComposer.readBuffer.texture;
  }

  _compositeBloom() {
    this._ensureBlendPass();
    this._blendMat.uniforms.tDiffuse.value = this._bloomTexture();
    const prevRT = this._renderer.getRenderTarget();
    const prevAutoClear = this._renderer.autoClear;
    this._renderer.setRenderTarget(null);
    this._renderer.autoClear = false;
    this._renderer.render(this._blendScene, this._blendCamera);
    this._renderer.autoClear = prevAutoClear;
    this._renderer.setRenderTarget(prevRT);
  }

  _renderTargetBloom() {
    this._maskScene();
    const prevFog = this._scene.fog;
    this._scene.fog = null;
    this._targetComposer.render();
    this._scene.fog = prevFog;
    this._restoreScene();
    this._compositeBloom();
  }

  render() {
    this._renderer.render(this._scene, this._camera);
    if (this._targetBloom && this._targetComposer) this._renderTargetBloom();
  }
}
