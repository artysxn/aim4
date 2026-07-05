// ---------------------------------------------------------------------------
// StarsScenario.js
// Gridshot-style clicking drill: tiny dots on the wall; each kill respawns one.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Target } from '../components/Target.js';
import { GridshotScenario } from './GridshotScenario.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const TARGET_SIZE = 0.1;
const TARGET_COUNT = 200;

const DEFAULT_BOUNDS_SCALE_X = 2;

export class StarsScenario extends GridshotScenario {
  constructor(opts) {
    const variant = opts.config?.variant === 'competitive' ? 'competitive' : 'practice';
    const preset = variant === 'competitive' ? competitivePresetFor('stars') : null;
    const s = variant === 'competitive' ? DEFAULTS.stars : (opts.settings?.data?.stars ?? {});
    const boundsScaleX =
      preset?.boundsScaleX ?? opts.config?.boundsScaleX ?? s.boundsScaleX ?? DEFAULT_BOUNDS_SCALE_X;

    super({
      ...opts,
      // Stars plays on a bigger board than Gridshot: pad the canvas so the
      // (exact-fit) canvas keeps the legacy full-wall play area. Subclasses
      // (Microflicks / Threeshot) may override the pad via their own config.
      config: { boundsPad: 8, ...opts.config, boundsScaleX }
    });

    const presetAfter = this.competitive ? competitivePresetFor('stars') : null;

    this.targetSize = presetAfter?.targetSize ?? this.config.targetSize ?? s.targetSize ?? TARGET_SIZE;
    this.targetCount = presetAfter?.targetCount ?? this.config.targetCount ?? s.targetCount ?? TARGET_COUNT;
    this.mode = 'clicking';
    this.floatEnabled = false;
    this.enableTimeLimit = false;
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.runDuration = this.competitive
      ? (presetAfter?.runDuration ?? 30)
      : this.settings.data.runDuration;
  }

  get name() {
    return 'stars';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const st = settings.data.stars ?? {};
    return `s${st.targetSize ?? TARGET_SIZE}_n${st.targetCount ?? TARGET_COUNT}_d${settings.data.runDuration}`;
  }

  configKey() {
    return StarsScenario.configKeyFor(this.settings, this.variant);
  }

  /** Lower-poly spheres; overlap is allowed — 200 tiny dots share the same wall. */
  _spawnAt(pos) {
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.targetSize, 10, 8),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.55,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(pos);
    this._initGridshotState(target, pos);
    this.addTarget(target);
  }

  _spawn() {
    // Spawn anywhere on the canvas — GridshotScenario._randomPos already covers
    // the whole (padded) board, centred on the view line.
    this._spawnAt(this._randomPos());
  }
}
