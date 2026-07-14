// ---------------------------------------------------------------------------
// MultiplayerDuelScenario.js
// Online 1v1 duel on a symmetric map. The local player moves with the shared
// PlayerController (CS2 movement); remote players render as the same avatar as
// the singleplayer enemy bot and are interpolated between server snapshots at
// display refresh rate (entity interpolation), so motion stays smooth on high-Hz
// monitors even though snapshots arrive at 32 Hz. Shots are validated
// server-side (server-authoritative hits/score); locally we only draw an
// immediate hitmarker for responsiveness.
//
// The scenario does NOT own the WebSocket — the MultiplayerController routes net
// events into the apply* / setSpawns methods, and reads getScores() for the HUD.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { clamp, degToRad, lerp } from '../utils/MathUtils.js';
import { gridLineColors, createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';
import { markBulletDecalSurface } from '../utils/bulletImpact.js';
import { getMap, mapExtent } from '../multiplayer/maps.js';
import {
  BODY_R,
  HEAD_R,
  bodyTopY,
  headCenterY,
  STAND_EYE,
  CROUCH_EYE,
  SPAWN_GRACE,
  SNAPSHOT_RATE
} from '../multiplayer/constants.js';
import { CSBotModel } from '../bots/CSBotModel.js';
import {
  DM_DEATH_FX_DUR,
  DM_DEATH_FX_PITCH,
  DUEL_DEATH_FX_DUR,
  DUEL_DEATH_FX_PITCH,
  updateDeathFxFrame
} from './deathFx.js';

const MAX_PITCH = degToRad(89);

// Reused scratch for drawing remote-shot tracers (no per-shot allocation).
const _wOrigin = new THREE.Vector3();
const _wEnd = new THREE.Vector3();
const STATE_HZ = 64; // cap upstream state sends (server sim is 128 Hz)
// Render ~2 snapshot periods behind server time so we always have a pair to lerp.
const INTERP_DELAY_MS = (1000 / SNAPSHOT_RATE) * 2;
const SNAP_HISTORY_MAX = Math.ceil(SNAPSHOT_RATE * 2);

export class MultiplayerDuelScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.net = this.config.net;
    this.myId = this.config.myId;
    this.mapId = this.config.mapId;
    this.target = this.config.target ?? 13;
    this.map = getMap(this.mapId);

    this.runDuration = Infinity; // never auto-finishes on the run timer
    this.isMultiplayer = true;
    this.isTracking = this.config.gameMode === 'tracking';
    this.isDeathmatch = this.config.gameMode === 'deathmatch';
    // Custom games pick the weapon; ranked matchmaking always uses the rifle.
    this.weaponId = this.isTracking
      ? 'tracking'
      : this.config.weapon === 'pistol'
        ? 'pistol'
        : 'rifle';

    if (this.isTracking) {
      this.infiniteAmmo = true;
      this.weaponBloom = false;
      this.viewmodelRecoil = false;
      this.showViewmodel = false;
      this.weaponTracers = false;
      this.matchEndsAt = this.config.matchEndsAt ?? null;
    }

    this.scores = this.config.scores || {};
    this.mpStats = this.config.stats || {};
    this.players = this.config.players || {}; // id -> { name, side }
    this.remotes = new Map(); // id -> avatar record
    this._snapHistory = []; // { st, players: Map<id, state> } newest last
    this._serverTimeOffset = null; // server Date.now() - performance.now()
    this.coverMeshes = [];
    this._arenaObjects = [];

    this._deathFx = null;
    this._dead = false;
    this._pendingSpawns = null;
    this._stateSendAccum = 0;

    this._buildEnvironment();
    if (this.config.spawns) this.setSpawns(this.config.spawns);
  }

  get name() {
    return 'mpduel';
  }
  configKey() {
    return `mp_${this.mapId}`;
  }

  tracerRaycastExtras() {
    const extras = this.coverMeshes.slice();
    for (const r of this.remotes.values()) {
      if (!r.dead) extras.push(...r.colliders);
    }
    return extras;
  }

  // ---- World --------------------------------------------------------------
  _clearEnvironment() {
    for (const obj of this._arenaObjects) {
      this.root.remove(obj);
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material?.dispose?.();
    }
    this._arenaObjects.length = 0;
    this.coverMeshes.length = 0;
  }

  /** Swap arena geometry mid-match (random map rotation on kill). */
  setMap(mapId, { force = false } = {}) {
    if (!mapId || (!force && mapId === this.mapId)) return;
    this.mapId = mapId;
    this.map = getMap(mapId);
    this._clearEnvironment();
    this._buildEnvironment();
  }

  _buildEnvironment() {
    const add = (obj) => { this.root.add(obj); this._arenaObjects.push(obj); return obj; };
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const extent = mapExtent(this.map);
    const floorSize = extent * 2;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    add(floor);

    const gridDiv = Math.min(120, Math.max(40, Math.round(floorSize / 2)));
    const grid = new THREE.GridHelper(floorSize, gridDiv, gridCenter, gridEdge);
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

  /** Build a remote-player avatar (the same skeletal bot as singleplayer). */
  _makeAvatar() {
    const c = this.settings.data.colors;
    const group = new THREE.Group();

    const model = new CSBotModel({ bodyColor: c.enemyBody, headColor: c.enemyHead });
    group.add(model.root);

    // Invisible hit proxies mirroring the server's analytic validation shapes
    // (cylinder + sphere in server/hitscan.js) so client claims and server
    // verdicts always agree. The skeletal model is display-only here.
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY_R, BODY_R, 1, 12),
      new THREE.MeshBasicMaterial()
    );
    body.visible = false;
    body.userData.zone = 'body';
    group.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R, 12, 10),
      new THREE.MeshBasicMaterial()
    );
    head.visible = false;
    head.userData.zone = 'head';
    group.add(head);

    this.root.add(group);
    return { group, model, body, head, colliders: [body, head] };
  }

  _ensureRemote(id) {
    let r = this.remotes.get(id);
    if (!r) {
      r = this._makeAvatar();
      r.cur = { x: 0, z: 0, y: STAND_EYE, yaw: 0, crouch: 0 };
      r.dead = false;
      this.remotes.set(id, r);
    }
    return r;
  }

  _playerSnapState(p) {
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      crouch: p.crouch,
      dead: p.dead
    };
  }

  _updateServerTimeOffset(st) {
    const estimate = st - performance.now();
    if (this._serverTimeOffset == null) this._serverTimeOffset = estimate;
    else this._serverTimeOffset += (estimate - this._serverTimeOffset) * 0.15;
  }

  /** Find snapshot bracket for renderTime; returns { from, to, alpha } or null. */
  _snapBracket(renderSt) {
    const hist = this._snapHistory;
    if (!hist.length) return null;

    const latest = hist[hist.length - 1];
    if (renderSt >= latest.st) {
      if (hist.length < 2) return { from: latest, to: latest, alpha: 1 };
      const prev = hist[hist.length - 2];
      const span = latest.st - prev.st;
      const alpha = span > 0 ? clamp((renderSt - prev.st) / span, 0, 1.25) : 1;
      return { from: prev, to: latest, alpha };
    }

    for (let i = 0; i < hist.length - 1; i++) {
      const from = hist[i];
      const to = hist[i + 1];
      if (from.st <= renderSt && renderSt <= to.st) {
        const span = to.st - from.st;
        const alpha = span > 0 ? (renderSt - from.st) / span : 0;
        return { from, to, alpha };
      }
    }

    return { from: hist[0], to: hist[0], alpha: 0 };
  }

  _lerpYaw(a, b, t) {
    let dy = b - a;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    return a + dy * t;
  }

  _lerpPlayerState(a, b, t) {
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      yaw: this._lerpYaw(a.yaw, b.yaw, t),
      crouch: lerp(a.crouch, b.crouch, t),
      dead: t < 0.5 ? a.dead : b.dead
    };
  }

  // ---- Spawns / lifecycle -------------------------------------------------
  setSpawns(spawns, { skipLocal = false } = {}) {
    if (!this.isDeathmatch) this.engine.viewmodel?.clearBulletDecals();
    this._snapHistory = [];
    this._serverTimeOffset = null;
    for (const [idStr, sp] of Object.entries(spawns)) {
      const id = Number(idStr);
      if (id === this.myId) {
        if (skipLocal) continue;
        this._dead = false;
        this._deathFx = null;
        this._pendingSpawns = null;
        this.engine.setDeathOverlay(0);
        this.engine.weapon?.reset(); // fresh magazine each spawn / round
        this.engine.player.spawn({
          pos: sp.pos,
          yaw: sp.yaw,
          colliders: this.map.boxes,
          spawnGrace: SPAWN_GRACE
        });
      } else {
        const r = this._ensureRemote(id);
        const eyeY = sp.pos[1] + STAND_EYE;
        r.cur.x = sp.pos[0];
        r.cur.z = sp.pos[2];
        r.cur.y = eyeY;
        r.cur.yaw = sp.yaw;
        r.cur.crouch = 0;
        r.dead = false;
        r.group.visible = true;
        delete r._sfx;
      }
    }
  }

  onStart() {
    // Local player already placed via setSpawns in the constructor.
  }

  // ---- Net event application (called by the controller) -------------------
  applySnapshot(msg) {
    const st = msg.st || Date.now();
    this._updateServerTimeOffset(st);
    if (msg.matchEndsAt) this.matchEndsAt = msg.matchEndsAt;

    const frame = { st, players: new Map() };
    for (const p of msg.players) {
      if (p.id === this.myId) continue;
      this._ensureRemote(p.id);
      frame.players.set(p.id, this._playerSnapState(p));
    }

    const hist = this._snapHistory;
    if (hist.length && st <= hist[hist.length - 1].st) {
      // Drop out-of-order duplicates (reconnect / clock jitter).
      while (hist.length && hist[hist.length - 1].st >= st) hist.pop();
    }
    hist.push(frame);
    while (hist.length > SNAP_HISTORY_MAX) hist.shift();
  }

  applyHit(msg) {
    if (msg.scores) this.scores = msg.scores;
    if (msg.stats) this.mpStats = msg.stats;
    if (this.isTracking && msg.shooterId === this.myId) {
      if (msg.zone === 'head') this.headshots++;
      this.crosshair?.hit();
    }
  }

  applyKill(msg) {
    if (this.isTracking) return;
    this.scores = msg.scores || this.scores;
    if (msg.stats) this.mpStats = msg.stats;
    if (msg.mapId) this.setMap(msg.mapId, { force: true });
    if (msg.shooterId === this.myId && msg.victimId !== this.myId) {
      beep(1000, 0.05, 'square', 0.06);
      this.kills++;
    }
    const iAmVictim = msg.victimId === this.myId;
    if (iAmVictim) this._die();
    if (msg.spawns) {
      if (iAmVictim) {
        this._pendingSpawns = msg.spawns;
        this.setSpawns(msg.spawns, { skipLocal: true });
      } else {
        this.setSpawns(msg.spawns);
      }
    }
  }

  applyRespawn(msg) {
    if (!msg.spawns) return;
    if (this.isDeathmatch && this._deathFx) {
      this._pendingSpawns = msg.spawns;
      this.setSpawns(msg.spawns, { skipLocal: true });
      return;
    }
    this.setSpawns(msg.spawns);
  }

  applyShotFired(msg) {
    if (this.isTracking || msg.shooterId === this.myId) return;
    this.engine.audio?.playRemoteShot(msg.x, msg.y, msg.z);
    const vm = this.engine.viewmodel;
    const hasEnd = [msg.ex, msg.ey, msg.ez].every(Number.isFinite);
    const hasMuzzle = [msg.mx, msg.my, msg.mz].every(Number.isFinite);
    const hasOrigin = [msg.ox, msg.oy, msg.oz].every(Number.isFinite);
    if (vm && hasEnd && (hasMuzzle || hasOrigin)) {
      if (hasMuzzle) _wOrigin.set(msg.mx, msg.my, msg.mz);
      else _wOrigin.set(msg.ox, msg.oy, msg.oz);
      _wEnd.set(msg.ex, msg.ey, msg.ez);
      vm.spawnTracer(_wOrigin, _wEnd);
      vm.spawnBulletImpact(_wEnd, null, { decal: false });
    }
  }

  _die() {
    if (this._dead) return;
    this._dead = true;
    this.engine.player.enabled = false;
    beep(180, 0.1, 'sawtooth', 0.2);
    this._deathFx = {
      t: 0,
      startPitch: this.input.pitch,
      duration: this.isDeathmatch ? DM_DEATH_FX_DUR : DUEL_DEATH_FX_DUR,
      flick: this.isDeathmatch ? DM_DEATH_FX_PITCH : DUEL_DEATH_FX_PITCH
    };
  }

  // ---- Per-frame ----------------------------------------------------------
  get input() {
    return this.engine.player.input;
  }

  onUpdate(dt) {
    this._updateDeathFx(dt);
    this._stateSendAccum += dt;
    if (this._stateSendAccum >= 1 / STATE_HZ) {
      this._stateSendAccum = 0;
      this._sendState();
    }
    this._interpRemotes(dt);
  }

  _sendState() {
    if (this._dead) return;
    const cam = this.engine.camera;
    const p = this.engine.player;
    this.net?.sendState({
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
      yaw: p.input.yaw,
      pitch: p.input.pitch,
      crouch: p.crouchAmt
    });
  }

  _interpRemotes(_dt) {
    const serverNow =
      performance.now() + (this._serverTimeOffset ?? 0);
    const renderSt = serverNow - INTERP_DELAY_MS;
    const bracket = this._snapBracket(renderSt);

    for (const [id, r] of this.remotes) {
      let state = null;
      if (bracket) {
        const a = bracket.from.players.get(id);
        const b = bracket.to.players.get(id);
        if (a && b) state = this._lerpPlayerState(a, b, bracket.alpha);
        else if (b) state = b;
        else if (a) state = a;
      }

      if (!state) {
        const latest = this._snapHistory[this._snapHistory.length - 1];
        state = latest?.players.get(id) ?? null;
      }
      if (!state) continue;

      r.cur.x = state.x;
      r.cur.y = state.y;
      r.cur.z = state.z;
      r.cur.yaw = state.yaw;
      r.cur.crouch = state.crouch;
      r.dead = state.dead;

      r.group.visible = !r.dead;
      const eyeOff = lerp(STAND_EYE, CROUCH_EYE, r.cur.crouch);
      const footY = r.cur.y - eyeOff;
      r.group.position.set(r.cur.x, footY, r.cur.z);
      // Hit proxies track the server's analytic shapes exactly.
      const bodyH = bodyTopY(r.cur.crouch);
      r.body.scale.y = bodyH;
      r.body.position.y = bodyH / 2;
      r.head.position.y = headCenterY(r.cur.crouch);
      // Camera yaw faces -Z; the model's forward is +Z, hence the +π.
      r.model.setYaw(r.cur.yaw + Math.PI);
      r.model.update(_dt, { crouch: r.cur.crouch });

      this.engine.audio?.updateRemotePlayer(id, r, _dt);
    }
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
    this.input.pitch = pitch;

    if (done) {
      this._deathFx = null;
      this.engine.setDeathOverlay(0);
      if (this._pendingSpawns) {
        const spawns = this._pendingSpawns;
        this._pendingSpawns = null;
        this.setSpawns(spawns);
      }
    }
  }

  // ---- Shooting -----------------------------------------------------------
  onShoot(raycaster) {
    if (this._dead && !this.isTracking) return;
    if (this.isDeathmatch && this.input.spawnGraceRemaining > 0) return;

    const colliders = [];
    for (const r of this.remotes.values()) {
      if (!r.dead) for (const c of r.colliders) colliders.push(c);
    }
    const coverHit = raycaster.intersectObjects(this.coverMeshes, false)[0];
    const hits = raycaster.intersectObjects(colliders, false);

    let claim = null;
    if (hits.length && (!coverHit || hits[0].distance < coverHit.distance)) {
      const obj = hits[0].object;
      for (const [id, r] of this.remotes) {
        if (r.dead) continue;
        if (r.colliders.includes(obj)) {
          const zone = obj.userData.zone === 'head' ? 'head' : 'body';
          claim = { victimId: id, zone };
          break;
        }
      }
      if (claim) {
        if (!this.isTracking) {
          this.hits++;
          this.crosshair?.hit();
        }
      }
    }

    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    let muzzle = null;
    const vm = this.engine.viewmodel;
    if (vm) {
      const p = this.engine.player;
      const motion = p?.enabled
        ? { onGround: p.onGround, speedHoriz: Math.hypot(p.vel.x, p.vel.z) }
        : {};
      vm.syncMuzzleForShot(motion);
      muzzle = vm.getMuzzlePosition(_wOrigin);
    }
    this.net?.sendShot(
      { x: o.x, y: o.y, z: o.z },
      { x: d.x, y: d.y, z: d.z },
      claim,
      this._lastShotAccuracy,
      this._lastImpact,
      muzzle ? { x: muzzle.x, y: muzzle.y, z: muzzle.z } : null
    );
  }

  // ---- HUD helpers --------------------------------------------------------
  getScores() {
    return this.scores;
  }
  getMpStats() {
    return this.mpStats;
  }
  getTarget() {
    return this.isTracking ? 0 : this.target;
  }

  getGameMode() {
    return this.isTracking ? 'tracking' : this.isDeathmatch ? 'deathmatch' : 'duel';
  }

  getMatchEndsAt() {
    return this.matchEndsAt;
  }

  setMatchEndsAt(ms) {
    if (Number.isFinite(ms)) this.matchEndsAt = ms;
  }

  dispose() {
    for (const r of this.remotes.values()) {
      this.root.remove(r.group);
      r.colliders.forEach((m) => { m.geometry?.dispose(); m.material?.dispose(); });
    }
    this.remotes.clear();
    for (const obj of this._arenaObjects) {
      this.root.remove(obj);
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material?.dispose?.();
    }
    this._arenaObjects.length = 0;
    this.engine.setDeathOverlay(0);
    super.dispose();
  }
}
