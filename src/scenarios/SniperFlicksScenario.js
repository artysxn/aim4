// ---------------------------------------------------------------------------
// SniperFlicksScenario.js  ("Flicks (AWP)")
//
// Pure scoped flicking: you spawn already scoped in (zoom 1) with the
// crosshair dead-centre on a distant canvas. One bot floats on the canvas at
// a random offset in X, Y, and depth (Z) within the zoom-1 scope FOV. Hit it →
// 0.25 s later the arena resets (crosshair recentred, new bot). Miss → the bot
// despawns and the reset takes 0.75 s instead.
//
// Practice tuning: spawn radius (X and Y), bot size, distance range, and an
// optional horizontal strafe. Competitive uses static bots and fixed rules.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, clamp, degToRad } from '../utils/MathUtils.js';
import { SourceMover1D } from '../utils/SourceMovement.js';
import { gridLineColors, createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';
import { canvasCenterY, CANVAS_FLOOR_CLEARANCE } from '../utils/canvasWall.js';
import { markBulletDecalSurface } from '../utils/bulletImpact.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { EYE_HEIGHT } from '../core/Engine.js';
import { HEAD_R, HEAD_OFFSET } from '../multiplayer/constants.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_Y = BODY_H + HEAD_R + HEAD_OFFSET;

// Zoom-1 scope (hFOV 40° at 4:3) half-angles with a safety margin, so every
// spawn is guaranteed visible after a single scope-in.
const MAX_ANG_X = 18; // degrees, hard cap
const MAX_ANG_Y = 13.5;
const BASE_ANG_X = 15; // default spawn radius at spawnScale 1
const BASE_ANG_Y = 10.5;
const MIN_ANG = 3.5; // never a no-flick spawn on top of the crosshair

const HIT_RESET_DELAY = 0.25;
const MISS_RESET_DELAY = 0.75;
const STRAFE_HALF = 1.6; // m — ping-pong range for moving bots
const STRAFE_SPEED = 2.6; // m/s
const SPAWN_ATTEMPTS = 48;
const VIEW_NDC_MARGIN = 0.9;

const _headPos = new THREE.Vector3();

export class SniperFlicksScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
    this.startScoped = 1; // spawn scoped in at zoom 1
    this.infiniteAmmo = true;

    const preset = this.competitive ? competitivePresetFor('sniperflicks') : null;
    const s = {
      ...DEFAULTS.sniperflicks,
      ...((this.competitive ? {} : this.settings.data.sniperflicks) ?? {})
    };
    this.spawnScaleX = preset?.spawnScaleX ?? this.config.spawnScaleX ?? s.spawnScaleX ?? 1;
    this.spawnScaleY = preset?.spawnScaleY ?? this.config.spawnScaleY ?? s.spawnScaleY ?? 1;
    this.botScale = preset?.botScale ?? this.config.botScale ?? s.botScale ?? 1;
    this.minDistance = preset?.minDistance ?? this.config.minDistance ?? s.minDistance ?? 35;
    this.maxDistance = Math.max(
      this.minDistance,
      preset?.maxDistance ?? this.config.maxDistance ?? s.maxDistance ?? 75
    );
    this.botsMove = preset?.botsMove ?? this.config.botsMove ?? s.botsMove ?? false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : this.settings.data.runDuration;

    this.bot = null;
    this._resetIn = null;
    this._buildEnvironment();
    this.engine.camera.position.y = this.centerY;
  }

  /** Re-read practice sliders (training gear / in-run pause settings). */
  _applyPracticeTuning() {
    if (this.competitive) return;
    const s = { ...DEFAULTS.sniperflicks, ...(this.settings.data.sniperflicks ?? {}) };
    this.spawnScaleX = s.spawnScaleX ?? 1;
    this.spawnScaleY = s.spawnScaleY ?? 1;
    this.botScale = s.botScale ?? 1;
    this.minDistance = s.minDistance ?? 35;
    this.maxDistance = Math.max(this.minDistance, s.maxDistance ?? 75);
    this.botsMove = !!s.botsMove;
  }

  applyLiveSettings() {
    super.applyLiveSettings();
    this._applyPracticeTuning();
  }

  get name() {
    return 'sniperflicks';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.sniperflicks ?? DEFAULTS.sniperflicks;
    return `x${c.spawnScaleX}_y${c.spawnScaleY}_s${c.botScale}_d${c.minDistance}-${c.maxDistance}_m${c.botsMove ? 1 : 0}_t${settings.data.runDuration}`;
  }

  configKey() {
    return SniperFlicksScenario.configKeyFor(this.settings, this.variant);
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(200, 100, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);

    // The canvas: a backdrop wall behind the deepest spawn, sized to cover the
    // whole zoom-1 spawn cone so every bot reads as "floating on the canvas".
    const wallZ = (this.maxDistance + 6) * 0.8;
    const wallW = Math.tan(degToRad(MAX_ANG_X)) * wallZ * 2 + 10;
    const wallH = Math.tan(degToRad(MAX_ANG_Y)) * wallZ * 2 + EYE_HEIGHT + 6;
    this.centerY = canvasCenterY(wallH);
    const gridMat = createCoverGridMaterial(c.cover, c.floor);
    applyCoverGridRepeat(gridMat, wallW, wallH);
    this._canvasWall = new THREE.Mesh(
      new THREE.BoxGeometry(wallW, wallH, 0.5),
      gridMat
    );
    this._canvasWall.position.set(0, this.centerY, -wallZ);
    markBulletDecalSurface(this._canvasWall);
    this.root.add(this._canvasWall);
    this._wallHalfW = wallW / 2;
    this._wallHalfH = wallH / 2;
    this._wallZ = wallZ;
  }

  _botHeight() {
    return (BODY_H + HEAD_R * 2 + HEAD_OFFSET) * this.botScale;
  }

  /** Bot must sit on the canvas in front of the player, above the floor, in view. */
  _isValidBotPlacement(cx, feetY, z) {
    if (feetY < CANVAS_FLOOR_CLEARANCE) return false;
    if (z >= -2) return false;
    if (z <= -this._wallZ) return false;

    const margin = 0.35 * this.botScale;
    const headY = feetY + HEAD_Y * this.botScale;
    if (Math.abs(cx) > this._wallHalfW - margin) return false;
    if (headY > this.centerY + this._wallHalfH - margin) return false;
    if (headY < this.centerY - this._wallHalfH + margin) return false;

    _headPos.set(cx, headY, z);
    this.camera.updateMatrixWorld(true);
    _headPos.project(this.camera);
    if (_headPos.z > 1) return false;
    if (Math.abs(_headPos.x) > VIEW_NDC_MARGIN || Math.abs(_headPos.y) > VIEW_NDC_MARGIN) return false;
    return true;
  }

  _maxStrafeX(feetY, z) {
    let lo = 0;
    let hi = this._wallHalfW;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) * 0.5;
      if (this._isValidBotPlacement(mid, feetY, z)) lo = mid;
      else hi = mid;
    }
    return Math.max(0, lo - 0.2 * this.botScale);
  }

  tracerRaycastExtras() {
    return this._canvasWall ? [this._canvasWall] : [];
  }

  _buildBot() {
    const t = new Target();
    const c = this.settings.data.colors;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 18),
      new THREE.MeshStandardMaterial({ color: c.enemyBody, emissive: c.enemyBody, emissiveIntensity: 0.4, roughness: 0.5 })
    );
    body.position.y = BODY_H / 2;
    t.addCollider(body, { zone: 'body', points: 50, crit: false });

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R, 22, 16),
      new THREE.MeshStandardMaterial({ color: c.enemyHead, emissive: c.enemyHead, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    head.position.y = HEAD_Y;
    t.addCollider(head, { zone: 'head', points: 100, crit: true });
    t.headMesh = head;
    return t;
  }

  _spawnBot() {
    this._applyPracticeTuning();
    const halfH = this._botHeight() * 0.5;
    const minFeetY = CANVAS_FLOOR_CLEARANCE;
    const maxFeetY = this.centerY + this._wallHalfH - halfH - 0.2 * this.botScale;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const dist = randRange(this.minDistance, this.maxDistance);
      const z = -dist;

      const maxX = clamp(BASE_ANG_X * this.spawnScaleX, MIN_ANG, MAX_ANG_X);
      const maxY = clamp(BASE_ANG_Y * this.spawnScaleY, MIN_ANG, MAX_ANG_Y);
      const angX = degToRad(randRange(MIN_ANG, maxX)) * (Math.random() < 0.5 ? -1 : 1);
      const angY = degToRad(randRange(MIN_ANG, maxY)) * (Math.random() < 0.5 ? -1 : 1);

      const cx = Math.tan(angX) * dist;
      let feetY = this.centerY + Math.tan(angY) * dist - halfH;
      feetY = clamp(feetY, minFeetY, maxFeetY);

      if (!this._isValidBotPlacement(cx, feetY, z)) continue;

      const target = this._buildBot();
      target.object.scale.setScalar(this.botScale);
      target.object.position.set(cx, feetY, z);
      this.addTarget(target);

      const mover = new SourceMover1D();
      mover.reset(0);
      this.bot = {
        target,
        mover,
        baseX: cx,
        feetY,
        z,
        strafeHalf: Math.min(STRAFE_HALF, this._maxStrafeX(feetY, z)),
        dir: Math.random() < 0.5 ? -1 : 1,
        reverseTimer: randRange(0.3, 0.8)
      };
      return;
    }

    // Last resort: offset spawn (validation should succeed after the z fix).
    const target = this._buildBot();
    target.object.scale.setScalar(this.botScale);
    const dist = randRange(this.minDistance, this.maxDistance);
    const maxX = clamp(BASE_ANG_X * this.spawnScaleX, MIN_ANG, MAX_ANG_X);
    const angX = degToRad(randRange(MIN_ANG, maxX)) * (Math.random() < 0.5 ? -1 : 1);
    const cx = Math.tan(angX) * dist;
    const feetY = clamp(this.centerY - halfH, minFeetY, maxFeetY);
    target.object.position.set(cx, feetY, -dist);
    this.addTarget(target);
    const mover = new SourceMover1D();
    mover.reset(0);
    this.bot = {
      target,
      mover,
      baseX: cx,
      feetY,
      z: -dist,
      strafeHalf: Math.min(STRAFE_HALF, this._maxStrafeX(feetY, -dist)),
      dir: 1,
      reverseTimer: randRange(0.3, 0.8)
    };
  }

  _clearBot(fadeColor) {
    if (this.bot?.target && this.bot.target.state !== 'dying') {
      this.bot.target.startDying(fadeColor);
    }
    this.bot = null;
  }

  /** Reset the arena: crosshair back to centre, scope restored, fresh bot. */
  _resetArena() {
    const input = this.engine.player?.input;
    if (input) {
      input.yaw = 0;
      input.pitch = 0;
    }
    this.camera.rotation.set(0, 0, 0);
    // Fresh bolt + instant re-scope (the mode always plays scoped at zoom 1).
    this.engine.weapon?.reset();
    this._spawnBot();
  }

  onStart() {
    this._resetArena();
  }

  onUpdate(dt) {
    if (this._resetIn != null) {
      this._resetIn -= dt;
      if (this._resetIn <= 0) {
        this._resetIn = null;
        this._resetArena();
      }
      return;
    }

    const b = this.bot;
    if (!b || b.target.state === 'dying') return;
    if (this.botsMove) {
      b.reverseTimer -= dt;
      if (b.reverseTimer <= 0) {
        b.dir = -b.dir;
        b.reverseTimer = randRange(0.3, 0.8);
      }
      const half = b.strafeHalf ?? STRAFE_HALF;
      b.mover.step(dt, b.dir, STRAFE_SPEED);
      if (b.mover.s <= -half) { b.mover.s = -half; b.dir = 1; }
      else if (b.mover.s >= half) { b.mover.s = half; b.dir = -1; }
      const x = b.baseX + b.mover.s;
      if (this._isValidBotPlacement(x, b.feetY, b.z)) {
        b.target.object.position.x = x;
      } else {
        b.dir = -b.dir;
        b.mover.s = clamp(b.mover.s, -half, half);
      }
    }
  }

  onShoot(raycaster) {
    if (this._resetIn != null) return;
    const b = this.bot;
    if (!b || b.target.state === 'dying') return;

    const hit = this.raycastTargets(raycaster, this.tracerRaycastExtras());
    const tgt = hit?.object?.userData?.target;
    if (tgt === b.target) {
      this.crosshair?.hit();
      this.hits++;
      this.kills++;
      if (hit.object.userData.zone === 'head') this.headshots++;
      this.score += hit.object.userData.points;
      beep(1000, 0.05, 'square', 0.05);
      this._clearBot(0x35e06a);
      this._resetIn = HIT_RESET_DELAY;
    } else {
      // Miss: the bot despawns and the reset takes longer.
      this.misses++;
      beep(240, 0.07, 'sawtooth', 0.05);
      this._clearBot(0xff4d4d);
      this._resetIn = MISS_RESET_DELAY;
    }
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }

  dispose() {
    this.bot = null;
    super.dispose();
  }
}
