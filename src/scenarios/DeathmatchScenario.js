// ---------------------------------------------------------------------------
// DeathmatchScenario.js  ("Deathmatch")
//
// Free-for-all on the deathmatch arena. Bots path toward enemies, jiggle-peek,
// and fire rifle bursts when they have line-of-sight — at you and at each other.
// Each bullet rolls independently for a hit (practice: 20% body / 5% head;
// competitive: 30% body / 10% head). Head = instant kill · Body = 2 shots.
//
//   Practice: bot count / speed / hit odds are tunable.
//   Competitive: fixed rules, 60 s, ranked by kills.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, clamp, lerp, degToRad } from '../utils/MathUtils.js';
import { srcFriction, srcAccelerate, RUN_SPEED, STAND_EYE } from '../utils/SourceMovement.js';
import { resolveBoxCollisions, groundHeightAt } from '../utils/BoxCollision.js';
import { gridLineColors, createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';
import { markBulletDecalSurface } from '../utils/bulletImpact.js';
import { SHOT_INTERVAL } from '../weapons/ak47.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEATHMATCH_MAP, deathmatchExtent } from './deathmatchMap.js';
import { eyeOffset, SPAWN_GRACE } from '../multiplayer/constants.js';
import { pickSpawnPreferHidden, movementHitScale, isPointVisible } from '../utils/spawnVisibility.js';
import { worldImpactNormal } from '../utils/bulletImpact.js';
import {
  DM_DEATH_FX_DUR,
  DM_DEATH_FX_PITCH,
  updateDeathFxFrame
} from './deathFx.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_R = 0.27;
const HEAD_Y = BODY_H + HEAD_R + 0.02;

const ENGAGE_RANGE = 22; // m — within this (and with LOS) a bot holds & jiggles
const DESIRED_RANGE = 9; // m — preferred fighting distance while engaged
const STRAFE_MIN = 0.18; // s between jiggle direction flips
const STRAFE_MAX = 0.5;
const REPATH_MIN = 1.2; // s between picking a fresh wander goal when blind
const REPATH_MAX = 3.0;
const CROUCH_GAP_MIN = 1.4;
const CROUCH_GAP_MAX = 3.5;
const CROUCH_HOLD_MIN = 0.2;
const CROUCH_HOLD_MAX = 0.55;
const CROUCH_RATE = 10;
const BACKSHOT_FIRE_DELAY = 1.0; // s — bot waits before firing when target isn't looking

const MAX_PITCH = degToRad(89);
const BOT_RESPAWN_DELAY = 0.5;

const PLAYER_HP = 2;
const PLAYER_BOARD_ID = 'player';
const KILL_FEED_MAX = 6;
const KILL_FEED_TTL_MS = 9000;

const _headPos = new THREE.Vector3();
const _aimPos = new THREE.Vector3();
const _losDir = new THREE.Vector3();
const _losRay = new THREE.Raycaster();
const _tracerEnd = new THREE.Vector3();
const _impactNormal = new THREE.Vector3();

export class DeathmatchScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const d = this.settings.data.deathmatch;
    const preset = this.competitive ? competitivePresetFor('deathmatch') : null;

    this.botCount = clamp(
      Math.round(preset?.botCount ?? this.config.botCount ?? d.botCount ?? 4),
      1,
      6
    );
    this.botSpeedMul = preset?.botSpeed ?? this.config.botSpeed ?? d.botSpeed ?? 1.0;
    this._bodyHit = preset?.botBodyHit ?? this.config.botBodyHit ?? d.botBodyHit ?? 0.2;
    this._headHit = preset?.botHeadHit ?? this.config.botHeadHit ?? d.botHeadHit ?? 0.05;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : Infinity;

    this.map = DEATHMATCH_MAP;
    this.colliders = this.map.boxes;
    this.coverMeshes = [];
    this._envObjects = [];
    this.bots = [];
    this._botSeq = 0;
    this._dead = false;
    this._playerHp = PLAYER_HP;
    this._deathFx = null;
    this._board = new Map();
    this._killFeed = [];
    this._lastAttackerBotId = null;

    this._buildEnvironment();
  }

  get name() {
    return 'deathmatch';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const d = settings.data.deathmatch;
    return `n${d.botCount}_spd${d.botSpeed}_bh${d.botBodyHit}_hh${d.botHeadHit}`;
  }
  configKey() {
    return DeathmatchScenario.configKeyFor(this.settings, this.variant);
  }

  tracerRaycastExtras() {
    return this.coverMeshes;
  }

  getScoreboardRows() {
    return [...this._board.values()].sort(
      (a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name)
    );
  }

  getKillFeedEntries() {
    const now = performance.now();
    return this._killFeed
      .filter((e) => now - e.at < KILL_FEED_TTL_MS)
      .map((e) => ({
        killer: this._board.get(e.killerId)?.name ?? '?',
        victim: this._board.get(e.victimId)?.name ?? '?',
        headshot: e.headshot
      }));
  }

  _ensureBoardEntry(id, name) {
    if (!this._board.has(id)) {
      this._board.set(id, { id, name, kills: 0, deaths: 0, isPlayer: id === PLAYER_BOARD_ID });
    }
    return this._board.get(id);
  }

  _pushKillFeed(killerId, victimId, { headshot = false } = {}) {
    this._killFeed.unshift({ killerId, victimId, headshot, at: performance.now() });
    if (this._killFeed.length > KILL_FEED_MAX) this._killFeed.length = KILL_FEED_MAX;
  }

  _recordKill(killerId, victimId, { headshot = false } = {}) {
    if (!this._board.has(killerId) || !this._board.has(victimId)) return;
    const killer = this._board.get(killerId);
    const victim = this._board.get(victimId);
    killer.kills++;
    victim.deaths++;
    this._pushKillFeed(killerId, victimId, { headshot });
  }

  // ---- Environment --------------------------------------------------------
  _buildEnvironment() {
    const add = (obj) => { this.root.add(obj); this._envObjects.push(obj); return obj; };
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const ext = deathmatchExtent(this.map);
    const size = ext * 2;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    add(floor);

    const grid = new THREE.GridHelper(size, Math.round(size / 2), gridCenter, gridEdge);
    grid.position.y = 0.002;
    add(grid);

    const boxMat = createCoverGridMaterial(c.cover, c.floor);
    for (const b of this.map.boxes) {
      const mat = boxMat.clone();
      mat.map = mat.map.clone();
      applyCoverGridRepeat(mat, b.size[0], b.size[1]);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]), mat);
      mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
      if (b.rotationY) mesh.rotation.y = b.rotationY;
      markBulletDecalSurface(mesh);
      add(mesh);
      this.coverMeshes.push(mesh);
    }
  }

  // ---- Spawns -------------------------------------------------------------
  _isInPlayerGrace() {
    return (this.engine.player?.input?.spawnGraceRemaining ?? 0) > 0;
  }

  /** Living observers whose active view we avoid when placing respawns. */
  _collectSpawnViewers() {
    const hFov = this.settings.data.hFov;
    const views = [];
    if (!this._dead && !this._isInPlayerGrace()) {
      const cam = this.camera;
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      views.push({
        eye: [cam.position.x, cam.position.y, cam.position.z],
        dir: [fwd.x, fwd.y, fwd.z],
        hFov
      });
    }
    for (const bot of this.bots) {
      if (bot.target.state === 'dying' || bot.spawnGrace > 0) continue;
      const ey = this._botEyePos(bot);
      const fwd = new THREE.Vector3();
      bot.target.object.getWorldDirection(fwd);
      views.push({
        eye: [bot.pos.x, ey, bot.pos.z],
        dir: [fwd.x, fwd.y, fwd.z],
        hFov
      });
    }
    return views;
  }

  /** Prefer spawns out of everyone's FOV; fall back to farthest from `avoid`. */
  _pickSpawn(avoid = []) {
    return pickSpawnPreferHidden(
      this.map.spawns,
      avoid,
      this._collectSpawnViewers(),
      this.colliders
    );
  }

  _playerPos() {
    return [this.camera.position.x, this.camera.position.y, this.camera.position.z];
  }

  _yawToward(from, to) {
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    return Math.atan2(-dx, -dz);
  }

  // ---- Bots ---------------------------------------------------------------
  _buildBot() {
    const t = new Target();
    const bodyRig = new THREE.Group();
    t.object.add(bodyRig);

    const c = this.settings.data.colors;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 18),
      new THREE.MeshStandardMaterial({ color: c.enemyBody, emissive: 0x661222, emissiveIntensity: 0.4, roughness: 0.5 })
    );
    body.position.y = BODY_H / 2;
    body.userData.target = t;
    body.userData.zone = 'body';
    body.userData.points = 35;
    body.userData.crit = false;
    t.colliders.push(body);
    bodyRig.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R, 22, 16),
      new THREE.MeshStandardMaterial({ color: c.enemyHead, emissive: 0xff7b00, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    head.position.y = HEAD_Y;
    t.addCollider(head, { zone: 'head', points: 100, crit: true });

    t.rig = bodyRig;
    t.headMesh = head;
    return t;
  }

  _spawnBot(avoid = [], slotIndex = 0) {
    const target = this._buildBot();
    this.addTarget(target);
    const sp = this._pickSpawn(avoid);
    const boardKey = `bot-${slotIndex}`;
    this._ensureBoardEntry(boardKey, `Bot ${slotIndex + 1}`);
    const bot = {
      id: this._botSeq++,
      boardKey,
      target,
      pos: { x: sp.pos[0], z: sp.pos[2] },
      vel: { x: 0, z: 0 },
      footY: sp.pos[1] || 0,
      hp: 2,
      crouch: 0,
      crouchWant: 0,
      crouchTimer: randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX),
      strafeDir: Math.random() < 0.5 ? -1 : 1,
      strafeTimer: randRange(STRAFE_MIN, STRAFE_MAX),
      repathTimer: 0,
      goal: null,
      stuckAccum: 0,
      stuckBias: 0,
      stuckDir: 1,
      fireTimer: randRange(0, SHOT_INTERVAL),
      spawnGrace: SPAWN_GRACE,
      sneakFireDelay: 0,
      sneakTargetKey: null
    };
    this.bots.push(bot);
    target.object.position.set(bot.pos.x, bot.footY, bot.pos.z);
    return bot;
  }

  /** Line-of-sight between two world points (cover occludes). */
  _hasLos(fromX, fromY, fromZ, tx, ty, tz) {
    const dist = Math.hypot(tx - fromX, ty - fromY, tz - fromZ);
    if (dist < 1e-4) return true;
    _headPos.set(fromX, fromY, fromZ);
    _losDir.set(tx - fromX, ty - fromY, tz - fromZ).multiplyScalar(1 / dist);
    _losRay.set(_headPos, _losDir);
    _losRay.far = dist;
    const hits = _losRay.intersectObjects(this.coverMeshes, false);
    return hits.length === 0 || hits[0].distance >= dist - 0.04;
  }

  /** Line-of-sight from a bot's head to a world point (cover occludes). */
  _botHasLosTo(bot, tx, ty, tz) {
    const head = bot.target.headMesh;
    if (!head) return false;
    head.getWorldPosition(_headPos);
    return this._hasLos(_headPos.x, _headPos.y, _headPos.z, tx, ty, tz);
  }

  _botEyePos(b) {
    const c = b.crouch || 0;
    return b.footY + eyeOffset(c);
  }

  /** Closest shootable target in range with LOS (player or another bot). */
  _pickShootTarget(bot) {
    const px = this.camera.position.x;
    const py = this.camera.position.y;
    const pz = this.camera.position.z;
    let best = null;
    let bestDist = ENGAGE_RANGE;

    if (!this._dead && !this._isInPlayerGrace() && this._botHasLosTo(bot, px, py, pz)) {
      const d = Math.hypot(px - bot.pos.x, pz - bot.pos.z);
      if (d < bestDist) {
        bestDist = d;
        best = { type: 'player', x: px, y: py, z: pz, dist: d };
      }
    }

    for (const other of this.bots) {
      if (other === bot || other.target.state === 'dying' || other.spawnGrace > 0) continue;
      const ey = this._botEyePos(other);
      if (!this._botHasLosTo(bot, other.pos.x, ey, other.pos.z)) continue;
      const d = Math.hypot(other.pos.x - bot.pos.x, other.pos.z - bot.pos.z);
      if (d < bestDist) {
        bestDist = d;
        best = { type: 'bot', bot: other, x: other.pos.x, y: ey, z: other.pos.z, dist: d };
      }
    }
    return best;
  }

  _shootTargetKey(target) {
    return target.type === 'player' ? 'player' : target.bot.id;
  }

  /** True when the shoot target's view cone includes this bot (FOV + cover LOS). */
  _targetSeesBot(attacker, target) {
    const hFov = this.settings.data.hFov;
    const head = attacker.target.headMesh;
    if (!head) return false;
    head.getWorldPosition(_headPos);
    const botPoint = [_headPos.x, _headPos.y, _headPos.z];
    const boxes = this.colliders;

    if (target.type === 'player') {
      if (this._dead || this._isInPlayerGrace()) return false;
      const cam = this.camera;
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      return isPointVisible(
        [cam.position.x, cam.position.y, cam.position.z],
        [fwd.x, fwd.y, fwd.z],
        botPoint,
        hFov,
        boxes
      );
    }

    const other = target.bot;
    const ey = this._botEyePos(other);
    const fwd = new THREE.Vector3();
    other.target.object.getWorldDirection(fwd);
    return isPointVisible(
      [other.pos.x, ey, other.pos.z],
      [fwd.x, fwd.y, fwd.z],
      botPoint,
      hFov,
      boxes
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

  _targetHitScale(target, maxSpeed) {
    if (target.type === 'player') {
      const p = this.engine.player;
      const speed = p?.enabled ? Math.hypot(p.vel.x, p.vel.z) : 0;
      return movementHitScale(speed, maxSpeed);
    }
    const speed = Math.hypot(target.bot.vel.x, target.bot.vel.z);
    return movementHitScale(speed, maxSpeed);
  }

  _botFire(bot, target) {
    if (bot.spawnGrace > 0) return;
    if (target.type === 'player' && this._isInPlayerGrace()) return;

    const head = bot.target.headMesh;
    if (!head) return;
    head.getWorldPosition(_headPos);

    this.engine.audio?.playRemoteShot(_headPos.x, _headPos.y, _headPos.z);
    const impact = this._tracerImpact(_headPos, target.x, target.y, target.z);
    const vm = this.engine.viewmodel;
    vm?.spawnTracer(_headPos, impact.point);
    vm?.spawnBulletImpact(impact.point, impact.normal, { decal: impact.decal });

    const max = RUN_SPEED * this.botSpeedMul;
    const hitScale = this._targetHitScale(target, max);
    const headHit = this._headHit * hitScale;
    const bodyHit = this._bodyHit * hitScale;
    const roll = Math.random();
    const zone = roll < headHit ? 'head' : roll < headHit + bodyHit ? 'body' : null;
    if (!zone) return;

    if (target.type === 'player') {
      this._lastAttackerBotId = bot.id;
      if (zone === 'head') this._onPlayerDeath(true);
      else this._damagePlayer();
    } else {
      this._botHitBot(bot, target.bot, zone);
    }
  }

  _damagePlayer() {
    if (this._dead || this._isInPlayerGrace()) return;
    this._playerHp -= 1;
    beep(520, 0.04, 'square', 0.08);
    if (this._playerHp <= 0) this._onPlayerDeath(false);
  }

  _botHitBot(attacker, victim, zone) {
    if (victim.target.state === 'dying') return;
    if (zone === 'head') {
      this._killBot(victim, false, attacker, true);
    } else {
      victim.hp -= 1;
      if (victim.hp <= 0) this._killBot(victim, false, attacker, false);
    }
  }

  /** Advance one bot with a (possibly unnormalized) wish direction. */
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

    const b = this.map.bounds;
    bot.pos.x = clamp(bot.pos.x, b.minX + BODY_R, b.maxX - BODY_R);
    bot.pos.z = clamp(bot.pos.z, b.minZ + BODY_R, b.maxZ - BODY_R);

    bot.footY = groundHeightAt(bot.pos.x, bot.pos.z, this.colliders, bot.footY, 0);
    resolveBoxCollisions(bot.pos, bot.vel, bot.footY, bot.crouch, this.colliders);
  }

  /** True when (x, z) lies inside any cover box footprint (honours rotationY). */
  _pointInCover(x, z) {
    for (const box of this.colliders) {
      let dx = x - box.pos[0];
      let dz = z - box.pos[2];
      const ry = box.rotationY || 0;
      if (ry) {
        const c = Math.cos(-ry);
        const s = Math.sin(-ry);
        const lx = dx * c - dz * s;
        const lz = dx * s + dz * c;
        dx = lx;
        dz = lz;
      }
      if (Math.abs(dx) <= box.size[0] / 2 + BODY_R && Math.abs(dz) <= box.size[2] / 2 + BODY_R) {
        return true;
      }
    }
    return false;
  }

  _pickWanderGoal(bot) {
    const b = this.map.bounds;
    // Bias the wander toward the player so blind bots converge instead of idling.
    const px = this.camera.position.x;
    const pz = this.camera.position.z;
    for (let i = 0; i < 8; i++) {
      const t = Math.random();
      const gx = lerp(bot.pos.x, px, t) + randRange(-8, 8);
      const gz = lerp(bot.pos.z, pz, t) + randRange(-8, 8);
      const x = clamp(gx, b.minX + 1, b.maxX - 1);
      const z = clamp(gz, b.minZ + 1, b.maxZ - 1);
      if (!this._pointInCover(x, z)) {
        bot.goal = { x, z };
        return;
      }
    }
    bot.goal = { x: clamp(px, b.minX + 1, b.maxX - 1), z: clamp(pz, b.minZ + 1, b.maxZ - 1) };
  }

  // ---- Round flow ---------------------------------------------------------
  onStart() {
    this._board.clear();
    this._killFeed = [];
    this._lastAttackerBotId = null;
    this._ensureBoardEntry(PLAYER_BOARD_ID, 'You');

    const spawn = this._pickSpawn();
    this.engine.player.spawn({
      pos: spawn.pos,
      yaw: this._yawToward(spawn.pos, [0, 0, 0]),
      bounds: this.map.bounds,
      colliders: this.colliders,
      spawnGrace: SPAWN_GRACE
    });

    const avoid = [spawn.pos];
    for (let i = 0; i < this.botCount; i++) {
      const bot = this._spawnBot(avoid, i);
      avoid.push([bot.pos.x, bot.footY, bot.pos.z]);
    }
    this._playerHp = PLAYER_HP;
  }

  onUpdate(dt) {
    const max = RUN_SPEED * this.botSpeedMul;
    const px = this.camera.position.x;
    const pz = this.camera.position.z;

    for (const bot of this.bots) {
      if (bot.target.state === 'dying') continue;

      if (bot.spawnGrace > 0) {
        bot.spawnGrace -= dt;
        bot.target.object.position.set(bot.pos.x, bot.footY, bot.pos.z);
        continue;
      }

      const prevX = bot.pos.x;
      const prevZ = bot.pos.z;

      const shootTarget = this._pickShootTarget(bot);
      const hasLos = !!shootTarget;
      const tx = shootTarget?.x ?? px;
      const tz = shootTarget?.z ?? pz;
      const dx = tx - bot.pos.x;
      const dz = tz - bot.pos.z;
      const dist = Math.hypot(dx, dz) || 1e-4;
      const dirX = dx / dist;
      const dirZ = dz / dist;

      let wishX = 0;
      let wishZ = 0;
      let engaged = false;

      if (hasLos && dist < ENGAGE_RANGE) {
        engaged = true;
        bot.strafeTimer -= dt;
        if (bot.strafeTimer <= 0) {
          bot.strafeDir = -bot.strafeDir;
          bot.strafeTimer = randRange(STRAFE_MIN, STRAFE_MAX);
        }
        const perpX = -dirZ;
        const perpZ = dirX;
        wishX = perpX * bot.strafeDir;
        wishZ = perpZ * bot.strafeDir;
        const rangeErr = clamp(dist - DESIRED_RANGE, -1, 1);
        wishX += dirX * rangeErr * 0.85;
        wishZ += dirZ * rangeErr * 0.85;
        bot.goal = null;

        const targetKey = this._shootTargetKey(shootTarget);
        const targetSeesMe = this._targetSeesBot(bot, shootTarget);
        if (targetSeesMe) {
          bot.sneakFireDelay = 0;
          bot.sneakTargetKey = targetKey;
        } else if (bot.sneakTargetKey !== targetKey) {
          bot.sneakTargetKey = targetKey;
          bot.sneakFireDelay = BACKSHOT_FIRE_DELAY;
        } else {
          bot.sneakFireDelay = Math.max(0, bot.sneakFireDelay - dt);
        }

        const mayFire = targetSeesMe || bot.sneakFireDelay <= 0;
        bot.fireTimer -= dt;
        if (mayFire && bot.fireTimer <= 0) {
          bot.fireTimer = SHOT_INTERVAL;
          this._botFire(bot, shootTarget);
        }
      } else {
        bot.sneakFireDelay = 0;
        bot.sneakTargetKey = null;
        bot.repathTimer -= dt;
        if (!bot.goal || bot.repathTimer <= 0) {
          this._pickWanderGoal(bot);
          bot.repathTimer = randRange(REPATH_MIN, REPATH_MAX);
        }
        let gx = bot.goal.x - bot.pos.x;
        let gz = bot.goal.z - bot.pos.z;
        const glen = Math.hypot(gx, gz) || 1e-4;
        gx /= glen;
        gz /= glen;
        if (bot.stuckBias > 0) {
          const baseX = gx;
          const baseZ = gz;
          gx = baseX - baseZ * bot.stuckDir * 1.3;
          gz = baseZ + baseX * bot.stuckDir * 1.3;
          bot.stuckBias -= dt;
        }
        wishX = gx;
        wishZ = gz;
        if (glen < 1.0) bot.goal = null;
      }

      this._moveBot(bot, wishX, wishZ, max, dt);

      if (!engaged) {
        const moved = Math.hypot(bot.pos.x - prevX, bot.pos.z - prevZ);
        if (moved < max * dt * 0.3) {
          bot.stuckAccum += dt;
          if (bot.stuckAccum > 0.3) {
            bot.stuckBias = 0.6;
            bot.stuckDir = Math.random() < 0.5 ? -1 : 1;
            bot.stuckAccum = 0;
            bot.goal = null;
          }
        } else {
          bot.stuckAccum = 0;
        }
      }

      bot.crouchTimer -= dt;
      if (bot.crouchWant && bot.crouchTimer <= 0) {
        bot.crouchWant = 0;
        bot.crouchTimer = randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX);
      } else if (!bot.crouchWant && bot.crouchTimer <= 0) {
        bot.crouchWant = engaged && Math.random() < 0.5 ? 1 : 0;
        bot.crouchTimer = randRange(CROUCH_HOLD_MIN, CROUCH_HOLD_MAX);
      }
      bot.crouch = clamp(bot.crouch + (bot.crouchWant - bot.crouch) * Math.min(1, CROUCH_RATE * dt), 0, 1);
      if (bot.target.rig) bot.target.rig.scale.y = lerp(1, 0.55, bot.crouch);
      if (bot.target.headMesh) {
        bot.target.headMesh.position.y = BODY_H * lerp(1, 0.55, bot.crouch) + HEAD_R + 0.02;
      }

      bot.target.object.position.set(bot.pos.x, bot.footY, bot.pos.z);
      const lookY = shootTarget?.y ?? bot.footY + 1.0;
      bot.target.object.lookAt(tx, lookY, tz);

      this._updateBotFootsteps(bot, dt);
    }
  }

  _updateBotFootsteps(bot, dt) {
    const audio = this.engine.audio;
    if (!audio || !bot?.target?.object) return;
    if (!bot._audioRemote) {
      bot._audioRemote = { cur: { x: 0, y: 0, z: 0, crouch: 0 }, dead: false };
    }
    const r = bot._audioRemote;
    r.cur.x = bot.pos.x;
    r.cur.y = bot.footY + STAND_EYE;
    r.cur.z = bot.pos.z;
    r.cur.crouch = bot.crouch;
    r.dead = bot.target.state === 'dying';
    audio.updateRemotePlayer(bot.id, r, dt);
  }

  // ---- Player death / respawn --------------------------------------------
  _onPlayerDeath(headshot = false) {
    if (this._dead) return;
    this._dead = true;
    this.deaths = (this.deaths || 0) + 1;
    if (this._lastAttackerBotId != null) {
      const attacker = this.bots.find((b) => b.id === this._lastAttackerBotId);
      if (attacker) {
        this._recordKill(attacker.boardKey, PLAYER_BOARD_ID, { headshot });
      }
    }
    this._lastAttackerBotId = null;
    beep(180, 0.1, 'sawtooth', 0.2);

    if (this.engine.player) this.engine.player.enabled = false;
    const input = this.engine.player?.input;
    this._deathFx = {
      t: 0,
      duration: DM_DEATH_FX_DUR,
      startPitch: input ? input.pitch : this.engine.camera.rotation.x,
      flick: DM_DEATH_FX_PITCH
    };
  }

  _respawnPlayer() {
    const botPts = this.bots.map((b) => [b.pos.x, b.footY, b.pos.z]);
    const spawn = this._pickSpawn(botPts);
    this.engine.weapon?.reset();
    this._playerHp = PLAYER_HP;
    this.engine.player.spawn({
      pos: spawn.pos,
      yaw: this._yawToward(spawn.pos, [0, 0, 0]),
      bounds: this.map.bounds,
      colliders: this.colliders,
      spawnGrace: SPAWN_GRACE
    });
    this._dead = false;
  }

  _updateDeathFx(dt) {
    const fx = this._deathFx;
    if (!fx) return;
    const { red, flick, done } = updateDeathFxFrame(fx, dt, {
      duration: fx.duration,
      flickAmount: fx.flick
    });
    this.engine.setDeathOverlay(red);

    const pitch = clamp(fx.startPitch + flick, -MAX_PITCH, MAX_PITCH);
    this.engine.camera.rotation.x = pitch;
    const input = this.engine.player?.input;
    if (input) input.pitch = pitch;

    if (done) {
      this._deathFx = null;
      this.engine.setDeathOverlay(0);
      if (this._dead) this._respawnPlayer();
    }
  }

  // ---- Player shooting bots ----------------------------------------------
  onShoot(raycaster) {
    if (this._isInPlayerGrace()) return;
    const hit = this.raycastTargets(raycaster, this.coverMeshes);
    if (!hit) return;
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt) return; // hit cover → blocked
    const bot = this.bots.find((b) => b.target === tgt);
    if (!bot || bot.target.state === 'dying' || bot.spawnGrace > 0) return;

    this.crosshair?.hit();
    const zone = obj.userData.zone;
    if (zone === 'head') {
      this.hits++;
      this.headshots++;
      this.kills++;
      this.score += obj.userData.points;
      beep(1000, 0.05, 'square', 0.05);
      this._recordKill(PLAYER_BOARD_ID, bot.boardKey, { headshot: true });
      this._killBot(bot);
    } else {
      this.hits++;
      this.score += obj.userData.points;
      bot.hp -= 1;
      beep(520, 0.04, 'square', 0.04);
      if (bot.hp <= 0) {
        this.kills++;
        this._recordKill(PLAYER_BOARD_ID, bot.boardKey, { headshot: false });
        this._killBot(bot);
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

  _killBot(bot, fromPlayer = true, killerBot = null, headshot = false) {
    if (!fromPlayer && killerBot) {
      this._recordKill(killerBot.boardKey, bot.boardKey, { headshot });
    }
    bot.target.startDying(0x35e06a);
    this.bots = this.bots.filter((b) => b !== bot);
    const slotIndex = parseInt(String(bot.boardKey).replace('bot-', ''), 10) || 0;
    setTimeout(() => {
      if (this.running && !this._disposed) {
        this._spawnBot(
          [this._playerPos(), ...this.bots.map((b) => [b.pos.x, b.footY, b.pos.z])],
          slotIndex
        );
      }
    }, BOT_RESPAWN_DELAY * 1000);
  }

  update(dt) {
    super.update(dt);
    if (!this.running) return;
    this._updateDeathFx(dt);
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }

  dispose() {
    this._disposed = true;
    this.bots = [];
    this.engine.setDeathOverlay?.(0);
    for (const obj of this._envObjects) {
      this.root.remove(obj);
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else {
        obj.material?.map?.dispose();
        obj.material?.dispose?.();
      }
    }
    this._envObjects = [];
    this.coverMeshes = [];
    super.dispose();
  }
}
