// ---------------------------------------------------------------------------
// BounceScenario.js
// Bouncy balls travel around the player inside a 90° forward arc. Each ball
// keeps a stable left-right angular speed (direction only flips at the arc
// edges), bounces off the floor under gravity, and slowly drifts nearer and
// further between a min/max distance. Shoot a ball to kill it; a fresh one
// spawns so the configured count stays alive.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const ARC_HALF = Math.PI / 4; // 90° field centred on forward
const GRAVITY = 12; // m/s² — snappier than earth gravity, reads as "bouncy"
const RADIAL_SPEED_MIN = 0.5; // m/s forward/back drift
const RADIAL_SPEED_MAX = 1.4;
// Horizontal direction changes ease over ~1/TURN_EASE s instead of snapping.
const TURN_EASE = 3.2;
// Per-ball angular speed spread so the balls never move in lockstep: each ball
// rolls its own speed at spawn AND re-rolls at every arc-edge reversal.
const OMEGA_VARIANCE_MIN = 0.75;
const OMEGA_VARIANCE_MAX = 1.25;

export class BounceScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    // Keyed by this.name so subclasses (Bounce Tracking) get their own preset,
    // defaults and settings blob without re-implementing the constructor.
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const b = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.bounce;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? b.targetSize;
    this.targetCount = preset?.targetCount ?? this.config.targetCount ?? b.targetCount;
    // Angular travel speed (deg/s around the player) — constant per ball.
    this.travelSpeed = preset?.travelSpeed ?? this.config.travelSpeed ?? b.travelSpeed;
    this.minDistance = preset?.minDistance ?? this.config.minDistance ?? b.minDistance;
    this.maxDistance = preset?.maxDistance ?? this.config.maxDistance ?? b.maxDistance;
    this.bounceStrength = preset?.bounceStrength ?? this.config.bounceStrength ?? b.bounceStrength ?? 6;
    // Bounce (Tracking) still uses apex height in metres.
    this.bounceHeight = preset?.bounceHeight ?? this.config.bounceHeight ?? b.bounceHeight ?? null;
    this.infiniteAmmo = this.config.infiniteAmmo ?? b.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil =
      preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? b.viewmodelRecoil ?? false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    if (this.maxDistance < this.minDistance + 0.5) {
      this.maxDistance = this.minDistance + 0.5;
    }

    this._buildEnvironment();
  }

  get name() {
    return 'bounce';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return BounceScenario.configKeyFor(this.settings, this.variant);
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

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(80, 60, gridCenter, gridEdge);
    grid.position.y = 0.001;
    this.root.add(grid);

    // Back wall behind the far edge so balls read against a surface.
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.maxDistance * 2.4 + 8, 10),
      new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.95, metalness: 0 })
    );
    wall.position.set(0, 5, -(this.maxDistance + 4));
    this.root.add(wall);
  }

  /** Per-ball angular speed: the configured speed ±25% so balls stay offset. */
  _rollOmega() {
    return ((this.travelSpeed * Math.PI) / 180) * randRange(OMEGA_VARIANCE_MIN, OMEGA_VARIANCE_MAX);
  }

  _spawnApexY() {
    if (this.bounceHeight != null) return this.bounceHeight;
    return this.bounceStrength * 0.45;
  }

  /** Upward velocity on each floor bounce (randomised per bounce). */
  _bounceVel() {
    if (this.bounceHeight != null) {
      return Math.sqrt(2 * GRAVITY * this.bounceHeight * randRange(0.75, 1));
    }
    return this.bounceStrength * randRange(0.9, 1.1);
  }

  _applyBallPosition(target) {
    const s = target._bounce;
    target.object.position.set(
      Math.sin(s.theta) * s.r,
      s.y,
      -Math.cos(s.theta) * s.r
    );
  }

  _spawn() {
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.targetSize, 24, 18),
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

    // Spawn in the far 40% of the distance band so fresh balls appear well back.
    const spawnNear = this.minDistance + (this.maxDistance - this.minDistance) * 0.6;
    const omega = this._rollOmega();
    const thetaDir = Math.random() < 0.5 ? -1 : 1;
    target._bounce = {
      theta: randRange(-ARC_HALF * 0.9, ARC_HALF * 0.9),
      thetaDir,
      omega,
      omegaCur: thetaDir * omega, // eased angular velocity (smooth reversals)
      r: randRange(spawnNear, this.maxDistance),
      vr: randRange(RADIAL_SPEED_MIN, RADIAL_SPEED_MAX) * (Math.random() < 0.5 ? -1 : 1),
      y: randRange(this.targetSize, this._spawnApexY()),
      vy: this._bounceVel() * randRange(-0.5, 0.5)
    };
    this._applyBallPosition(target);
    this.addTarget(target);
  }

  _updateBalls(dt) {
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const s = t._bounce;
      if (!s) continue;

      // Left-right: the desired direction flips at the arc edges, but the
      // actual angular velocity eases toward it so reversals read as a smooth
      // deceleration + turn instead of an instant snap. Each reversal re-rolls
      // the ball's angular speed so the group never synchronises.
      if (s.theta <= -ARC_HALF && s.thetaDir < 0) {
        s.thetaDir = 1;
        s.omega = this._rollOmega();
      } else if (s.theta >= ARC_HALF && s.thetaDir > 0) {
        s.thetaDir = -1;
        s.omega = this._rollOmega();
      }
      if (s.omegaCur == null) s.omegaCur = s.thetaDir * s.omega;
      const omegaTarget = s.thetaDir * s.omega;
      s.omegaCur += (omegaTarget - s.omegaCur) * Math.min(1, TURN_EASE * dt);
      s.theta += s.omegaCur * dt;
      // Never let the eased turn carry a ball meaningfully past the arc.
      const over = ARC_HALF * 1.08;
      if (s.theta < -over) s.theta = -over;
      else if (s.theta > over) s.theta = over;

      // Forward/back: slow drift, reflecting between min and max distance.
      s.r += s.vr * dt;
      if (s.r < this.minDistance) {
        s.r = this.minDistance;
        s.vr = Math.abs(s.vr);
      } else if (s.r > this.maxDistance) {
        s.r = this.maxDistance;
        s.vr = -Math.abs(s.vr);
      }

      // Vertical: gravity + elastic floor bounce to a stable apex.
      s.vy -= GRAVITY * dt;
      s.y += s.vy * dt;
      if (s.y < this.targetSize) {
        s.y = this.targetSize;
        s.vy = this._bounceVel();
      }

      this._applyBallPosition(t);
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
  }

  _penalizeMiss() {
    this.misses++;
    if (!this.competitive) return;
    this.kills = Math.max(0, this.kills - 1);
    this.score = Math.max(0, this.score - 1);
  }

  onStart() {
    for (let i = 0; i < this.targetCount; i++) this._spawn();
  }

  onUpdate(dt) {
    this._updateBalls(dt);
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
    this._registerHit(target);
  }
}
