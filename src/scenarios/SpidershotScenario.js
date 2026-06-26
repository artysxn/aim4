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
const EXPIRE_RESET_DELAY = 0.5;
const DECOY_PENALTY_DELAY = 1.0;
const DECOY_COLOR = 0x0a0a0a;

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
    this.viewmodelRecoil =
      preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? s.viewmodelRecoil ?? false;
    this.decoyEnabled = this.competitive
      ? (preset?.decoyEnabled ?? true)
      : (this.config.decoyEnabled ?? s.decoyEnabled ?? true);
    this.decoyChancePer = preset?.decoyChancePer ?? this.config.decoyChancePer ?? s.decoyChancePer ?? 0.1;
    this.decoyMin = preset?.decoyMin ?? this.config.decoyMin ?? s.decoyMin ?? 0;
    this.decoyMax = preset?.decoyMax ?? this.config.decoyMax ?? s.decoyMax ?? 2;
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
    /** Seconds before spawning phase 1 after a fail or decoy penalty. */
    this._phaseDelay = 0;

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

  _maxSpawnSize() {
    if (this.randomSize) return Math.max(this.randomSizeMax, this.targetSize);
    return this.targetSize;
  }

  /** Axis-aligned spawn region (centre + sideward, after clamp). */
  _spawnExtents(size = this._maxSpawnSize()) {
    const halfX = this.boundsW / 2 - size - 0.05;
    const halfH = this.boundsH / 2;
    const yMinBound = Math.max(size + 0.25, this.centerY - halfH);
    const yMaxBound = this.centerY + halfH;

    const maxD = Math.max(this.minDistance, this.maxDistance);
    const angleRad = degToRad(this.angleSpread);
    const polarHalfY = maxD * Math.sin(angleRad);

    const minX = -Math.min(maxD, halfX);
    const maxX = Math.min(maxD, halfX);
    let minY = Math.max(yMinBound, this.centerY - polarHalfY);
    let maxY = Math.min(yMaxBound, this.centerY + polarHalfY);
    minY = Math.min(minY, this.centerY - size);
    maxY = Math.max(maxY, this.centerY + size);

    return { minX, maxX, minY, maxY };
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const size = this._maxSpawnSize();
    const { minX, maxX, minY, maxY } = this._spawnExtents(size);
    const margin = size + 0.12;
    const wallW = maxX - minX + margin * 2;
    const wallH = maxY - minY + margin * 2;
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(wallW, wallH),
      new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.95, metalness: 0 })
    );
    wall.position.set((minX + maxX) / 2, (minY + maxY) / 2, this.wallZ);
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

  _spawnAt(x, y, { center = false, timed = false, decoy = false } = {}) {
    const size = this._sizeForSpawn();
    const pos = this._clampPos(x, y, size);

    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 28, 20),
      new THREE.MeshStandardMaterial(
        decoy
          ? { color: DECOY_COLOR, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.85, metalness: 0 }
          : {
              color: this.settings.data.colors.target,
              emissive: 0xff2a10,
              emissiveIntensity: 0.5,
              roughness: 0.4,
              metalness: 0.1
            }
      )
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: decoy ? 0 : 1, crit: false });

    const driftDir = Math.random() < 0.5 ? -1 : 1;
    const driftSpeed =
      !center && !decoy && this.horizontalDrift
        ? randRange(this.driftSpeedMax * 0.35, this.driftSpeedMax)
        : 0;

    target._spider = {
      center,
      timed,
      decoy,
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

  _randomSidewardPos() {
    const minD = Math.min(this.minDistance, this.maxDistance);
    const maxD = Math.max(this.minDistance, this.maxDistance);
    const side = Math.random() < 0.5 ? -1 : 1;
    const dist = randRange(minD, maxD);
    const angle = degToRad(randRange(-this.angleSpread, this.angleSpread));
    return {
      x: side * dist * Math.cos(angle),
      y: this.centerY + dist * Math.sin(angle)
    };
  }

  _rollDecoyCount() {
    let n = this.decoyMin;
    for (let i = this.decoyMin + 1; i <= this.decoyMax; i++) {
      if (Math.random() < this.decoyChancePer) n = i;
      else break;
    }
    return n;
  }

  _spawnDecoys() {
    if (!this.decoyEnabled) return;
    const count = this._rollDecoyCount();
    for (let i = 0; i < count; i++) {
      const { x, y } = this._randomSidewardPos();
      this._spawnAt(x, y, { decoy: true });
    }
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
    for (let i = 0; i < count; i++) {
      const { x, y } = this._randomSidewardPos();
      this._spawnAt(x, y, { center: false, timed: true });
    }
    this._spawnDecoys();
  }

  /** Enter phase 2 from centre kill, or repeat phase 2 after a streak. */
  _enterPhase2({ firstInCycle = false } = {}) {
    this._stage = 2;
    const count = firstInCycle && this._cycleDouble ? 2 : 1;
    this._spawnSideward(count);
  }

  _instantDespawn(target) {
    const i = this.targets.indexOf(target);
    if (i >= 0) this._removeTargetAt(i);
  }

  _clearAllTargets() {
    while (this.targets.length) this._removeTargetAt(this.targets.length - 1);
  }

  _clearDecoys() {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      if (this.targets[i]._spider?.decoy) this._removeTargetAt(i);
    }
  }

  _activeRealCount() {
    return this.targets.filter((t) => t.state !== 'dying' && !t._spider?.decoy).length;
  }

  _schedulePhase1(delay) {
    this._clearAllTargets();
    this._resetCycle();
    this._stage = 1;
    this._phaseDelay = delay;
  }

  _registerHit(target) {
    if (!target || target.state === 'dying') return;

    if (target._spider?.decoy) {
      this._onDecoyHit(target);
      return;
    }

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

    if (this._stage === 2 && this._activeRealCount() === 0) {
      this._clearDecoys();
      this._onPhase2Cleared();
    }
  }

  _onDecoyHit(target) {
    this.misses++;
    this.score = Math.max(0, this.score - 1);
    this.kills = Math.max(0, this.kills - 1);
    this._instantDespawn(target);
    beep(180, 0.12, 'sawtooth', 0.18);
    this._schedulePhase1(DECOY_PENALTY_DELAY);
  }

  _onPhase2TimedOut() {
    this._schedulePhase1(EXPIRE_RESET_DELAY);
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
      if (t.state === 'dying' || t._spider?.decoy) continue;
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
    this._phaseDelay = 0;
    this._resetCycle();
    this._stage = 1;
    this._spawnCenter();
  }

  onUpdate(dt) {
    if (this._phaseDelay > 0) {
      this._phaseDelay = Math.max(0, this._phaseDelay - dt);
      if (this._phaseDelay <= 0) this._spawnCenter();
      return;
    }

    this._updateDrift(dt);

    let hadTimedExpiry = false;
    for (const t of this.targets) {
      if (t.state === 'dying' || t._spider?.decoy) continue;
      const sp = t._spider;
      if (sp?.timed && sp.ttk != null && t.age >= sp.ttk) {
        this.misses++;
        this._instantDespawn(t);
        hadTimedExpiry = true;
      }
    }

    if (hadTimedExpiry && this._stage === 2 && this._activeRealCount() === 0) {
      this._onPhase2TimedOut();
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) return;
    this._registerHit(hit.object.userData.target);
  }
}
