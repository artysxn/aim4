// ---------------------------------------------------------------------------
// MicroflicksScenario.js
// Stars variant: tiny dots in a tight cluster; respawns hug the last kill (10% random).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { randRange, clamp } from '../utils/MathUtils.js';
import { StarsScenario } from './StarsScenario.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const BASE_BOUNDS_W = 9;
const BASE_BOUNDS_H = 5;
const DEFAULT_SIZE = 0.1;
const DEFAULT_COUNT = 2;
const DEFAULT_BOUNDS_SCALE_X = 2;
const RANDOM_SPAWN_CHANCE = 0.1;
/** Near-respawn offset radii (× target size); was 0.6–1.8, now 2× min / 4× max. */
const NEAR_SPREAD_MIN = 1.2;
const NEAR_SPREAD_MAX = 7.2;

export class MicroflicksScenario extends StarsScenario {
  constructor(opts) {
    const variant = opts.config?.variant === 'competitive' ? 'competitive' : 'practice';
    const preset = variant === 'competitive' ? competitivePresetFor('microflicks') : null;
    const m = variant === 'competitive' ? DEFAULTS.microflicks : (opts.settings?.data?.microflicks ?? {});
    const boundsScaleX =
      preset?.boundsScaleX ?? opts.config?.boundsScaleX ?? m.boundsScaleX ?? DEFAULT_BOUNDS_SCALE_X;
    const boundsScaleY =
      preset?.boundsScaleY ?? opts.config?.boundsScaleY ?? m.boundsScaleY ?? 1;

    super({
      ...opts,
      // No canvas pad: Microflicks keeps its tight Gridshot-sized board.
      config: { boundsPad: 0, ...opts.config, boundsScaleX, boundsScaleY }
    });

    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? m.targetSize ?? DEFAULT_SIZE;
    this.targetCount = preset?.targetCount ?? this.config.targetCount ?? m.targetCount ?? DEFAULT_COUNT;
    this.floatEnabled = preset?.floatEnabled ?? this.config.floatEnabled ?? m.floatEnabled ?? false;
    this.floatSpeedMax = this.config.floatSpeedMax ?? m.floatSpeedMax ?? 2;
    this.boundsScaleX = boundsScaleX;
    this.boundsScaleY = boundsScaleY;
    this.boundsW = BASE_BOUNDS_W * this.boundsScaleX;
    this.boundsH = BASE_BOUNDS_H * this.boundsScaleY;
    this.randomSpawnChance = preset?.randomSpawnChance ?? RANDOM_SPAWN_CHANCE;
    this.viewmodelRecoil = false;
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
    return `s${m.targetSize ?? DEFAULT_SIZE}_n${m.targetCount ?? DEFAULT_COUNT}_x${m.boundsScaleX ?? DEFAULT_BOUNDS_SCALE_X}_y${m.boundsScaleY ?? 1}_f${m.floatEnabled ? 1 : 0}_d${settings.data.runDuration}`;
  }

  configKey() {
    return MicroflicksScenario.configKeyFor(this.settings, this.variant);
  }

  _nearSpread() {
    return randRange(this.targetSize * NEAR_SPREAD_MIN, this.targetSize * NEAR_SPREAD_MAX);
  }

  /** Spawn box inset — shared by random spawns and near-kill clamping. */
  _spawnExtents() {
    const inset = this.targetSize + 0.05;
    const halfW = Math.max(0.1, this.boundsW / 2 - inset);
    const halfH = Math.max(0.1, this.boundsH / 2 - inset);
    return { halfW, yMin: this.centerY - halfH, yMax: this.centerY + halfH };
  }

  /** Random spawn within the canvas (not the full Stars gray wall). */
  _randomPos() {
    const { halfW, yMin, yMax } = this._spawnExtents();
    return new THREE.Vector3(
      randRange(-halfW, halfW),
      randRange(yMin, yMax),
      -this.wallDistance + this.targetSize + 0.05
    );
  }

  _clampToWall(pos) {
    const { halfW, yMin, yMax } = this._spawnExtents();
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
