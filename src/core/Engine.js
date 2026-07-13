// ---------------------------------------------------------------------------
// Engine.js
// Core Three.js setup: renderer, scene, camera, lights and the single
// requestAnimationFrame loop. Owns resolution / FOV logic so the rest of the
// app never touches the renderer directly.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { sourceVFovFromHFov, clamp } from '../utils/MathUtils.js';
import { getResolutionSpec } from './SettingsManager.js';
import { TargetBloomPass } from '../utils/targetBloomPass.js';
import { SkyboxManager } from '../sky/SkyboxManager.js';
import { defaultSkyboxId } from '../sky/skyboxCatalog.js';

export const EYE_HEIGHT = 1.6;

export class Engine {
  constructor(settings) {
    this.settings = settings;
    this.canvas = document.getElementById('game-canvas');
    this.zoomHFov = null; // scoped weapon override for the FOV setting (null = hipfire)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0a0a, 35, 110);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
    this.camera.rotation.order = 'YXZ'; // yaw (Y) then pitch (X) — FPS standard
    this.camera.position.set(0, EYE_HEIGHT, 0);

    this.clock = new THREE.Clock();
    this.onUpdate = null; // (dt) => void, set by main.js
    this.onError = null; // (error) => void, set by main.js
    this.lastError = null;
    this.player = null; // PlayerController, assigned by main.js
    this.deathFxEl = document.getElementById('death-fx');
    this._running = false;
    this.fps = 0;
    /** Optional (renderer, camera) => void — drawn after the main scene pass. */
    this.afterRender = null;

    this._setupLights();
    this._bloom = new TargetBloomPass(this.renderer, this.scene, this.camera);
    this._skybox = new SkyboxManager(this.scene);
    this.applyResolution();
    this.applyColors();
    this.applyPostProcessing();
    this.applySkybox();

    window.addEventListener('resize', () => this.applyResolution());
    settings.onChange(() => {
      this.applyResolution();
      this.applyColors();
      this.applyPostProcessing();
      this.applySkybox();
    });
  }

_setupLights() {
    // Neutral lights to ensure custom mesh colors render accurately
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(8, 18, 6);
    this.scene.add(dir);
    
    // Lowered intensity slightly to balance the brighter pure-white ambient color
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  }

  /**
   * Configure the backbuffer. Fixed resolutions render at their exact pixel
   * size (updateStyle = false) and the canvas is scaled to fill the viewport.
   * 4:3 stretched modes (1280×960, etc.) stretch horizontally on widescreen
   * displays — same as CS2 scaling mode "Stretched".
   *
   * FOV follows Source / CS2: the slider is horizontal FOV at 4:3; vertical
   * FOV stays fixed while widescreen gains horizontal coverage.
   */
  applyResolution() {
    const s = this.settings.activeSettings();
    const res = getResolutionSpec(s);
    const displayW = window.innerWidth;
    const displayH = window.innerHeight;
    let w, h, pixelRatio;

    if (res && res.size) {
      [w, h] = res.size;
      pixelRatio = 1; // exact backbuffer, no DPR multiplication
    } else {
      w = displayW;
      h = displayH;
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    }

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false); // false => do not write inline CSS size
    // Scale the backbuffer to the physical viewport (anisotropic when aspects differ).
    this.canvas.style.width = `${displayW}px`;
    this.canvas.style.height = `${displayH}px`;

    this.renderAspect = w / h;
    this.displayAspect = displayW / displayH;
    this.displayStretch = this.displayAspect / this.renderAspect;

    this.camera.aspect = this.renderAspect;
    this.camera.fov = sourceVFovFromHFov(this.zoomHFov ?? s.hFov);
    this.camera.updateProjectionMatrix();
    this._bloom?.setSize(w, h);
  }

  applyPostProcessing() {
    const s = this.settings.activeSettings();
    this._bloom?.setOptions({
      targetBloom: s.targetGlow === true,
      skyBloom: s.customSkybox === true && s.skyboxPostFx !== false
    });
  }

  /** @deprecated Use applyPostProcessing */
  applyTargetBloom() {
    this.applyPostProcessing();
  }

  applySkybox() {
    const s = this.settings.activeSettings();
    this._skybox?.apply({
      ...s,
      skyboxId: s.skyboxId || defaultSkyboxId()
    });
  }

  /** Scope zoom: override the horizontal FOV (null restores the user setting). */
  setZoomFov(hFov) {
    const next = hFov ?? null;
    if (this.zoomHFov === next) return;
    this.zoomHFov = next;
    this.applyResolution();
  }

  applyColors() {
    const s = this.settings.activeSettings();
    const bg = s.colors.bg;
    this.renderer.setClearColor(bg, 1);
    this.scene.fog.color.set(bg);
    if (this._skybox) {
      this._skybox.syncUniforms(s);
      this._skybox.syncPostFxLayer(s);
    }
  }

  resetCamera() {
    this.camera.position.set(0, EYE_HEIGHT, 0);
    this.camera.rotation.set(0, 0, 0);
    this.setDeathOverlay(0);
    if (this.player) this.player.reset();
  }

  /** Full-screen red tint for duels death (0 = off, 1 = full). */
  setDeathOverlay(strength) {
    if (!this.deathFxEl) return;
    const a = Math.max(0, Math.min(1, strength));
    this.deathFxEl.style.opacity = String(a);
  }

  /** Reset transient in-run visuals (death tint). */
  clearRunEffects() {
    this.setDeathOverlay(0);
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      requestAnimationFrame(loop);
      // Cap dt so a backgrounded tab doesn't produce a huge catch-up step.
      const dt = clamp(this.clock.getDelta(), 0, 0.05);
      if (dt > 0) {
        const instant = 1 / dt;
        this.fps = this.fps
          ? Math.round(this.fps * 0.88 + instant * 0.12)
          : Math.round(instant);
      }
      // Guard the per-frame update: a thrown error must never silently freeze
      // the screen. We surface it (once) and keep rendering so the game stays
      // responsive and the failure is diagnosable instead of a blank hang.
      try {
        if (this.onUpdate) this.onUpdate(dt);
      } catch (e) {
        if (!this.lastError) {
          console.error('[aim-trainer] error in update loop (rendering continues):', e);
          if (this.onError) this.onError(e);
        }
        this.lastError = e;
      }
      this._skybox?.update(this.camera);
      this._bloom.render();
      if (this.afterRender) this.afterRender(this.renderer, this.camera);
    };
    loop();
  }
}
