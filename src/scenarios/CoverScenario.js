// ---------------------------------------------------------------------------
// CoverScenario.js  ("Cover")
//
// Rifle fight against peeking bots on tiered rows. Three rows of cover boxes
// stand in front of you — each row further back and 200 u (≈5.1 m) higher than
// the last. One bot is live at a time: it spawns hidden behind a random box,
// strafes out (left or right) until it can FULLY see you (continuing past the
// default peek offset on outer boxes if needed), waits a random extra
// 25–200 ms, then opens fire. While shooting it jiggles A/D (random 0.05–0.15 s
// taps) and has a 20% chance per shot to toggle crouch. Kill it and the next
// bot starts peeking 0.25–0.75 s later; your HP (4 hits) resets on every kill.
// You can strafe/crouch/jump inside a small movement box.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, clamp, lerp } from '../utils/MathUtils.js';
import { SourceMover1D, RUN_SPEED, UNIT } from '../utils/SourceMovement.js';
import { gridLineColors, createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';
import { markBulletDecalSurface, worldImpactNormal } from '../utils/bulletImpact.js';
import { movementHitScale } from '../utils/spawnVisibility.js';
import { SHOT_INTERVAL } from '../weapons/ak47.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { HEAD_R, HEAD_OFFSET } from '../multiplayer/constants.js';
import { DEATH_OVERLAY_STRENGTH } from './deathFx.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_Y = BODY_H + HEAD_R + HEAD_OFFSET;

const ROW_RISE = 200 * UNIT; // each row is 200 u (≈5.08 m) above the previous
const PLAYER_HALF_X = 6;
const PLAYER_HALF_Z = 4;
const COVER_W = 2.8;
const COVER_H = 2.6;
const COVER_D = 1.4;
const COVER_GAP = 8; // metres between box centres on a row
const PLATFORM_D = 6; // row platform depth
const SPAWN_HINT_LEAD = 0.5; // s before peek — highlight the spawn box
const NEXT_BOT_DELAY_MIN = 0.25; // s after a kill before the next bot peeks
const NEXT_BOT_DELAY_MAX = 0.75;
const DEATH_RESPAWN_DELAY = 0.9; // s after the player dies
const JIGGLE_MIN = 0.05; // s — A/D tap window while shooting
const JIGGLE_MAX = 0.15;
const CROUCH_TOGGLE_CHANCE = 0.2; // per shot fired
const CROUCH_RATE = 10;
const MAX_PEEK_EXTRA = COVER_GAP * 1.5; // extra strafe past default peek if still occluded
// Per-bullet hit odds against the player (scaled down while you move).
const BOT_HEAD_HIT = 0.04;
const BOT_BODY_HIT = 0.2;

const _headPos = new THREE.Vector3();
const _eyePos = new THREE.Vector3();
const _losDir = new THREE.Vector3();
const _losRay = new THREE.Raycaster();
const _tracerEnd = new THREE.Vector3();
const _impactNormal = new THREE.Vector3();

export class CoverScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    // Full-auto rifle with its normal bloom/recoil — this is a gunfight mode.
    this.weaponId = 'rifle';
    this.infiniteAmmo = true;
    const preset = this.competitive ? competitivePresetFor('cover') : null;
    const c = { ...DEFAULTS.cover, ...((this.competitive ? DEFAULTS.cover : this.settings.data.cover) ?? {}) };

    this.rowCount = clamp(Math.round(preset?.rowCount ?? this.config.rowCount ?? c.rowCount), 1, 3);
    this.coverPerRow = clamp(Math.round(preset?.coverPerRow ?? this.config.coverPerRow ?? c.coverPerRow), 1, 5);
    this.rowDistance = preset?.rowDistance ?? this.config.rowDistance ?? c.rowDistance;
    this.rowSpacing = preset?.rowSpacing ?? this.config.rowSpacing ?? c.rowSpacing;
    this.botSpeed = preset?.botSpeed ?? this.config.botSpeed ?? c.botSpeed;
    // Extra delay AFTER the bot fully sees you before it may shoot (ms).
    this.reactMin = (preset?.reactMin ?? this.config.reactMin ?? c.reactMin) / 1000;
    this.reactMax = Math.max(
      this.reactMin,
      (preset?.reactMax ?? this.config.reactMax ?? c.reactMax) / 1000
    );
    this.playerHp = Math.max(1, Math.round(preset?.playerHp ?? this.config.playerHp ?? c.playerHp));
    // Body shots to drop a bot (a headshot is always instant).
    this.botHp = Math.max(1, Math.round(preset?.botHp ?? this.config.botHp ?? c.botHp));
    this.spawnHint = preset?.spawnHint ?? this.config.spawnHint ?? c.spawnHint ?? true;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : this.settings.data.runDuration;

    this._hp = this.playerHp;
    this.bot = null;
    this._nextBotIn = 0;
    this._nextSpawn = null; // { spot, side } picked while waiting for the next bot
    this._hintMesh = null;
    this._deathFxT = 0;
    this.coverBoxes = []; // all occluders (cover + platforms)
    this._spots = []; // { x, z, behindZ, footY, coverMesh } — one per cover box
    this._buildEnvironment();
  }

  get name() {
    return 'cover';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.cover ?? DEFAULTS.cover;
    return `r${c.rowCount}_b${c.coverPerRow}_d${settings.data.runDuration}`;
  }

  configKey() {
    return CoverScenario.configKeyFor(this.settings, this.variant);
  }

  tracerRaycastExtras() {
    return this.coverBoxes;
  }

  // ---- Environment ---------------------------------------------------------
  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(120, 90, gridCenter, gridEdge);
    grid.position.y = 0.001;
    this.root.add(grid);

    // Player movement box outline.
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(PLAYER_HALF_X * 2, 0.02, PLAYER_HALF_Z * 2)),
      new THREE.LineBasicMaterial({ color: gridCenter })
    );
    box.position.y = 0.03;
    this.root.add(box);

    const coverMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.85, metalness: 0.05 });
    const gridBoxMat = createCoverGridMaterial(c.cover, c.floor);
    const rowW = (this.coverPerRow - 1) * COVER_GAP + COVER_W + 6;

    for (let row = 0; row < this.rowCount; row++) {
      const rowY = row * ROW_RISE; // floor height of this row
      const rowZ = -(this.rowDistance + row * this.rowSpacing);

      // Raised rows stand on a visible platform slab.
      if (rowY > 0) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(rowW, rowY, PLATFORM_D), coverMat);
        slab.position.set(0, rowY / 2, rowZ);
        markBulletDecalSurface(slab);
        this.root.add(slab);
        this.coverBoxes.push(slab);
      }

      for (let i = 0; i < this.coverPerRow; i++) {
        const x = (i - (this.coverPerRow - 1) / 2) * COVER_GAP;
        const mat = gridBoxMat.clone();
        mat.map = mat.map.clone();
        applyCoverGridRepeat(mat, COVER_W, COVER_H);
        const cover = new THREE.Mesh(new THREE.BoxGeometry(COVER_W, COVER_H, COVER_D), mat);
        // Boxes sit near the platform's FRONT edge (toward the player, +z) so
        // the slab never blocks a peeking bot's downward line of sight.
        const z = rowZ + PLATFORM_D / 2 - COVER_D / 2 - 0.4;
        cover.position.set(x, rowY + COVER_H / 2, z);
        markBulletDecalSurface(cover);
        this.root.add(cover);
        this.coverBoxes.push(cover);
        // Bot stands flush against the back face (−z), hidden until it strafes out.
        const behindZ = z - COVER_D / 2 - BODY_R;
        this._spots.push({ x, z, behindZ, footY: rowY, coverMesh: cover });
      }
    }
  }

  // ---- Bot -------------------------------------------------------------------
  _buildBot() {
    const t = new Target();
    const bodyRig = new THREE.Group();
    t.object.add(bodyRig);

    const c = this.settings.data.colors;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 18),
      new THREE.MeshStandardMaterial({ color: c.enemyBody, emissive: 0x404040, emissiveIntensity: 0.4, roughness: 0.5 })
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
    t.spawnDuration = 0;
    t.spawnT = 0;
    t.object.scale.setScalar(1);
    return t;
  }

  _scheduleNextBot(delay = this._nextBotDelay()) {
    this._nextBotIn = delay;
    this._nextSpawn = {
      spot: this._spots[randInt(0, this._spots.length - 1)],
      side: Math.random() < 0.5 ? -1 : 1
    };
    if (!this.spawnHint || delay > SPAWN_HINT_LEAD) this._clearSpawnHint();
  }

  _clearSpawnHint() {
    if (!this._hintMesh) return;
    const mat = this._hintMesh.material;
    mat.emissive.setHex(0x000000);
    mat.emissiveIntensity = 0;
    this._hintMesh = null;
  }

  _updateSpawnHint(active) {
    if (!this.spawnHint || !active) {
      this._clearSpawnHint();
      return;
    }
    const mesh = this._nextSpawn?.spot?.coverMesh;
    if (!mesh || mesh === this._hintMesh) return;
    this._clearSpawnHint();
    this._hintMesh = mesh;
    mesh.material.emissive.setHex(0xff2200);
    mesh.material.emissiveIntensity = 0.55;
  }

  _nextBotDelay() {
    return randRange(NEXT_BOT_DELAY_MIN, NEXT_BOT_DELAY_MAX);
  }

  _spawnBot() {
    const spot = this._nextSpawn?.spot ?? this._spots[randInt(0, this._spots.length - 1)];
    const side = this._nextSpawn?.side ?? (Math.random() < 0.5 ? -1 : 1);
    this._nextSpawn = null;
    this._clearSpawnHint();

    const target = this._buildBot();
    this.addTarget(target);
    const mover = new SourceMover1D();
    // Flush behind the box centre, then strafe left or right to peek.
    mover.reset(0);
    this.bot = {
      target,
      spot,
      mover,
      hp: this.botHp,
      side,
      peekTarget: side * (COVER_W / 2 + BODY_R + randRange(0.15, 0.55)),
      phase: 'peeking', // peeking | shooting
      fireDelay: null, // set the moment full LOS is gained (25–200 ms)
      fireTimer: 0,
      jiggleDir: side,
      jiggleTimer: randRange(JIGGLE_MIN, JIGGLE_MAX),
      crouch: 0,
      crouchWant: 0
    };
    this._placeBot();
  }

  _placeBot() {
    const b = this.bot;
    if (!b) return;
    b.target.object.position.set(b.spot.x + b.mover.s, b.spot.footY, b.spot.behindZ);
    const cam = this.camera;
    b.target.object.lookAt(cam.position.x, b.spot.footY + 1.0, cam.position.z);
  }

  /** Full visibility: BOTH the bot's head and body centre see the player's eye. */
  _botFullyVisible(b) {
    const head = b.target.headMesh;
    if (!head) return false;
    this.camera.getWorldPosition(_eyePos);
    head.getWorldPosition(_headPos);
    if (!this._segmentClear(_headPos, _eyePos)) return false;
    // Body centre.
    _headPos.set(
      b.spot.x + b.mover.s,
      b.spot.footY + BODY_H * 0.5 * lerp(1, 0.55, b.crouch),
      b.spot.behindZ
    );
    return this._segmentClear(_headPos, _eyePos);
  }

  _segmentClear(from, to) {
    const dist = from.distanceTo(to);
    if (dist < 1e-4) return true;
    _losDir.copy(to).sub(from).multiplyScalar(1 / dist);
    _losRay.set(from, _losDir);
    _losRay.far = dist;
    const hits = _losRay.intersectObjects(this.coverBoxes, false);
    return hits.length === 0 || hits[0].distance >= dist - 0.04;
  }

  _botFire(b) {
    const head = b.target.headMesh;
    if (!head) return;
    head.getWorldPosition(_headPos);
    this.camera.getWorldPosition(_eyePos);

    this.engine.audio?.playRemoteShot(_headPos.x, _headPos.y, _headPos.z);
    // Tracer to the player (or the cover it clips).
    const dist = _headPos.distanceTo(_eyePos);
    let end = _tracerEnd.copy(_eyePos);
    let normal = null;
    let decal = false;
    if (dist > 1e-4) {
      _losDir.copy(_eyePos).sub(_headPos).multiplyScalar(1 / dist);
      _losRay.set(_headPos, _losDir);
      _losRay.far = dist;
      const hits = _losRay.intersectObjects(this.coverBoxes, false);
      if (hits.length && hits[0].distance < dist - 0.04) {
        end = _tracerEnd.copy(hits[0].point);
        normal = worldImpactNormal(hits[0], _impactNormal);
        decal = true;
      }
    }
    const vm = this.engine.viewmodel;
    vm?.spawnTracer(_headPos, end);
    vm?.spawnBulletImpact(end, normal, { decal });

    // Hit roll (harder to hit while you move).
    const p = this.engine.player;
    const speed = p?.enabled ? Math.hypot(p.vel.x, p.vel.z) : 0;
    const scale = movementHitScale(speed, RUN_SPEED);
    const roll = Math.random();
    if (roll < (BOT_HEAD_HIT + BOT_BODY_HIT) * scale) this._damagePlayer();

    // 20% chance per shot to crouch/uncrouch.
    if (Math.random() < CROUCH_TOGGLE_CHANCE) b.crouchWant = b.crouchWant ? 0 : 1;
  }

  _damagePlayer() {
    this._hp -= 1;
    beep(520, 0.04, 'square', 0.08);
    this.engine.setDeathOverlay(DEATH_OVERLAY_STRENGTH * 0.35);
    this._deathFxT = Math.max(this._deathFxT, 0.12);
    if (this._hp <= 0) this._onPlayerDeath();
  }

  _onPlayerDeath() {
    this.misses++;
    beep(180, 0.1, 'sawtooth', 0.2);
    this.engine.setDeathOverlay(DEATH_OVERLAY_STRENGTH);
    this._deathFxT = 0.45;
    if (this.bot) this.bot.target.startDying(0xff4d4d);
    this.bot = null;
    this._hp = this.playerHp;
    this._scheduleNextBot(DEATH_RESPAWN_DELAY);
  }

  _killBot() {
    if (this.bot) this.bot.target.startDying(0x35e06a);
    this.bot = null;
    this._hp = this.playerHp; // HP resets on every kill
    this._scheduleNextBot();
  }

  // ---- Round flow -------------------------------------------------------------
  onStart() {
    this.engine.player.spawn({
      pos: [0, 0, 0],
      yaw: 0,
      bounds: { minX: -PLAYER_HALF_X, maxX: PLAYER_HALF_X, minZ: -PLAYER_HALF_Z, maxZ: PLAYER_HALF_Z }
    });
    this._spawnBot();
  }

  onUpdate(dt) {
    if (this._deathFxT > 0) {
      this._deathFxT -= dt;
      if (this._deathFxT <= 0) this.engine.setDeathOverlay(0);
    }

    const b = this.bot;
    if (!b || b.target.state === 'dying') {
      if (this.spawnHint && this._nextSpawn && this._nextBotIn <= SPAWN_HINT_LEAD) {
        this._updateSpawnHint(true);
      }
      this._nextBotIn -= dt;
      if (this._nextBotIn <= 0) this._spawnBot();
      return;
    }

    this._updateSpawnHint(false);

    const max = RUN_SPEED * this.botSpeed;

    if (b.phase === 'peeking') {
      const visible = this._botFullyVisible(b);
      if (!visible) {
        // Outer boxes may need to strafe past the default peek offset before
        // the player has line of sight — keep moving outward until visible.
        const limit = b.peekTarget + b.side * MAX_PEEK_EXTRA;
        const canAdvance = b.side > 0 ? b.mover.s < limit : b.mover.s > limit;
        if (canAdvance) b.mover.step(dt, b.side, max);
      } else if (Math.abs(b.mover.v) > 0.05) {
        b.mover.step(dt, -Math.sign(b.mover.v), max);
      }
      this._placeBot();
      if (visible) {
        if (b.fireDelay == null) {
          b.peekTarget = b.mover.s;
          b.fireDelay = randRange(this.reactMin, this.reactMax);
        }
        b.fireDelay -= dt;
        if (b.fireDelay <= 0) {
          b.phase = 'shooting';
          b.fireTimer = 0;
        }
      }
    } else {
      // Shooting: jiggle A/D around the peek spot with 0.05–0.15 s taps.
      b.jiggleTimer -= dt;
      if (b.jiggleTimer <= 0) {
        b.jiggleDir = -b.jiggleDir;
        b.jiggleTimer = randRange(JIGGLE_MIN, JIGGLE_MAX);
      }
      b.mover.step(dt, b.jiggleDir, max);
      // Keep the jiggle outside cover (stay exposed) and near the peek spot.
      const minOut = b.side * (COVER_W / 2 + BODY_R + 0.05);
      const maxOut = b.peekTarget + b.side * 0.9;
      const lo = Math.min(minOut, maxOut);
      const hi = Math.max(minOut, maxOut);
      if (b.mover.s < lo) { b.mover.s = lo; b.jiggleDir = 1; }
      else if (b.mover.s > hi) { b.mover.s = hi; b.jiggleDir = -1; }
      this._placeBot();

      b.fireTimer -= dt;
      if (b.fireTimer <= 0 && this.engine.player?.enabled) {
        b.fireTimer = SHOT_INTERVAL;
        this._botFire(b);
      }
    }

    // Crouch animation (rig squashes; the head rides down with it).
    b.crouch = clamp(b.crouch + (b.crouchWant - b.crouch) * Math.min(1, CROUCH_RATE * dt), 0, 1);
    if (b.target.rig) b.target.rig.scale.y = lerp(1, 0.55, b.crouch);
    if (b.target.headMesh) {
      b.target.headMesh.position.y = BODY_H * lerp(1, 0.55, b.crouch) + HEAD_R + HEAD_OFFSET;
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster, this.coverBoxes);
    if (!hit) return;
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt) return; // cover blocked the shot
    const b = this.bot;
    if (!b || tgt !== b.target || tgt.state === 'dying') return;

    this.crosshair?.hit();
    const zone = obj.userData.zone;
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
      b.hp -= 1;
      beep(520, 0.04, 'square', 0.04);
      if (b.hp <= 0) {
        this.kills++;
        this._killBot();
      } else {
        const mat = obj.material;
        mat.emissiveIntensity = 1.0;
        setTimeout(() => {
          try {
            mat.emissiveIntensity = 0.4;
          } catch {
            /* disposed */
          }
        }, 80);
      }
    }
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }

  dispose() {
    this.engine.setDeathOverlay(0);
    this._clearSpawnHint();
    this.bot = null;
    super.dispose();
  }
}
