// ---------------------------------------------------------------------------
// TrackingScenario.js  ("Tracking")
//
// Single-target tracking drill: one bot with infinite HP strafes ADAD in front
// of you while tap-crouching. Hold fire at 600 RPM (no recoil / no viewmodel);
// head hits = 3 pts, body = 2 pts.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, clamp, lerp } from '../utils/MathUtils.js';
import { SourceMover1D, UNIT } from '../utils/SourceMovement.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { HEAD_R, HEAD_OFFSET } from '../multiplayer/constants.js';

const BODY_R = 0.35;
const BODY_H = 1.3;

const PLAYER_HALF = 2.5;
const BOT_DISTANCE = 12;
const STRAFE_HALF = 4.5;

// Faster / denser ADAD than Range — near-constant direction flips + frequent bursts.
const REVERSE_MIN = 0.28;
const REVERSE_MAX = 0.75;
const BURST_MIN = 0.035;
const BURST_MAX = 0.09;
const BURST_GAP_MIN = 0.9;
const BURST_GAP_MAX = 2.4;
const CROUCH_GAP_MIN = 0.65;
const CROUCH_GAP_MAX = 1.8;
const CROUCH_HOLD_MIN = 0.16;
const CROUCH_HOLD_MAX = 0.38;
const CROUCH_RATE = 13;

const HEAD_PTS = 3;
const BODY_PTS = 2;
const TRACKING_RUN_SPEED = 210 * UNIT; // max lateral strafe (u/s → m/s)

export class TrackingScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor('tracking') : null;
    const t = this.settings.data.tracking;

    this.botWidth = preset?.botWidth ?? this.config.botWidth ?? t.botWidth ?? 1;
    this.botSpeedMul = preset?.botSpeed ?? this.config.botSpeed ?? t.botSpeed ?? 1;
    this.botCrouchTap = preset?.botCrouchTap ?? t.botCrouchTap !== false;
    this.strafeRate = preset?.strafeRate ?? t.strafeRate ?? 1;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : Infinity;

    this.weaponId = 'tracking';
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.showViewmodel = false;
    this.weaponTracers = false;

    this.bot = null;
    this._buildArena();
  }

  get name() {
    return 'tracking';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const tr = settings.data.tracking;
    return `w${tr.botWidth}_s${tr.botSpeed}_d${settings.data.runDuration}`;
  }

  configKey() {
    return TrackingScenario.configKeyFor(this.settings, this.variant);
  }

  _buildArena() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(22, 48),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(40, 40, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);

    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(PLAYER_HALF * 2, 0.02, PLAYER_HALF * 2)),
      new THREE.LineBasicMaterial({ color: gridCenter })
    );
    box.position.y = 0.03;
    this.root.add(box);
  }

  _buildBot() {
    const t = new Target();
    const bodyRig = new THREE.Group();
    t.object.add(bodyRig);

    const w = this.botWidth;
    const bodyR = BODY_R * w;
    const headR = HEAD_R * w;
    const headY = BODY_H + headR + HEAD_OFFSET;

    const c = this.settings.data.colors;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(bodyR, bodyR, BODY_H, 18),
      new THREE.MeshStandardMaterial({ color: c.enemyBody, emissive: 0x404040, emissiveIntensity: 0.4, roughness: 0.5 })
    );
    body.position.y = BODY_H / 2;
    body.userData.target = t;
    body.userData.zone = 'body';
    t.colliders.push(body);
    bodyRig.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(headR, 22, 16),
      new THREE.MeshStandardMaterial({ color: c.enemyHead, emissive: 0xff7b00, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    head.position.y = headY;
    t.addCollider(head, { zone: 'head', points: HEAD_PTS, crit: false });

    t.rig = bodyRig;
    t.headMesh = head;
    t._headYStand = headY;
    return t;
  }

  _strafeRange(min, max) {
    const r = Math.max(0.05, this.strafeRate);
    return randRange(min / r, max / r);
  }

  _spawnBot() {
    const target = this._buildBot();
    this.addTarget(target);
    const mover = new SourceMover1D();
    mover.reset(0);
    this.bot = {
      target,
      mover,
      crouch: 0,
      crouchWant: 0,
      wishDir: Math.random() < 0.5 ? -1 : 1,
      reverseTimer: this._strafeRange(BURST_MIN, BURST_MAX),
      crouchTimer: randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX),
      burstRemaining: randInt(5, 10),
      burstStartTimer: this._strafeRange(0.4, 1.2)
    };
    this._placeBot(this.bot);
  }

  _placeBot(bot) {
    const x = bot.mover.s;
    bot.target.object.position.set(x, 0, -BOT_DISTANCE);
  }

  onStart() {
    this.engine.player.spawn({
      pos: [0, 0, 0],
      yaw: 0,
      bounds: { minX: -PLAYER_HALF, maxX: PLAYER_HALF, minZ: -PLAYER_HALF, maxZ: PLAYER_HALF }
    });
    this._spawnBot();
  }

  onUpdate(dt) {
    const bot = this.bot;
    if (!bot || bot.target.state === 'dying') return;

    const max = TRACKING_RUN_SPEED * this.botSpeedMul;
    const cam = this.camera;

    bot.burstStartTimer -= dt;
    if (bot.burstStartTimer <= 0 && bot.burstRemaining === 0) {
      bot.burstRemaining = randInt(5, 11);
      bot.burstStartTimer = this._strafeRange(BURST_GAP_MIN, BURST_GAP_MAX);
    }

    bot.reverseTimer -= dt;
    if (bot.reverseTimer <= 0) {
      bot.wishDir = -bot.wishDir;
      if (bot.burstRemaining > 0) {
        bot.burstRemaining--;
        bot.reverseTimer = this._strafeRange(BURST_MIN, BURST_MAX);
      } else {
        bot.reverseTimer = this._strafeRange(REVERSE_MIN, REVERSE_MAX);
      }
    }

    bot.mover.step(dt, bot.wishDir, max);
    if (bot.mover.s <= -STRAFE_HALF) {
      bot.mover.s = -STRAFE_HALF;
      bot.wishDir = 1;
    } else if (bot.mover.s >= STRAFE_HALF) {
      bot.mover.s = STRAFE_HALF;
      bot.wishDir = -1;
    }
    this._placeBot(bot);

    if (this.botCrouchTap) {
      bot.crouchTimer -= dt;
      if (bot.crouchWant && bot.crouchTimer <= 0) {
        bot.crouchWant = 0;
        bot.crouchTimer = randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX);
      } else if (!bot.crouchWant && bot.crouchTimer <= 0) {
        bot.crouchWant = 1;
        bot.crouchTimer = randRange(CROUCH_HOLD_MIN, CROUCH_HOLD_MAX);
      }

      bot.crouch = clamp(bot.crouch + (bot.crouchWant - bot.crouch) * Math.min(1, CROUCH_RATE * dt), 0, 1);
    } else {
      bot.crouch = 0;
      bot.crouchWant = 0;
    }

    if (bot.target.rig) bot.target.rig.scale.y = lerp(1, 0.55, bot.crouch);
    if (bot.target.headMesh) {
      bot.target.headMesh.position.y = BODY_H * lerp(1, 0.55, bot.crouch) + HEAD_R * this.botWidth + HEAD_OFFSET;
    }

    bot.target.object.lookAt(cam.position.x, bot.target.object.position.y + 1.0, cam.position.z);
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) return;
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt || tgt.state === 'dying' || !this.bot || this.bot.target !== tgt) return;

    this.crosshair?.hit();
    const zone = obj.userData.zone;
    this.hits++;
    if (zone === 'head') {
      this.headshots++;
      this.score += HEAD_PTS;
      beep(1000, 0.04, 'square', 0.05);
    } else {
      this.score += BODY_PTS;
      beep(520, 0.03, 'square', 0.04);
    }

    const mat = obj.material;
    if (mat?.emissiveIntensity != null) {
      mat.emissiveIntensity = zone === 'head' ? 1.2 : 0.9;
      setTimeout(() => {
        try {
          mat.emissiveIntensity = zone === 'head' ? 0.5 : 0.4;
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

  dispose() {
    this.bot = null;
    super.dispose();
  }
}
