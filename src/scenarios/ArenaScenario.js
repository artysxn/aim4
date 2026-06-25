// ---------------------------------------------------------------------------
// ArenaScenario.js  ("Crossfire" — an 80° column range)
//
// A row of columns is spread across an 80° arc in front of the player. The
// round loop:
//   1. ready    — a circle spawns in a gap; the player must hit it to arm.
//   2. arming   — after a random 0.33–2.0 s delay, a bot breaks from the column
//                 on the LEFT of that gap.
//   3. moving   — the bot executes one of two plans:
//                   • 70% CROSS — run straight across the gap to the next column
//                     (exposed in the gap; flick and kill it in transit).
//                   • 30% PEEK  — step OUT to the left (open peek + hold), then
//                     cross to the right to reach new cover (exposes twice).
//   4. cooldown — brief pause after a kill / escape, then a new circle spawns.
//
// Head = instant kill (crit), body = chip damage (two shots). Columns block
// raycasts, so a bot behind cover can't be hit.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, lerp, degToRad } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { startMissFlash, updateMissFlash } from './missFlash.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_R = 0.27;

const COL_H = 2.8;
const CIRCLE_R = 0.45;

const ARC_SPAN = degToRad(80);
const PEEK_OUT_DUR = 0.18; // s, quick step-out for an open peek
const MIN_DELAY = 0.33; // s, bot reaction-delay window
const MAX_DELAY = 2.0;
const PEEK_CHANCE = 0.3;

export class ArenaScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol'; // Crossfire is a pistol mode
    const preset = this.competitive ? competitivePresetFor('arena') : null;
    const a = this.settings.data.arena;
    this.crossDur = (preset?.crossDuration ?? this.config.crossDuration ?? a.crossDuration) / 1000;
    this.peekHold = (preset?.peekHold ?? this.config.peekHold ?? a.peekHold) / 1000;
    this.colCount = Math.max(2, preset?.columns ?? this.config.columns ?? a.columns);
    this.colRadius = preset?.columnRadius ?? this.config.columnRadius ?? a.columnRadius;
    this.ringR = preset?.ringRadius ?? this.config.ringRadius ?? a.ringRadius;
    this.infiniteAmmo = preset?.infiniteAmmo ?? this.config.infiniteAmmo ?? a.infiniteAmmo ?? false;
    this.competitiveMissPenalty = !!preset?.competitiveMissPenalty;
    this.botR = this.ringR + 1;
    this.enemyScale = this.config.enemyScale ?? a.enemyScale;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this.step = ARC_SPAN / (this.colCount - 1); // angular gap between columns
    this.halfStep = this.step / 2;

    this.phase = 'ready';
    this.timer = 0;
    this.moveT = 0;
    this.gap = 0; // index of the LEFT column of the active gap
    this.plan = 'cross';
    this.circle = null;
    this.bot = null;
    this._missFlash = null;

    this.colAngle = [];
    this.columns = [];
    this._buildEnvironment();
  }

  get name() {
    return 'arena';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const a = settings.data.arena;
    return `cross${a.crossDuration}_col${a.columns}_cr${a.columnRadius}_r${a.ringRadius}_es${a.enemyScale}_d${settings.data.runDuration}`;
  }
  configKey() {
    return ArenaScenario.configKeyFor(this.settings, this.variant);
  }

  tracerRaycastExtras() {
    return this.columns;
  }

  // ---- Environment --------------------------------------------------------
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
      this.root.add(col);
      this.columns.push(col);
    }
  }

  // ---- Builders -----------------------------------------------------------
  _buildBot() {
    const s = this.enemyScale;
    const bodyR = BODY_R * s;
    const bodyH = BODY_H * s;
    const headR = HEAD_R * s;
    const headY = bodyH + headR + 0.02 * s;

    const c = this.settings.data.colors;
    const t = new Target();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(bodyR, bodyR, bodyH, 18),
      new THREE.MeshStandardMaterial({ color: c.enemyBody, emissive: 0x404040, emissiveIntensity: 0.4, roughness: 0.5 })
    );
    body.position.y = bodyH / 2;
    t.addCollider(body, { zone: 'body', points: 35, crit: false });

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(headR, 22, 16),
      new THREE.MeshStandardMaterial({ color: c.enemyHead, emissive: 0xff7b00, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    head.position.y = headY;
    t.addCollider(head, { zone: 'head', points: 100, crit: true });
    return t;
  }

  /** Position the bot on its arc at an angular offset from the active column. */
  _setBotOffset(off) {
    const ang = this.colAngle[this.gap] + off;
    this.bot.object.position.set(this.botR * Math.sin(ang), 0, -this.botR * Math.cos(ang));
    this.bot.object.lookAt(0, 0, 0);
  }

  // ---- Round flow ---------------------------------------------------------
  onStart() {
    this._spawnCircle();
  }

  _spawnCircle() {
    this.gap = randInt(0, this.colCount - 2); // gap is between column gap and gap+1
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
    this.phase = 'ready';
  }

  _arm() {
    this.phase = 'arming';
    this.timer = randRange(MIN_DELAY, MAX_DELAY);
    this.plan = Math.random() < PEEK_CHANCE ? 'peek' : 'cross';
    this.moveT = 0;
    // Spawn the bot hidden directly behind the left column of the gap.
    this.bot = this._buildBot();
    this.addTarget(this.bot);
    this._setBotOffset(0);
  }

  _startMove() {
    this.phase = 'moving';
    this.moveT = 0;
  }

  _advanceBot(dt) {
    this.moveT += dt;
    const step = this.step;
    let off;
    let done = false;

    if (this.plan === 'cross') {
      const t = this.moveT / this.crossDur;
      off = lerp(0, step, Math.min(1, t));
      if (t >= 1) done = true;
    } else {
      // PEEK: step out left -> hold -> cross right to the next column.
      const peekOff = -this.halfStep;
      if (this.moveT < PEEK_OUT_DUR) {
        off = lerp(0, peekOff, this.moveT / PEEK_OUT_DUR);
      } else if (this.moveT < PEEK_OUT_DUR + this.peekHold) {
        off = peekOff;
      } else {
        const ct = (this.moveT - PEEK_OUT_DUR - this.peekHold) / this.crossDur;
        off = lerp(peekOff, step, Math.min(1, ct));
        if (ct >= 1) done = true;
      }
    }

    this._setBotOffset(off);
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
    this.kills = Math.max(0, this.kills - 1);
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
      // 'ready' — the circle simply waits to be hit.
    }
  }

  onShoot(raycaster) {
    const colMeshes = this.columns; // cover blocks shots
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

    // Circle: arms the round.
    if (tgt === this.circle && this.phase === 'ready') {
      this.hits++;
      this.score += obj.userData.points;
      this.crosshair?.hit();
      beep(660, 0.04, 'square', 0.05);
      tgt.startDying(0x35e06a);
      this.circle = null;
      this._arm();
      return;
    }

    // Bot: only damageable while it is breaking cover.
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
