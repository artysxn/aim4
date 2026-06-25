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
import { spreadRng, applySpreadToDir } from '../utils/shotAccuracy.js';
import { viewPunchImpulse } from '../weapons/ak47.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0); // crosshair is always screen center
// Reused firing scratch (no per-shot allocation).
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _tmpEnd = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

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
    // Every scenario fires a weapon (ammo + viewmodel). The id selects the model
    // from the registry; default is the full-auto rifle, overridden per scenario.
    this.usesWeapon = true;
    this.weaponId = 'rifle';
    this._lastImpact = new THREE.Vector3();
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
    this.engine.weapon?.reset(); // fresh magazine at the start of every run
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

  /**
   * Fire one bullet. Driven by the WeaponController, which supplies the
   * deterministic AK recoil offset (applied to the bullet direction), the random
   * bloom cone half-angle and the burst shot index. The per-scenario onShoot()
   * hook still owns hit detection; this method owns aim, spread and the shared
   * weapon juice (flash, kick, tracer, view-punch).
   */
  shoot(recoil = null, bloom = 0, shotIndex = 0, punch = null) {
    if (!this.running) return;
    this.shotsFired++;
    this.engine.audio?.playLocalShot();

    const cam = this.camera;
    const input = this.engine.player?.input;
    // Aim from the player's TRUE look (input yaw/pitch), so the visual view-punch
    // never bends the bullet. Fall back to the live camera if no input exists.
    if (input) {
      _euler.set(input.pitch, input.yaw, 0, 'YXZ');
      _dir.set(0, 0, -1).applyQuaternion(_quat.setFromEuler(_euler));
    } else {
      cam.getWorldDirection(_dir);
    }
    _dir.normalize();

    // Deterministic recoil pattern: pitch up around camera-right, yaw drift.
    if (recoil) {
      _right.crossVectors(_dir, _up).normalize();
      _dir.applyQuaternion(_quat.setFromAxisAngle(_right, recoil.pitch));
      _dir.applyQuaternion(_quat.setFromAxisAngle(_up, -recoil.yaw));
    }
    const aimX = _dir.x;
    const aimY = _dir.y;
    const aimZ = _dir.z;

    // Random bloom cone on top of the pattern.
    const seed = (Math.random() * 0xffffffff) >>> 0;
    if (bloom > 0) {
      const s = applySpreadToDir({ x: _dir.x, y: _dir.y, z: _dir.z }, bloom, spreadRng(seed));
      _dir.set(s.x, s.y, s.z).normalize();
    }

    _raycaster.ray.origin.copy(cam.position);
    _raycaster.ray.direction.copy(_dir);
    _raycaster.near = 0;
    _raycaster.far = Infinity;

    const player = this.engine.player;
    const state = player?.enabled
      ? player.getAccuracyState()
      : { onGround: true, speedHoriz: 0 };
    this._lastShotAccuracy = {
      seed,
      onGround: state.onGround,
      speedHoriz: state.speedHoriz,
      aimDx: aimX,
      aimDy: aimY,
      aimDz: aimZ
    };

    // Impact point for the tracer: nearest mesh under the scenario root, else far.
    const hit = _raycaster.intersectObject(this.root, true)[0];
    if (hit) this._lastImpact.copy(hit.point);
    else this._lastImpact.copy(cam.position).addScaledVector(_dir, 120);

    this.onShoot(_raycaster);

    // Shared weapon juice.
    const vm = this.engine.viewmodel;
    if (vm) {
      vm.fire();
      vm.spawnTracer(vm.getMuzzlePosition(_muzzle), this._lastImpact);
      const p = punch || viewPunchImpulse(shotIndex);
      vm.punch(p.pitch, p.yaw);
    }
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
