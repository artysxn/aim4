// ---------------------------------------------------------------------------
// GridshotScenario.js
// Spherical targets on a forward wall. Clicking mode: shoot to destroy.
// Tracking mode: hold crosshair on target, then click when ready or auto-hit.
// Optional horizontal drift and adjustable spawn-box scale.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { EYE_HEIGHT } from '../core/Engine.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const READY_COLOR = new THREE.Color(0x35e06a);

const BASE_BOUNDS_W = 9;
const BASE_BOUNDS_H = 5;

export class GridshotScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol'; // Gridshot is a pistol mode
    const preset = this.competitive ? competitivePresetFor('gridshot') : null;
    const g = this.settings.data.gridshot;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? g.targetSize;
    this.targetCount = preset?.targetCount ?? this.config.targetCount ?? g.targetCount;
    this.enableTimeLimit = this.config.enableTimeLimit ?? g.enableTimeLimit;
    this.maxTargetAge = (this.config.maxTargetAge ?? g.maxTargetAge) / 1000;
    this.mode = preset?.mode ?? this.config.mode ?? g.mode ?? 'clicking';
    this.trackTime = this.config.trackTime ?? g.trackTime ?? 0.4;
    this.trackResolve = this.config.trackResolve ?? g.trackResolve ?? 'click';
    this.floatEnabled = preset?.floatEnabled ?? this.config.floatEnabled ?? g.floatEnabled ?? false;
    this.floatSpeedMax = this.config.floatSpeedMax ?? g.floatSpeedMax ?? 2;
    this.boundsScaleX = preset?.boundsScaleX ?? this.config.boundsScaleX ?? g.boundsScaleX ?? 1;
    this.boundsScaleY = preset?.boundsScaleY ?? this.config.boundsScaleY ?? g.boundsScaleY ?? 1;
    this.infiniteAmmo = this.config.infiniteAmmo ?? g.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil = this.config.viewmodelRecoil ?? g.viewmodelRecoil !== false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this.wallDistance = 16;
    this.boundsW = BASE_BOUNDS_W * this.boundsScaleX;
    this.boundsH = BASE_BOUNDS_H * this.boundsScaleY;
    this.centerY = EYE_HEIGHT;

    this._buildEnvironment();
  }

  get name() {
    return 'gridshot';
  }

  /** One leaderboard per run duration (practice) or fixed competitive board. */
  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return GridshotScenario.configKeyFor(this.settings, this.variant);
  }

  /** Parse run duration from a gridshot config key (legacy or current). */
  static runDurationFromKey(configKey) {
    const m = String(configKey || '').match(/(?:^d|_d)(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Seconds actively spent in this gridshot run (paused time excluded). */
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
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.boundsW + 8, this.boundsH + 8),
      new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.95, metalness: 0 })
    );
    wall.position.set(0, this.centerY, -this.wallDistance);
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

  _randomPos() {
    const halfH = this.boundsH / 2;
    const yMin = Math.max(this.targetSize + 0.25, this.centerY - halfH);
    const yMax = this.centerY + halfH;
    return new THREE.Vector3(
      randRange(-this.boundsW / 2, this.boundsW / 2),
      randRange(yMin, yMax),
      -this.wallDistance + this.targetSize + 0.05
    );
  }

  _initGridshotState(target, pos) {
    target._gridshot = {
      trackT: 0,
      ready: false,
      driftDir: Math.random() < 0.5 ? -1 : 1,
      driftSpeed: this.floatEnabled ? randRange(0, this.floatSpeedMax) : 0,
      posX: pos.x
    };
  }

  _setTargetReady(target, ready) {
    const mesh = target._mesh;
    if (!mesh?.material) return;
    const base = this.settings.data.colors.target;
    if (ready) {
      mesh.material.color.copy(READY_COLOR);
      mesh.material.emissive.set(0x1a8840);
    } else {
      mesh.material.color.set(base);
      mesh.material.emissive.set(0xff2a10);
    }
  }

  _targetUnderCrosshair() {
    _raycaster.setFromCamera(_center, this.camera);
    const hits = _raycaster.intersectObjects(this.activeColliders(), false);
    if (!hits.length) return null;
    const tgt = hits[0].object.userData.target;
    return tgt && tgt.state !== 'dying' ? tgt : null;
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

  _penalizeMiss() {
    if (!this.competitive) return;
    this.misses++;
    this.kills = Math.max(0, this.kills - 1);
    this.score = Math.max(0, this.score - 1);
  }

  _spawn() {
    let pos = this._randomPos();
    for (let i = 0; i < 12; i++) {
      let ok = true;
      for (const t of this.targets) {
        if (t.state === 'dying') continue;
        if (t.object.position.distanceTo(pos) < this.targetSize * 2.4) {
          ok = false;
          break;
        }
      }
      if (ok) break;
      pos = this._randomPos();
    }

    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.targetSize, 28, 20),
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
    target.object.position.copy(pos);
    this._initGridshotState(target, pos);
    this.addTarget(target);
  }

  _updateTracking(dt) {
    let trackProgress = 0;
    if (this.mode !== 'tracking') {
      this.crosshair?.setTrackProgress(0);
      return;
    }
    const hovered = this._targetUnderCrosshair();

    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const gs = t._gridshot;
      if (!gs) continue;

      if (t === hovered) {
        gs.trackT += dt;
        trackProgress = Math.min(1, gs.trackT / this.trackTime);
        if (gs.trackT >= this.trackTime) {
          if (this.trackResolve === 'auto') {
            this._registerHit(t);
          } else if (!gs.ready) {
            gs.ready = true;
            this._setTargetReady(t, true);
          }
        }
      } else {
        gs.trackT = 0;
        if (gs.ready) {
          gs.ready = false;
          this._setTargetReady(t, false);
        }
      }
    }

    this.crosshair?.setTrackProgress(trackProgress);
  }

  _updateFloat(dt) {
    if (!this.floatEnabled) return;
    const halfX = this.boundsW / 2 - this.targetSize - 0.05;

    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const gs = t._gridshot;
      if (!gs || !gs.driftSpeed) continue;

      gs.posX += gs.driftDir * gs.driftSpeed * dt;
      if (gs.posX < -halfX) {
        gs.posX = -halfX;
        gs.driftDir = 1;
      } else if (gs.posX > halfX) {
        gs.posX = halfX;
        gs.driftDir = -1;
      }
      t.object.position.x = gs.posX;
    }
  }

  onStart() {
    for (let i = 0; i < this.targetCount; i++) this._spawn();
  }

  onUpdate(dt) {
    this._updateTracking(dt);
    this._updateFloat(dt);

    if (this.enableTimeLimit) {
      for (const t of this.targets) {
        if (t.state !== 'dying' && t.age >= this.maxTargetAge) {
          this.misses++;
          t.startDying(0xff2222);
        }
      }
    }

    const active = this.targets.filter((t) => t.state !== 'dying').length;
    for (let i = active; i < this.targetCount; i++) this._spawn();
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) {
      this._penalizeMiss();
      return;
    }
    const target = hit.object.userData.target;
    if (!target || target.state === 'dying') {
      this._penalizeMiss();
      return;
    }

    if (this.mode === 'tracking' && this.trackResolve === 'click') {
      if (!target._gridshot?.ready) {
        this._penalizeMiss();
        return;
      }
    }

    this._registerHit(target);
  }
}
