// ---------------------------------------------------------------------------
// ExpandScenario.js  ("Expand")
//
// Small dots spawn near the centre of a tight canvas and rush toward you at a
// constant world speed — they grow as they approach, so they seem to accelerate
// at the edges. Spawn cadence matches Survival (0.4 s base, shaving delay every
// N spawns). Let one pass or miss a shot in strict mode and the run ends.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { canvasCenterY } from '../utils/canvasWall.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const CANVAS_W = 6;
const CANVAS_H = 4;
const WALL_DISTANCE = 16;
const SPAWN_CENTER_R = 1.1; // m — random offset around the crosshair on the wall
const SPAWN_REDUCE = 0.01; // s removed from spawn delay per ramp step
const SPAWNS_PER_REDUCE = 8;
const SPAWN_INTERVAL_FLOOR = 0.08;
const PASS_Z = 0.35; // past the player = lost

/** Fixed Competitive Expand rules. */
export const EXPAND_COMPETITIVE = {
  spawnInterval: 0.4,
  startSize: 0.08,
  moveSpeed: 8.5,
  noMiss: true
};

export class ExpandScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.runDuration = Infinity;

    const p = { ...DEFAULTS.expand, ...(this.settings.data.expand ?? {}) };
    if (this.competitive) {
      this.spawnInterval = EXPAND_COMPETITIVE.spawnInterval;
      this.startSize = EXPAND_COMPETITIVE.startSize;
      this.moveSpeed = EXPAND_COMPETITIVE.moveSpeed;
      this.noMiss = true;
    } else {
      this.spawnInterval = (this.config.spawnInterval ?? p.spawnInterval) / 1000;
      this.startSize = this.config.startSize ?? p.startSize ?? 0.08;
      this.moveSpeed = this.config.moveSpeed ?? p.moveSpeed ?? 8.5;
      this.noMiss = this.config.noMiss ?? p.noMiss !== false;
    }

    this.wallDistance = WALL_DISTANCE;
    this.boundsW = CANVAS_W;
    this.boundsH = CANVAS_H;
    this.centerY = canvasCenterY(CANVAS_H);
    this.wallZ = -this.wallDistance;

    this._spawnTimer = 0;
    this._currentSpawnInterval = this.spawnInterval;
    this._spawnCount = 0;
    this._gameOverReason = null;
    this._ended = false;

    this._buildEnvironment();
    this.engine.camera.position.y = this.centerY;
  }

  get name() {
    return 'expand';
  }

  get showElapsedTime() {
    return true;
  }

  static configKeyFor(settings, variant = 'competitive') {
    return variant === 'competitive' ? 'competitive' : 'practice';
  }

  configKey() {
    return ExpandScenario.configKeyFor(this.settings, this.variant);
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.boundsW + 2, this.boundsH + 2),
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

  _spawnPos() {
    const halfX = this.boundsW / 2 - this.startSize - 0.05;
    const halfH = this.boundsH / 2 - this.startSize - 0.05;
    let x = randRange(-SPAWN_CENTER_R, SPAWN_CENTER_R);
    let yOff = randRange(-SPAWN_CENTER_R * 0.65, SPAWN_CENTER_R * 0.65);
    x = Math.max(-halfX, Math.min(halfX, x));
    yOff = Math.max(-halfH, Math.min(halfH, yOff));
    return new THREE.Vector3(
      x,
      this.centerY + yOff,
      this.wallZ + this.startSize + 0.05
    );
  }

  _visualScale(spawnZ, z) {
    return Math.abs(spawnZ) / Math.max(0.45, Math.abs(z));
  }

  _applyExpandScale(target) {
    const ex = target._expand;
    if (!ex || !target._mesh) return;
    const s = this._visualScale(ex.spawnZ, target.object.position.z);
    target._mesh.scale.setScalar(s);
  }

  _spawnDot() {
    const pos = this._spawnPos();
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.startSize, 20, 14),
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
    target.object.position.copy(pos);
    target._expand = { spawnZ: pos.z, speed: this.moveSpeed };
    this._applyExpandScale(target);
    this.addTarget(target);

    this._spawnCount++;
    if (this._spawnCount % SPAWNS_PER_REDUCE === 0) {
      this._currentSpawnInterval = Math.max(
        SPAWN_INTERVAL_FLOOR,
        this._currentSpawnInterval - SPAWN_REDUCE
      );
    }
  }

  _gameOver(reason) {
    if (this._ended || !this.running) return;
    this._ended = true;
    this._gameOverReason = reason;
    for (const t of this.targets) {
      if (t.state !== 'dying') t.startDying(reason === 'pass' ? 0xff4400 : 0xff2222);
    }
    beep(reason === 'pass' ? 180 : 220, 0.12, 'sawtooth', 0.08);
    this._requestFinish?.();
  }

  _onPass() {
    this.misses++;
    this.kills = Math.max(0, this.kills - 1);
    this.score = Math.max(0, this.score - 1);
    if (this.noMiss) this._gameOver('pass');
  }

  _onMissedShot() {
    this.misses++;
    if (this.noMiss) this._gameOver('miss');
  }

  _registerHit(target) {
    if (!target || target.state === 'dying') return;
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
  }

  onStart() {
    this._spawnTimer = 0;
    this._spawnCount = 0;
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

    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const ex = t._expand;
      if (!ex) continue;
      t.object.position.z += ex.speed * dt;
      this._applyExpandScale(t);
      if (t.object.position.z > PASS_Z) {
        t.startDying(0xff4400);
        this._onPass();
        if (this._ended) return;
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
