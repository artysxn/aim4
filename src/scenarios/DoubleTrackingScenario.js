// ---------------------------------------------------------------------------
// DoubleTrackingScenario.js  ("Double (Tracking)")
//
// Double with smooth drifting dots on each canvas, 20% smaller targets, and
// a 0.3 s crosshair hold before a click registers.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { DoubleScenario } from './DoubleScenario.js';
import { beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { competitivePresetFor } from './competitivePresets.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const READY_COLOR = new THREE.Color(0x35e06a);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _normal = new THREE.Vector3();

export class DoubleTrackingScenario extends DoubleScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const d =
      (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ??
      DEFAULTS.doubletracking;
    this.holdTime = preset?.holdTime ?? this.config.holdTime ?? d.holdTime ?? 0.3;
    this.floatSpeed = preset?.floatSpeed ?? this.config.floatSpeed ?? d.floatSpeed ?? 1.0;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? d.targetSize ?? this.targetSize * 0.8;
  }

  get name() {
    return 'doubletracking';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return DoubleTrackingScenario.configKeyFor(this.settings, this.variant);
  }

  _activeDot() {
    return this.targets.find((t) => t.state !== 'dying') || null;
  }

  _setDotReady(target, ready) {
    const mesh = target._mesh;
    if (!mesh?.material) return;
    if (ready) {
      mesh.material.color.copy(READY_COLOR);
      mesh.material.emissive.set(0x1a8840);
    } else {
      mesh.material.color.set(this.settings.data.colors.target);
      mesh.material.emissive.set(this.settings.data.colors.target);
    }
  }

  _hoveredDot() {
    _raycaster.setFromCamera(_center, this.camera);
    const hits = _raycaster.intersectObjects(this.activeColliders(), false);
    if (!hits.length) return null;
    const tgt = hits[0].object.userData.target;
    return tgt && tgt.state !== 'dying' ? tgt : null;
  }

  _applyDotLocalPos(target) {
    const m = target._dotMotion;
    if (!m) return;
    const { center, quat } = this._canvases[m.canvasIdx];
    _right.set(1, 0, 0).applyQuaternion(quat);
    _up.set(0, 1, 0).applyQuaternion(quat);
    _normal.set(0, 0, 1).applyQuaternion(quat);
    target.object.position
      .copy(center)
      .add(_right.multiplyScalar(m.lx))
      .add(_up.multiplyScalar(m.ly))
      .add(_normal.multiplyScalar(this.targetSize + 0.05));
  }

  _spawnDot() {
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.targetSize, 24, 18),
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

    const half = this.canvasSize / 2 - this.targetSize - 0.05;
    const speed = this.floatSpeed * randRange(0.75, 1.25);
    const angle = randRange(0, Math.PI * 2);
    target._dotMotion = {
      canvasIdx: this._canvasIdx,
      lx: randRange(-half, half),
      ly: randRange(-half, half),
      lvx: Math.cos(angle) * speed,
      lvy: Math.sin(angle) * speed,
      hold: 0,
      ready: false
    };
    this._applyDotLocalPos(target);
    this.addTarget(target);
  }

  _updateDotMotion(target, dt) {
    const m = target._dotMotion;
    if (!m) return;
    const half = this.canvasSize / 2 - this.targetSize - 0.05;
    m.lx += m.lvx * dt;
    m.ly += m.lvy * dt;
    if (m.lx < -half) {
      m.lx = -half;
      m.lvx = Math.abs(m.lvx);
    } else if (m.lx > half) {
      m.lx = half;
      m.lvx = -Math.abs(m.lvx);
    }
    if (m.ly < -half) {
      m.ly = -half;
      m.lvy = Math.abs(m.lvy);
    } else if (m.ly > half) {
      m.ly = half;
      m.lvy = -Math.abs(m.lvy);
    }
    this._applyDotLocalPos(target);
  }

  onUpdate(dt) {
    const dot = this._activeDot();
    if (!dot) {
      this.crosshair?.setTrackProgress(0);
      return;
    }
    this._updateDotMotion(dot, dt);
    const m = dot._dotMotion;
    const hovered = this._hoveredDot();
    if (hovered === dot) {
      m.hold += dt;
      if (m.hold >= this.holdTime && !m.ready) {
        m.ready = true;
        this._setDotReady(dot, true);
      }
    } else if (m.hold > 0 || m.ready) {
      m.hold = 0;
      if (m.ready) {
        m.ready = false;
        this._setDotReady(dot, false);
      }
    }
    this.crosshair?.setTrackProgress(Math.min(1, m.hold / this.holdTime));
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      this.misses++;
      return;
    }
    if (!target._dotMotion?.ready) return;
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
    this._canvasIdx = (this._canvasIdx + 1) % this.canvasCount;
    this._spawnDot();
  }
}
