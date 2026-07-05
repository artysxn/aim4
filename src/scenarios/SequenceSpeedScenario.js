// ---------------------------------------------------------------------------
// SequenceSpeedScenario.js  ("Sequence (Speed)")
//
// Sequence chain where each dot starts small and grows like Survival. If a dot
// pops before you kill it, the run ends instantly. Missed shots are allowed.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { SequenceScenario } from './SequenceScenario.js';
import { beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { lerp } from '../utils/MathUtils.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { competitivePresetFor } from './competitivePresets.js';

export class SequenceSpeedScenario extends SequenceScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const s =
      (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ??
      DEFAULTS.sequencespeed;
    this.startSize = preset?.startSize ?? this.config.startSize ?? s.startSize ?? 0.12;
    this.maxSize = preset?.maxSize ?? this.config.maxSize ?? s.maxSize ?? 0.55;
    this.growTime = (preset?.growTime ?? this.config.growTime ?? s.growTime ?? 1500) / 1000;
    this._ended = false;
  }

  get name() {
    return 'sequencespeed';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return SequenceSpeedScenario.configKeyFor(this.settings, this.variant);
  }

  _spawnDot(pos) {
    const size = this.startSize;
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 24, 18),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.45,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(pos);
    target._grow = { startSize: size, maxSize: this.maxSize };
    this.addTarget(target);
    this._dotAge = 0;
  }

  _updateGrowth() {
    const ratio = this.maxSize / this.startSize;
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      const growT = Math.min(1, t.age / this.growTime);
      const scale = lerp(1, ratio, growT);
      t._mesh.scale.setScalar(scale);
      if (growT > 0.85) {
        const urgency = (growT - 0.85) / 0.15;
        t._mesh.material.emissive.setRGB(1, 0.15 * (1 - urgency), 0);
        t._mesh.material.emissiveIntensity = 0.45 + urgency * 0.55;
      }
    }
  }

  _loseRun() {
    if (this._ended || !this.running) return;
    this._ended = true;
    const dot = this._activeDot();
    if (dot) dot.startDying(0xff4400);
    beep(180, 0.12, 'sawtooth', 0.08);
    this._requestFinish?.();
  }

  onUpdate(dt) {
    if (this._ended) return;
    if (this._phase === 'cooldown') {
      this._cooldownLeft -= dt;
      if (this._cooldownLeft <= 0) {
        this._phase = 'chain';
        this._spawnDot(this._randomWallPos());
      }
      return;
    }
    this._dotAge += dt;
    this._updateGrowth();
    const dot = this._activeDot();
    if (dot && dot.age >= this.growTime) {
      this.misses++;
      this._loseRun();
    }
  }

  onShoot(raycaster) {
    if (this._phase !== 'chain' || this._ended) return;
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      this.misses++;
      return;
    }
    this.hits++;
    this.kills++;
    this.score += 1;
    this._lastKillPos = target.object.position.clone();
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
    this._chainIdx++;
    this._spawnDot(this._nextChainPos());
  }
}
