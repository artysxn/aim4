// ---------------------------------------------------------------------------
// SurvivalScenario.js
// Dots spawn and grow until shot or they explode. Every 8 hits shave 0.01 s off the
// spawn delay (down to a floor). Miss a shot (or run out of strikes in Practice)
// and the run ends. Competitive uses fixed rules and counts toward leaderboards;
// Practice is configurable and offline-only.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, lerp } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { EYE_HEIGHT } from '../core/Engine.js';

const BASE_BOUNDS_W = 12;
const BASE_BOUNDS_H = 6;
const HIT_SPAWN_REDUCE = 0.01; // seconds removed from spawn delay per ramp step
const HITS_PER_SPAWN_REDUCE = 8;
const SPAWN_INTERVAL_FLOOR = 0.08;

/** Fixed Competitive Survival rules — not user-configurable. */
export const SURVIVAL_COMPETITIVE = {
  spawnInterval: 0.42,
  despawnTime: 1.8,
  maxSize: 0.55,
  startSize: 0.12,
  missesAllowed: 0
};

export class SurvivalScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.runDuration = Infinity;

    const p = this.settings.data.survival;
    if (this.competitive) {
      this.spawnInterval = SURVIVAL_COMPETITIVE.spawnInterval;
      this.despawnTime = SURVIVAL_COMPETITIVE.despawnTime;
      this.maxSize = SURVIVAL_COMPETITIVE.maxSize;
      this.startSize = SURVIVAL_COMPETITIVE.startSize;
      this.missesAllowed = SURVIVAL_COMPETITIVE.missesAllowed;
    } else {
      this.spawnInterval = (this.config.spawnInterval ?? p.spawnInterval) / 1000;
      this.despawnTime = (this.config.despawnTime ?? p.despawnTime) / 1000;
      this.maxSize = this.config.maxSize ?? p.maxSize;
      this.startSize = this.config.startSize ?? p.startSize ?? 0.12;
      this.missesAllowed = this.config.missesAllowed ?? p.missesAllowed ?? 3;
    }

    this.wallDistance = 16;
    this.boundsW = BASE_BOUNDS_W;
    this.boundsH = BASE_BOUNDS_H;
    this.centerY = EYE_HEIGHT;
    this.wallZ = -this.wallDistance;

    this._spawnTimer = 0;
    this._currentSpawnInterval = this.spawnInterval;
    this._missShots = 0;
    this._gameOverReason = null;
    this._ended = false;

    this._buildEnvironment();
  }

  get name() {
    return 'survival';
  }

  get showElapsedTime() {
    return true;
  }

  static configKeyFor(settings, variant = 'competitive') {
    return variant === 'competitive' ? 'competitive' : 'practice';
  }

  configKey() {
    return SurvivalScenario.configKeyFor(this.settings, this.variant);
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

  _randomPos(size) {
    const halfX = this.boundsW / 2 - size - 0.05;
    const halfH = this.boundsH / 2;
    const yMin = Math.max(size + 0.25, this.centerY - halfH);
    const yMax = this.centerY + halfH;
    return new THREE.Vector3(
      randRange(-halfX, halfX),
      randRange(yMin, yMax),
      this.wallZ + size + 0.05
    );
  }

  _spawnDot() {
    const size = this.startSize;
    let pos = this._randomPos(size);
    for (let i = 0; i < 10; i++) {
      let ok = true;
      for (const t of this.targets) {
        if (t.state === 'dying') continue;
        if (t.object.position.distanceTo(pos) < size * 3) {
          ok = false;
          break;
        }
      }
      if (ok) break;
      pos = this._randomPos(size);
    }

    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 24, 18),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.45,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(pos);
    target._survival = { startSize: size };
    this.addTarget(target);
  }

  _updateGrowth() {
    const sizeRatio = this.maxSize / this.startSize;
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const growT = Math.min(1, t.age / this.despawnTime);
      const scale = lerp(1, sizeRatio, growT);
      t._mesh.scale.setScalar(scale);
      if (growT > 0.85) {
        const urgency = (growT - 0.85) / 0.15;
        t._mesh.material.emissive.setRGB(1, 0.15 * (1 - urgency), 0);
        t._mesh.material.emissiveIntensity = 0.45 + urgency * 0.55;
      }
    }
  }

  _gameOver(reason) {
    if (this._ended || !this.running) return;
    this._ended = true;
    this._gameOverReason = reason;
    for (const t of this.targets) {
      if (t.state !== 'dying') {
        t.startDying(reason === 'explode' ? 0xff4400 : 0xff2222);
      }
    }
    beep(reason === 'explode' ? 180 : 220, 0.12, 'sawtooth', 0.08);
    this._requestFinish?.();
  }

  _onMissedShot() {
    this.misses++;
    this._missShots++;
    if (this._missShots > this.missesAllowed) {
      this._gameOver('miss');
    }
  }

  _registerHit(target) {
    if (!target || target.state === 'dying') return;
    this.hits++;
    this.kills++;
    this.score += 1;
    if (this.hits % HITS_PER_SPAWN_REDUCE === 0) {
      this._currentSpawnInterval = Math.max(
        SPAWN_INTERVAL_FLOOR,
        this._currentSpawnInterval - HIT_SPAWN_REDUCE
      );
    }
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
  }

  onStart() {
    this._spawnTimer = 0;
    this._currentSpawnInterval = this.spawnInterval;
    this._spawnDot();
  }

  onUpdate(dt) {
    if (this._ended) return;

    this._spawnTimer += dt;
    while (this._spawnTimer >= this._currentSpawnInterval) {
      this._spawnTimer -= this._currentSpawnInterval;
      this._spawnDot();
    }

    this._updateGrowth();

    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      if (t.age >= this.despawnTime) {
        this._gameOver('explode');
        return;
      }
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) {
      this._onMissedShot();
      return;
    }
    this._registerHit(hit.object.userData.target);
  }

  results() {
    return { ...super.results(), gameOverReason: this._gameOverReason };
  }
}
