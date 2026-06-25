// ---------------------------------------------------------------------------
// SpidershotScenario.js
// Two-stage loop: (1) centre dot → (2) sideward dot(s) → repeat.
// Optional streaks widen stage 2, double spawn, drift, random size.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, degToRad } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { EYE_HEIGHT } from '../core/Engine.js';

const BASE_BOUNDS_W = 12;
const BASE_BOUNDS_H = 6;

export class SpidershotScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    const s = this.settings.data.spidershot;
    this.targetSize = this.config.targetSize ?? s.targetSize;
    this.timeToKill = (this.config.timeToKill ?? s.timeToKill) / 1000;
    this.maxDistance = this.config.maxDistance ?? s.maxDistance;
    this.minDistance = this.config.minDistance ?? s.minDistance;
    this.heightSpread = this.config.heightSpread ?? s.heightSpread;
    this.angleSpread = this.config.angleSpread ?? s.angleSpread;
    this.streakChance = this.config.streakChance ?? s.streakChance;
    this.streakLengthMin = this.config.streakLengthMin ?? s.streakLengthMin;
    this.streakLengthMax = this.config.streakLengthMax ?? s.streakLengthMax;
    this.doubleSpawnChance = this.config.doubleSpawnChance ?? s.doubleSpawnChance;
    this.horizontalDrift = this.config.horizontalDrift ?? s.horizontalDrift ?? false;
    this.driftSpeedMax = this.config.driftSpeedMax ?? s.driftSpeedMax ?? 1.5;
    this.randomSize = this.config.randomSize ?? s.randomSize ?? false;
    this.randomSizeMin = this.config.randomSizeMin ?? s.randomSizeMin;
    this.randomSizeMax = this.config.randomSizeMax ?? s.randomSizeMax;
    this.infiniteAmmo = this.config.infiniteAmmo ?? s.infiniteAmmo !== false;
    this.weaponBloom = false;

    this.wallDistance = 16;
    this.boundsW = BASE_BOUNDS_W;
    this.boundsH = BASE_BOUNDS_H * this.heightSpread;
    this.centerY = EYE_HEIGHT;
    this.wallZ = -this.wallDistance;

    /** @type {1 | 2} */
    this._stage = 1;

    this._buildEnvironment();
  }

  get name() {
    return 'spidershot';
  }

  static configKeyFor(settings) {
    const s = settings.data.spidershot;
    return `ttk${s.timeToKill}_md${Math.round(s.maxDistance * 10)}_d${settings.data.runDuration}`;
  }

  configKey() {
    return SpidershotScenario.configKeyFor(this.settings);
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
      size,
      driftDir,
      driftSpeed,
      posX: pos.x
    };

    target.object.position.set(pos.x, pos.y, this.wallZ + size + 0.05);
    this.addTarget(target);
    return target;
  }

  _enterStage1() {
    this._stage = 1;
    if (this._activeCount() === 0) {
      this._spawnAt(0, this.centerY, { center: true, timed: false });
    }
  }

  _waveSizeForStage2() {
    let count = Math.random() < this.doubleSpawnChance ? 2 : 1;
    if (Math.random() < this.streakChance) {
      count = Math.max(count, randInt(this.streakLengthMin, this.streakLengthMax));
    }
    return count;
  }

  _enterStage2() {
    this._stage = 2;
    this._spawnSideward(this._waveSizeForStage2());
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

  _registerHit(target) {
    if (!target || target.state === 'dying') return;
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();

    if (target._spider?.center) {
      this._enterStage2();
      return;
    }

    if (this._stage === 2 && this._activeCount() === 0) {
      this._enterStage1();
    }
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
    this._stage = 1;
    this._enterStage1();
  }

  onUpdate(dt) {
    this._updateDrift(dt);

    let expired = false;
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const sp = t._spider;
      if (sp?.timed && t.age >= this.timeToKill) {
        this.misses++;
        t.startDying(0xff2222);
        expired = true;
      }
    }

    if (expired && this._stage === 2 && this._activeCount() === 0) {
      this._enterStage1();
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) return;
    this._registerHit(hit.object.userData.target);
  }
}
