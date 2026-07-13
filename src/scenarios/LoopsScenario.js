// ---------------------------------------------------------------------------
// LoopsScenario.js  ("Loops (Static)")
//
// Dots orbit the player on full 360° circles at varying distances. Each dot's
// height bobs gently; smaller dots move slightly slower, larger ones faster.
// Five targets are active — click one to score and a fresh dot takes its place.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, lerp } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const SIZE_MIN_RATIO = 0.55;
const SPEED_MIN_MUL = 0.78;
const SPEED_MAX_MUL = 1.22;
const BOB_AMP = 0.32;
const BOB_SPEED_MIN = 0.9;
const BOB_SPEED_MAX = 1.6;
const HEIGHT_BASE = 2.0;
const ARENA_R = 24;

export class LoopsScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const l = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.loops;
    this.baseTargetSize = preset?.targetSize ?? this.config.targetSize ?? l.targetSize ?? 0.3;
    this.travelSpeed = preset?.travelSpeed ?? this.config.travelSpeed ?? l.travelSpeed ?? 50;
    this.minDistance = preset?.minDistance ?? this.config.minDistance ?? l.minDistance ?? 8;
    this.maxDistance = preset?.maxDistance ?? this.config.maxDistance ?? l.maxDistance ?? 16;
    this.targetCount = this._targetCount();
    this.holdTime = preset?.holdTime ?? this.config.holdTime ?? l.holdTime ?? 0;
    this.trackingMode = this._trackingMode();
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    if (this.maxDistance < this.minDistance + 0.5) {
      this.maxDistance = this.minDistance + 0.5;
    }

    if (this.trackingMode) {
      this.weaponId = 'pistol';
      this.infiniteAmmo = true;
      this.weaponBloom = false;
      this.viewmodelRecoil = false;
      this.showViewmodel = false;
      this.usesWeapon = false;
    } else {
      this.weaponId = 'pistol';
      this.infiniteAmmo = true;
      this.weaponBloom = false;
      this.viewmodelRecoil = false;
    }

    this._loops = [];
    this._buildEnvironment();
  }

  get name() {
    return 'loops';
  }

  _targetCount() {
    return 5;
  }

  _trackingMode() {
    return false;
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const l = settings.data.loops ?? DEFAULTS.loops;
    return `s${l.targetSize}_v${l.travelSpeed}_d${settings.data.runDuration}`;
  }

  configKey() {
    return LoopsScenario.configKeyFor(this.settings, this.variant);
  }

  get modeSeconds() {
    return this.elapsed;
  }

  results() {
    const timePlayed = Math.round(this.modeSeconds * 1000) / 1000;
    return {
      scenario: this.name,
      configKey: this.configKey(),
      score: Math.round(this.kills),
      accuracy: this.accuracy,
      critRatio: this.critRatio,
      kills: this.kills,
      hits: this.hits,
      shots: this.shotsFired,
      misses: this.misses,
      timePlayed,
      kpm: timePlayed > 0 ? this.kills / (timePlayed / 60) : 0,
      ...this._runMeta()
    };
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA_R, 64),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(ARENA_R * 2, 48, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);

    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 65 }, (_, i) => {
          const a = (i / 64) * Math.PI * 2;
          return new THREE.Vector3(Math.sin(a) * this.maxDistance, 0.03, -Math.cos(a) * this.maxDistance);
        })
      ),
      new THREE.LineBasicMaterial({ color: gridCenter, transparent: true, opacity: 0.35 })
    );
    this.root.add(ring);
  }

  _sizeRange() {
    const min = this.baseTargetSize * SIZE_MIN_RATIO;
    return { min, max: this.baseTargetSize };
  }

  _rollSize() {
    const { min, max } = this._sizeRange();
    return randRange(min, max);
  }

  _omegaForSize(size) {
    const { min, max } = this._sizeRange();
    const t = max > min ? (size - min) / (max - min) : 1;
    const deg = this.travelSpeed * lerp(SPEED_MIN_MUL, SPEED_MAX_MUL, t);
    const rad = (deg * Math.PI) / 180;
    return rad * (Math.random() < 0.5 ? -1 : 1);
  }

  _buildLoopTarget(size) {
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 24, 18),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    return target;
  }

  _spawnLoop() {
    const size = this._rollSize();
    const target = this._buildLoopTarget(size);
    const loop = {
      target,
      theta: randRange(0, Math.PI * 2),
      omega: this._omegaForSize(size),
      radius: randRange(this.minDistance, this.maxDistance),
      baseY: HEIGHT_BASE + randRange(-0.25, 0.35),
      bobPhase: randRange(0, Math.PI * 2),
      bobSpeed: randRange(BOB_SPEED_MIN, BOB_SPEED_MAX),
      size,
      hold: 0
    };
    this._applyLoopPosition(loop);
    this.addTarget(target);
    this._loops.push(loop);
    return loop;
  }

  _applyLoopPosition(loop) {
    const bob = Math.sin(loop.bobPhase) * BOB_AMP * loop.size;
    loop.target.object.position.set(
      Math.sin(loop.theta) * loop.radius,
      loop.baseY + bob,
      -Math.cos(loop.theta) * loop.radius
    );
  }

  _removeLoop(loop) {
    const i = this._loops.indexOf(loop);
    if (i >= 0) this._loops.splice(i, 1);
    if (loop.target.state !== 'dying') loop.target.startDying(0x35e06a);
  }

  _respawnLoop() {
    while (this._loops.length < this.targetCount) this._spawnLoop();
  }

  _activeLoops() {
    return this._loops.filter((l) => l.target.state !== 'dying');
  }

  onStart() {
    this._loops = [];
    this._respawnLoop();
  }

  onUpdate(dt) {
    for (const loop of this._activeLoops()) {
      loop.theta += loop.omega * dt;
      loop.bobPhase += loop.bobSpeed * dt;
      this._applyLoopPosition(loop);
    }
    this._updateTracking(dt);
    this._pruneDeadLoops();
  }

  _pruneDeadLoops() {
    const before = this._loops.length;
    this._loops = this._loops.filter((l) => l.target.state !== 'dying');
    if (this._loops.length < this.targetCount && before !== this._loops.length) {
      this._respawnLoop();
    }
  }

  _updateTracking(_dt) {
    // Loops (Tracking) overrides.
  }

  _scoreLoop(loop) {
    this.hits++;
    this.kills++;
    this.score += 1;
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
    this._removeLoop(loop);
    this._respawnLoop();
  }

  onShoot(raycaster) {
    if (this.trackingMode) return;
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      if (!this.competitive) return;
      this.misses++;
      this.kills = Math.max(0, this.kills - 1);
      this.score = Math.max(0, this.score - 1);
      return;
    }
    const loop = this._loops.find((l) => l.target === target);
    if (!loop) return;
    this._scoreLoop(loop);
  }

  dispose() {
    this._loops = [];
    super.dispose();
  }
}
