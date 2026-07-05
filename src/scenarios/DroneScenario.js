// ---------------------------------------------------------------------------
// DroneScenario.js  ("Drone")
//
// Ball, inverted: YOU are the ball. The camera rides the exact Bounce/Ball
// trajectory — angular travel around the arena, radial drift, gravity bounces
// off the sloped floor — while the target sits STATIC in the middle of the
// arena. Hold the full-auto tracking rifle on it; every landed bullet scores.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const ARC_HALF = Math.PI / 2; // 180° of travel around the target
const GRAVITY = 12;
const RADIAL_SPEED_MIN = 1.2;
const RADIAL_SPEED_MAX = 2.6;
const TURN_EASE = 3.2;
const SLOPE = 0.14; // floor rise per metre from the centre (same as Ball)
const HIT_PTS = 2;
const TARGET_Y = 2.5; // static target height at the arena centre
const RIDE_EYE = 0.9; // camera sits this far above the "ball" you ride

export class DroneScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor('drone') : null;
    const d = { ...DEFAULTS.drone, ...((this.competitive ? DEFAULTS.drone : this.settings.data.drone) ?? {}) };
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? d.targetSize;
    this.travelSpeed = preset?.travelSpeed ?? this.config.travelSpeed ?? d.travelSpeed;
    this.minDistance = preset?.minDistance ?? this.config.minDistance ?? d.minDistance;
    this.maxDistance = preset?.maxDistance ?? this.config.maxDistance ?? d.maxDistance;
    this.bounceHeight = preset?.bounceHeight ?? this.config.bounceHeight ?? d.bounceHeight;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : Infinity;

    if (this.maxDistance < this.minDistance + 0.5) {
      this.maxDistance = this.minDistance + 0.5;
    }

    // Strafes-style weapon: full-auto tracking rifle, no viewmodel/tracers.
    this.weaponId = 'tracking';
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.showViewmodel = false;
    this.weaponTracers = false;

    this._ride = null; // the "ball" state the camera rides
    this._buildEnvironment();
  }

  get name() {
    return 'drone';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const d = settings.data.drone ?? DEFAULTS.drone;
    return `s${d.targetSize}_v${d.travelSpeed}_d${settings.data.runDuration}`;
  }

  configKey() {
    return DroneScenario.configKeyFor(this.settings, this.variant);
  }

  /** Floor height of the sloped arena at distance r from the centre. */
  _floorY(r) {
    return Math.max(0, r - this.minDistance * 0.5) * SLOPE;
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const flat = new THREE.Mesh(
      new THREE.CircleGeometry(this.minDistance * 0.5, 40),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    flat.rotation.x = -Math.PI / 2;
    this.root.add(flat);

    const edgeR = this.maxDistance + 4;
    const slopeH = this._floorY(edgeR);
    const slope = new THREE.Mesh(
      new THREE.CylinderGeometry(edgeR, this.minDistance * 0.5, slopeH, 64, 1, true),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1, side: THREE.DoubleSide })
    );
    slope.position.y = slopeH / 2;
    this.root.add(slope);

    const grid = new THREE.GridHelper(80, 60, gridCenter, gridEdge);
    grid.position.y = 0.001;
    this.root.add(grid);
  }

  _bounceVel() {
    const mul = this.competitive ? randRange(0.8, 1.2) : randRange(0.8, 1);
    return Math.sqrt(2 * GRAVITY * this.bounceHeight) * mul;
  }

  _spawnTarget() {
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.targetSize, 24, 18),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: HIT_PTS, crit: false });
    target.object.position.set(0, TARGET_Y, 0);
    this.ball = target;
    this.addTarget(target);
  }

  _startRide() {
    const thetaDir = Math.random() < 0.5 ? -1 : 1;
    const omega = (this.travelSpeed * Math.PI) / 180;
    const r = randRange(this.minDistance, this.maxDistance);
    this._ride = {
      theta: randRange(-ARC_HALF * 0.85, ARC_HALF * 0.85),
      thetaDir,
      omega,
      omegaCur: thetaDir * omega,
      r,
      vr: randRange(RADIAL_SPEED_MIN, RADIAL_SPEED_MAX) * (Math.random() < 0.5 ? -1 : 1),
      y: this._floorY(r) + randRange(0.2, this.bounceHeight),
      vy: this._bounceVel() * randRange(-0.5, 0.5)
    };
    this._applyRide();
  }

  _applyRide() {
    const s = this._ride;
    this.camera.position.set(
      Math.sin(s.theta) * s.r,
      s.y + RIDE_EYE,
      -Math.cos(s.theta) * s.r
    );
  }

  onStart() {
    this._spawnTarget();
    this._startRide();
  }

  onUpdate(dt) {
    const s = this._ride;
    if (!s) return;

    // Horizontal: eased reversals at the arc edges (exactly like Ball).
    if (s.theta <= -ARC_HALF && s.thetaDir < 0) s.thetaDir = 1;
    else if (s.theta >= ARC_HALF && s.thetaDir > 0) s.thetaDir = -1;
    const omegaTarget = s.thetaDir * s.omega;
    s.omegaCur += (omegaTarget - s.omegaCur) * Math.min(1, TURN_EASE * dt);
    s.theta += s.omegaCur * dt;
    const over = ARC_HALF * 1.05;
    if (s.theta < -over) s.theta = -over;
    else if (s.theta > over) s.theta = over;

    // Radial drift between min/max distance.
    s.r += s.vr * dt;
    if (s.r < this.minDistance) {
      s.r = this.minDistance;
      s.vr = Math.abs(s.vr);
    } else if (s.r > this.maxDistance) {
      s.r = this.maxDistance;
      s.vr = -Math.abs(s.vr);
    }

    // Vertical: gravity bounce off the sloped floor at this radius.
    const floorY = this._floorY(s.r) + 0.2;
    s.vy -= GRAVITY * dt;
    s.y += s.vy * dt;
    if (s.y < floorY) {
      s.y = floorY;
      s.vy = this._bounceVel();
    }

    this._applyRide();
  }

  /** Strafes-style scoring: every landed bullet is worth points. */
  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) return;
    const target = hit.object.userData.target;
    if (!target || target.state === 'dying') return;
    this.hits++;
    this.score += HIT_PTS;
    this.crosshair?.hit();
    beep(520, 0.03, 'square', 0.04);
    const mat = target._mesh?.material;
    if (mat?.emissiveIntensity != null) {
      mat.emissiveIntensity = 1.0;
      setTimeout(() => {
        try {
          mat.emissiveIntensity = 0.5;
        } catch {
          /* disposed */
        }
      }, 60);
    }
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.score) };
  }
}
