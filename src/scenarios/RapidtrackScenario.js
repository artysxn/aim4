// ---------------------------------------------------------------------------
// RapidtrackScenario.js  ("Rapidtrack")
//
// Same scoring and weapon as Strafes (tracking): hold-fire at 600 RPM, head 3 /
// body 2 pts, infinite-HP bot with ADAD + tap crouch. You may roam the full
// arena; the bot has its own world position, strafes tangentially around you at
// close range, and closes in at Source run speed when it falls behind.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { TrackingScenario } from './TrackingScenario.js';
import { randRange, randInt, clamp, lerp } from '../utils/MathUtils.js';
import { srcFriction, srcAccelerate, UNIT } from '../utils/SourceMovement.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { HEAD_R, HEAD_OFFSET, BODY_R } from '../multiplayer/constants.js';

const BODY_H = 1.3;
const ARENA_HALF = 11;
const DEFAULT_BOT_DISTANCE = 6;
const TRACKING_RUN_SPEED = 210 * UNIT;

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

export class RapidtrackScenario extends TrackingScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const r = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.rapidtrack;

    this.botWidth = preset?.botWidth ?? this.config.botWidth ?? r.botWidth ?? 1;
    this.botSpeedMul = preset?.botSpeed ?? this.config.botSpeed ?? r.botSpeed ?? 1;
    this.botCrouchTap = preset?.botCrouchTap ?? r.botCrouchTap !== false;
    this.strafeRate = preset?.strafeRate ?? r.strafeRate ?? 1;
    this.botDistance = preset?.botDistance ?? this.config.botDistance ?? r.botDistance ?? DEFAULT_BOT_DISTANCE;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : Infinity;
  }

  get name() {
    return 'rapidtrack';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const rt = settings.data.rapidtrack ?? DEFAULTS.rapidtrack;
    return `w${rt.botWidth}_s${rt.botSpeed}_r${rt.botDistance}_d${settings.data.runDuration}`;
  }

  configKey() {
    return RapidtrackScenario.configKeyFor(this.settings, this.variant);
  }

  _buildArena() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA_HALF + 1, 48),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper((ARENA_HALF + 1) * 2, 44, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);

    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(ARENA_HALF * 2, 0.02, ARENA_HALF * 2)),
      new THREE.LineBasicMaterial({ color: gridCenter })
    );
    box.position.y = 0.03;
    this.root.add(box);
  }

  _spawnBot() {
    const target = this._buildBot();
    this.addTarget(target);

    const px = this.engine.player?.pos?.x ?? 0;
    const pz = this.engine.player?.pos?.z ?? 0;
    const yaw = this.engine.player?.input?.yaw ?? 0;
    const dist = this.botDistance;
    const side = Math.random() < 0.5 ? -1 : 1;
    const arc = randRange(-0.55, 0.55);

    this.bot = {
      target,
      pos: {
        x: px + Math.sin(yaw + arc) * dist,
        z: pz - Math.cos(yaw + arc) * dist
      },
      vel: { x: 0, z: 0 },
      crouch: 0,
      crouchWant: 0,
      wishDir: side,
      reverseTimer: this._strafeRange(BURST_MIN, BURST_MAX),
      crouchTimer: randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX),
      burstRemaining: randInt(5, 10),
      burstStartTimer: this._strafeRange(0.4, 1.2)
    };
    this._syncBotTransform();
    this._facePlayer(this.bot);
  }

  _syncBotTransform() {
    const bot = this.bot;
    if (!bot) return;
    bot.target.object.position.set(bot.pos.x, 0, bot.pos.z);
  }

  /** Yaw-only facing — keeps the rig upright (no lookAt pitch tilt). */
  _facePlayer(bot) {
    const px = this.camera.position.x;
    const pz = this.camera.position.z;
    const dx = px - bot.pos.x;
    const dz = pz - bot.pos.z;
    if (Math.hypot(dx, dz) > 1e-4) {
      bot.target.object.rotation.set(0, Math.atan2(dx, -dz), 0);
    }
  }

  _moveBot(bot, wishX, wishZ, max, dt) {
    const len = Math.hypot(wishX, wishZ);
    if (len > 0) {
      wishX /= len;
      wishZ /= len;
    }
    srcFriction(bot.vel, dt, len > 0 ? max : 0);
    if (len > 0) srcAccelerate(bot.vel, wishX, wishZ, max, dt);

    bot.pos.x += bot.vel.x * dt;
    bot.pos.z += bot.vel.z * dt;

    const pad = BODY_R + 0.15;
    bot.pos.x = clamp(bot.pos.x, -ARENA_HALF + pad, ARENA_HALF - pad);
    bot.pos.z = clamp(bot.pos.z, -ARENA_HALF + pad, ARENA_HALF - pad);
  }

  onStart() {
    this.engine.player.spawn({
      pos: [0, 0, 0],
      yaw: 0,
      bounds: {
        minX: -ARENA_HALF,
        maxX: ARENA_HALF,
        minZ: -ARENA_HALF,
        maxZ: ARENA_HALF
      }
    });
    this._spawnBot();
  }

  onUpdate(dt) {
    const bot = this.bot;
    if (!bot || bot.target.state === 'dying') return;

    const max = TRACKING_RUN_SPEED * this.botSpeedMul;
    const px = this.camera.position.x;
    const pz = this.camera.position.z;

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

    const dx = bot.pos.x - px;
    const dz = bot.pos.z - pz;
    const dist = Math.hypot(dx, dz) || 1e-4;
    const radialX = dx / dist;
    const radialZ = dz / dist;
    // Tangent around the player (curved strafe path).
    const tanX = -radialZ;
    const tanZ = radialX;

    let wishX = tanX * bot.wishDir;
    let wishZ = tanZ * bot.wishDir;

    // Drift toward the desired stand-off distance at real movement speed.
    const rangeErr = clamp(dist - this.botDistance, -2, 2);
    wishX -= radialX * rangeErr * 0.85;
    wishZ -= radialZ * rangeErr * 0.85;

    this._moveBot(bot, wishX, wishZ, max, dt);
    this._syncBotTransform();

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

    this._facePlayer(bot);
  }
}
