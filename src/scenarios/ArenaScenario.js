// ---------------------------------------------------------------------------
// ArenaScenario.js  ("Crossfire (Clicks)" — an 80° column range)
//
// A row of columns is spread across an 80° arc in front of the player. The
// round loop:
//   1. ready    — a circle spawns in a gap; hold crosshair on it 0.5 s to arm.
//   2. arming   — after a random 0.33–2.0 s delay, a bot breaks from either
//                 pillar of that gap.
//   3. moving   — the bot crosses the gap at 250 u/s (70% straight cross,
//                 30% peek-jiggle on the Clicks variant).
//   4. cooldown — brief pause after a kill / escape, then a new circle spawns.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { buildCSBotTarget } from '../bots/buildBotTarget.js';
import { randRange, randInt, degToRad } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { markBulletDecalSurface } from '../utils/bulletImpact.js';
import { UNIT } from '../utils/SourceMovement.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { startMissFlash, updateMissFlash } from './missFlash.js';

const COL_H = 2.8;
const CIRCLE_R = 0.45;

const ARC_SPAN = degToRad(80);
const MIN_DELAY = 0.33;
const MAX_DELAY = 2.0;
const PEEK_CHANCE = 0.3;
const ARM_HOLD_TIME = 0.5; // s crosshair hold on the red circle to arm
const CROSS_SPEED = 250 * UNIT; // fixed bot cross / peek-jiggle speed
const PLAYER_CIRCLE_R = 1.5; // m — small movement zone at the centre

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const _losRay = new THREE.Raycaster();
const _botPos = new THREE.Vector3();
const _eyePos = new THREE.Vector3();
const _losDir = new THREE.Vector3();

export class ArenaScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const a = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS[this.name] ?? DEFAULTS.arena;
    this.colCount = Math.max(2, preset?.columns ?? this.config.columns ?? a.columns);
    this.colRadius = preset?.columnRadius ?? this.config.columnRadius ?? a.columnRadius;
    this.ringR = preset?.ringRadius ?? this.config.ringRadius ?? a.ringRadius;
    this.botDistMin = preset?.botDistMin ?? this.config.botDistMin ?? a.botDistMin ?? 0.5;
    this.botDistMax = preset?.botDistMax ?? this.config.botDistMax ?? a.botDistMax ?? 1.5;
    this.infiniteAmmo = preset?.infiniteAmmo ?? this.config.infiniteAmmo ?? a.infiniteAmmo ?? false;
    this.competitiveMissPenalty = !!preset?.competitiveMissPenalty;
    this.enemyScale = this.config.enemyScale ?? a.enemyScale;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this.step = ARC_SPAN / (this.colCount - 1);
    this.halfStep = this.step / 2;

    this.phase = 'ready';
    this.timer = 0;
    this.gap = 0;
    this.spawnCol = 0;
    this.crossSign = 1;
    this.botOff = 0;
    this.peekSub = 'out'; // peek plan: out until LOS, then cross
    this.botR = this.ringR + 1;
    this.plan = 'cross';
    this.circle = null;
    this.bot = null;
    this._circleHold = 0;
    this._missFlash = null;

    this.colAngle = [];
    this.columns = [];
    this._buildEnvironment();
  }

  get name() {
    return 'arena';
  }

  /** Clicks variant may peek; sniper subclass forces cross-only. */
  _allowPeek() {
    return true;
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const a = settings.data.arena;
    return `col${a.columns}_cr${a.columnRadius}_r${a.ringRadius}_bd${a.botDistMin}-${a.botDistMax}_es${a.enemyScale}_d${settings.data.runDuration}`;
  }

  configKey() {
    return ArenaScenario.configKeyFor(this.settings, this.variant);
  }

  tracerRaycastExtras() {
    const extras = this.columns.slice();
    if (this.wall) extras.unshift(this.wall);
    return extras;
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 56),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(18, 18, 7, 56, 1, true),
      new THREE.MeshStandardMaterial({ color: c.cover, side: THREE.BackSide, roughness: 0.9 })
    );
    wall.position.y = 3.5;
    markBulletDecalSurface(wall);
    this.wall = wall;
    this.root.add(wall);

    const grid = new THREE.GridHelper(36, 36, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);

    const colMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.8, metalness: 0.05 });
    for (let i = 0; i < this.colCount; i++) {
      const angle = -ARC_SPAN / 2 + i * this.step;
      this.colAngle.push(angle);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(this.colRadius, this.colRadius, COL_H, 20), colMat);
      col.position.set(this.ringR * Math.sin(angle), COL_H / 2, -this.ringR * Math.cos(angle));
      markBulletDecalSurface(col);
      this.root.add(col);
      this.columns.push(col);
    }
  }

  _buildBot() {
    return buildCSBotTarget({
      colors: this.settings.data.colors,
      bodyPoints: 35,
      headPoints: 100,
      scale: this.enemyScale
    });
  }

  _setBotOffset(off) {
    this.botOff = off;
    const ang = this.colAngle[this.spawnCol] + off;
    this.bot.object.position.set(this.botR * Math.sin(ang), 0, -this.botR * Math.cos(ang));
    this.bot.object.lookAt(0, 0, 0);
  }

  /** True when the bot's head has a clear line of sight to the player's eye. */
  _botSeesPlayer() {
    const b = this.bot;
    if (!b || b.state === 'dying') return false;
    b.headMesh.getWorldPosition(_botPos);
    this.camera.getWorldPosition(_eyePos);
    const dist = _botPos.distanceTo(_eyePos);
    if (dist < 1e-4) return true;
    _losDir.copy(_eyePos).sub(_botPos).multiplyScalar(1 / dist);
    _losRay.set(_botPos, _losDir);
    _losRay.far = dist;
    const hits = _losRay.intersectObjects(this.columns, false);
    return hits.length === 0 || hits[0].distance >= dist - 0.05;
  }

  _stepBotOff(target, dt) {
    const angVel = CROSS_SPEED / this.botR;
    const delta = target - this.botOff;
    if (Math.abs(delta) < 1e-6) return true;
    const step = Math.sign(delta) * angVel * dt;
    if (Math.abs(step) >= Math.abs(delta)) {
      this.botOff = target;
      return true;
    }
    this.botOff += step;
    return false;
  }

  _hoveredCircle() {
    if (!this.circle || this.circle.state === 'dying') return false;
    _raycaster.setFromCamera(_center, this.camera);
    const hits = _raycaster.intersectObjects(this.circle.getColliders(), false);
    return hits.length > 0;
  }

  _updateCircleHold(dt) {
    if (this._hoveredCircle()) {
      this._circleHold += dt;
      this.crosshair?.setTrackProgress(Math.min(1, this._circleHold / ARM_HOLD_TIME));
      if (this._circleHold >= ARM_HOLD_TIME) {
        beep(660, 0.04, 'square', 0.05);
        this.circle.startDying(0x35e06a);
        this.circle = null;
        this._circleHold = 0;
        this.crosshair?.setTrackProgress(0);
        this._arm();
      }
    } else {
      this._circleHold = 0;
      this.crosshair?.setTrackProgress(0);
    }
  }

  onStart() {
    this.engine.player.spawn({
      pos: [0, 0, 0],
      yaw: 0,
      bounds: { circleRadius: PLAYER_CIRCLE_R }
    });
    this._spawnCircle();
  }

  _spawnCircle() {
    this.engine.viewmodel?.clearBulletDecals();
    this.gap = randInt(0, this.colCount - 2);
    const ang = this.colAngle[this.gap] + this.halfStep;
    const circle = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(CIRCLE_R, 26, 18),
      new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff1414, emissiveIntensity: 0.65, roughness: 0.35 })
    );
    circle.addCollider(mesh, { zone: 'circle', points: 10, crit: false });
    circle.object.position.set(this.ringR * Math.sin(ang), 1.4, -this.ringR * Math.cos(ang));
    this.addTarget(circle);
    this.circle = circle;
    this._circleHold = 0;
    this.phase = 'ready';
  }

  _arm() {
    this.phase = 'arming';
    this.timer = randRange(MIN_DELAY, MAX_DELAY);
    this.spawnCol = Math.random() < 0.5 ? this.gap : this.gap + 1;
    this.crossSign = this.spawnCol === this.gap ? 1 : -1;
    this.botR = this.ringR + randRange(this.botDistMin, this.botDistMax);
    this.plan = this._allowPeek() && Math.random() < PEEK_CHANCE ? 'peek' : 'cross';
    this.botOff = 0;
    this.peekSub = 'out';
    this.bot = this._buildBot();
    this.addTarget(this.bot);
    this._setBotOffset(0);
  }

  _startMove() {
    this.phase = 'moving';
    this.botOff = 0;
    this.peekSub = 'out';
  }

  _advanceBot(dt) {
    const targetOff = this.crossSign * this.step;
    let done = false;

    if (this.plan === 'cross') {
      done = this._stepBotOff(targetOff, dt);
    } else {
      const peekOff = -this.crossSign * this.halfStep;
      if (this.peekSub === 'out') {
        this._stepBotOff(peekOff, dt);
        if (this._botSeesPlayer()) this.peekSub = 'cross';
      } else {
        done = this._stepBotOff(targetOff, dt);
      }
    }

    this._setBotOffset(this.botOff);
    if (done) this._botEscaped();
  }

  _botEscaped() {
    this.misses++;
    if (this.bot) this.bot.startDying(0xff2222);
    this.bot = null;
    this.phase = 'cooldown';
    this.timer = 0.25;
  }

  _penalizeMissShot() {
    if (!this.competitive) {
      this.kills = Math.max(0, this.kills - 1);
      this.score = Math.max(0, this.score - 1);
    }
    if (!this.competitiveMissPenalty || this.phase === 'cooldown') return;
    this.misses++;
    if (this.circle) {
      this.circle.startDying(0xff2222);
      this.circle = null;
    }
    if (this.bot) {
      this.bot.startDying(0xff2222);
      this.bot = null;
    }
    this._circleHold = 0;
    this.crosshair?.setTrackProgress(0);
    this.phase = 'cooldown';
    this.timer = 0.25;
    this._missFlash = startMissFlash();
  }

  _competitiveMissPenalty() {
    this._penalizeMissShot();
  }

  _killBot(green = 0x35e06a) {
    if (this.bot) this.bot.startDying(green);
    this.bot = null;
    this.phase = 'cooldown';
    this.timer = 0.3;
  }

  onUpdate(dt) {
    if (this._missFlash && updateMissFlash(this.engine, this._missFlash, dt)) {
      this._missFlash = null;
    }
    switch (this.phase) {
      case 'ready':
        this._updateCircleHold(dt);
        break;
      case 'arming':
        this.timer -= dt;
        if (this.timer <= 0) this._startMove();
        break;
      case 'moving':
        if (this.bot && this.bot.state !== 'dying') this._advanceBot(dt);
        break;
      case 'cooldown':
        this.timer -= dt;
        if (this.timer <= 0) this._spawnCircle();
        break;
    }
    if (this.bot && this.bot.state !== 'dying') this.bot.model.update(dt);
  }

  onShoot(raycaster) {
    const colMeshes = this.columns;
    const hit = this.raycastTargets(raycaster, colMeshes);
    if (!hit) {
      this._penalizeMissShot();
      return;
    }
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt) {
      this._penalizeMissShot();
      return;
    }

    if (tgt === this.circle && this.phase === 'ready') return;

    if (tgt === this.bot && this.phase === 'moving' && tgt.state !== 'dying') {
      const zone = obj.userData.zone;
      this.crosshair?.hit();
      if (zone === 'head') {
        this.hits++;
        this.headshots++;
        this.kills++;
        this.score += obj.userData.points;
        beep(1000, 0.05, 'square', 0.05);
        this._killBot();
      } else {
        this.hits++;
        this.score += obj.userData.points;
        tgt.hp = (tgt.hp ?? 2) - 1;
        beep(520, 0.04, 'square', 0.04);
        if (tgt.hp <= 0) {
          this.kills++;
          this._killBot();
        } else {
          const mat = obj.material;
          mat.emissiveIntensity = 1.0;
          setTimeout(() => {
            try {
              mat.emissiveIntensity = 0.4;
            } catch (e) {
              /* disposed */
            }
          }, 80);
        }
      }
    }
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }

  dispose() {
    if (this._missFlash) this.engine.setDeathOverlay(0);
    super.dispose();
  }
}
