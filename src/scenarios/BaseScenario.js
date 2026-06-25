// ---------------------------------------------------------------------------
// BaseScenario.js
// Abstract scenario: owns the metric counters (score, shots, hits, headshots,
// kills, misses), the run timer, target list, raycasting against targets and
// the standard lifecycle (start / pause / resume / update / shoot / dispose).
// Concrete scenarios override the onStart / onUpdate / onShoot hooks.
//
// Shared THREE.Raycaster / Vector2 instances are reused across all shots to
// avoid per-shot allocation and GC churn.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { shotSpreadRad, spreadRng, applySpreadToRay } from '../utils/shotAccuracy.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0); // crosshair is always screen center

// --- Tiny WebAudio blip used for hit feedback (lazily created) -------------
let _audioCtx = null;
export function beep(freq = 700, dur = 0.05, type = 'square', gain = 0.05) {
  try {
    if (!_audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _audioCtx = new AC();
    }
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(g);
    g.connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur);
  } catch (e) {
    /* ignore audio failures */
  }
}

export class BaseScenario {
  constructor({ engine, settings, config = {}, crosshair = null }) {
    this.engine = engine;
    this.scene = engine.scene;
    this.camera = engine.camera;
    this.settings = settings;
    this.config = config;
    this.crosshair = crosshair;

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.targets = [];

    // Metrics
    this.score = 0;
    this.shotsFired = 0;
    this.hits = 0;
    this.headshots = 0;
    this.kills = 0;
    this.misses = 0; // expired / escaped targets

    this.elapsed = 0; // seconds, accumulates only while running
    this.running = false;
  }

  // ---- Identity / derived metrics ----------------------------------------
  get name() {
    return 'base';
  }
  get accuracy() {
    return this.shotsFired ? this.hits / this.shotsFired : 0;
  }
  get critRatio() {
    return this.hits ? this.headshots / this.hits : 0;
  }
  get kps() {
    return this.elapsed > 0 ? this.kills / this.elapsed : 0;
  }
  configKey() {
    return 'default';
  }

  // ---- Lifecycle ----------------------------------------------------------
  start() {
    this.running = true;
    this.onStart();
  }
  pause() {
    this.running = false;
  }
  resume() {
    this.running = true;
  }

  update(dt) {
    if (!this.running) return;
    this.elapsed += dt;
    // Player movement (no-op unless a scenario enabled the controller).
    if (this.engine.player) this.engine.player.update(dt);
    // Advance + reap targets.
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      t.update(dt);
      if (!t.alive) this._removeTargetAt(i);
    }
    this.onUpdate(dt);
  }

  shoot() {
    if (!this.running) return;
    this.shotsFired++;
    this.engine.audio?.playLocalShot();
    _raycaster.setFromCamera(_center, this.camera);

    const player = this.engine.player;
    if (player?.enabled) {
      const state = player.getAccuracyState();
      const seed = (Math.random() * 0xffffffff) >>> 0;
      const spread = shotSpreadRad(state);
      const aim = _raycaster.ray.direction.clone();
      applySpreadToRay(_raycaster.ray, spread, spreadRng(seed));
      this._lastShotAccuracy = {
        seed,
        onGround: state.onGround,
        speedHoriz: state.speedHoriz,
        aimDx: aim.x,
        aimDy: aim.y,
        aimDz: aim.z
      };
    } else {
      this._lastShotAccuracy = null;
    }

    this.onShoot(_raycaster);
  }

  // ---- Target management --------------------------------------------------
  addTarget(target) {
    this.targets.push(target);
    this.root.add(target.object);
  }

  _removeTargetAt(i) {
    const t = this.targets[i];
    this.root.remove(t.object);
    t.dispose();
    this.targets.splice(i, 1);
  }

  /** All colliders of targets that are still hittable (not mid-death). */
  activeColliders() {
    const arr = [];
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      for (const c of t.getColliders()) arr.push(c);
    }
    return arr;
  }

  raycastTargets(raycaster, extra = []) {
    const objects = this.activeColliders().concat(extra);
    const hits = raycaster.intersectObjects(objects, false);
    return hits.length ? hits[0] : null;
  }

  /** World positions for off-screen threat chevrons (multiplayer duels only). */
  getThreats() {
    return [];
  }

  results() {
    const timePlayed = this.elapsed;
    return {
      scenario: this.name,
      configKey: this.configKey(),
      score: Math.round(this.score),
      accuracy: this.accuracy,
      critRatio: this.critRatio,
      kills: this.kills,
      hits: this.hits,
      shots: this.shotsFired,
      misses: this.misses,
      duration: this.settings.data.runDuration,
      timePlayed,
      kpm: timePlayed > 0 ? this.kills / (timePlayed / 60) : 0
    };
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.targets.length = 0;
    this.scene.remove(this.root);
  }

  // ---- Hooks (override in subclasses) ------------------------------------
  onStart() {}
  onUpdate(/* dt */) {}
  onShoot(/* raycaster */) {}
}
