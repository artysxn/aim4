// ---------------------------------------------------------------------------
// LineScenario.js  ("Line")
//
// One dot on a wide 180° wall canvas. It travels left ↔ right along a
// horizontal line, bouncing off the field edges. Hold the tracking rifle on
// it — every landed bullet scores.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { UNIT } from '../utils/SourceMovement.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { canvasCenterY } from '../utils/canvasWall.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const WALL_DISTANCE = 16;
const FIELD_HALF_ANGLE = Math.PI / 4; // 90° each side → 180° horizontal field
const CANVAS_H = 3;
const HIT_PTS = 2;

export class LineScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const l = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.line;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? l.targetSize;
    this.travelSpeed = preset?.travelSpeed ?? this.config.travelSpeed ?? l.travelSpeed;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : Infinity;

    this.weaponId = 'tracking';
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.showViewmodel = false;
    this.weaponTracers = false;

    this.wallDistance = WALL_DISTANCE;
    this.fieldHalf = WALL_DISTANCE * Math.tan(FIELD_HALF_ANGLE);
    this.canvasW = this.fieldHalf * 2;
    this.centerY = canvasCenterY(CANVAS_H);

    this._dot = null;
    this._buildEnvironment();
    this.engine.camera.position.y = this.centerY;
  }

  get name() {
    return 'line';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const l = settings.data.line ?? DEFAULTS.line;
    return `s${l.targetSize}_v${l.travelSpeed}_d${settings.data.runDuration}`;
  }

  configKey() {
    return LineScenario.configKeyFor(this.settings, this.variant);
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.canvasW, CANVAS_H),
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

  _spawnDot() {
    const inset = this.targetSize + 0.05;
    const xMin = -this.fieldHalf + inset;
    const xMax = this.fieldHalf - inset;
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.targetSize, 24, 18),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: 0xff2a10,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: HIT_PTS, crit: false });
    target.object.position.set(
      randRange(xMin, xMax),
      this.centerY,
      -this.wallDistance + this.targetSize + 0.05
    );
    this.addTarget(target);
    const speed = Math.max(40, this.travelSpeed) * UNIT;
    this._dot = {
      target,
      dir: Math.random() < 0.5 ? -1 : 1,
      speed
    };
  }

  onStart() {
    this._spawnDot();
  }

  onUpdate(dt) {
    const d = this._dot;
    if (!d || d.target.state === 'dying') return;

    const inset = this.targetSize + 0.05;
    const xMin = -this.fieldHalf + inset;
    const xMax = this.fieldHalf - inset;
    const pos = d.target.object.position;
    pos.x += d.dir * d.speed * dt;

    if (pos.x <= xMin) {
      pos.x = xMin;
      d.dir = 1;
    } else if (pos.x >= xMax) {
      pos.x = xMax;
      d.dir = -1;
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) return;
    const target = hit.object.userData.target;
    if (!target || target.state === 'dying' || target !== this._dot?.target) return;
    this.hits++;
    this.score += HIT_PTS;
    this.crosshair?.hit();
    beep(520, 0.03, 'square', 0.04);
    const mat = target._mesh?.material;
    if (mat?.emissiveIntensity != null) {
      mat.emissiveIntensity = 1.0;
      setTimeout(() => {
        try {
          mat.emissiveIntensity = 0.5;
        } catch {
          /* disposed */
        }
      }, 60);
    }
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.score) };
  }
}
