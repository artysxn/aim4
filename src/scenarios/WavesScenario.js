// ---------------------------------------------------------------------------
// WavesScenario.js  ("Waves" — challenge)
//
// Rounds of small dots spawn hugging one side of the canvas (left or right)
// and sweep across to the other side, each at its own random 150–230 u/s.
// Any dot that crosses the far edge = lose. Any missed shot = lose. Clear the
// wave to trigger the next; every 4th cleared round adds one more dot.
// Endless — the run lasts as long as your aim does.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { UNIT } from '../utils/SourceMovement.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { EYE_HEIGHT } from '../core/Engine.js';

const BOUNDS_W = 12;
const BOUNDS_H = 6;
const WALL_DISTANCE = 16;
const DOT_SIZE = 0.16;
const SPEED_MIN = 150 * UNIT; // u/s → m/s, rolled per dot
const SPEED_MAX = 230 * UNIT;
const START_COUNT = 3;
const ROUND_PAUSE = 0.8; // s between a cleared wave and the next
const ROUNDS_PER_STEP = 4; // every 4th cleared round adds a dot

export class WavesScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    this.targetSize = DOT_SIZE;
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.runDuration = Infinity; // ends when you lose
    this.missLimit = 1; // one missed shot = game over

    this.wallDistance = WALL_DISTANCE;
    this.boundsW = BOUNDS_W;
    this.boundsH = BOUNDS_H;
    this.centerY = EYE_HEIGHT;

    this._round = 0; // completed rounds
    this._pauseLeft = 0;
    this._waveActive = false;

    this._buildEnvironment();
  }

  get name() {
    return 'waves';
  }

  get showElapsedTime() {
    return true;
  }

  static configKeyFor() {
    return 'challenge';
  }

  configKey() {
    return 'challenge';
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.boundsW + 8, this.boundsH + 8),
      new THREE.MeshStandardMaterial({ color: c.cover, roughness: 0.95, metalness: 0 })
    );
    wall.position.set(0, this.centerY, -this.wallDistance);
    this.root.add(wall);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(80, 60, gridCenter, gridEdge);
    grid.position.y = 0.001;
    this.root.add(grid);
  }

  _dotCountForRound() {
    return START_COUNT + Math.floor(this._round / ROUNDS_PER_STEP);
  }

  _spawnWave() {
    const fromLeft = Math.random() < 0.5;
    const halfW = this.boundsW / 2 - this.targetSize;
    const halfH = this.boundsH / 2 - this.targetSize;
    const yMin = Math.max(this.targetSize + 0.25, this.centerY - halfH);
    const startX = fromLeft ? -halfW : halfW;
    const dir = fromLeft ? 1 : -1; // left spawns travel right and vice versa
    const n = this._dotCountForRound();

    for (let i = 0; i < n; i++) {
      const target = new Target();
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(this.targetSize, 20, 14),
        new THREE.MeshStandardMaterial({
          color: this.settings.data.colors.target,
          emissive: this.settings.data.colors.target,
          emissiveIntensity: 0.5,
          roughness: 0.4,
          metalness: 0.1
        })
      );
      target._mesh = mesh;
      target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
      target.object.position.set(
        // Slight stagger off the edge so a wave reads as a column, not a stack.
        startX - dir * randRange(0, 0.8),
        randRange(yMin, this.centerY + halfH),
        -this.wallDistance + this.targetSize + 0.05
      );
      target._wave = { dir, speed: randRange(SPEED_MIN, SPEED_MAX) };
      this.addTarget(target);
    }
    this._waveActive = true;
  }

  _lose() {
    beep(220, 0.15, 'sawtooth', 0.08);
    this._requestFinish?.();
  }

  onStart() {
    this._round = 0;
    this._spawnWave();
  }

  onUpdate(dt) {
    if (!this._waveActive) {
      this._pauseLeft -= dt;
      if (this._pauseLeft <= 0) this._spawnWave();
      return;
    }

    const halfW = this.boundsW / 2;
    let alive = 0;
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const w = t._wave;
      if (!w) continue;
      alive++;
      const pos = t.object.position;
      pos.x += w.dir * w.speed * dt;
      // Crossing the far edge loses the run.
      if ((w.dir > 0 && pos.x > halfW) || (w.dir < 0 && pos.x < -halfW)) {
        this.misses++;
        this._lose();
        return;
      }
    }

    if (alive === 0) {
      // Wave cleared.
      this._round++;
      this._waveActive = false;
      this._pauseLeft = ROUND_PAUSE;
      beep(980, 0.06, 'square', 0.05);
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      // BaseScenario's missLimit also catches this, but be explicit: any
      // missed shot ends the challenge.
      this.misses++;
      this._lose();
      return;
    }
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
  }
}
