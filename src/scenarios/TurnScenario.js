// ---------------------------------------------------------------------------
// TurnScenario.js  ("Turn")
//
// One dot strafes across the wall at a random 150–230 u/s, left or right.
// Killing it spawns the next dot close by moving the OPPOSITE way. A dot that
// survives 2 s despawns (chain miss); a missed shot removes the dot, waits a
// second, then respawns it somewhere new in a fresh random direction.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { UNIT } from '../utils/SourceMovement.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { canvasCenterY } from '../utils/canvasWall.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const BOUNDS_W = 12;
const BOUNDS_H = 6;
const SPEED_MIN = 150 * UNIT; // u/s → m/s
const SPEED_MAX = 230 * UNIT;
const NEAR_MIN = 0.6; // m — how close the opposite-direction follow-up spawns
const NEAR_MAX = 1.6;
const MISS_DELAY = 1.0; // s — pause after a missed shot
const TIMEOUT_DELAY = 0.4; // s — pause after a dot times out

export class TurnScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const t = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.turn;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? t.targetSize;
    // Dot lifetime (ms in settings → s here).
    this.dotTime = (preset?.dotTime ?? this.config.dotTime ?? t.dotTime) / 1000;
    this.infiniteAmmo = this.config.infiniteAmmo ?? t.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil =
      preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? t.viewmodelRecoil ?? false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this.wallDistance = 16;
    this.boundsW = BOUNDS_W;
    this.boundsH = BOUNDS_H;
    // Float at the canvas centre: half the board above the view line, half below.
    this.centerY = canvasCenterY(this.boundsH);

    this._dot = null; // { target, dir, speed, age }
    this._respawnLeft = 0;

    this._buildEnvironment();
    this.engine.camera.position.y = this.centerY;
  }

  get name() {
    return 'turn';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return TurnScenario.configKeyFor(this.settings, this.variant);
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

  _spawnDot({ near = null, dir = null } = {}) {
    const halfW = this.boundsW / 2 - this.targetSize;
    const halfH = this.boundsH / 2 - this.targetSize;
    const yMin = this.centerY - halfH;
    const yMax = this.centerY + halfH;
    let x;
    let y;
    if (near) {
      const a = randRange(0, Math.PI * 2);
      const d = randRange(NEAR_MIN, NEAR_MAX);
      x = Math.max(-halfW, Math.min(halfW, near.x + Math.cos(a) * d));
      y = Math.max(yMin, Math.min(yMax, near.y + Math.sin(a) * d));
    } else {
      x = randRange(-halfW, halfW);
      y = randRange(yMin, yMax);
    }

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
    target.object.position.set(x, y, -this.wallDistance + this.targetSize + 0.05);
    this.addTarget(target);

    this._dot = {
      target,
      dir: dir ?? (Math.random() < 0.5 ? -1 : 1),
      speed: randRange(SPEED_MIN, SPEED_MAX),
      age: 0
    };
  }

  _clearDot(color) {
    if (this._dot?.target && this._dot.target.state !== 'dying') {
      this._dot.target.startDying(color);
    }
    this._dot = null;
  }

  onStart() {
    this._spawnDot();
  }

  onUpdate(dt) {
    if (!this._dot) {
      this._respawnLeft -= dt;
      if (this._respawnLeft <= 0) this._spawnDot(); // fresh spot, fresh direction
      return;
    }

    const d = this._dot;
    d.age += dt;
    if (d.age >= this.dotTime) {
      // Too slow — the dot despawns and a fresh one follows shortly.
      this.misses++;
      this._clearDot(0xff2222);
      this._respawnLeft = TIMEOUT_DELAY;
      beep(220, 0.08, 'sawtooth', 0.05);
      return;
    }

    // Strafe along the wall; reflect at the edges so the dot stays on canvas.
    const halfW = this.boundsW / 2 - this.targetSize;
    const pos = d.target.object.position;
    pos.x += d.dir * d.speed * dt;
    if (pos.x < -halfW) {
      pos.x = -halfW;
      d.dir = 1;
    } else if (pos.x > halfW) {
      pos.x = halfW;
      d.dir = -1;
    }
  }

  onShoot(raycaster) {
    if (!this._dot) return;
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      // Miss: the dot vanishes, waits a second, then reappears somewhere new.
      this.misses++;
      if (this.competitive) {
        this.kills = Math.max(0, this.kills - 1);
        this.score = Math.max(0, this.score - 1);
      }
      this._clearDot(0xff2222);
      this._respawnLeft = MISS_DELAY;
      return;
    }

    this.hits++;
    this.kills++;
    this.score += 1;
    this.crosshair?.hit();
    beep(820, 0.04, 'square', 0.05);
    const lastPos = { x: target.object.position.x, y: target.object.position.y };
    const nextDir = -this._dot.dir; // opposite direction to the killed dot
    this._clearDot(0x35e06a);
    this._spawnDot({ near: lastPos, dir: nextDir });
  }
}
