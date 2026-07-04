// ---------------------------------------------------------------------------
// BoxScenario.js  ("Box")
//
// Tracking drill on a floating canvas: one dot travels the canvas' rectangular
// perimeter — right, up, left, down, repeating — at a random 100–200 u/s.
// Hold the crosshair on the dot for the track window (default 2 s) to arm it
// (it turns green), then click to kill. A fresh dot spawns 0.5 s later at a
// random point on the path with a freshly-rolled speed.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { UNIT } from '../utils/SourceMovement.js';
import { canvasCenterY } from '../utils/canvasWall.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const READY_COLOR = new THREE.Color(0x35e06a);

const WALL_DISTANCE = 10;
const RESPAWN_DELAY = 0.5; // s between a kill and the next dot

export class BoxScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    // Keyed by this.name so Circle reuses this constructor with its own
    // preset / defaults / settings blob.
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const b = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.box;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? b.targetSize;
    this.sizeX = preset?.sizeX ?? this.config.sizeX ?? b.sizeX;
    this.sizeY = preset?.sizeY ?? this.config.sizeY ?? b.sizeY;
    // Travel speed in Source units/s: each dot rolls speed ± variance.
    this.travelSpeed = preset?.travelSpeed ?? this.config.travelSpeed ?? b.travelSpeed;
    this.speedVariance = preset?.speedVariance ?? this.config.speedVariance ?? b.speedVariance;
    // Continuous crosshair hold (s) before the dot becomes shootable.
    this.holdTime = preset?.holdTime ?? this.config.holdTime ?? b.holdTime;
    this.infiniteAmmo = this.config.infiniteAmmo ?? b.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    // The dot's CENTRE travels the sizeX × sizeY path; the canvas is padded by
    // the dot radius so the whole dot always stays on the board.
    const pad = this.targetSize + 0.05;
    this.canvasW = this.sizeX + pad * 2;
    this.canvasH = this.sizeY + pad * 2;
    this.centerY = canvasCenterY(this.canvasH);

    this._dot = null; // { target, s, speed (m/s), hold, ready }
    this._respawnLeft = 0;

    this._buildEnvironment();
    this.engine.camera.position.y = this.centerY;
  }

  get name() {
    return 'box';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return BoxScenario.configKeyFor(this.settings, this.variant);
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

  // ---- Environment ---------------------------------------------------------
  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    // Canvas = exactly the area the dot can occupy, centred on the view line.
    this.root.add(this._canvasMesh(c));

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

  /** Rectangular canvas (Circle overrides with an elliptical board). */
  _canvasMesh(colors) {
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.canvasW, this.canvasH),
      new THREE.MeshStandardMaterial({ color: colors.cover, roughness: 0.95, metalness: 0 })
    );
    wall.position.set(0, this.centerY, -WALL_DISTANCE);
    return wall;
  }

  // ---- Path (perimeter param s, metres) -------------------------------------
  _pathLength() {
    return 2 * (this.sizeX + this.sizeY);
  }

  /** Position on the path at param s: right along the bottom → up → left → down. */
  _pathPos(s) {
    const w = this.sizeX;
    const h = this.sizeY;
    const hw = w / 2;
    const hh = h / 2;
    const p = ((s % this._pathLength()) + this._pathLength()) % this._pathLength();
    if (p < w) return { x: -hw + p, y: -hh };
    if (p < w + h) return { x: hw, y: -hh + (p - w) };
    if (p < 2 * w + h) return { x: hw - (p - w - h), y: hh };
    return { x: -hw, y: hh - (p - 2 * w - h) };
  }

  /** Advance the dot by `dist` metres along the path. */
  _advancePath(dot, dist) {
    dot.s += dist;
  }

  _applyDotPosition() {
    const d = this._dot;
    if (!d) return;
    const p = this._pathPos(d.s);
    d.target.object.position.set(p.x, this.centerY + p.y, -WALL_DISTANCE + this.targetSize + 0.05);
  }

  // ---- Dot lifecycle ---------------------------------------------------------
  _rollSpeed() {
    const v = Math.max(0, this.speedVariance);
    return Math.max(10, this.travelSpeed + randRange(-v, v)) * UNIT; // u/s → m/s
  }

  _spawnDot() {
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
    this.addTarget(target);
    this._dot = {
      target,
      s: randRange(0, this._pathLength()),
      speed: this._rollSpeed(),
      hold: 0,
      ready: false
    };
    this._applyDotPosition();
  }

  _setDotReady(ready) {
    const mesh = this._dot?.target?._mesh;
    if (!mesh?.material) return;
    if (ready) {
      mesh.material.color.copy(READY_COLOR);
      mesh.material.emissive.set(0x1a8840);
    } else {
      mesh.material.color.set(this.settings.data.colors.target);
      mesh.material.emissive.set(0xff2a10);
    }
  }

  _hoveredDot() {
    _raycaster.setFromCamera(_center, this.camera);
    const hits = _raycaster.intersectObjects(this.activeColliders(), false);
    if (!hits.length) return null;
    const tgt = hits[0].object.userData.target;
    return tgt && tgt.state !== 'dying' ? tgt : null;
  }

  _penalizeMiss() {
    this.misses++;
    if (!this.competitive) return;
    this.kills = Math.max(0, this.kills - 1);
    this.score = Math.max(0, this.score - 1);
  }

  onStart() {
    this._spawnDot();
  }

  onUpdate(dt) {
    if (!this._dot || this._dot.target.state === 'dying') {
      this._respawnLeft -= dt;
      this.crosshair?.setTrackProgress(0);
      if (this._respawnLeft <= 0) this._spawnDot();
      return;
    }

    const d = this._dot;
    this._advancePath(d, d.speed * dt);
    this._applyDotPosition();

    // Continuous hold gate: looking away resets the timer (and the ready state).
    const hovered = this._hoveredDot();
    if (hovered === d.target) {
      d.hold += dt;
      if (d.hold >= this.holdTime && !d.ready) {
        d.ready = true;
        this._setDotReady(true);
      }
    } else if (d.hold > 0 || d.ready) {
      d.hold = 0;
      if (d.ready) {
        d.ready = false;
        this._setDotReady(false);
      }
    }
    this.crosshair?.setTrackProgress(Math.min(1, d.hold / this.holdTime));
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      this._penalizeMiss();
      return;
    }
    // Only a tracked-ready (green) dot can be clicked.
    if (!this._dot?.ready || target !== this._dot.target) return;
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
    this._dot = null;
    this._respawnLeft = RESPAWN_DELAY;
  }
}
