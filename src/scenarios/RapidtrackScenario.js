// ---------------------------------------------------------------------------
// RapidtrackScenario.js  ("Rapidtrack")
//
// Same scoring and weapon as Strafes (tracking): hold-fire at 600 RPM, head 3 /
// body 2 pts, infinite-HP bot with ADAD + tap crouch. You may roam the full
// arena; the bot stays much closer and strafes along a curved arc in front of
// you instead of a flat horizontal line.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { TrackingScenario } from './TrackingScenario.js';
import { randRange, randInt, clamp, lerp } from '../utils/MathUtils.js';
import { UNIT } from '../utils/SourceMovement.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { HEAD_R, HEAD_OFFSET } from '../multiplayer/constants.js';

const BODY_H = 1.3;
const ARENA_HALF = 11;
const DEFAULT_BOT_DISTANCE = 6;
const STRAFE_HALF = 4.5; // max arc length along the curve (m)
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

  /** Bot rides a circular arc centred on the player at `botDistance`. */
  _placeBot(bot) {
    const p = this.engine.player;
    const px = p?.pos?.x ?? 0;
    const pz = p?.pos?.z ?? 0;
    const yaw = p?.input?.yaw ?? 0;
    const theta = bot.mover.s / this.botDistance;
    const dist = this.botDistance;
    const bx = px + Math.sin(yaw + theta) * dist;
    const bz = pz - Math.cos(yaw + theta) * dist;
    bot.target.object.position.set(bx, 0, bz);
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
}
