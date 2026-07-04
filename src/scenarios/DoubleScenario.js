// ---------------------------------------------------------------------------
// DoubleScenario.js  ("Double")
//
// N small canvases (default two: left + right). Exactly one dot is active at a
// time; killing it spawns the next dot on the next canvas, forcing a full
// flick between canvases on every kill. Canvases either sit flat on the front
// wall or curve around the player.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { EYE_HEIGHT } from '../core/Engine.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const WALL_DISTANCE = 14; // flat layout: canvas plane distance
const RING_RADIUS = 12;   // around layout: canvas ring distance

export class DoubleScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const d = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.double;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? d.targetSize;
    this.canvasSize = preset?.canvasSize ?? this.config.canvasSize ?? d.canvasSize;
    // Gap between neighbouring canvas centres (flat) / their arc spacing (around).
    this.canvasDistance = preset?.canvasDistance ?? this.config.canvasDistance ?? d.canvasDistance;
    this.canvasCount = Math.max(2, Math.round(preset?.canvasCount ?? this.config.canvasCount ?? d.canvasCount));
    this.layout = preset?.layout ?? this.config.layout ?? d.layout ?? 'flat'; // 'flat' | 'around'
    this.infiniteAmmo = this.config.infiniteAmmo ?? d.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil =
      preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? d.viewmodelRecoil ?? false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this._canvasIdx = 0;
    this._canvases = []; // { center: Vector3, quat: Quaternion }
    this._buildEnvironment();
    // Float at the canvas row's centre so panels extend equally up and down
    // from the base view line.
    this.engine.camera.position.y = this._centerY;
  }

  get name() {
    return 'double';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return DoubleScenario.configKeyFor(this.settings, this.variant);
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const grid = new THREE.GridHelper(80, 60, gridCenter, gridEdge);
    grid.position.y = 0.001;
    this.root.add(grid);

    const canvasMat = new THREE.MeshStandardMaterial({
      color: c.cover,
      roughness: 0.95,
      metalness: 0
    });

    const n = this.canvasCount;
    // Lift the canvas row so a big canvas never dips below the floor.
    const centerY = Math.max(EYE_HEIGHT, this.canvasSize / 2 + 0.3);
    this._centerY = centerY;
    for (let i = 0; i < n; i++) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(this.canvasSize, this.canvasSize), canvasMat);
      let center;
      if (this.layout === 'around') {
        // Spread the canvases across an arc centred on forward; spacing scales
        // with the configured distance so panels never overlap.
        const arcStep = Math.max(0.35, (this.canvasSize + this.canvasDistance) / RING_RADIUS);
        const a = (i - (n - 1) / 2) * arcStep;
        center = new THREE.Vector3(Math.sin(a) * RING_RADIUS, centerY, -Math.cos(a) * RING_RADIUS);
        panel.position.copy(center);
        panel.lookAt(0, centerY, 0);
      } else {
        const spacing = this.canvasSize + this.canvasDistance;
        const x = (i - (n - 1) / 2) * spacing;
        center = new THREE.Vector3(x, centerY, -WALL_DISTANCE);
        panel.position.copy(center);
      }
      this.root.add(panel);
      this._canvases.push({ center, quat: panel.quaternion.clone() });
    }
  }

  /** Random point on canvas i, pushed slightly toward the player. */
  _spawnPosOn(i) {
    const { center, quat } = this._canvases[i];
    const half = this.canvasSize / 2 - this.targetSize - 0.05;
    const local = new THREE.Vector3(
      randRange(-half, half),
      randRange(-half, half),
      this.targetSize + 0.05
    );
    return local.applyQuaternion(quat).add(center);
  }

  _spawnDot() {
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
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(this._spawnPosOn(this._canvasIdx));
    this.addTarget(target);
  }

  _penalizeMiss() {
    this.misses++;
    if (!this.competitive) return;
    this.kills = Math.max(0, this.kills - 1);
    this.score = Math.max(0, this.score - 1);
  }

  onStart() {
    this._canvasIdx = 0;
    this._spawnDot();
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      this._penalizeMiss();
      return;
    }
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
    // The next dot appears on the next canvas over (alternates for two).
    this._canvasIdx = (this._canvasIdx + 1) % this.canvasCount;
    this._spawnDot();
  }
}
