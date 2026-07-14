// ---------------------------------------------------------------------------
// SniperQuickscopesScenario.js  ("Pit (AWP)")
//
// Cover, bent into a circle: you stand in a circular pit and the three cover
// rows become three concentric RINGS of boxes around you — each ring further
// out and one platform-step higher. A random box in your current line of sight
// lights up red, then a rifle bot peeks out of it (left or right) and opens
// fire. You carry the sniper: quickscope it before it shreds you.
//
// All bot behaviour (peek → react → jiggle+shoot, crouch taps, HP, hit rolls)
// is inherited from CoverScenario; this class only re-shapes the arena into
// rings and re-maps the bot's 1-D strafe onto each box's tangent axis.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  CoverScenario,
  BODY_R,
  BODY_H,
  COVER_W,
  COVER_H,
  COVER_D,
  ROW_RISE
} from './CoverScenario.js';
import { randRange, lerp } from '../utils/MathUtils.js';
import { gridLineColors, createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';
import { markBulletDecalSurface } from '../utils/bulletImpact.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const PIT_HALF = 2.5; // player movement box inside the pit
const PLATFORM_D = 4; // radial depth of each pedestal slab
// Tangent width must cover default peek + MAX_PEEK_EXTRA strafe (CoverScenario).
const PIT_PEEK_EXTRA = 12; // COVER_GAP (8 m) × 1.5 — same cap as flat Cover rows
const PIT_PLATFORM_W =
  COVER_W + 2 * (COVER_W / 2 + BODY_R + 0.55 + PIT_PEEK_EXTRA) + 2;
const SPAWN_HINT_LEAD = 0.5; // s before the peek — the spawn box glows red
const VIEW_PICK_DEG = 42; // spawn boxes must be within this half-angle of the view

const _eye = new THREE.Vector3();
const _body = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class SniperQuickscopesScenario extends CoverScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
    this.postKillSpawnExtra = 0.7;
  }

  get name() {
    return 'sniperquickscopes';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.sniperquickscopes ?? DEFAULTS.sniperquickscopes;
    return `r${c.rowCount}_b${c.coverPerRow}_l${c.losMissPenalty !== false ? 1 : 0}_d${settings.data.runDuration}`;
  }

  configKey() {
    return SniperQuickscopesScenario.configKeyFor(this.settings, this.variant);
  }

  // ---- Ring environment ----------------------------------------------------
  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const outerR = this.rowDistance + (this.rowCount - 1) * this.rowSpacing + 12;
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(outerR, 64),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(outerR * 2, Math.round(outerR), gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);

    // Pit rim: a thin ring marking the player's circular pit.
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(PIT_HALF + 0.6, PIT_HALF + 0.6, 0.06, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: gridCenter, roughness: 0.9, side: THREE.DoubleSide })
    );
    rim.position.y = 0.03;
    this.root.add(rim);

    const coverMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.85, metalness: 0.05 });
    const gridBoxMat = createCoverGridMaterial(c.cover, c.floor);

    for (let ring = 0; ring < this.rowCount; ring++) {
      const ringY = ring * ROW_RISE; // floor height of this ring
      const ringR = this.rowDistance + ring * this.rowSpacing;
      const count = this.coverPerRow;

      for (let i = 0; i < count; i++) {
        // Stagger alternate rings by half a slot so boxes never stack radially.
        const theta = ((i + (ring % 2) * 0.5) / count) * Math.PI * 2;
        const sin = Math.sin(theta);
        const cos = Math.cos(theta);
        const x = sin * ringR;
        const z = cos * ringR;

        // Raised boxes stand on their own pedestal slab (wide enough for peeks).
        if (ringY > 0) {
          const slab = new THREE.Mesh(
            new THREE.BoxGeometry(PIT_PLATFORM_W, ringY, PLATFORM_D),
            coverMat
          );
          slab.position.set(x, ringY / 2, z);
          slab.rotation.y = theta;
          markBulletDecalSurface(slab);
          this.root.add(slab);
          this.coverBoxes.push(slab);
        }

        const mat = gridBoxMat.clone();
        mat.map = mat.map.clone();
        applyCoverGridRepeat(mat, COVER_W, COVER_H);
        const cover = new THREE.Mesh(new THREE.BoxGeometry(COVER_W, COVER_H, COVER_D), mat);
        cover.position.set(x, ringY + COVER_H / 2, z);
        cover.rotation.y = theta; // local X = tangent, local Z = radial
        markBulletDecalSurface(cover);
        this.root.add(cover);
        this.coverBoxes.push(cover);

        // Bot home: flush behind the box, radially away from the pit.
        const back = COVER_D / 2 + BODY_R;
        this._spots.push({
          // tangent axis for the 1-D peek strafe
          tx: cos,
          tz: -sin,
          // bot home position (feet)
          bx: x + sin * back,
          bz: z + cos * back,
          footY: ringY,
          coverMesh: cover
        });
      }
    }
  }

  // ---- Ring-aware bot placement ---------------------------------------------
  _placeBot() {
    const b = this.bot;
    if (!b) return;
    const s = b.spot;
    b.target.object.position.set(
      s.bx + s.tx * b.mover.s,
      s.footY,
      s.bz + s.tz * b.mover.s
    );
    const cam = this.camera;
    b.target.model.aimAt(cam.position.x, cam.position.y, cam.position.z);
  }

  _botFullyVisible(b) {
    const head = b.target.headMesh;
    if (!head) return false;
    this.camera.getWorldPosition(_eye);
    head.getWorldPosition(_body);
    if (!this._segmentClear(_body, _eye)) return false;
    const s = b.spot;
    _body.set(
      s.bx + s.tx * b.mover.s,
      s.footY + BODY_H * 0.5 * lerp(1, 0.55, b.crouch),
      s.bz + s.tz * b.mover.s
    );
    return this._segmentClear(_body, _eye);
  }

  /** Spawn boxes are picked from those in the player's current line of sight. */
  _scheduleNextBot(delay = this._nextBotDelay()) {
    this._nextBotIn = delay;
    this._nextSpawn = {
      spot: this._pickSpotInView(),
      side: Math.random() < 0.5 ? -1 : 1
    };
    if (!this.spawnHint || delay > SPAWN_HINT_LEAD) this._clearSpawnHint();
  }

  _pickSpotInView() {
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    const fx = _fwd.x;
    const fz = _fwd.z;
    const fLen = Math.hypot(fx, fz) || 1e-6;
    const cosLimit = Math.cos((VIEW_PICK_DEG * Math.PI) / 180);
    const inView = this._spots.filter((s) => {
      const dx = s.bx - cam.position.x;
      const dz = s.bz - cam.position.z;
      const dLen = Math.hypot(dx, dz) || 1e-6;
      return (dx * fx + dz * fz) / (dLen * fLen) >= cosLimit;
    });
    const pool = inView.length ? inView : this._spots;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  onStart() {
    this.engine.player.spawn({
      pos: [0, 0, 0],
      yaw: 0,
      bounds: { minX: -PIT_HALF, maxX: PIT_HALF, minZ: -PIT_HALF, maxZ: PIT_HALF }
    });
    // The first bot is announced like every other: red box, then the peek.
    this._scheduleNextBot(randRange(0.8, 1.4));
  }
}
