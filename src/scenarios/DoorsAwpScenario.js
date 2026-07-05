// ---------------------------------------------------------------------------
// DoorsAwpScenario.js  ("Doors (AWP)")
//
// Fixed split-pillar layout (doors.json). You spawn on Team B with the AWP;
// a bot breaks from one of ten Team-A lanes and crosses the doors to the far
// side. Shoot them through the walls — any hit counts. If they make it across,
// the round is lost.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, clamp, lerp } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { buildMapMeshes } from '../utils/buildMapMeshes.js';
import { worldImpactNormal } from '../utils/bulletImpact.js';
import { UNIT } from '../utils/SourceMovement.js';
import { mapExtent } from '../multiplayer/maps.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { DOORS_MAP } from '../maps/doorsMapData.js';
import { HEAD_R, HEAD_OFFSET } from '../multiplayer/constants.js';
import { startMissFlash, updateMissFlash } from './missFlash.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_Y = BODY_H + HEAD_R + HEAD_OFFSET;

const BOT_CROSS_SPEED = 250 * UNIT;
const JUMP_CHANCE = 0.33;
const JUMP_PEAK_Y = 1.9; // peak arc height (m) — half of the original 3.8 m
const CROSS_MARGIN = 0.45;
const ARM_MIN = 0.5;
const ARM_MAX = 1.0;
const PLAYER_YAW = Math.PI; // Team B faces the doors (+Z)
const TRACER_MISS_DEPTH = 120;

/** Y rotation so the bot stands upright and faces along ±X. */
function botFacingY(crossDir) {
  return crossDir > 0 ? -Math.PI / 2 : Math.PI / 2;
}

export class DoorsAwpScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
    this.infiniteAmmo = true;
    this.weaponBloom = true;
    this.viewmodelRecoil = true;
    this.showViewmodel = true;
    this.weaponTracers = true;

    const preset = this.competitive ? competitivePresetFor('doorsawp') : null;
    const s = {
      ...DEFAULTS.doorsawp,
      ...((this.competitive ? {} : this.settings.data.doorsawp) ?? {})
    };
    this.botSpeedMul = preset?.botSpeed ?? this.config.botSpeed ?? s.botSpeed ?? 1;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : this.settings.data.runDuration;

    this.map = DOORS_MAP;
    this.coverMeshes = [];
    this.colliderBoxes = [];
    this._arenaObjects = [];

    this.phase = 'arming';
    this.timer = 0;
    this.bot = null;
    this._missFlash = null;

    this._buildEnvironment();
  }

  get name() {
    return 'doorsawp';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.doorsawp ?? DEFAULTS.doorsawp;
    return `spd${c.botSpeed}_d${settings.data.runDuration}`;
  }

  configKey() {
    return DoorsAwpScenario.configKeyFor(this.settings, this.variant);
  }

  tracerRaycastExtras() {
    return this.coverMeshes.slice();
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const extent = mapExtent(this.map);
    const floorSize = extent * 2;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);
    this._arenaObjects.push(floor);

    const gridDiv = Math.min(120, Math.max(40, Math.round(floorSize / 2)));
    const grid = new THREE.GridHelper(floorSize, gridDiv, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);
    this._arenaObjects.push(grid);

    const built = buildMapMeshes(this.map, {
      coverColor: c.cover,
      floorColor: c.floor,
      root: this.root,
      onMesh: (m) => this._arenaObjects.push(m)
    });
    this.coverMeshes = built.coverMeshes;
    this.colliderBoxes = built.colliderBoxes;
  }

  _playerBounds() {
    const b = this.map.bounds;
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  }

  _respawnPlayer() {
    const sp = this.map.spawns.B.pos;
    this.engine.player.spawn({
      pos: sp,
      yaw: PLAYER_YAW,
      bounds: this._playerBounds(),
      colliders: this.colliderBoxes
    });
    this.engine.weapon?.reset();
  }

  _buildBot() {
    const t = new Target();
    const col = this.settings.data.colors;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 18),
      new THREE.MeshStandardMaterial({ color: col.enemyBody, emissive: col.enemyBody, emissiveIntensity: 0.4, roughness: 0.5 })
    );
    body.position.y = BODY_H / 2;
    t.addCollider(body, { zone: 'body', points: 50, crit: false });

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R, 22, 16),
      new THREE.MeshStandardMaterial({ color: col.enemyHead, emissive: col.enemyHead, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    head.position.y = HEAD_Y;
    t.addCollider(head, { zone: 'head', points: 100, crit: true });
    return t;
  }

  _pickSpawn() {
    const spawns = this.map.spawns.A;
    const idx = randInt(0, spawns.length - 1);
    const pos = spawns[idx].pos;
    const startX = pos[0];
    const startZ = pos[2];
    // x = -5 lanes are on the player's right; x = 5 lanes are on the left.
    const crossDir = startX < 0 ? 1 : -1;
    const targetX = startX < 0 ? 5 : -5;
    const jump = Math.random() < JUMP_CHANCE;
    return { startX, startZ, crossDir, targetX, jump };
  }

  _placeBot(b) {
    b.target.object.position.set(b.x, b.y, b.startZ);
    b.target.object.rotation.set(0, botFacingY(b.crossDir), 0);
  }

  _clearBot(fadeColor) {
    if (this.bot?.target && this.bot.target.state !== 'dying') {
      this.bot.target.startDying(fadeColor);
    }
    this.bot = null;
  }

  /** Spawn a fresh bot at a lane and hold before it crosses. */
  _scheduleNextRound() {
    this._clearBot(0xff2222);

    const spawn = this._pickSpawn();
    const target = this._buildBot();
    this.addTarget(target);

    this.bot = {
      target,
      ...spawn,
      x: spawn.startX,
      y: 0,
      progress: 0
    };
    this._placeBot(this.bot);
    this.phase = 'arming';
    this.timer = randRange(ARM_MIN, ARM_MAX);
  }

  _startBotMove() {
    if (!this.bot) return;
    this.bot.progress = 0;
    this.bot.x = this.bot.startX;
    this.bot.y = 0;
    this._placeBot(this.bot);
    this.phase = 'moving';
  }

  _botEscaped() {
    this.misses++;
    this._respawnPlayer();
    this._scheduleNextRound();
  }

  _killBot() {
    this._clearBot(0x35e06a);
    this._respawnPlayer();
    this._scheduleNextRound();
  }

  /** Wallbang: targets are tested before cover so shots register through walls. */
  _raycastBot(raycaster) {
    const colliders = this.activeColliders();
    const hits = raycaster.intersectObjects(colliders, false);
    return hits.length ? hits[0] : this._nearMissSphereCheck(raycaster.ray, colliders);
  }

  _resolveBulletImpact() {
    const raycaster = this._shotRaycaster();
    const botHit = this._raycastBot(raycaster);
    if (botHit) {
      this._lastImpact.copy(botHit.point);
      worldImpactNormal(botHit, this._lastImpactNormal);
      return botHit;
    }
    const wallHits = raycaster.intersectObjects(this.coverMeshes, false);
    if (wallHits.length) {
      this._lastImpact.copy(wallHits[0].point);
      worldImpactNormal(wallHits[0], this._lastImpactNormal);
      return wallHits[0];
    }
    this._lastImpact
      .copy(raycaster.ray.origin)
      .addScaledVector(raycaster.ray.direction, TRACER_MISS_DEPTH);
    return null;
  }

  _advanceBot(dt) {
    const b = this.bot;
    if (!b || b.target.state === 'dying') return;

    const speed = BOT_CROSS_SPEED * this.botSpeedMul;
    const totalDist = Math.abs(b.targetX - b.startX);
    const step = (speed * dt) / totalDist;
    const nextProgress = clamp(b.progress + step, 0, 1);
    b.progress = nextProgress;
    b.x = lerp(b.startX, b.targetX, nextProgress);

    if (b.jump) {
      b.y = 4 * JUMP_PEAK_Y * nextProgress * (1 - nextProgress);
    } else {
      b.y = 0;
    }

    this._placeBot(b);

    const crossed = b.crossDir > 0
      ? b.x >= b.targetX - CROSS_MARGIN
      : b.x <= b.targetX + CROSS_MARGIN;
    if (crossed) this._botEscaped();
  }

  onStart() {
    this._respawnPlayer();
    this._scheduleNextRound();
  }

  onUpdate(dt) {
    if (this._missFlash && updateMissFlash(this.engine, this._missFlash, dt)) {
      this._missFlash = null;
    }
    switch (this.phase) {
      case 'arming':
        this.timer -= dt;
        if (this.timer <= 0) this._startBotMove();
        break;
      case 'moving':
        this._advanceBot(dt);
        break;
    }
  }

  onShoot(raycaster) {
    if (this.phase !== 'moving') return;
    const b = this.bot;
    if (!b || b.target.state === 'dying') return;

    const hit = this._raycastBot(raycaster);
    const tgt = hit?.object?.userData?.target;
    if (tgt === b.target) {
      this.crosshair?.hit();
      this.hits++;
      this.kills++;
      if (hit.object.userData.zone === 'head') this.headshots++;
      this.score += hit.object.userData.points;
      beep(1000, 0.05, 'square', 0.05);
      this._killBot();
      return;
    }

    this.misses++;
    beep(240, 0.07, 'sawtooth', 0.05);
    this._missFlash = startMissFlash();
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
