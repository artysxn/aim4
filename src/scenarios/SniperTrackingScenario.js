// ---------------------------------------------------------------------------
// SniperTrackingScenario.js  ("Tracking (AWP)")
//
// Strafes-style tracking, but through the sniper scope. You spawn scoped in
// (zoom 1) and may move. One bot strafes ADAD in front of you with improved
// variance: besides the quick reversals, every second there is a 20% chance
// it commits to ONE direction for an uninterrupted 0.2–0.7 s run.
//
// You must keep your crosshair on the bot for 0.5 s IN A ROW before a shot is
// allowed to kill it (a progress bar under the scope hairlines fills up).
// Land the shot → a new bot spawns 1 s later at a random-ish distance.
// Track, control, shoot.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { TrackingScenario } from './TrackingScenario.js';
import { beep } from './BaseScenario.js';
import { randRange, clamp, lerp } from '../utils/MathUtils.js';
import { SourceMover1D, UNIT } from '../utils/SourceMovement.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
const STRAFE_HALF = 4.5;
const RUN_SPEED_1D = 210 * UNIT;

// Quick reversals plus occasional committed runs (the "improved variance").
const REVERSE_MIN = 0.2;
const REVERSE_MAX = 0.45;
const COMMIT_MIN = 0.2; // s — uninterrupted same-direction run
const COMMIT_MAX = 0.7;
const COMMIT_CHANCE_PER_SEC = 0.2;

const CROUCH_GAP_MIN = 0.65;
const CROUCH_GAP_MAX = 1.8;
const CROUCH_HOLD_MIN = 0.16;
const CROUCH_HOLD_MAX = 0.38;
const CROUCH_RATE = 13;

const _ray = new THREE.Raycaster();
const _dir = new THREE.Vector3();

export class SniperTrackingScenario extends TrackingScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
    this.startScoped = 1; // spawn scoped in
    this.infiniteAmmo = true;
    // Unlike Strafes, this is a real weapon mode: sniper bloom, viewmodel while
    // unscoped, recoil.
    this.weaponBloom = true;
    this.viewmodelRecoil = true;
    this.showViewmodel = true;
    this.weaponTracers = true;

    const preset = this.competitive ? competitivePresetFor('snipertracking') : null;
    const t = (this.competitive
      ? DEFAULTS.snipertracking
      : (this.settings.data.snipertracking ?? DEFAULTS.snipertracking)) || {};
    this.holdTime = preset?.holdTime ?? this.config.holdTime ?? t.holdTime ?? 0.5;
    this.respawnDelay = preset?.respawnDelay ?? this.config.respawnDelay ?? t.respawnDelay ?? 1.0;
    this.minDistance = preset?.minDistance ?? this.config.minDistance ?? t.minDistance ?? 10;
    this.maxDistance = Math.max(
      this.minDistance,
      preset?.maxDistance ?? this.config.maxDistance ?? t.maxDistance ?? 16
    );
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : this.settings.data.runDuration;

    this._onTargetT = 0;
    this._respawnIn = null;
  }

  get name() {
    return 'snipertracking';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.snipertracking ?? DEFAULTS.snipertracking;
    return `w${c.botWidth}_s${c.botSpeed}_h${c.holdTime}_d${settings.data.runDuration}`;
  }

  configKey() {
    return SniperTrackingScenario.configKeyFor(this.settings, this.variant);
  }

  _spawnBot() {
    const target = this._buildBot();
    this.addTarget(target);
    const mover = new SourceMover1D();
    mover.reset(randRange(-STRAFE_HALF * 0.5, STRAFE_HALF * 0.5));
    this.bot = {
      target,
      mover,
      crouch: 0,
      crouchWant: 0,
      wishDir: Math.random() < 0.5 ? -1 : 1,
      reverseTimer: randRange(REVERSE_MIN, REVERSE_MAX),
      commitRoll: 1, // s until the next 20% commit roll
      crouchTimer: randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX),
      dist: randRange(this.minDistance, this.maxDistance)
    };
    this._onTargetT = 0;
    this._placeBot(this.bot);
  }

  _placeBot(bot) {
    bot.target.object.position.set(bot.mover.s, 0, -(bot.dist ?? 12));
  }

  /** Continuous time-on-target gate before a shot may kill (skipped when holdTime is 0). */
  _updateHoldGate(dt) {
    const bot = this.bot;
    if (!bot || bot.target.state === 'dying' || this.holdTime <= 0) {
      if (this.holdTime <= 0) this.crosshair?.setTrackProgress(0);
      else {
        this._onTargetT = 0;
        this.crosshair?.setTrackProgress(0);
      }
      return;
    }
    const cam = this.camera;
    cam.getWorldDirection(_dir);
    _ray.ray.origin.copy(cam.position);
    _ray.ray.direction.copy(_dir);
    _ray.far = Infinity;
    const onTarget = _ray.intersectObjects(bot.target.colliders, false).length > 0;
    this._onTargetT = onTarget ? this._onTargetT + dt : 0;
    this.crosshair?.setTrackProgress(clamp(this._onTargetT / this.holdTime, 0, 1));
  }

  onUpdate(dt) {
    if (this._respawnIn != null) {
      this._respawnIn -= dt;
      if (this._respawnIn <= 0) {
        this._respawnIn = null;
        this._spawnBot();
      }
      return;
    }

    const bot = this.bot;
    if (!bot || bot.target.state === 'dying') return;

    const max = RUN_SPEED_1D * this.botSpeedMul;
    const cam = this.camera;

    // Reversals + committed runs: every second there is a 20% chance the bot
    // locks its current direction for an uninterrupted 0.2–0.7 s.
    bot.commitRoll -= dt;
    if (bot.commitRoll <= 0) {
      bot.commitRoll = 1;
      if (Math.random() < COMMIT_CHANCE_PER_SEC) {
        bot.reverseTimer = Math.max(bot.reverseTimer, randRange(COMMIT_MIN, COMMIT_MAX));
      }
    }
    bot.reverseTimer -= dt;
    if (bot.reverseTimer <= 0) {
      bot.wishDir = -bot.wishDir;
      bot.reverseTimer = randRange(REVERSE_MIN, REVERSE_MAX);
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
    }

    bot.target.model.aimAt(cam.position.x, cam.position.y, cam.position.z);
    bot.target.model.update(dt, { crouch: bot.crouch });

    this._updateHoldGate(dt);
  }

  onShoot(raycaster) {
    const bot = this.bot;
    if (!bot || bot.target.state === 'dying') return;

    const hit = this.raycastTargets(raycaster);
    const tgt = hit?.object?.userData?.target;
    if (tgt !== bot.target) return; // plain miss — the bot keeps strafing

    if (this.holdTime > 0 && this._onTargetT < this.holdTime) {
      // On target, but not tracked long enough — the shot is not allowed yet.
      beep(240, 0.06, 'sawtooth', 0.05);
      return;
    }

    this.crosshair?.hit();
    this.hits++;
    this.kills++;
    if (hit.object.userData.zone === 'head') this.headshots++;
    this.score += 1;
    beep(1000, 0.05, 'square', 0.05);
    bot.target.startDying(0x35e06a);
    this.bot = null;
    this._onTargetT = 0;
    this.crosshair?.setTrackProgress(0);
    this._respawnIn = this.respawnDelay;
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }
}
