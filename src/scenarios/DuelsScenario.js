// ---------------------------------------------------------------------------
// DuelsScenario.js  ("Duels")
//
// A 1v1 peek-fight in one of ten hand-built arenas (varying distance, height,
// cover and peek side). Five symmetric arenas let the bot peek either direction;
// five asymmetric arenas restrict peeks to one side only (left or right).
// You spawn behind your own box and may strafe + crouch within a small box to
// peek your cover. The enemy hides behind its box and breaks out at CS2 speed —
// peeking LEFT or RIGHT, WIDE or CLOSE, holding the angle, jiggling (out-in-out),
// or peeking and retreating. Drop it while it is exposed.
//
// The bot's lateral movement runs through SourceMover1D, the exact friction +
// acceleration model the player uses, so its peeks ramp and stop like a real
// player's. Cover boxes are real occluders: a shot is only valid while the bot
// has actually cleared its box.
//
//   Head = instant kill (crit) · Body = 2 shots.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, clamp, lerp, degToRad } from '../utils/MathUtils.js';
import { SourceMover1D, RUN_SPEED, STAND_EYE } from '../utils/SourceMovement.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { competitivePresetFor } from './competitivePresets.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_R = 0.27;
const HEAD_Y = BODY_H + HEAD_R + 0.02; // local head-centre height (feet at 0)

const _headPos = new THREE.Vector3();
const _eyePos = new THREE.Vector3();
const _losDir = new THREE.Vector3();
const _losRay = new THREE.Raycaster();
const MAX_PITCH = degToRad(89);

// Each arena: where the player spawns + how far they may roam, where the enemy
// lives, and the boxes (all of which occlude). `ecHalf` is the half-width of the
// enemy's main cover along the strafe (X) axis — peek offsets are measured from it.
// Optional `peekSide`: -1 = left only, +1 = right only; omit for 50/50.
const ARENAS = [
  {
    label: 'Long Lane',
    player: { pos: [0, 0, 11], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: 0, z: -11, y: 0 },
    ecHalf: 0.8,
    boxes: [
      { pos: [0, 0.7, 10.0], size: [1.8, 1.4, 0.4], role: 'player' },
      { pos: [0, 3.0, -10.0], size: [1.6, 6.0, 0.45], role: 'enemy' }
    ]
  },
  {
    label: 'CQB',
    player: { pos: [0, 0, 3.4], yaw: 0, half: [1.3, 0.8] },
    enemy: { x: 0, z: -3.4, y: 0 },
    ecHalf: 0.65,
    boxes: [
      { pos: [0, 0.65, 2.6], size: [1.4, 1.3, 0.4], role: 'player' },
      { pos: [0, 3.0, -2.6], size: [1.3, 6.0, 0.4], role: 'enemy' }
    ]
  },
  {
    label: 'High Ground',
    player: { pos: [0, 0, 8], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: 0, z: -8, y: 1.8 },
    ecHalf: 0.85,
    boxes: [
      { pos: [0, 0.7, 7.2], size: [1.8, 1.4, 0.4], role: 'player' },
      { pos: [0, 0.9, -8.0], size: [3.4, 1.8, 3.4], role: 'prop' }, // platform (top 1.8)
      { pos: [0, 4.8, -6.7], size: [1.7, 6.0, 0.45], role: 'enemy' } // wall on platform
    ]
  },
  {
    label: 'The Pit',
    player: { pos: [0, 1.6, 7], yaw: 0, half: [1.6, 0.9] },
    enemy: { x: 0, z: -7, y: 0 },
    ecHalf: 0.8,
    boxes: [
      { pos: [0, 0.8, 7.5], size: [4.0, 1.6, 4.0], role: 'prop' }, // player platform (top 1.6)
      { pos: [0, 3.0, -6.2], size: [1.6, 6.0, 0.45], role: 'enemy' }
    ]
  },
  {
    label: 'Split',
    player: { pos: [0, 0, 7.5], yaw: 0, half: [2.0, 1.0] },
    enemy: { x: 0, z: -7.5, y: 0 },
    ecHalf: 0.7,
    boxes: [
      { pos: [0, 0.7, 6.7], size: [2.0, 1.4, 0.4], role: 'player' },
      { pos: [0, 3.0, -6.7], size: [1.4, 6.0, 0.45], role: 'enemy' },
      { pos: [-2.4, 3.75, -6.9], size: [0.6, 7.5, 0.6], role: 'prop' },
      { pos: [2.4, 3.75, -6.9], size: [0.6, 7.5, 0.6], role: 'prop' }
    ]
  },
  // ---- Asymmetric (one-sided peek) -----------------------------------------
  // Corner bunkers / ramparts: a continuous sealed mass on the blocked flank
  // (prop boxes flush with enemy cover) and a clear open lane on the peek side.
  {
    label: 'Left Corner',
    peekSide: -1,
    player: { pos: [1.0, 0, 3.5], yaw: 0, half: [1.5, 0.8] },
    enemy: { x: 0.3, z: -3.9, y: 0 },
    ecHalf: 0.425,
    boxes: [
      { pos: [1.2, 0.65, 2.7], size: [1.4, 1.3, 0.4], role: 'player' },
      { pos: [-0.05, 3.0, -3.05], size: [0.85, 6.0, 0.48], role: 'enemy' },
      { pos: [0.5875, 3.0, -3.05], size: [0.425, 6.0, 0.48], role: 'prop' },
      { pos: [2.0, 3.15, -3.05], size: [2.4, 6.3, 2.6], role: 'prop' }
    ]
  },
  {
    label: 'Right Corner',
    peekSide: 1,
    player: { pos: [-1.0, 0, 3.5], yaw: 0, half: [1.5, 0.8] },
    enemy: { x: -0.3, z: -3.9, y: 0 },
    ecHalf: 0.425,
    boxes: [
      { pos: [-1.2, 0.65, 2.7], size: [1.4, 1.3, 0.4], role: 'player' },
      { pos: [0.05, 3.0, -3.05], size: [0.85, 6.0, 0.48], role: 'enemy' },
      { pos: [-0.5875, 3.0, -3.05], size: [0.425, 6.0, 0.48], role: 'prop' },
      { pos: [-2.0, 3.15, -3.05], size: [2.4, 6.3, 2.6], role: 'prop' }
    ]
  },
  {
    label: 'Left Rampart',
    peekSide: -1,
    player: { pos: [1.2, 0, 7.5], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: 0.5, z: -8.0, y: 0 },
    ecHalf: 0.5,
    boxes: [
      { pos: [1.5, 0.7, 6.8], size: [1.6, 1.4, 0.4], role: 'player' },
      { pos: [0.3, 3.0, -7.2], size: [1.0, 6.0, 0.5], role: 'enemy' },
      { pos: [2.0125, 3.0, -7.2], size: [2.425, 6.0, 0.5], role: 'prop' },
      { pos: [3.5, 3.6, -7.0], size: [0.55, 7.2, 6.0], role: 'prop' }
    ]
  },
  {
    label: 'Right Loft',
    peekSide: 1,
    player: { pos: [-0.5, 0, 7.5], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: -0.15, z: -7.6, y: 1.8 },
    ecHalf: 0.45,
    boxes: [
      { pos: [-0.8, 0.7, 6.8], size: [1.6, 1.4, 0.4], role: 'player' },
      { pos: [0, 0.9, -8.0], size: [3.0, 1.8, 3.0], role: 'prop' },
      { pos: [0.15, 4.8, -6.8], size: [0.9, 6.0, 0.45], role: 'enemy' },
      { pos: [-0.4, 4.8, -6.8], size: [0.2, 6.0, 0.45], role: 'prop' },
      { pos: [-1.6, 4.8, -6.9], size: [2.2, 6.0, 2.2], role: 'prop' }
    ]
  },
  {
    label: 'Left Bulwark',
    peekSide: -1,
    player: { pos: [1.5, 0, 10.5], yaw: 0, half: [2.0, 1.0] },
    enemy: { x: 0.4, z: -11.0, y: 0 },
    ecHalf: 0.45,
    boxes: [
      { pos: [2.0, 0.7, 9.5], size: [1.8, 1.4, 0.4], role: 'player' },
      { pos: [-0.15, 3.0, -10.0], size: [0.9, 6.0, 0.55], role: 'enemy' },
      { pos: [2.0, 3.15, -10.0], size: [3.4, 6.3, 0.55], role: 'prop' },
      { pos: [4.0, 4.2, -9.5], size: [0.6, 8.4, 4.5], role: 'prop' }
    ]
  }
];

const REACT_MIN = 0.45; // s, delay between peeks
const REACT_MAX = 1.9;
const HOLD_MIN = 0.5; // s, time held on a hold-peek
const HOLD_MAX = 1.4;
const CROUCH_RATE = 9;
const DUELS_MOVE_HALF = 10; // 20 m × 20 m player roam box
const DEATH_FX_DUR = 0.55;
const DEATH_FX_PITCH = degToRad(38); // upward view flick on death (radians)

export class DuelsScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const d = this.settings.data.duels;
    const choice = this.config.arena ?? d.arena;
    this.arenaIndex = choice >= 1 && choice <= ARENAS.length ? choice - 1 : randInt(0, ARENAS.length - 1);
    this.arena = ARENAS[this.arenaIndex];

    const preset = this.competitive ? competitivePresetFor('duels') : null;
    this._ttk = this.config.ttk ?? preset?.ttk ?? d.ttk ?? 0.5;
    this._arenaObjects = [];
    this.coverMeshes = [];
    this.enemy = null;
    this._buildArena();
  }

  get name() {
    return 'duels';
  }

  static configKeyFor(settings) {
    const d = settings.data.duels;
    const a = d.arena >= 1 && d.arena <= ARENAS.length ? d.arena : 'rand';
    return `arena${a}_d${settings.data.runDuration}`;
  }
  configKey() {
    return DuelsScenario.configKeyFor(this.settings);
  }

  _playerBounds(a) {
    const [px, , pz] = a.player.pos;
    return {
      minX: px - DUELS_MOVE_HALF,
      maxX: px + DUELS_MOVE_HALF,
      minZ: pz - DUELS_MOVE_HALF,
      maxZ: pz + DUELS_MOVE_HALF
    };
  }

  _colliderBoxes(a) {
    return a.boxes.map((b) => ({ pos: b.pos, size: b.size }));
  }

  // ---- Environment --------------------------------------------------------
  _buildArena() {
    // Dispose previous arena objects (supports mid-run arena switches).
    for (const obj of this._arenaObjects) {
      this.root.remove(obj);
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material?.dispose?.();
    }
    this._arenaObjects = [];
    this.coverMeshes = [];

    const add = (obj) => { this.root.add(obj); this._arenaObjects.push(obj); return obj; };
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    add(floor);

    const grid = new THREE.GridHelper(80, 80, gridCenter, gridEdge);
    grid.position.y = 0.002;
    add(grid);

    const boxMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.85, metalness: 0.05 });
    const enemyBoxMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.85, metalness: 0.05 });
    for (const b of this.arena.boxes) {
      const mat = b.role === 'enemy' ? enemyBoxMat : boxMat;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]), mat);
      mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
      add(mesh);
      this.coverMeshes.push(mesh);
    }
  }

  _switchArena() {
    let newIdx;
    do { newIdx = randInt(0, ARENAS.length - 1); } while (newIdx === this.arenaIndex && ARENAS.length > 1);
    this.arenaIndex = newIdx;
    this.arena = ARENAS[newIdx];
    this._buildArena();
    const a = this.arena;
    this.engine.player.spawn({
      pos: a.player.pos,
      yaw: a.player.yaw,
      bounds: this._playerBounds(a),
      colliders: this._colliderBoxes(a)
    });
  }

  // ---- Bot ---------------------------------------------------------------
  _buildBot() {
    const t = new Target();

    // bodyRig squishes on crouch; head is a sibling (not inside it) so it keeps its shape.
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

  _spawnEnemy() {
    const target = this._buildBot();
    this.addTarget(target);
    const mover = new SourceMover1D();
    mover.reset(0);
    this.enemy = {
      target,
      mover,
      hp: 2,
      crouch: 0,
      phase: 'idle',
      timer: randRange(REACT_MIN, REACT_MAX),
      sub: 0,
      side: 1,
      offset: 0,
      jiggleLeft: 0,
      hasLos: false,
      wasLos: false,
      exposedTimer: -1,
      countedMiss: false
    };
    this._placeEnemy(0);
  }

  /** Position the live bot at lateral offset `s` from its home column. */
  _placeEnemy(s) {
    const e = this.enemy;
    const a = this.arena;
    e.target.object.position.set(a.enemy.x + s, a.enemy.y, a.enemy.z);
  }

  _peekOffsets() {
    const a = this.arena;
    const close = a.ecHalf + BODY_R + 0.25;
    const wide = a.ecHalf + BODY_R + 1.4;
    return { close, wide };
  }

  /** True when the bot's head centre has unobstructed line-of-sight to the player eye. */
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

  _beginPeek() {
    const e = this.enemy;
    const { close, wide } = this._peekOffsets();
    const forced = this.arena.peekSide;
    e.side = forced != null ? forced : Math.random() < 0.5 ? -1 : 1;
    const width = Math.random() < 0.5 ? close : wide;
    e.offset = e.side * width;
    e.countedMiss = false;

    const roll = Math.random();
    if (roll < 0.25) {
      e.phase = 'jiggle';
      e.jiggleLeft = randInt(2, 4); // out-in repetitions
      e.sub = 0;
    } else if (roll < 0.55) {
      e.phase = 'peekreturn'; // out then straight back
    } else {
      e.phase = 'hold';
      e.timer = randRange(HOLD_MIN, HOLD_MAX);
      e.crouchWant = Math.random() < 0.35 ? 1 : 0; // sometimes crouch on the hold
    }
  }

  _retreatDone() {
    const e = this.enemy;
    // A completed peek the player failed to punish counts as a miss (a trade lost).
    if (!e.countedMiss && e.target.state !== 'dying') {
      this.misses++;
      e.countedMiss = true;
    }
    e.phase = 'idle';
    e.timer = randRange(REACT_MIN, REACT_MAX);
    e.crouchWant = 0;
  }

  // ---- Round flow --------------------------------------------------------
  onStart() {
    const a = this.arena;
    this.engine.player.spawn({
      pos: a.player.pos,
      yaw: a.player.yaw,
      bounds: this._playerBounds(a),
      colliders: this._colliderBoxes(a)
    });
    this._spawnEnemy();
  }

  onUpdate(dt) {
    const e = this.enemy;
    if (!e) return;

    // Crouch animation (rig scales down from the feet).
    const want = e.phase === 'hold' ? e.crouchWant || 0 : 0;
    e.crouch = clamp(e.crouch + (want - e.crouch) * Math.min(1, CROUCH_RATE * dt), 0, 1);
    if (e.target.rig) e.target.rig.scale.y = lerp(1, 0.55, e.crouch);
    if (e.target.headMesh) {
      e.target.headMesh.position.y = BODY_H * lerp(1, 0.55, e.crouch) + HEAD_R + 0.02;
    }

    if (e.target.state === 'dying') return;
    const max = RUN_SPEED;

    switch (e.phase) {
      case 'idle':
        e.timer -= dt;
        // Settle behind cover.
        e.mover.seek(dt, 0, max);
        if (e.timer <= 0) this._beginPeek();
        break;

      case 'hold': {
        e.mover.seek(dt, e.offset, max);
        e.timer -= dt;
        if (e.timer <= 0) e.phase = 'back';
        break;
      }

      case 'peekreturn': {
        const reached = e.mover.seek(dt, e.offset, max);
        if (reached) e.phase = 'back';
        break;
      }

      case 'jiggle': {
        // Alternate between the peek offset and just behind cover.
        const goalOut = e.sub % 2 === 0;
        const goal = goalOut ? e.offset : 0;
        const reached = e.mover.seek(dt, goal, max);
        if (reached) {
          e.sub++;
          e.jiggleLeft--;
          if (e.jiggleLeft <= 0) e.phase = 'back';
        }
        break;
      }

      case 'back': {
        const reached = e.mover.seek(dt, 0, max);
        if (reached) this._retreatDone();
        break;
      }
    }

    this._placeEnemy(e.mover.s);

    const hasLos = this._botHeadHasLos(e);

    // TTK starts only once the bot's head can actually see the player.
    if (hasLos && !e.wasLos) e.exposedTimer = this._ttk;
    if (!hasLos) e.exposedTimer = -1;
    e.wasLos = hasLos;
    e.hasLos = hasLos;

    if (hasLos && e.exposedTimer > 0) {
      e.exposedTimer -= dt;
      if (e.exposedTimer <= 0) this._onPlayerDeath();
    }

    this._updateBotFootsteps(e, dt);
  }

  /** Spatial footsteps for the strafing bot (same rules as MP remotes). */
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

  _onPlayerDeath() {
    const e = this.enemy;
    this.misses++;
    beep(180, 0.1, 'sawtooth', 0.2);
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
    this._respawnTimer = DEATH_FX_DUR + 0.35;
    this._switchArenaOnRespawn = true;
  }

  _updateDeathFx(dt) {
    const fx = this._deathFx;
    if (!fx) return;

    fx.t += dt;
    const p = Math.min(1, fx.t / fx.duration);

    // Fast red wash in, ease out before the next duel.
    let red;
    if (p < 0.2) red = p / 0.2;
    else if (p > 0.5) red = 1 - (p - 0.5) / 0.5;
    else red = 1;
    this.engine.setDeathOverlay(red);

    // Upward view flick (pitch), not a positional camera lift.
    const flick = fx.flick * Math.sin(Math.min(1, p * 1.6) * Math.PI * 0.5);
    const pitch = clamp(fx.startPitch + flick, -MAX_PITCH, MAX_PITCH);
    this.engine.camera.rotation.x = pitch;
    const input = this.engine.player?.input;
    if (input) input.pitch = pitch;

    if (fx.t >= fx.duration) {
      this._deathFx = null;
      this.engine.setDeathOverlay(0);
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster, this.coverMeshes);
    if (!hit) return;
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt) return; // hit a box → blocked

    const e = this.enemy;
    if (!e || tgt !== e.target || e.target.state === 'dying') return;

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

  _killEnemy() {
    const e = this.enemy;
    e.target.startDying(0x35e06a);
    this.enemy = null;
    this._respawnTimer = 0.45;
    this._switchArenaOnRespawn = true;
  }

  // BaseScenario.update advances targets/elapsed; we also tick the respawn delay.
  update(dt) {
    super.update(dt);
    if (!this.running) return;
    this._updateDeathFx(dt);
    if (this._respawnTimer != null) {
      this._respawnTimer -= dt;
      if (this._respawnTimer <= 0) {
        this._respawnTimer = null;
        this.engine.weapon?.reset(); // auto-reload the mag on every round reset
        if (this._switchArenaOnRespawn) {
          this._switchArenaOnRespawn = false;
          this._switchArena();
        }
        this._spawnEnemy();
      }
    }
  }
}
