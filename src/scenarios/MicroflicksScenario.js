// ---------------------------------------------------------------------------
// MicroflicksScenario.js
// Stars variant: tiny dots in a tight cluster; respawns hug the last kill (10% random).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { randRange, clamp } from '../utils/MathUtils.js';
import { StarsScenario } from './StarsScenario.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';

const BASE_BOUNDS_W = 9;
const BASE_BOUNDS_H = 5;
const DEFAULT_SIZE = 0.1;
const DEFAULT_COUNT = 2;
const RANDOM_SPAWN_CHANCE = 0.1;

export class MicroflicksScenario extends StarsScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor('microflicks') : null;
    const m = this.settings.data.microflicks ?? {};

    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? m.targetSize ?? DEFAULT_SIZE;
    this.targetCount = preset?.targetCount ?? this.config.targetCount ?? m.targetCount ?? DEFAULT_COUNT;
    this.floatEnabled = preset?.floatEnabled ?? this.config.floatEnabled ?? m.floatEnabled ?? false;
    this.floatSpeedMax = this.config.floatSpeedMax ?? m.floatSpeedMax ?? 2;
    this.boundsScaleX = preset?.boundsScaleX ?? this.config.boundsScaleX ?? m.boundsScaleX ?? 1;
    this.boundsScaleY = preset?.boundsScaleY ?? this.config.boundsScaleY ?? m.boundsScaleY ?? 1;
    this.boundsW = BASE_BOUNDS_W * this.boundsScaleX;
    this.boundsH = BASE_BOUNDS_H * this.boundsScaleY;
    this.randomSpawnChance = preset?.randomSpawnChance ?? RANDOM_SPAWN_CHANCE;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;
    this._lastKillPos = null;
  }

  get name() {
    return 'microflicks';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const m = settings.data.microflicks ?? {};
    return `s${m.targetSize ?? DEFAULT_SIZE}_n${m.targetCount ?? DEFAULT_COUNT}_x${m.boundsScaleX ?? 1}_y${m.boundsScaleY ?? 1}_f${m.floatEnabled ? 1 : 0}_d${settings.data.runDuration}`;
  }

  configKey() {
    return MicroflicksScenario.configKeyFor(this.settings, this.variant);
  }

  _nearSpread() {
    return randRange(this.targetSize * 0.6, this.targetSize * 1.8);
  }

  _clampToWall(pos) {
    const halfW = this.boundsW / 2 - this.targetSize - 0.05;
    const halfH = this.boundsH / 2;
    const yMin = Math.max(this.targetSize + 0.25, this.centerY - halfH);
    const yMax = this.centerY + halfH;
    pos.x = clamp(pos.x, -halfW, halfW);
    pos.y = clamp(pos.y, yMin, yMax);
    pos.z = -this.wallDistance + this.targetSize + 0.05;
    return pos;
  }

  _offsetNear(anchor) {
    const angle = Math.random() * Math.PI * 2;
    const r = this._nearSpread();
    return this._clampToWall(
      new THREE.Vector3(
        anchor.x + Math.cos(angle) * r,
        anchor.y + Math.sin(angle) * r * 0.65,
        anchor.z
      )
    );
  }

  _nextSpawnPos() {
    if (Math.random() < this.randomSpawnChance) return this._randomPos();
    const anchor = this._lastKillPos;
    if (!anchor) return this._randomPos();
    return this._offsetNear(anchor);
  }

  _spawn() {
    this._spawnAt(this._nextSpawnPos());
  }

  onStart() {
    let anchor = this._randomPos();
    this._spawnAt(anchor);
    for (let i = 1; i < this.targetCount; i++) {
      const pos = this._offsetNear(anchor);
      this._spawnAt(pos);
      anchor = pos;
    }
  }

  _registerHit(target) {
    if (!target || target.state === 'dying') return;
    this._lastKillPos = target.object.position.clone();
    super._registerHit(target);
  }
}
