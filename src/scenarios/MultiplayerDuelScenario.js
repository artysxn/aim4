// ---------------------------------------------------------------------------
// MultiplayerDuelScenario.js
// Online 1v1 duel on a symmetric map. The local player moves with the shared
// PlayerController (CS2 movement); remote players render as the same avatar as
// the singleplayer enemy bot and are interpolated from server snapshots. Shots
// are validated server-side (server-authoritative hits/score); locally we only
// draw an immediate hitmarker for responsiveness.
//
// The scenario does NOT own the WebSocket — the MultiplayerController routes net
// events into the apply* / setSpawns methods, and reads getScores() for the HUD.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { clamp, degToRad, lerp } from '../utils/MathUtils.js';
import { gridLineColors, createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';
import { getMap, mapExtent } from '../multiplayer/maps.js';
import {
  BODY_R,
  BODY_H,
  HEAD_R,
  HEAD_OFFSET,
  crouchScale,
  STAND_EYE,
  CROUCH_EYE,
  SPAWN_GRACE
} from '../multiplayer/constants.js';

const HEAD_Y = BODY_H + HEAD_R + HEAD_OFFSET;
const MAX_PITCH = degToRad(89);
const DEATH_FX_DUR = 0.55;
const DEATH_FX_PITCH = degToRad(38);
const INTERP_RATE = 50; // exponential follow rate for remote interpolation
const STATE_HZ = 64; // cap upstream state sends (server sim is 128 Hz)

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

    this.scores = this.config.scores || {};
    this.mpStats = this.config.stats || {};
    this.players = this.config.players || {}; // id -> { name, side }
    this.remotes = new Map(); // id -> avatar record
    this.coverMeshes = [];
    this._arenaObjects = [];

    this._deathFx = null;
    this._dead = false;
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
  setMap(mapId) {
    if (mapId === this.mapId) return;
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
      add(mesh);
      this.coverMeshes.push(mesh);
    }
  }

  /** Build a remote-player avatar (identical to the Duels enemy bot model). */
  _makeAvatar() {
    const c = this.settings.data.colors;
    const group = new THREE.Group();

    const rig = new THREE.Group();
    group.add(rig);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 18),
      new THREE.MeshStandardMaterial({ color: c.enemyBody, emissive: 0x661222, emissiveIntensity: 0.4, roughness: 0.5 })
    );
    body.position.y = BODY_H / 2;
    body.userData.zone = 'body';
    rig.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R, 22, 16),
      new THREE.MeshStandardMaterial({ color: c.enemyHead, emissive: 0xff7b00, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    head.position.y = HEAD_Y;
    head.userData.zone = 'head';
    group.add(head);

    this.root.add(group);
    return { group, rig, body, head, colliders: [body, head] };
  }

  _ensureRemote(id) {
    let r = this.remotes.get(id);
    if (!r) {
      r = this._makeAvatar();
      r.cur = { x: 0, z: 0, y: STAND_EYE, yaw: 0, crouch: 0 };
      r.target = { x: 0, z: 0, y: STAND_EYE, yaw: 0, crouch: 0 };
      r.vel = { x: 0, y: 0, z: 0 };
      r.lastSnapSt = 0;
      r.dead = false;
      this.remotes.set(id, r);
    }
    return r;
  }

  // ---- Spawns / lifecycle -------------------------------------------------
  setSpawns(spawns) {
    for (const [idStr, sp] of Object.entries(spawns)) {
      const id = Number(idStr);
      if (id === this.myId) {
        this._dead = false;
        this._deathFx = null;
        this.engine.setDeathOverlay(0);
        this.engine.player.spawn({
          pos: sp.pos,
          yaw: sp.yaw,
          colliders: this.map.boxes,
          spawnGrace: SPAWN_GRACE
        });
      } else {
        const r = this._ensureRemote(id);
        const eyeY = sp.pos[1] + STAND_EYE;
        r.cur.x = r.target.x = sp.pos[0];
        r.cur.z = r.target.z = sp.pos[2];
        r.cur.y = r.target.y = eyeY;
        r.cur.yaw = r.target.yaw = sp.yaw;
        r.cur.crouch = r.target.crouch = 0;
        r.dead = false;
        r.group.visible = true;
      }
    }
  }

  onStart() {
    // Local player already placed via setSpawns in the constructor.
  }

  // ---- Net event application (called by the controller) -------------------
  applySnapshot(msg) {
    const st = msg.st || Date.now();
    for (const p of msg.players) {
      if (p.id === this.myId) continue;
      const r = this._ensureRemote(p.id);
      const prev = r.target;
      const dt = r.lastSnapSt ? (st - r.lastSnapSt) / 1000 : 0;
      if (dt > 0.001 && dt < 0.25) {
        r.vel.x = (p.x - prev.x) / dt;
        r.vel.y = (p.y - prev.y) / dt;
        r.vel.z = (p.z - prev.z) / dt;
      }
      r.lastSnapSt = st;
      r.target.x = p.x;
      r.target.y = p.y;
      r.target.z = p.z;
      r.target.yaw = p.yaw;
      r.target.crouch = p.crouch;
      r.dead = p.dead;
    }
  }

  applyHit(msg) {
    // Hitmarker + local hits count are handled at fire time from the client raycast.
    if (msg.shooterId === this.myId) return;
  }

  applyKill(msg) {
    this.scores = msg.scores || this.scores;
    if (msg.stats) this.mpStats = msg.stats;
    if (msg.mapId) this.setMap(msg.mapId);
    if (msg.shooterId === this.myId && msg.victimId !== this.myId) {
      beep(1000, 0.05, 'square', 0.06);
      this.kills++;
    }
    if (msg.spawns) this.setSpawns(msg.spawns);
    else if (msg.victimId === this.myId) this._die();
  }

  applyRespawn(msg) {
    if (msg.spawns) this.setSpawns(msg.spawns);
  }

  _die() {
    if (this._dead) return;
    this._dead = true;
    this.engine.player.enabled = false;
    beep(180, 0.1, 'sawtooth', 0.2);
    this._deathFx = { t: 0, startPitch: this.input.pitch };
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

  _interpRemotes(dt) {
    const a = 1 - Math.exp(-INTERP_RATE * dt);
    // Extrapolate remote targets forward by ~half RTT so they don't always trail.
    const ext = Math.min(0.06, (this.net?.pingMs || 0) * 0.0005);
    for (const r of this.remotes.values()) {
      const tx = r.target.x + r.vel.x * ext;
      const ty = r.target.y + r.vel.y * ext;
      const tz = r.target.z + r.vel.z * ext;
      r.cur.x += (tx - r.cur.x) * a;
      r.cur.y += (ty - r.cur.y) * a;
      r.cur.z += (tz - r.cur.z) * a;
      r.cur.crouch += (r.target.crouch - r.cur.crouch) * a;
      // Shortest-arc yaw interpolation.
      let dy = r.target.yaw - r.cur.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      r.cur.yaw += dy * a;

      r.group.visible = !r.dead;
      const sc = crouchScale(r.cur.crouch);
      const eyeOff = lerp(STAND_EYE, CROUCH_EYE, r.cur.crouch);
      const footY = r.cur.y - eyeOff;
      r.group.position.set(r.cur.x, footY, r.cur.z);
      r.group.rotation.y = r.cur.yaw;
      r.rig.scale.y = sc;
      r.head.position.y = BODY_H * sc + HEAD_R + HEAD_OFFSET;
    }
  }

  _updateDeathFx(dt) {
    const fx = this._deathFx;
    if (!fx) return;
    fx.t += dt;
    const prog = Math.min(1, fx.t / DEATH_FX_DUR);
    let red;
    if (prog < 0.2) red = prog / 0.2;
    else if (prog > 0.5) red = 1 - (prog - 0.5) / 0.5;
    else red = 1;
    this.engine.setDeathOverlay(red);

    const flick = DEATH_FX_PITCH * Math.sin(Math.min(1, prog * 1.6) * Math.PI * 0.5);
    const pitch = clamp(fx.startPitch + flick, -MAX_PITCH, MAX_PITCH);
    this.engine.camera.rotation.x = pitch;
    this.input.pitch = pitch;

    if (fx.t >= DEATH_FX_DUR) {
      this._deathFx = null;
      this.engine.setDeathOverlay(0);
    }
  }

  // ---- Shooting -----------------------------------------------------------
  onShoot(raycaster) {
    if (this._dead) return;

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
        this.hits++;
        this.crosshair?.hit();
      }
    }

    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    this.net?.sendShot({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, claim);
  }

  // ---- HUD helpers --------------------------------------------------------
  getScores() {
    return this.scores;
  }
  getMpStats() {
    return this.mpStats;
  }
  getTarget() {
    return this.target;
  }

  getThreats() {
    const out = [];
    for (const r of this.remotes.values()) {
      if (r.dead) continue;
      const sc = crouchScale(r.cur.crouch);
      const footY = r.cur.y - lerp(STAND_EYE, CROUCH_EYE, r.cur.crouch);
      out.push(new THREE.Vector3(r.cur.x, footY + BODY_H * sc * 0.6, r.cur.z));
    }
    return out;
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
