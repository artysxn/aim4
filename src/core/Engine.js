// ---------------------------------------------------------------------------
// Engine.js
// Core Three.js setup: renderer, scene, camera, lights and the single
// requestAnimationFrame loop. Owns resolution / FOV logic so the rest of the
// app never touches the renderer directly.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { hFovToVFov, clamp } from '../utils/MathUtils.js';
import { RESOLUTIONS } from './SettingsManager.js';

export const EYE_HEIGHT = 1.6;

export class Engine {
  constructor(settings) {
    this.settings = settings;
    this.canvas = document.getElementById('game-canvas');

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

    this._setupLights();
    this.applyResolution();
    this.applyColors();

    window.addEventListener('resize', () => this.applyResolution());
    settings.onChange(() => { this.applyResolution(); this.applyColors(); });
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
   * Configure the backbuffer. For fixed resolutions we render at the exact
   * pixel size (updateStyle = false) and let CSS stretch the canvas to fill
   * the viewport — exactly like hardware scaling in competitive shooters.
   * Horizontal FOV is held constant regardless of the resulting aspect.
   */
  applyResolution() {
    const res = RESOLUTIONS[this.settings.data.resolution];
    let w, h, pixelRatio;

    if (res && res.size) {
      [w, h] = res.size;
      pixelRatio = 1; // exact backbuffer, no DPR multiplication
    } else {
      w = window.innerWidth;
      h = window.innerHeight;
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    }

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false); // false => do not write inline CSS size
    // CSS forces the canvas to fill the viewport (stretch).
    this.canvas.style.width = '100vw';
    this.canvas.style.height = '100vh';

    this.renderAspect = w / h;
    this.camera.aspect = this.renderAspect;
    this.camera.fov = hFovToVFov(this.settings.data.hFov, this.renderAspect);
    this.camera.updateProjectionMatrix();
  }

  applyColors() {
    const bg = this.settings.data.colors.bg;
    this.renderer.setClearColor(bg, 1);
    this.scene.fog.color.set(bg);
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
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
}
