// ---------------------------------------------------------------------------
// RangeScenario.js  ("Range")
//
// A stadium tracking drill. Bots ring the player on a fixed-radius arc (90°, 180°
// or 360°, chosen in settings) and strafe LEFT/RIGHT only — never toward you —
// reversing at random and tap-crouching now and then. You stand at centre and
// may roam a 5×5 m box (and crouch) if you want to add your own movement.
//
// Lateral motion is arc-length driven by SourceMover1D, so each bot accelerates,
// counter-strafes and tops out at the same 215 u/s Source speed the player has.
//
//   Head = instant kill (crit) · Body = 2 shots.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, randInt, clamp, lerp, degToRad } from '../utils/MathUtils.js';
import { SourceMover1D, RUN_SPEED } from '../utils/SourceMovement.js';
import { gridLineColors, createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_R = 0.27;
const HEAD_Y = BODY_H + HEAD_R + 0.02;

const PLAYER_HALF = 2.5; // metres → 5×5 m roam box
const REVERSE_MIN = 0.6;  // s between normal direction flips
const REVERSE_MAX = 1.8;
const BURST_MIN = 0.07;   // s between flips during an ADAD burst
const BURST_MAX = 0.16;
const BURST_GAP_MIN = 3.0; // s between bursts
const BURST_GAP_MAX = 7.0;
const CROUCH_GAP_MIN = 1.5; // s between random crouch taps
const CROUCH_GAP_MAX = 4.0;
const CROUCH_HOLD_MIN = 0.22;
const CROUCH_HOLD_MAX = 0.5;
const CROUCH_RATE = 11;

export class RangeScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const r = this.settings.data.range;
    this.arcDeg = this.config.arc ?? r.arc;
    this.enemyCount = this.config.enemyCount ?? r.enemyCount;
    this.radius = this.config.radius ?? r.radius;
    this.botStrafe = this.config.botStrafe ?? r.botStrafe !== false;
    this.botCrouchTap = this.config.botCrouchTap ?? r.botCrouchTap !== false;
    this.infiniteAmmo = this.config.infiniteAmmo ?? r.infiniteAmmo !== false;

    this.arc = degToRad(this.arcDeg);
    this.full = this.arcDeg >= 360;
    // θ = 0 is dead ahead (-Z). Non-full arcs are centred on it.
    this.thetaMin = this.full ? -Math.PI : -this.arc / 2;
    this.thetaMax = this.full ? Math.PI : this.arc / 2;

    this.bots = [];
    this.coverBoxes = [];
    this._coverMeshes = [];
    this._buildStadium();
  }

  get name() {
    return 'range';
  }

  static configKeyFor(settings) {
    const r = settings.data.range;
    const cover = r.coverEnabled
      ? `_c${r.coverCount}_d${r.coverDistance}_t${r.coverThickness}_h${r.coverHeight}`
      : '';
    return `arc${r.arc}_n${r.enemyCount}_r${r.radius}${cover}_d${settings.data.runDuration}`;
  }
  configKey() {
    return RangeScenario.configKeyFor(this.settings);
  }

  // ---- Environment --------------------------------------------------------
  _buildStadium() {
    const R = this.radius;
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R + 14, 64),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.PolarGridHelper(R + 12, 16, 8, 64, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);

    // Tiered seating: concentric rising rings around the arena.
    const tierMat = new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.95, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i++) {
      const rad = R + 5 + i * 1.6;
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 1.2 + i * 0.8, 64, 1, true), tierMat);
      ring.position.y = (1.2 + i * 0.8) / 2 + i * 0.9;
      this.root.add(ring);
    }

    // A 5×5 m guide square so the player can see their roam box.
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(PLAYER_HALF * 2, 0.02, PLAYER_HALF * 2)),
      new THREE.LineBasicMaterial({ color: gridCenter })
    );
    box.position.y = 0.03;
    this.root.add(box);

    this._buildCover();
  }

  _buildCover() {
    for (const mesh of this._coverMeshes) {
      this.root.remove(mesh);
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    }
    this._coverMeshes.length = 0;
    this.coverBoxes = [];

    const r = this.settings.data.range;
    if (!r.coverEnabled || r.coverCount < 1) return;

    const dist = r.coverDistance;
    const depth = r.coverThickness;
    const height = r.coverHeight;
    const width = Math.max(1.4, depth * 1.5);
    const c = this.settings.data.colors;
    const boxMat = createCoverGridMaterial(c.cover, c.floor);

    for (let i = 0; i < r.coverCount; i++) {
      const t = r.coverCount === 1
        ? 0.5
        : i / (r.coverCount - 1);
      const theta = lerp(this.thetaMin, this.thetaMax, t);
      const x = dist * Math.sin(theta);
      const z = -dist * Math.cos(theta);
      const box = { pos: [x, height / 2, z], size: [width, height, depth] };
      this.coverBoxes.push(box);

      const mat = boxMat.clone();
      mat.map = mat.map.clone();
      applyCoverGridRepeat(mat, width, height);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
      mesh.position.set(x, height / 2, z);
      this.root.add(mesh);
      this._coverMeshes.push(mesh);
    }
  }

  // ---- Bots ---------------------------------------------------------------
  _buildBot() {
    const t = new Target();

    // bodyRig squishes on crouch; head is NOT inside it so it doesn't shrink.
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
    return t;
  }

  _spawnBot(theta) {
    const target = this._buildBot();
    this.addTarget(target);
    const mover = new SourceMover1D();
    mover.reset(theta * this.radius); // arc length
    const bot = {
      target,
      mover,
      hp: 2,
      crouch: 0,
      crouchWant: 0,
      wishDir: Math.random() < 0.5 ? -1 : 1,
      reverseTimer: randRange(REVERSE_MIN, REVERSE_MAX),
      crouchTimer: randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX),
      burstRemaining: 0,
      burstStartTimer: randRange(2.0, 8.0) // stagger initial burst times across bots
    };
    this.bots.push(bot);
    this._placeBot(bot);
    return bot;
  }

  _placeBot(bot) {
    const theta = bot.mover.s / this.radius;
    const x = this.radius * Math.sin(theta);
    const z = -this.radius * Math.cos(theta);
    bot.target.object.position.set(x, 0, z);
  }

  /** Pick a spawn angle in the arc, biased away from existing bots. */
  _freeTheta() {
    let best = this._randTheta();
    let bestGap = -1;
    for (let i = 0; i < 8; i++) {
      const cand = this._randTheta();
      let gap = Infinity;
      for (const b of this.bots) {
        const t = b.mover.s / this.radius;
        gap = Math.min(gap, Math.abs(this._angDiff(cand, t)));
      }
      if (gap > bestGap) {
        bestGap = gap;
        best = cand;
      }
    }
    return best;
  }
  _randTheta() {
    return randRange(this.thetaMin, this.thetaMax);
  }
  _angDiff(a, b) {
    let d = a - b;
    if (this.full) {
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
    }
    return d;
  }

  onStart() {
    this.engine.player.spawn({
      pos: [0, 0, 0],
      yaw: 0,
      bounds: { minX: -PLAYER_HALF, maxX: PLAYER_HALF, minZ: -PLAYER_HALF, maxZ: PLAYER_HALF },
      colliders: this.coverBoxes.length ? this.coverBoxes : null
    });
    for (let i = 0; i < this.enemyCount; i++) {
      const theta = lerp(this.thetaMin, this.thetaMax, this.full ? i / this.enemyCount : (i + 0.5) / this.enemyCount);
      this._spawnBot(theta);
    }
  }

  onUpdate(dt) {
    const max = RUN_SPEED;
    const cam = this.camera;
    const strafe = this.botStrafe;
    const crouchTap = this.botCrouchTap;
    for (const bot of this.bots) {
      if (bot.target.state === 'dying') continue;

      if (strafe) {
        // ADAD burst: fire up to 6 rapid direction flips at random intervals.
        bot.burstStartTimer -= dt;
        if (bot.burstStartTimer <= 0 && bot.burstRemaining === 0) {
          bot.burstRemaining = randInt(2, 6);
          bot.burstStartTimer = randRange(BURST_GAP_MIN, BURST_GAP_MAX);
        }

        // Direction reversal — fast cadence during a burst, normal otherwise.
        bot.reverseTimer -= dt;
        if (bot.reverseTimer <= 0) {
          bot.wishDir = -bot.wishDir;
          if (bot.burstRemaining > 0) {
            bot.burstRemaining--;
            bot.reverseTimer = randRange(BURST_MIN, BURST_MAX);
          } else {
            bot.reverseTimer = randRange(REVERSE_MIN, REVERSE_MAX);
          }
        }

        // Strafe along the arc; reflect at the arc edges for non-full ranges.
        bot.mover.step(dt, bot.wishDir, max);
        let theta = bot.mover.s / this.radius;
        if (this.full) {
          if (theta > Math.PI) {
            theta -= 2 * Math.PI;
            bot.mover.s = theta * this.radius;
          } else if (theta < -Math.PI) {
            theta += 2 * Math.PI;
            bot.mover.s = theta * this.radius;
          }
        } else {
          if (theta <= this.thetaMin) {
            theta = this.thetaMin;
            bot.mover.s = theta * this.radius;
            bot.wishDir = 1;
          } else if (theta >= this.thetaMax) {
            theta = this.thetaMax;
            bot.mover.s = theta * this.radius;
            bot.wishDir = -1;
          }
        }
        this._placeBot(bot);
      }

      if (crouchTap) {
        bot.crouchTimer -= dt;
        if (bot.crouchWant && bot.crouchTimer <= 0) {
          bot.crouchWant = 0;
          bot.crouchTimer = randRange(CROUCH_GAP_MIN, CROUCH_GAP_MAX);
        } else if (!bot.crouchWant && bot.crouchTimer <= 0) {
          bot.crouchWant = 1;
          bot.crouchTimer = randRange(CROUCH_HOLD_MIN, CROUCH_HOLD_MAX);
        }
      } else {
        bot.crouchWant = 0;
      }

      bot.crouch = clamp(bot.crouch + (bot.crouchWant - bot.crouch) * Math.min(1, CROUCH_RATE * dt), 0, 1);
      if (bot.target.rig) bot.target.rig.scale.y = lerp(1, 0.55, bot.crouch);
      if (bot.target.headMesh) {
        bot.target.headMesh.position.y = BODY_H * lerp(1, 0.55, bot.crouch) + HEAD_R + 0.02;
      }

      bot.target.object.lookAt(cam.position.x, bot.target.object.position.y + 1.0, cam.position.z);
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) return;
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt || tgt.state === 'dying') return;

    this.crosshair?.hit();
    const bot = this.bots.find((b) => b.target === tgt);
    if (!bot) return;
    const zone = obj.userData.zone;

    if (zone === 'head') {
      this.hits++;
      this.headshots++;
      this.kills++;
      this.score += obj.userData.points;
      beep(1000, 0.05, 'square', 0.05);
      this._killBot(bot);
    } else {
      this.hits++;
      this.score += obj.userData.points;
      bot.hp -= 1;
      beep(520, 0.04, 'square', 0.04);
      if (bot.hp <= 0) {
        this.kills++;
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

  _killBot(bot) {
    bot.target.startDying(0x35e06a);
    // Remove from the live list and respawn a replacement elsewhere on the arc.
    this.bots = this.bots.filter((b) => b !== bot);
    setTimeout(() => {
      if (this.running && !this._disposed) this._spawnBot(this._freeTheta());
    }, 350);
  }

  dispose() {
    this._disposed = true;
    this.bots = [];
    for (const mesh of this._coverMeshes) {
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    }
    this._coverMeshes.length = 0;
    super.dispose();
  }
}
