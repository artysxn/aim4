// ---------------------------------------------------------------------------
// targetBloomPass.js — selective emissive bloom for dot-target glow.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const BLOOM_STRENGTH = 0.95;
const BLOOM_RADIUS = 0.38;
const BLOOM_THRESHOLD = 0.9;

export class TargetBloomPass {
  constructor(renderer, scene, camera) {
    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;
    this.enabled = false;
    this._composer = null;
    this._bloomPass = null;
  }

  _ensureComposer() {
    if (this._composer) return;
    const size = new THREE.Vector2();
    this._renderer.getSize(size);
    this._composer = new EffectComposer(this._renderer);
    this._composer.addPass(new RenderPass(this._scene, this._camera));
    this._bloomPass = new UnrealBloomPass(size, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this._composer.addPass(this._bloomPass);
  }

  setSize(width, height) {
    if (!this._composer) return;
    this._composer.setSize(width, height);
    this._bloomPass?.setSize(width, height);
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) this._ensureComposer();
  }

  render() {
    if (this.enabled && this._composer) {
      this._composer.render();
      return;
    }
    this._renderer.render(this._scene, this._camera);
  }
}
