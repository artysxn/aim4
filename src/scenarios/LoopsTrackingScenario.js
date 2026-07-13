// ---------------------------------------------------------------------------
// LoopsTrackingScenario.js  ("Loops (Tracking)")
//
// Same orbital dots as Loops (Static), but only three are up at once and each
// must be tracked continuously for 1 s before it scores and respawns.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { LoopsScenario } from './LoopsScenario.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const READY_COLOR = new THREE.Color(0x35e06a);

export class LoopsTrackingScenario extends LoopsScenario {
  constructor(opts) {
    super(opts);
  }

  get name() {
    return 'loopstracking';
  }

  _targetCount() {
    return 3;
  }

  _trackingMode() {
    return true;
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const l = settings.data.loopstracking ?? DEFAULTS.loopstracking;
    return `s${l.targetSize}_v${l.travelSpeed}_h${l.holdTime}_d${settings.data.runDuration}`;
  }

  configKey() {
    return LoopsTrackingScenario.configKeyFor(this.settings, this.variant);
  }

  _hoveredLoop() {
    _raycaster.setFromCamera(_center, this.camera);
    const hits = _raycaster.intersectObjects(this.activeColliders(), false);
    if (!hits.length) return null;
    const tgt = hits[0].object.userData.target;
    if (!tgt || tgt.state === 'dying') return null;
    return this._loops.find((l) => l.target === tgt) ?? null;
  }

  _setLoopReady(loop, ready) {
    const mesh = loop?.target?._mesh;
    if (!mesh?.material) return;
    if (ready) {
      mesh.material.color.copy(READY_COLOR);
      mesh.material.emissive.set(0x1a8840);
    } else {
      mesh.material.color.set(this.settings.data.colors.target);
      mesh.material.emissive.set(this.settings.data.colors.target);
    }
  }

  _updateTracking(dt) {
    const hovered = this._hoveredLoop();
    let progress = 0;

    for (const loop of this._activeLoops()) {
      if (loop === hovered) {
        loop.hold += dt;
        progress = loop.hold / this.holdTime;
        if (loop.hold >= this.holdTime) {
          this._setLoopReady(loop, false);
          this._scoreLoop(loop);
          loop.hold = 0;
          continue;
        }
        if (loop.hold >= this.holdTime * 0.85) this._setLoopReady(loop, true);
      } else if (loop.hold > 0) {
        loop.hold = 0;
        this._setLoopReady(loop, false);
      }
    }

    this.crosshair?.setTrackProgress(Math.min(1, progress));
  }
}
