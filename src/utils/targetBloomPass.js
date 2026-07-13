// ---------------------------------------------------------------------------
// targetBloomPass.js — UnrealBloom on mesh-masked passes (dot targets only).
// Base scene renders normally; bloom pass blacks out non-masked meshes, render
// masked meshes bright, blooms, then additively composites over the scene.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BLOOM_LAYER } from './bloomLayers.js';
import { resolveTargetGlowConfig } from './targetGlowConfig.js';

const BLACK_CLEAR = new THREE.Color(0x000000);

const ADDITIVE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const ADDITIVE_FRAG = /* glsl */`
uniform sampler2D tBloom;
uniform float uGain;
uniform float uGamma;
uniform float uCompositeThresh;
void main() {
  vec3 b = texture2D(tBloom, vUv).rgb;
  float lum = max(max(b.r, b.g), b.b);
  // Drop mask-pass black background; keep bloomed target energy.
  b *= smoothstep(uCompositeThresh, uCompositeThresh + 0.06, lum);
  b = pow(max(b, vec3(0.0)), vec3(uGamma)) * uGain;
  gl_FragColor = vec4(b, 1.0);
}
`;

export class TargetBloomPass {
  constructor(renderer, scene, camera) {
    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;
    this._targetBloom = false;
    this._glowConfig = resolveTargetGlowConfig();
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
      uniforms: {
        tBloom: { value: null },
        uGain: { value: this._glowConfig.compositeGain },
        uGamma: { value: this._glowConfig.bloomGamma },
        uCompositeThresh: { value: this._glowConfig.compositeThreshold }
      },
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

  _makeComposer() {
    const composer = new EffectComposer(this._renderer);
    composer.renderToScreen = false;
    composer.addPass(new RenderPass(this._scene, this._camera, null, BLACK_CLEAR, 1));
    const size = new THREE.Vector2();
    this._renderer.getSize(size);
    const bloomPass = new UnrealBloomPass(
      size,
      this._glowConfig.bloomStrength,
      this._glowConfig.bloomRadius,
      0
    );
    composer.addPass(bloomPass);
    composer.setPixelRatio(this._renderer.getPixelRatio());
    composer.bloomPass = bloomPass;
    return composer;
  }

  _ensureComposer() {
    if (!this._targetComposer) this._targetComposer = this._makeComposer();
  }

  _applyBloomParams() {
    const c = this._glowConfig;
    const bloomPass = this._targetComposer?.bloomPass;
    if (bloomPass) {
      bloomPass.strength = c.bloomStrength;
      bloomPass.radius = c.bloomRadius;
      bloomPass.threshold = 0;
      if (bloomPass.highPassUniforms?.luminosityThreshold) {
        bloomPass.highPassUniforms.luminosityThreshold.value = 0;
      }
    }
    if (this._blendMat) {
      this._blendMat.uniforms.uGain.value = c.compositeGain;
      this._blendMat.uniforms.uGamma.value = c.bloomGamma;
      this._blendMat.uniforms.uCompositeThresh.value = c.compositeThreshold;
    }
  }

  setSize(width, height) {
    if (!this._targetComposer) return;
    const pr = this._renderer.getPixelRatio();
    this._targetComposer.setSize(width, height);
    this._targetComposer.setPixelRatio(pr);
    this._targetComposer.bloomPass?.setSize(width * pr, height * pr);
  }

  setOptions({ targetBloom = false, glowConfig } = {}) {
    const next = resolveTargetGlowConfig(glowConfig ?? this._glowConfig);
    const changed = JSON.stringify(next) !== JSON.stringify(this._glowConfig);
    this._targetBloom = !!targetBloom;
    this._glowConfig = next;
    if (changed) this._bloomMats.clear();
    if (this._targetBloom) {
      this._ensureComposer();
      this._applyBloomParams();
      const size = new THREE.Vector2();
      this._renderer.getSize(size);
      this.setSize(size.x, size.y);
    }
  }

  _isBloomMesh(obj) {
    return obj.isMesh && obj.layers.isEnabled(BLOOM_LAYER);
  }

  _bloomMaterialFor(mesh) {
    const hex = mesh.userData._glowColor ?? mesh.material?.color?.getHex?.() ?? 0xffffff;
    const strength = mesh.userData._glowStrength ?? 1;
    const lift = this._glowConfig.bloomLift;
    const key = `${hex}_${strength.toFixed(3)}_${lift.toFixed(3)}`;
    if (!this._bloomMats.has(key)) {
      const c = new THREE.Color(hex);
      c.multiplyScalar(lift * strength);
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

  /** Final bloomed mask pass (targets + halos on black). */
  _bloomTexture() {
    return this._targetComposer.readBuffer.texture;
  }

  _compositeBloom() {
    this._ensureBlendPass();
    this._blendMat.uniforms.tBloom.value = this._bloomTexture();
    this._blendMat.uniforms.uGain.value = this._glowConfig.compositeGain;
    this._blendMat.uniforms.uGamma.value = this._glowConfig.bloomGamma;
    this._blendMat.uniforms.uCompositeThresh.value = this._glowConfig.compositeThreshold;
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
