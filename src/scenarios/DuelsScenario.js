// ---------------------------------------------------------------------------
// DuelsScenario.js  ("Duels")
//
// A 1v1 peek-fight in one of fifteen hand-built arenas (varying distance,
// height, cover shape and peek side). Seven symmetric arenas let the bot peek
// either direction; eight asymmetric arenas restrict peeks to one side only
// (left or right). Cover is built from layered crates, bunkers, ramparts,
// platforms and low barriers — not bare pillars — so every arena reads and
// plays differently.
// You spawn behind your own box and may strafe + crouch within a small box to
// peek your cover. The enemy hides behind its box and breaks out at CS2 speed —
// peeking LEFT or RIGHT, WIDE or CLOSE, holding the angle, peeking and
// retreating, or JIGGLE-PEEKING: strafing out only until its head is barely
// visible, immediately snapping back, then re-deciding which angle to search.
// Drop it while it is exposed.
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
import { markBulletDecalSurface, worldImpactNormal } from '../utils/bulletImpact.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { HEAD_R, HEAD_OFFSET } from '../multiplayer/constants.js';
import { movementHitScale, isPointVisible } from '../utils/spawnVisibility.js';
import { SHOT_INTERVAL } from '../weapons/ak47.js';
import {
  getDuelsArenaPool,
  resolveDuelsArenaChoice,
  duelsArenaConfigKey
} from './duelsArenas.js';
import { mapExtent } from '../multiplayer/maps.js';
import { DEATH_OVERLAY_STRENGTH } from './deathFx.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_Y = BODY_H + HEAD_R + HEAD_OFFSET; // local head-centre height (feet at 0)

const _headPos = new THREE.Vector3();
const _eyePos = new THREE.Vector3();
const _aimPos = new THREE.Vector3();
const _tracerEnd = new THREE.Vector3();
const _impactNormal = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _losDir = new THREE.Vector3();
const _losRay = new THREE.Raycaster();
const MAX_PITCH = degToRad(89);
const PLAYER_HP = 2;
const BACKSHOT_FIRE_DELAY = 1.0;

// Each arena: where the player spawns + how far they may roam, where the enemy
// lives, and the boxes (all of which occlude). `ecHalf` is the half-width of the
// enemy's main cover along the strafe (X) axis — peek offsets are measured from it.
// Optional `peekSide`: -1 = left only, +1 = right only; omit for 50/50.
// ===========================================================================
//  SYMMETRIC arenas (peekSide omitted) — both flanks of the enemy cover are
//  open, so the bot may break left OR right. Decorative props are kept either
//  low (head clears over them), behind the enemy, or well outside peek range so
//  they never seal a lane.
// ===========================================================================
export const ARENAS = [
  {
    // Long flat lane. Mid-tall central wall with a wide backdrop and two
    // mismatched crate stacks set well back for depth.
    label: 'Long Lane',
    player: { pos: [0, 0, 12.5], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: 0, z: -12.5, y: 0 },
    ecHalf: 0.85,
    boxes: [
      { pos: [0, 0.7, 11.5], size: [2.0, 1.4, 0.5], role: 'player' },
      { pos: [0, 1.5, -11.5], size: [1.7, 3.0, 0.55], role: 'enemy' },
      { pos: [0, 1.1, -13.4], size: [5.4, 2.2, 0.45], role: 'prop' }, // backdrop wall
      { pos: [-3.7, 0.55, -11.7], size: [1.1, 1.1, 1.1], role: 'prop' },
      { pos: [3.7, 0.9, -11.7], size: [1.1, 1.8, 1.1], role: 'prop' }
    ]
  },
  {
    // Mid-range crate yard. Cover is a stepped crate stack, flanked by low
    // pallets the bot's head clears over.
    label: 'Garage',
    player: { pos: [0, 0, 8], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: 0, z: -8, y: 0 },
    ecHalf: 0.95,
    boxes: [
      { pos: [0, 0.6, 7.0], size: [2.0, 1.2, 1.0], role: 'player' },
      { pos: [0, 1.0, -7.2], size: [1.9, 2.0, 1.1], role: 'enemy' }, // big crate (top 2.0)
      { pos: [0, 2.3, -7.35], size: [1.1, 0.6, 0.9], role: 'prop' }, // stacked crate (top 2.6)
      { pos: [-3.7, 0.4, -7.0], size: [1.2, 0.8, 1.4], role: 'prop' }, // low pallet
      { pos: [3.7, 0.4, -7.0], size: [1.2, 0.8, 1.4], role: 'prop' }
    ]
  },
  {
    // The enemy holds a low raised catwalk; you fight up onto it. Side rail
    // blocks are low enough that the elevated head still peeks over them.
    label: 'Catwalk',
    player: { pos: [0, 0, 9.5], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: 0, z: -9.5, y: 0.9 },
    ecHalf: 0.8,
    boxes: [
      { pos: [0, 0.7, 8.5], size: [1.8, 1.4, 0.5], role: 'player' },
      { pos: [0, 0.45, -9.5], size: [4.2, 0.9, 2.2], role: 'prop' }, // platform (top 0.9)
      { pos: [0, 2.35, -8.9], size: [1.7, 2.9, 0.5], role: 'enemy' }, // wall on platform
      { pos: [-3.0, 1.4, -9.3], size: [0.45, 1.6, 1.6], role: 'prop' },
      { pos: [3.0, 1.4, -9.3], size: [0.45, 1.6, 1.6], role: 'prop' }
    ]
  },
  {
    // Open plaza: a tall central monument with two low flanking wings. The
    // wings shape the space without sealing either peek.
    label: 'Plaza',
    player: { pos: [0, 0, 8.5], yaw: 0, half: [2.0, 1.0] },
    enemy: { x: 0, z: -8.5, y: 0 },
    ecHalf: 0.7,
    boxes: [
      { pos: [0, 0.7, 7.5], size: [2.2, 1.4, 0.5], role: 'player' },
      { pos: [0, 1.45, -7.6], size: [1.4, 2.9, 0.7], role: 'enemy' },
      { pos: [-2.3, 0.45, -7.6], size: [1.8, 0.9, 0.7], role: 'prop' }, // low wing
      { pos: [2.3, 0.45, -7.6], size: [1.8, 0.9, 0.7], role: 'prop' }
    ]
  },
  {
    // Close-quarters crate pit. A wide crate wall with a taller crate behind
    // for a backdrop and two mismatched crates pushed out of the lanes.
    label: 'Bunker Yard',
    player: { pos: [0, 0, 6], yaw: 0, half: [1.6, 0.9] },
    enemy: { x: 0, z: -6, y: 0 },
    ecHalf: 1.0,
    boxes: [
      { pos: [0, 0.6, 5.2], size: [2.0, 1.2, 1.0], role: 'player' },
      { pos: [0, 1.1, -5.4], size: [2.0, 2.2, 1.0], role: 'enemy' },
      { pos: [0, 1.6, -6.6], size: [1.3, 3.2, 1.0], role: 'prop' }, // taller backdrop crate
      { pos: [-3.8, 0.55, -5.3], size: [1.1, 1.1, 1.0], role: 'prop' },
      { pos: [3.8, 0.85, -5.3], size: [1.1, 1.7, 1.0], role: 'prop' }
    ]
  },
  {
    // The enemy holds high ground on a chest-high overpass; you fight up at it.
    // Support pillars sit just outside the wide peek on both sides.
    label: 'Overpass',
    player: { pos: [0, 0, 10], yaw: 0, half: [1.9, 1.0] },
    enemy: { x: 0, z: -10, y: 1.8 },
    ecHalf: 0.85,
    boxes: [
      { pos: [0, 0.7, 9.0], size: [1.9, 1.4, 0.5], role: 'player' },
      { pos: [0, 0.9, -10.0], size: [3.6, 1.8, 3.0], role: 'prop' }, // platform (top 1.8)
      { pos: [0, 3.3, -9.0], size: [1.8, 3.0, 0.5], role: 'enemy' }, // wall on platform
      { pos: [-3.3, 1.0, -9.6], size: [0.5, 2.0, 2.4], role: 'prop' },
      { pos: [3.3, 1.0, -9.6], size: [0.5, 2.0, 2.4], role: 'prop' }
    ]
  },
  {
    // You hold the high ground this time, looking down into a trench at the
    // enemy. Crates flank the trench, a back wall caps it.
    label: 'Trench',
    player: { pos: [0, 1.6, 7], yaw: 0, half: [1.6, 0.9] },
    enemy: { x: 0, z: -7, y: 0 },
    ecHalf: 0.85,
    boxes: [
      { pos: [0, 0.8, 7.5], size: [4.0, 1.6, 3.0], role: 'prop' }, // player platform (top 1.6)
      { pos: [0, 1.5, -6.4], size: [1.8, 3.0, 0.55], role: 'enemy' },
      { pos: [-3.4, 0.6, -6.4], size: [1.2, 1.2, 1.4], role: 'prop' },
      { pos: [3.4, 0.6, -6.4], size: [1.2, 1.2, 1.4], role: 'prop' },
      { pos: [0, 1.0, -7.8], size: [5.0, 2.0, 0.4], role: 'prop' } // back wall
    ]
  },
  // =========================================================================
  //  ASYMMETRIC arenas (peekSide forced) — one flank is sealed by a continuous
  //  mass of prop boxes flush with the enemy cover; the other flank is the only
  //  open lane, so the bot can peek that side only.  -1 = left, +1 = right.
  // =========================================================================
  {
    // Tight corner: enemy tucked against a solid bunker on the right, peeks left.
    label: 'Left Corner',
    peekSide: -1,
    player: { pos: [1.0, 0, 3.6], yaw: 0, half: [1.5, 0.8] },
    enemy: { x: 0.3, z: -4.0, y: 0 },
    ecHalf: 0.45,
    boxes: [
      { pos: [1.2, 0.65, 2.8], size: [1.4, 1.3, 0.5], role: 'player' },
      { pos: [0.0, 1.45, -3.1], size: [0.9, 2.9, 0.5], role: 'enemy' }, // x -0.45..0.45
      { pos: [0.85, 1.45, -3.1], size: [0.8, 2.9, 0.5], role: 'prop' }, // seal right (0.45..1.25)
      { pos: [2.1, 1.55, -3.1], size: [1.8, 3.1, 2.2], role: 'prop' } // bunker mass right
    ]
  },
  {
    // Mirror of Left Corner: bunker on the left, peeks right.
    label: 'Right Corner',
    peekSide: 1,
    player: { pos: [-1.0, 0, 3.6], yaw: 0, half: [1.5, 0.8] },
    enemy: { x: -0.3, z: -4.0, y: 0 },
    ecHalf: 0.45,
    boxes: [
      { pos: [-1.2, 0.65, 2.8], size: [1.4, 1.3, 0.5], role: 'player' },
      { pos: [0.0, 1.45, -3.1], size: [0.9, 2.9, 0.5], role: 'enemy' },
      { pos: [-0.85, 1.45, -3.1], size: [0.8, 2.9, 0.5], role: 'prop' }, // seal left
      { pos: [-2.1, 1.55, -3.1], size: [1.8, 3.1, 2.2], role: 'prop' } // bunker mass left
    ]
  },
  {
    // Rampart with a stepped wall sealing the right and a tall flank wall; the
    // open left lane has a low crate for texture. Peeks left.
    label: 'Left Rampart',
    peekSide: -1,
    player: { pos: [1.2, 0, 8], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: 0.5, z: -8.5, y: 0 },
    ecHalf: 0.55,
    boxes: [
      { pos: [1.5, 0.7, 7.2], size: [1.6, 1.4, 0.5], role: 'player' },
      { pos: [0.3, 1.5, -7.6], size: [1.1, 3.0, 0.55], role: 'enemy' }, // x -0.25..0.85
      { pos: [1.55, 1.5, -7.6], size: [1.4, 3.0, 0.55], role: 'prop' }, // seal right (0.85..2.25)
      { pos: [3.0, 1.2, -7.4], size: [0.6, 2.4, 3.0], role: 'prop' }, // tall flank wall right
      { pos: [-2.6, 0.5, -7.6], size: [1.0, 1.0, 1.0], role: 'prop' } // low crate in open lane
    ]
  },
  {
    // Enemy lofted on a platform with a bunker sealing the left; peeks right
    // and down at you from the high ground.
    label: 'Right Loft',
    peekSide: 1,
    player: { pos: [-0.5, 0, 8], yaw: 0, half: [1.8, 1.0] },
    enemy: { x: -0.2, z: -8.0, y: 1.8 },
    ecHalf: 0.5,
    boxes: [
      { pos: [-0.8, 0.7, 7.2], size: [1.6, 1.4, 0.5], role: 'player' },
      { pos: [0, 0.9, -8.4], size: [3.0, 1.8, 2.8], role: 'prop' }, // platform (top 1.8)
      { pos: [0.15, 3.25, -7.2], size: [1.0, 2.9, 0.5], role: 'enemy' }, // wall on platform
      { pos: [-0.7, 3.25, -7.2], size: [0.8, 2.9, 0.5], role: 'prop' }, // seal left
      { pos: [-1.9, 2.4, -7.4], size: [1.8, 4.2, 2.0], role: 'prop' } // bunker left
    ]
  },
  {
    // Long-range bulwark: a thick sealed wall and flank on the right, open lane
    // on the left. Peeks left across distance.
    label: 'Left Bulwark',
    peekSide: -1,
    player: { pos: [1.5, 0, 11], yaw: 0, half: [2.0, 1.0] },
    enemy: { x: 0.4, z: -11.5, y: 0 },
    ecHalf: 0.5,
    boxes: [
      { pos: [2.0, 0.7, 10.0], size: [1.8, 1.4, 0.5], role: 'player' },
      { pos: [0.1, 1.5, -10.5], size: [1.0, 3.0, 0.6], role: 'enemy' }, // x -0.4..0.6
      { pos: [1.6, 1.5, -10.5], size: [2.0, 3.0, 0.6], role: 'prop' }, // seal right (0.6..2.6)
      { pos: [3.4, 1.6, -10.2], size: [0.6, 3.2, 3.5], role: 'prop' } // long flank wall right
    ]
  },
  {
    // Crate stack duel: a wall of crates seals the left and rises in a step; the
    // right lane is open. Peeks right.
    label: 'Right Stacks',
    peekSide: 1,
    player: { pos: [-1.2, 0, 7.5], yaw: 0, half: [1.6, 0.9] },
    enemy: { x: -0.45, z: -7.5, y: 0 },
    ecHalf: 0.5,
    boxes: [
      { pos: [-1.5, 0.65, 6.7], size: [1.6, 1.3, 0.5], role: 'player' },
      { pos: [-0.05, 1.2, -7.0], size: [1.0, 2.4, 1.0], role: 'enemy' }, // crate cover (top 2.4)
      { pos: [-1.05, 1.2, -7.0], size: [1.0, 2.4, 1.0], role: 'prop' }, // seal left crate
      { pos: [-2.05, 1.9, -7.2], size: [1.2, 1.2, 1.0], role: 'prop' }, // stacked crate (seal upper)
      { pos: [-2.0, 0.5, -7.0], size: [1.0, 1.0, 1.0], role: 'prop' } // low crate left
    ]
  },
  {
    // You hold a raised perch; a sealed wall and flank cover the right, the left
    // lane stays open. Peeks left while you shoot down.
    label: 'Left Skybox',
    peekSide: -1,
    player: { pos: [1.0, 1.6, 7], yaw: 0, half: [1.6, 0.9] },
    enemy: { x: 0.4, z: -7, y: 0 },
    ecHalf: 0.55,
    boxes: [
      { pos: [1.2, 0.8, 7.6], size: [3.6, 1.6, 2.8], role: 'prop' }, // player platform (top 1.6)
      { pos: [0.2, 1.5, -6.4], size: [1.1, 3.0, 0.55], role: 'enemy' }, // x -0.35..0.75
      { pos: [1.55, 1.5, -6.4], size: [1.6, 3.0, 0.55], role: 'prop' }, // seal right (0.75..2.35)
      { pos: [3.0, 1.6, -6.4], size: [0.6, 3.2, 3.0], role: 'prop' } // flank wall right
    ]
  },
  {
    // Close redoubt: a deep bunker mass seals the left, a low barrier breaks up
    // the open right lane. Peeks right.
    label: 'Right Redoubt',
    peekSide: 1,
    player: { pos: [-1.3, 0, 5.5], yaw: 0, half: [1.6, 0.9] },
    enemy: { x: -0.5, z: -5.8, y: 0 },
    ecHalf: 0.6,
    boxes: [
      { pos: [-1.6, 0.65, 4.7], size: [1.6, 1.3, 0.6], role: 'player' },
      { pos: [-0.1, 1.3, -5.3], size: [1.2, 2.6, 0.6], role: 'enemy' }, // x -0.7..0.5
      { pos: [-1.3, 1.3, -5.3], size: [1.2, 2.6, 0.6], role: 'prop' }, // seal left (-1.9..-0.7)
      { pos: [-2.6, 1.5, -5.1], size: [1.4, 3.0, 2.6], role: 'prop' }, // bunker mass left
      { pos: [0.0, 0.425, -4.7], size: [2.0, 0.85, 0.6], role: 'prop' } // low front barrier
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
const DEATH_FX_PITCH = degToRad(38) * 0.25; // upward view flick on death (radians)
/** Max aim deviation (degrees) to count a shot as "at the bot" during jiggle. */
const JIGGLE_ENGAGE_AIM_DEG = 10;

export class DuelsScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const d = this.settings.data.duels;
    const choice = this.config.arena ?? d.arena;
    const resolved = resolveDuelsArenaChoice(ARENAS, choice);
    this.arenaIndex = resolved.index;
    this.arena = resolved.arena;

    const preset = this.competitive ? competitivePresetFor('duels') : null;
    this._ttk = this.config.ttk ?? preset?.ttk ?? d.ttk ?? 0.5;
    this._botHeadHitBase = preset?.botHeadHit ?? 0.08;
    this._botBodyHitBase = preset?.botBodyHit ?? 0.40;
    this._botHitRamp = preset?.botHitRamp ?? 0.01;
    this._playerHp = PLAYER_HP;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : this.settings.data.runDuration;
    this._arenaObjects = [];
    this.coverMeshes = [];
    this.enemy = null;
    this._buildArena();
  }

  get name() {
    return 'duels';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return duelsArenaConfigKey(ARENAS, settings.data.duels.arena, settings.data.runDuration);
  }
  configKey() {
    return DuelsScenario.configKeyFor(this.settings, this.variant);
  }

  tracerRaycastExtras() {
    return this.coverMeshes;
  }

  _playerBounds(a) {
    if (a.bounds) {
      return { minX: a.bounds.minX, maxX: a.bounds.maxX, minZ: a.bounds.minZ, maxZ: a.bounds.maxZ };
    }
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

    const floorSize = this.arena.bounds ? mapExtent({ bounds: this.arena.bounds }) * 2 : 80;
    const gridDiv = this.arena.bounds
      ? Math.min(120, Math.max(40, Math.round(mapExtent({ bounds: this.arena.bounds }))))
      : 80;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    add(floor);

    const grid = new THREE.GridHelper(floorSize, gridDiv, gridCenter, gridEdge);
    grid.position.y = 0.002;
    add(grid);

    const boxMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.85, metalness: 0.05 });
    const enemyBoxMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.85, metalness: 0.05 });
    for (const b of this.arena.boxes) {
      const mat = b.role === 'enemy' ? enemyBoxMat : boxMat;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]), mat);
      mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
      markBulletDecalSurface(mesh);
      add(mesh);
      this.coverMeshes.push(mesh);
    }
  }

  _switchArena() {
    this.engine.viewmodel?.clearBulletDecals();
    const pool = getDuelsArenaPool(ARENAS);
    let newIdx;
    do { newIdx = randInt(0, pool.length - 1); } while (newIdx === this.arenaIndex && pool.length > 1);
    this.arenaIndex = newIdx;
    this.arena = pool[newIdx];
    this._buildArena();
    this.engine.replayRecorder?.recordEnvironmentChange();
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
    this._playerHp = PLAYER_HP;
    this.enemy = {
      target,
      mover,
      hp: 2,
      crouch: 0,
      phase: 'idle',
      timer: randRange(REACT_MIN, REACT_MAX),
      side: 1,
      offset: 0,
      jiggleLeft: 0,
      jpOut: false,
      jpTarget: 0,
      hasLos: false,
      wasLos: false,
      exposedTimer: -1,
      countedMiss: false,
      fireTimer: randRange(0, SHOT_INTERVAL),
      sneakFireDelay: 0,
      sneakTargetKey: null,
      headHit: this._botHeadHitBase,
      bodyHit: this._botBodyHitBase
    };
    if (this.competitive) {
      const ramp = this.kills * this._botHitRamp;
      this.enemy.headHit = this._botHeadHitBase + ramp;
      this.enemy.bodyHit = this._botBodyHitBase + ramp;
    }
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
      this._colliderBoxes(this.arena)
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

  _duelBotFire(e) {
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

  _beginPeek() {
    const e = this.enemy;
    const { close, wide } = this._peekOffsets();
    const forced = this.arena.peekSide;
    e.side = forced != null ? forced : Math.random() < 0.5 ? -1 : 1;
    e.countedMiss = false;

    const roll = Math.random();
    if (roll < 0.3) {
      // Jiggle-peek: dart out only until the head is barely visible, snap back
      // immediately, then re-decide which angle to search. Bait / info-gather.
      e.phase = 'jigglepeek';
      e.jiggleLeft = randInt(2, 4); // info-peeks before settling back behind cover
      e.jpOut = true;
      e.jpTarget = e.side * wide; // hard cap, only reached if the player is hidden
      e.offset = e.jpTarget;
    } else if (roll < 0.6) {
      e.offset = e.side * (Math.random() < 0.5 ? close : wide);
      e.phase = 'peekreturn'; // out then straight back
    } else {
      e.offset = e.side * (Math.random() < 0.5 ? close : wide);
      e.phase = 'hold';
      e.timer = randRange(HOLD_MIN, HOLD_MAX);
      e.crouchWant = Math.random() < 0.35 ? 1 : 0; // sometimes crouch on the hold
    }
  }

  /** After a jiggle-peek snaps back behind cover, pick a fresh angle to search. */
  _reJiggle() {
    const e = this.enemy;
    const { wide } = this._peekOffsets();
    const forced = this.arena.peekSide;
    // Symmetric arenas re-roll the side so the bot baits both angles; forced
    // arenas keep their single open side.
    e.side = forced != null ? forced : Math.random() < 0.5 ? -1 : 1;
    e.jpOut = true;
    e.jpTarget = e.side * wide;
    e.offset = e.jpTarget;
  }

  /** Competitive: player fired at the bot during a jiggle peek but didn't connect. */
  _shotEngagedBot(raycaster) {
    const e = this.enemy;
    const head = e?.target?.headMesh;
    if (!head) return false;
    head.getWorldPosition(_headPos);
    _losDir.subVectors(_headPos, raycaster.ray.origin);
    const dist = _losDir.length();
    if (dist < 1e-4) return true;
    _losDir.multiplyScalar(1 / dist);
    return raycaster.ray.direction.dot(_losDir) > Math.cos(degToRad(JIGGLE_ENGAGE_AIM_DEG));
  }

  /** Commit to a wide strafe on the current jiggle side — no teleport, normal TTK. */
  _triggerJiggleCounter() {
    const e = this.enemy;
    if (e.phase === 'counterwide') return;
    const { wide } = this._peekOffsets();
    e.phase = 'counterwide';
    e.jpOut = false;
    e.jiggleLeft = 0;
    e.offset = e.side * wide;
    e.crouchWant = 0;
    e.countedMiss = true;
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
    this._playerHp = PLAYER_HP;
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
      e.target.headMesh.position.y = BODY_H * lerp(1, 0.55, e.crouch) + HEAD_R + HEAD_OFFSET;
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

      case 'jigglepeek': {
        const goal = e.jpOut ? e.jpTarget : 0;
        const reached = e.mover.seek(dt, goal, max);
        if (e.jpOut) {
          // Move the head to its just-advanced position and test it: the instant
          // the head barely clears cover (gains LOS) — or we hit the wide cap
          // because the player is hidden — snap the strafe the opposite way.
          this._placeEnemy(e.mover.s);
          if (this._botHeadHasLos(e) || reached) e.jpOut = false;
        } else if (reached) {
          // Back behind cover: make a new decision on which angle to search.
          e.jiggleLeft--;
          if (e.jiggleLeft <= 0) this._retreatDone();
          else this._reJiggle();
        }
        break;
      }

      case 'counterwide': {
        e.mover.seek(dt, e.offset, max);
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
    e.hasLos = hasLos;

    if (this.competitive) {
      if (hasLos && this.engine.player?.enabled) {
        const playerSeesBot = this._playerSeesBot(e);
        if (playerSeesBot) {
          e.sneakFireDelay = 0;
          e.sneakTargetKey = 'player';
        } else if (e.sneakTargetKey !== 'player') {
          e.sneakTargetKey = 'player';
          e.sneakFireDelay = BACKSHOT_FIRE_DELAY;
        } else {
          e.sneakFireDelay = Math.max(0, e.sneakFireDelay - dt);
        }
        const mayFire = playerSeesBot || e.sneakFireDelay <= 0;
        e.fireTimer -= dt;
        if (mayFire && e.fireTimer <= 0) {
          e.fireTimer = SHOT_INTERVAL;
          this._duelBotFire(e);
        }
      } else {
        e.sneakFireDelay = 0;
        e.sneakTargetKey = null;
      }
    } else {
      // Practice: legacy TTK once the bot's head can see the player.
      if (hasLos && !e.wasLos) e.exposedTimer = this._ttk;
      if (!hasLos) e.exposedTimer = -1;
      e.wasLos = hasLos;
      if (hasLos && e.exposedTimer > 0) {
        e.exposedTimer -= dt;
        if (e.exposedTimer <= 0) this._onPlayerDeath(false);
      }
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

  _onPlayerDeath(_headshot = false) {
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
    this.engine.setDeathOverlay(red * DEATH_OVERLAY_STRENGTH);

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
    const e = this.enemy;

    if (
      this.competitive &&
      e?.phase === 'jigglepeek' &&
      e.target.state !== 'dying' &&
      (!hit || hit.object.userData.target !== e.target) &&
      this._shotEngagedBot(raycaster)
    ) {
      this._triggerJiggleCounter();
    }

    if (!hit) return;
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt) return; // hit a box → blocked

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

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }
}
