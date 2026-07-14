// ---------------------------------------------------------------------------
// PeekswitchBotsScenario.js  ("Peekswitch (Bots)")
//
// Same peek arena as Peekswitch (Static), but one duel-style bot spawns on
// ground level inside the active spawn zone. Kill it to pull the next bot from
// the opposite flank. Bots strafe, tap crouch, and can kill you like Duels.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { beep } from './BaseScenario.js';
import { buildCSBotTarget } from '../bots/buildBotTarget.js';
import { randRange, clamp, lerp, degToRad } from '../utils/MathUtils.js';
import { srcFriction, srcAccelerate, RUN_SPEED, STAND_EYE } from '../utils/SourceMovement.js';
import { resolveBoxCollisions, groundHeightAt } from '../utils/BoxCollision.js';
import { markBulletDecalSurface, worldImpactNormal } from '../utils/bulletImpact.js';
import { movementHitScale, movementReactionDelay, isPointVisible } from '../utils/spawnVisibility.js';
import { SHOT_INTERVAL } from '../weapons/ak47.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { BODY_R } from '../multiplayer/constants.js';
import { DEATH_OVERLAY_STRENGTH } from './deathFx.js';
import { botDifficultyMultipliers } from './botDifficulty.js';
import {
  PeekswitchBaseScenario,
  randomGroundInZone,
  spawnZoneAabb
} from './peekswitchCommon.js';

const PLAYER_HP = 2;
const OFF_ENGAGE_RANGE = 22;
const OFF_DESIRED_RANGE = 9;
const OFF_STRAFE_MIN = 0.18;
const OFF_STRAFE_MAX = 0.5;
const OFF_REPATH_MIN = 1.2;
const OFF_REPATH_MAX = 3.0;
const OFF_CROUCH_RATE = 10;
const BACKSHOT_FIRE_DELAY = 1.0;
const DEATH_FX_DUR = 0.55;
const DEATH_FX_PITCH = degToRad(38) * 0.25;
const BOT_RESPAWN_DELAY = 0.45;
const PLAYER_RESPAWN_DELAY = 0.9;

const _headPos = new THREE.Vector3();
const _eyePos = new THREE.Vector3();
const _aimPos = new THREE.Vector3();
const _tracerEnd = new THREE.Vector3();
const _impactNormal = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _losDir = new THREE.Vector3();
const _losRay = new THREE.Raycaster();

export class PeekswitchBotsScenario extends PeekswitchBaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'rifle';
    this.infiniteAmmo = true;
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const s = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.peekswitchbots;
    this._botHeadHitBase = preset?.botHeadHit ?? 0.08;
    this._botBodyHitBase = preset?.botBodyHit ?? 0.40;
    this._botHitRamp = preset?.botHitRamp ?? 0.01;
    this._botHp = Math.max(1, Math.round(preset?.botHp ?? this.config.botHp ?? s.botHp ?? 2));
    this._applyBotDifficulty(s);
    this._playerHp = PLAYER_HP;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : this.settings.data.runDuration;
    this.enemy = null;
    this._respawnTimer = null;
    this._deathFx = null;
  }

  get name() {
    return 'peekswitchbots';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return PeekswitchBotsScenario.configKeyFor(this.settings, this.variant);
  }

  _applyBotDifficulty(s) {
    if (this.competitive) {
      this._reactionMul = 1;
      this._hitMul = 1;
      return;
    }
    const mul = botDifficultyMultipliers(s?.botDifficulty);
    this._reactionMul = mul.reaction;
    this._hitMul = mul.hit;
  }

  _enemyHitRates() {
    const ramp = this.competitive ? this.kills * this._botHitRamp : 0;
    return {
      headHit: (this._botHeadHitBase + ramp) * this._hitMul,
      bodyHit: (this._botBodyHitBase + ramp) * this._hitMul
    };
  }

  _reactSeconds(seconds) {
    return this.competitive ? seconds : seconds * this._reactionMul;
  }

  _botReactionDelay(speed) {
    return this._reactSeconds(movementReactionDelay(speed));
  }

  _zoneBounds() {
    return spawnZoneAabb(this._currentZone());
  }

  _buildBot() {
    return buildCSBotTarget({
      colors: this.settings.data.colors,
      bodyPoints: 50,
      headPoints: 100,
      markDecal: markBulletDecalSurface
    });
  }

  _spawnEnemy() {
    const target = this._buildBot();
    this.addTarget(target);
    const spawn = randomGroundInZone(this._currentZone());
    const hitRates = this._enemyHitRates();
    this.enemy = {
      target,
      pos: { x: spawn.x, z: spawn.z },
      vel: { x: 0, z: 0 },
      footY: spawn.footY,
      hp: this._botHp,
      crouch: 0,
      crouchWant: 0,
      strafeDir: Math.random() < 0.5 ? -1 : 1,
      strafeTimer: randRange(OFF_STRAFE_MIN, OFF_STRAFE_MAX),
      goal: null,
      repathTimer: 0,
      stuckAccum: 0,
      stuckBias: 0,
      stuckDir: 1,
      fireTimer: randRange(0, SHOT_INTERVAL),
      sneakFireDelay: 0,
      sneakTargetKey: null,
      hadPlayerLos: false,
      playerReactDelay: 0,
      headHit: hitRates.headHit,
      bodyHit: hitRates.bodyHit
    };
    this._syncBotTransform();
  }

  _syncBotTransform() {
    const e = this.enemy;
    if (!e) return;
    e.target.object.position.set(e.pos.x, e.footY, e.pos.z);
  }

  _moveBot(e, wishX, wishZ, max, dt) {
    const len = Math.hypot(wishX, wishZ);
    if (len > 0) {
      wishX /= len;
      wishZ /= len;
    }
    srcFriction(e.vel, dt, len > 0 ? max : 0);
    if (len > 0) srcAccelerate(e.vel, wishX, wishZ, max, dt);

    e.pos.x += e.vel.x * dt;
    e.pos.z += e.vel.z * dt;

    const b = this._zoneBounds();
    e.pos.x = clamp(e.pos.x, b.minX + BODY_R, b.maxX - BODY_R);
    e.pos.z = clamp(e.pos.z, b.minZ + BODY_R, b.maxZ - BODY_R);

    e.footY = groundHeightAt(e.pos.x, e.pos.z, this.colliderBoxes, e.footY, 0);
    resolveBoxCollisions(e.pos, e.vel, e.footY, e.crouch, this.colliderBoxes);
  }

  _pickWanderGoal(e) {
    const b = this._zoneBounds();
    const px = this.camera.position.x;
    const pz = this.camera.position.z;
    for (let i = 0; i < 8; i++) {
      const t = Math.random();
      const gx = lerp(e.pos.x, px, t) + randRange(-2, 2);
      const gz = lerp(e.pos.z, pz, t) + randRange(-2, 2);
      e.goal = {
        x: clamp(gx, b.minX + BODY_R, b.maxX - BODY_R),
        z: clamp(gz, b.minZ + BODY_R, b.maxZ - BODY_R)
      };
      return;
    }
    e.goal = { x: px, z: pz };
  }

  _rollBotCrouch(e) {
    if (e.crouchWant) {
      if (Math.random() < 0.66) e.crouchWant = 0;
    } else if (Math.random() < 0.33) {
      e.crouchWant = 1;
    }
  }

  _botHeadHasLos(e) {
    const head = e.target.headMesh;
    if (!head) return false;
    head.getWorldPosition(_headPos);
    this.camera.getWorldPosition(_eyePos);
    const dist = _headPos.distanceTo(_eyePos);
    if (dist < 1e-4) return true;
    _losDir.copy(_eyePos).sub(_headPos).multiplyScalar(1 / dist);
    _losRay.set(_headPos, _losDir);
    _losRay.far = dist;
    const hits = _losRay.intersectObjects(this.coverMeshes, false);
    return hits.length === 0 || hits[0].distance >= dist - 0.04;
  }

  _playerSeesBot(e) {
    const head = e.target.headMesh;
    if (!head || !this.engine.player?.enabled) return false;
    head.getWorldPosition(_headPos);
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    return isPointVisible(
      [cam.position.x, cam.position.y, cam.position.z],
      [_fwd.x, _fwd.y, _fwd.z],
      [_headPos.x, _headPos.y, _headPos.z],
      this.settings.data.hFov,
      this.coverColliderBoxes
    );
  }

  _tracerImpact(from, tx, ty, tz) {
    const dist = from.distanceTo(_aimPos.set(tx, ty, tz));
    if (dist < 1e-4) {
      return { point: _tracerEnd.copy(_aimPos), normal: null, decal: false };
    }
    _losDir.copy(_aimPos).sub(from).multiplyScalar(1 / dist);
    _losRay.set(from, _losDir);
    _losRay.far = dist;
    const hits = _losRay.intersectObjects(this.coverMeshes, false);
    if (hits.length && hits[0].distance < dist - 0.04) {
      const h = hits[0];
      return {
        point: _tracerEnd.copy(h.point),
        normal: worldImpactNormal(h, _impactNormal),
        decal: true
      };
    }
    return { point: _tracerEnd.copy(_aimPos), normal: null, decal: false };
  }

  _botFire(e) {
    const head = e.target.headMesh;
    if (!head || !this.engine.player?.enabled) return;
    head.getWorldPosition(_headPos);
    this.camera.getWorldPosition(_eyePos);

    this.engine.audio?.playRemoteShot(_headPos.x, _headPos.y, _headPos.z);
    const impact = this._tracerImpact(_headPos, _eyePos.x, _eyePos.y, _eyePos.z);
    const vm = this.engine.viewmodel;
    vm?.spawnTracer(_headPos, impact.point);
    vm?.spawnBulletImpact(impact.point, impact.normal, { decal: impact.decal });

    const p = this.engine.player;
    const speed = p?.enabled ? Math.hypot(p.vel.x, p.vel.z) : 0;
    const hitScale = movementHitScale(speed, RUN_SPEED);
    const headHit = e.headHit * hitScale;
    const bodyHit = e.bodyHit * hitScale;
    const roll = Math.random();
    const zone = roll < headHit ? 'head' : roll < headHit + bodyHit ? 'body' : null;
    if (!zone) return;
    if (zone === 'head') this._onPlayerDeath(true);
    else this._damagePlayer();
  }

  _damagePlayer() {
    if (!this.engine.player?.enabled) return;
    this._playerHp -= 1;
    beep(520, 0.04, 'square', 0.08);
    if (this._playerHp <= 0) this._onPlayerDeath(false);
  }

  _onPlayerDeath() {
    this.misses++;
    beep(180, 0.1, 'sawtooth', 0.2);
    const e = this.enemy;
    if (e) e.target.startDying(0xff4d4d);
    this.enemy = null;

    if (this.engine.player) this.engine.player.enabled = false;
    const input = this.engine.player?.input;
    this._deathFx = {
      t: 0,
      duration: DEATH_FX_DUR,
      startPitch: input ? input.pitch : this.engine.camera.rotation.x,
      flick: DEATH_FX_PITCH
    };
    this._respawnTimer = DEATH_FX_DUR + PLAYER_RESPAWN_DELAY;
    this._respawnAfterDeath = true;
  }

  _updateDeathFx(dt) {
    const fx = this._deathFx;
    if (!fx) return;

    fx.t += dt;
    const p = Math.min(1, fx.t / fx.duration);
    const lift = Math.sin(p * Math.PI) * fx.flick;
    this.engine.setDeathOverlay(DEATH_OVERLAY_STRENGTH * (1 - p));
    const input = this.engine.player?.input;
    if (input) input.pitch = fx.startPitch - lift;

    if (fx.t >= fx.duration) {
      this._deathFx = null;
      this.engine.setDeathOverlay(0);
    }
  }

  _updateEnemy(dt) {
    const e = this.enemy;
    if (!e || e.target.state === 'dying') return;

    const max = RUN_SPEED;
    const px = this.camera.position.x;
    const py = this.camera.position.y;
    const pz = this.camera.position.z;
    const prevX = e.pos.x;
    const prevZ = e.pos.z;

    const hasLos = this._botHeadHasLos(e);
    const dx = px - e.pos.x;
    const dz = pz - e.pos.z;
    const dist = Math.hypot(dx, dz) || 1e-4;
    const dirX = dx / dist;
    const dirZ = dz / dist;

    let wishX = 0;
    let wishZ = 0;
    let engaged = false;

    if (hasLos && dist < OFF_ENGAGE_RANGE && this.engine.player?.enabled) {
      engaged = true;
      e.strafeTimer -= dt;
      if (e.strafeTimer <= 0) {
        e.strafeDir = -e.strafeDir;
        e.strafeTimer = randRange(OFF_STRAFE_MIN, OFF_STRAFE_MAX);
      }
      const perpX = -dirZ;
      const perpZ = dirX;
      wishX = perpX * e.strafeDir;
      wishZ = perpZ * e.strafeDir;
      const rangeErr = clamp(dist - OFF_DESIRED_RANGE, -1, 1);
      wishX += dirX * rangeErr * 0.85;
      wishZ += dirZ * rangeErr * 0.85;
      e.goal = null;

      if (!e.hadPlayerLos) {
        const p = this.engine.player;
        const speed = p?.enabled ? Math.hypot(p.vel.x, p.vel.z) : 0;
        e.playerReactDelay = this._botReactionDelay(speed);
        e.hadPlayerLos = true;
      }
      e.playerReactDelay = Math.max(0, e.playerReactDelay - dt);

      const playerSeesBot = this._playerSeesBot(e);
      if (playerSeesBot) {
        e.sneakFireDelay = 0;
        e.sneakTargetKey = 'player';
      } else if (e.sneakTargetKey !== 'player') {
        e.sneakTargetKey = 'player';
        e.sneakFireDelay = this._reactSeconds(BACKSHOT_FIRE_DELAY);
      } else {
        e.sneakFireDelay = Math.max(0, e.sneakFireDelay - dt);
      }

      const mayFire = (playerSeesBot || e.sneakFireDelay <= 0) && e.playerReactDelay <= 0;
      e.fireTimer -= dt;
      if (mayFire && e.fireTimer <= 0) {
        e.fireTimer = SHOT_INTERVAL;
        this._botFire(e);
        this._rollBotCrouch(e);
      }
    } else {
      e.sneakFireDelay = 0;
      e.sneakTargetKey = null;
      e.hadPlayerLos = false;
      e.playerReactDelay = 0;
      e.repathTimer -= dt;
      if (!e.goal || e.repathTimer <= 0) {
        this._pickWanderGoal(e);
        e.repathTimer = randRange(OFF_REPATH_MIN, OFF_REPATH_MAX);
      }
      let gx = e.goal.x - e.pos.x;
      let gz = e.goal.z - e.pos.z;
      const glen = Math.hypot(gx, gz) || 1e-4;
      gx /= glen;
      gz /= glen;
      if (e.stuckBias > 0) {
        const baseX = gx;
        const baseZ = gz;
        gx = baseX - baseZ * e.stuckDir * 1.3;
        gz = baseZ + baseX * e.stuckDir * 1.3;
        e.stuckBias -= dt;
      }
      wishX = gx;
      wishZ = gz;
      if (glen < 1.0) e.goal = null;
    }

    this._moveBot(e, wishX, wishZ, max, dt);

    if (!engaged) {
      const moved = Math.hypot(e.pos.x - prevX, e.pos.z - prevZ);
      if (moved < max * dt * 0.3) {
        e.stuckAccum += dt;
        if (e.stuckAccum > 0.3) {
          e.stuckBias = 0.6;
          e.stuckDir = Math.random() < 0.5 ? -1 : 1;
          e.stuckAccum = 0;
          e.goal = null;
        }
      } else {
        e.stuckAccum = 0;
      }
    }

    e.crouch = clamp(
      e.crouch + (e.crouchWant - e.crouch) * Math.min(1, OFF_CROUCH_RATE * dt),
      0,
      1
    );

    this._syncBotTransform();
    e.target.model.aimAt(px, py, pz);
    e.target.model.update(dt, { crouch: e.crouch });
    this._updateBotFootsteps(e, dt);
  }

  _updateBotFootsteps(e, dt) {
    const audio = this.engine.audio;
    if (!audio || !e?.target?.object) return;
    if (!e._audioRemote) {
      e._audioRemote = { cur: { x: 0, y: 0, z: 0, crouch: 0 }, dead: false };
    }
    const r = e._audioRemote;
    const pos = e.target.object.position;
    r.cur.x = pos.x;
    r.cur.y = pos.y + STAND_EYE;
    r.cur.z = pos.z;
    r.cur.crouch = e.crouch;
    r.dead = e.target.state === 'dying';
    audio.updateRemotePlayer(0, r, dt);
  }

  _killEnemy() {
    const e = this.enemy;
    e.target.startDying(0x35e06a);
    this.enemy = null;
    this._playerHp = PLAYER_HP;
    this._advanceZone();
    this._respawnTimer = BOT_RESPAWN_DELAY;
    this._respawnAfterDeath = false;
  }

  onStart() {
    super.onStart();
    this._spawnEnemy();
  }

  onUpdate(dt) {
    this._updateEnemy(dt);
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster, this.coverMeshes);
    if (!hit) return;
    const obj = hit.object;
    const tgt = obj.userData.target;
    const e = this.enemy;
    if (!tgt || !e || tgt !== e.target || e.target.state === 'dying') return;

    this.crosshair?.hit();
    const zone = obj.userData.zone;
    if (zone === 'head') {
      this.hits++;
      this.headshots++;
      this.kills++;
      this.score += obj.userData.points;
      beep(1000, 0.05, 'square', 0.05);
      this._killEnemy();
    } else {
      this.hits++;
      this.score += obj.userData.points;
      e.hp -= 1;
      beep(520, 0.04, 'square', 0.04);
      if (e.hp <= 0) {
        this.kills++;
        this._killEnemy();
      } else {
        const mat = obj.material;
        mat.emissiveIntensity = 1.0;
        setTimeout(() => {
          try {
            mat.emissiveIntensity = 0.4;
          } catch (err) {
            /* disposed */
          }
        }, 80);
      }
    }
  }

  update(dt) {
    super.update(dt);
    if (!this.running) return;
    this._updateDeathFx(dt);
    if (this._respawnTimer != null) {
      this._respawnTimer -= dt;
      if (this._respawnTimer <= 0) {
        this._respawnTimer = null;
        this.engine.weapon?.reset();
        if (this._respawnAfterDeath) {
          this._respawnAfterDeath = false;
          this._respawnPlayer();
          this._spawnEnemy();
        } else {
          this._spawnEnemy();
        }
      }
    }
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }
}
