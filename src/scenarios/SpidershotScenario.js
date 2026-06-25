// ---------------------------------------------------------------------------
// SpidershotScenario.js
// Cycle: (1) centre dot, no timer → (2) sideward dot(s) with TTK → repeat.
// Double spawn (phase 2 only, rolled on centre kill) and streaks (extra phase 2
// waves after clearing phase 2) are mutually exclusive per cycle.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, degToRad } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { EYE_HEIGHT } from '../core/Engine.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';

const BASE_BOUNDS_W = 12;
const BASE_BOUNDS_H = 6;
const DOUBLE_SPAWN_TTK_MULT = 1.75;

export class SpidershotScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    const preset = this.competitive ? competitivePresetFor('spidershot') : null;
    const s = this.settings.data.spidershot;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? s.targetSize;
    this.timeToKill = (preset?.timeToKill ?? this.config.timeToKill ?? s.timeToKill) / 1000;
    this.maxDistance = preset?.maxDistance ?? this.config.maxDistance ?? s.maxDistance;
    this.minDistance = preset?.minDistance ?? this.config.minDistance ?? s.minDistance;
    this.heightSpread = preset?.heightSpread ?? this.config.heightSpread ?? s.heightSpread;
    this.angleSpread = preset?.angleSpread ?? this.config.angleSpread ?? s.angleSpread;
    this.streakChance = preset?.streakChance ?? this.config.streakChance ?? s.streakChance;
    this.streakLengthMin = preset?.streakLengthMin ?? this.config.streakLengthMin ?? s.streakLengthMin;
    this.streakLengthMax = preset?.streakLengthMax ?? this.config.streakLengthMax ?? s.streakLengthMax;
    this.doubleSpawnChance = preset?.doubleSpawnChance ?? this.config.doubleSpawnChance ?? s.doubleSpawnChance;
    this.horizontalDrift = this.config.horizontalDrift ?? s.horizontalDrift ?? false;
    this.driftSpeedMax = this.config.driftSpeedMax ?? s.driftSpeedMax ?? 1.5;
    this.randomSize = preset?.randomSize ?? this.config.randomSize ?? s.randomSize ?? false;
    this.randomSizeMin = preset?.randomSizeMin ?? this.config.randomSizeMin ?? s.randomSizeMin;
    this.randomSizeMax = preset?.randomSizeMax ?? this.config.randomSizeMax ?? s.randomSizeMax;
    this.infiniteAmmo = preset?.infiniteAmmo ?? this.config.infiniteAmmo ?? s.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil = preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? s.viewmodelRecoil !== false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this.wallDistance = 16;
    this.boundsW = BASE_BOUNDS_W;
    this.boundsH = BASE_BOUNDS_H * this.heightSpread;
    this.centerY = EYE_HEIGHT;
    this.wallZ = -this.wallDistance;

    /** @type {1 | 2} */
    this._stage = 1;
    /** Per-cycle: double spawn active (mutually exclusive with streak). */
    this._cycleDouble = false;
    this._streakAllowed = true;
    /** Queued extra phase-2 waves after a streak proc. */
    this._streakWavesLeft = 0;
    /** TTK multiplier for the current cycle's timed targets (double spawn → 1.75×). */
    this._cycleTtkMult = 1;

    this._buildEnvironment();
  }

  get name() {
    return 'spidershot';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const s = settings.data.spidershot;
    return `ttk${s.timeToKill}_md${Math.round(s.maxDistance * 10)}_d${settings.data.runDuration}`;
  }

  configKey() {
    return SpidershotScenario.configKeyFor(this.settings, this.variant);
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.boundsW + 8, this.boundsH + 8),
      new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.95, metalness: 0 })
    );
    wall.position.set(0, this.centerY, this.wallZ);
    this.root.add(wall);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(80, 60, gridCenter, gridEdge);
    grid.position.y = 0.001;
    this.root.add(grid);
  }

  _resetCycle() {
    this._cycleDouble = false;
    this._streakAllowed = true;
    this._streakWavesLeft = 0;
    this._cycleTtkMult = 1;
  }

  _sizeForSpawn() {
    if (!this.randomSize) return this.targetSize;
    return randRange(this.randomSizeMin, this.randomSizeMax);
  }

  _clampPos(x, y, size) {
    const halfX = this.boundsW / 2 - size - 0.05;
    const halfH = this.boundsH / 2;
    const yMin = Math.max(size + 0.25, this.centerY - halfH);
    const yMax = this.centerY + halfH;
    return {
      x: THREE.MathUtils.clamp(x, -halfX, halfX),
      y: THREE.MathUtils.clamp(y, yMin, yMax)
    };
  }

  _timedTtk() {
    return this.timeToKill * this._cycleTtkMult;
  }

  _spawnAt(x, y, { center = false, timed = false } = {}) {
    const size = this._sizeForSpawn();
    const pos = this._clampPos(x, y, size);

    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 28, 20),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: 0xff2a10,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });

    const driftDir = Math.random() < 0.5 ? -1 : 1;
    const driftSpeed =
      !center && this.horizontalDrift
        ? randRange(this.driftSpeedMax * 0.35, this.driftSpeedMax)
        : 0;

    target._spider = {
      center,
      timed,
      ttk: timed ? this._timedTtk() : null,
      size,
      driftDir,
      driftSpeed,
      posX: pos.x
    };

    target.object.position.set(pos.x, pos.y, this.wallZ + size + 0.05);
    this.addTarget(target);
    return target;
  }

  _spawnCenter() {
    this._stage = 1;
    if (this._activeCount() === 0) {
      this._spawnAt(0, this.centerY, { center: true, timed: false });
    }
  }

  /** Roll double spawn for this cycle (exclusive with streak). */
  _rollCycleModifiers() {
    this._cycleDouble = Math.random() < this.doubleSpawnChance;
    this._streakAllowed = !this._cycleDouble;
    this._cycleTtkMult = this._cycleDouble ? DOUBLE_SPAWN_TTK_MULT : 1;
    this._streakWavesLeft = 0;
  }

  _spawnSideward(count = 1) {
    const minD = Math.min(this.minDistance, this.maxDistance);
    const maxD = Math.max(this.minDistance, this.maxDistance);
    for (let i = 0; i < count; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const dist = randRange(minD, maxD);
      const angle = degToRad(randRange(-this.angleSpread, this.angleSpread));
      const x = side * dist * Math.cos(angle);
      const y = this.centerY + dist * Math.sin(angle);
      this._spawnAt(x, y, { center: false, timed: true });
    }
  }

  /** Enter phase 2 from centre kill, or repeat phase 2 after a streak. */
  _enterPhase2({ firstInCycle = false } = {}) {
    this._stage = 2;
    const count = firstInCycle && this._cycleDouble ? 2 : 1;
    this._spawnSideward(count);
  }

  _registerHit(target) {
    if (!target || target.state === 'dying') return;
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();

    if (target._spider?.center) {
      this._rollCycleModifiers();
      this._enterPhase2({ firstInCycle: true });
      return;
    }

    if (this._stage === 2 && this._activeCount() === 0) {
      this._onPhase2Cleared();
    }
  }

  /** All phase-2 targets gone — streak extension or back to phase 1. */
  _onPhase2Cleared() {
    if (this._streakWavesLeft > 0) {
      this._streakWavesLeft--;
      this._enterPhase2({ firstInCycle: false });
      return;
    }

    if (this._streakAllowed && Math.random() < this.streakChance) {
      const extra = randInt(this.streakLengthMin, this.streakLengthMax);
      this._streakWavesLeft = extra - 1;
      this._enterPhase2({ firstInCycle: false });
      return;
    }

    this._resetCycle();
    this._spawnCenter();
  }

  _activeCount() {
    return this.targets.filter((t) => t.state !== 'dying').length;
  }

  _updateDrift(dt) {
    if (!this.horizontalDrift || this._stage !== 2) return;
    const halfX = this.boundsW / 2 - 0.05;

    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const sp = t._spider;
      if (!sp?.driftSpeed) continue;

      sp.posX += sp.driftDir * sp.driftSpeed * dt;
      const limit = halfX - sp.size;
      if (sp.posX < -limit) {
        sp.posX = -limit;
        sp.driftDir = 1;
      } else if (sp.posX > limit) {
        sp.posX = limit;
        sp.driftDir = -1;
      }
      t.object.position.x = sp.posX;
    }
  }

  onStart() {
    this._resetCycle();
    this._stage = 1;
    this._spawnCenter();
  }

  onUpdate(dt) {
    this._updateDrift(dt);

    let expired = false;
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const sp = t._spider;
      if (sp?.timed && sp.ttk != null && t.age >= sp.ttk) {
        this.misses++;
        t.startDying(0xff2222);
        expired = true;
      }
    }

    if (expired && this._stage === 2 && this._activeCount() === 0) {
      this._resetCycle();
      this._spawnCenter();
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) return;
    this._registerHit(hit.object.userData.target);
  }
}
