// ---------------------------------------------------------------------------
// PasuScenario.js
// Like Gridshot — spherical targets on a wall — but smaller by default and
// always drifting on a diagonal, bouncing inside the spawn box. Supports the
// same clicking / tracking modes as Gridshot.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { canvasCenterY } from '../utils/canvasWall.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const READY_COLOR = new THREE.Color(0x35e06a);

const BASE_BOUNDS_W = 9;
const BASE_BOUNDS_H = 5;

export class PasuScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    // Keyed by this.name so subclasses (Pasu Tracking) get their own preset,
    // defaults and settings blob without re-implementing the constructor.
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const p = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.pasu;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? p.targetSize;
    this.targetCount = preset?.targetCount ?? this.config.targetCount ?? p.targetCount;
    this.enableTimeLimit = this.config.enableTimeLimit ?? p.enableTimeLimit;
    this.maxTargetAge = (this.config.maxTargetAge ?? p.maxTargetAge) / 1000;
    this.mode = this.config.mode ?? p.mode ?? 'clicking';
    this.trackTime = this.config.trackTime ?? p.trackTime ?? 0.4;
    this.trackResolve = this.config.trackResolve ?? p.trackResolve ?? 'click';
    this.travelSpeedMax = preset?.travelSpeedMax ?? this.config.travelSpeedMax ?? p.travelSpeedMax ?? 2.5;
    this.boundsScaleX = this.config.boundsScaleX ?? p.boundsScaleX ?? 1;
    this.boundsScaleY = this.config.boundsScaleY ?? p.boundsScaleY ?? 1;
    this.angleOffset = preset?.angleOffset ?? this.config.angleOffset ?? p.angleOffset ?? 360;
    this.infiniteAmmo = this.config.infiniteAmmo ?? p.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil =
      preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? p.viewmodelRecoil ?? false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this.wallDistance = 16;
    this.boundsW = BASE_BOUNDS_W * this.boundsScaleX;
    this.boundsH = BASE_BOUNDS_H * this.boundsScaleY;
    // Float at the canvas centre: half the board above the view line, half below.
    this.centerY = canvasCenterY(this.boundsH);

    this._buildEnvironment();
    this.engine.camera.position.y = this.centerY;
  }

  get name() {
    return 'pasu';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return PasuScenario.configKeyFor(this.settings, this.variant);
  }

  static runDurationFromKey(configKey) {
    const m = String(configKey || '').match(/(?:^d|_d)(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
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
    // The canvas is EXACTLY the dot spawn/travel area.
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.boundsW, this.boundsH),
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

  _bounds() {
    const inset = this.targetSize + 0.05;
    const halfX = Math.max(0.1, this.boundsW / 2 - inset);
    const halfH = Math.max(0.1, this.boundsH / 2 - inset);
    return { minX: -halfX, maxX: halfX, yMin: this.centerY - halfH, yMax: this.centerY + halfH };
  }

  _randomPos() {
    const b = this._bounds();
    return new THREE.Vector3(
      randRange(b.minX, b.maxX),
      randRange(b.yMin, b.yMax),
      -this.wallDistance + this.targetSize + 0.05
    );
  }

  /** Travel angle (rad). 360° = any direction; smaller = near-horizontal only. */
  _randomTravelAngle() {
    const spread = Math.max(0, Math.min(360, this.angleOffset));
    if (spread >= 360) return randRange(0, Math.PI * 2);
    const half = (spread / 2) * (Math.PI / 180);
    const base = Math.random() < 0.5 ? 0 : Math.PI;
    return base + randRange(-half, half);
  }

  _initPasuState(target, pos) {
    const speed = randRange(this.travelSpeedMax * 0.45, this.travelSpeedMax);
    const angle = this._randomTravelAngle();
    target._pasu = {
      trackT: 0,
      ready: false,
      velX: Math.cos(angle) * speed,
      velY: Math.sin(angle) * speed
    };
    target.object.position.copy(pos);
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
      mesh.material.emissive.set(this.settings.data.colors.target);
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
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    this._initPasuState(target, pos);
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
      const ps = t._pasu;
      if (!ps) continue;

      if (t === hovered) {
        ps.trackT += dt;
        trackProgress = Math.min(1, ps.trackT / this.trackTime);
        if (ps.trackT >= this.trackTime) {
          if (this.trackResolve === 'auto') {
            this._registerHit(t);
          } else if (!ps.ready) {
            ps.ready = true;
            this._setTargetReady(t, true);
          }
        }
      } else {
        ps.trackT = 0;
        if (ps.ready) {
          ps.ready = false;
          this._setTargetReady(t, false);
        }
      }
    }

    this.crosshair?.setTrackProgress(trackProgress);
  }

  _updateTravel(dt) {
    const b = this._bounds();

    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const ps = t._pasu;
      if (!ps) continue;

      const pos = t.object.position;
      pos.x += ps.velX * dt;
      pos.y += ps.velY * dt;

      if (pos.x < b.minX) {
        pos.x = b.minX;
        ps.velX = Math.abs(ps.velX);
      } else if (pos.x > b.maxX) {
        pos.x = b.maxX;
        ps.velX = -Math.abs(ps.velX);
      }
      if (pos.y < b.yMin) {
        pos.y = b.yMin;
        ps.velY = Math.abs(ps.velY);
      } else if (pos.y > b.yMax) {
        pos.y = b.yMax;
        ps.velY = -Math.abs(ps.velY);
      }
    }
  }

  onStart() {
    for (let i = 0; i < this.targetCount; i++) this._spawn();
  }

  onUpdate(dt) {
    this._updateTracking(dt);
    this._updateTravel(dt);

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

  _penalizeMiss() {
    this.misses++;
    this.kills = Math.max(0, this.kills - 1);
    this.score = Math.max(0, this.score - 1);
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) {
      this._penalizeMiss();
      return;
    }
    const target = hit.object.userData.target;
    if (!target || target.state === 'dying') return;

    if (this.mode === 'tracking' && this.trackResolve === 'click') {
      if (!target._pasu?.ready) return;
    }

    this._registerHit(target);
  }
}
