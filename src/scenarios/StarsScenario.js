// ---------------------------------------------------------------------------
// StarsScenario.js
// Gridshot-style clicking drill: 200 tiny dots on the wall; each kill respawns one.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Target } from '../components/Target.js';
import { GridshotScenario } from './GridshotScenario.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';

const TARGET_SIZE = 0.1;
const TARGET_COUNT = 200;

export class StarsScenario extends GridshotScenario {
  constructor(opts) {
    super(opts);
    const preset = this.competitive ? competitivePresetFor('stars') : null;

    this.targetSize = preset?.targetSize ?? TARGET_SIZE;
    this.targetCount = preset?.targetCount ?? TARGET_COUNT;
    this.mode = 'clicking';
    this.floatEnabled = false;
    this.enableTimeLimit = false;
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;
  }

  get name() {
    return 'stars';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
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
        emissive: 0xff2a10,
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
    this._spawnAt(this._randomPos());
  }
}
