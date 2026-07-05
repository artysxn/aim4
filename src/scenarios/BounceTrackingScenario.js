// ---------------------------------------------------------------------------
// BounceTrackingScenario.js  ("Bounce (Tracking)")
//
// Bounce with a tracking gate: balls are slightly bigger, fewer and slower,
// and a ball only becomes killable after the crosshair has been held on it for
// an uninterrupted hold window (default 0.5 s) — it turns green, then a click
// takes it down. Looking away resets that ball's hold progress.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BounceScenario } from './BounceScenario.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import { competitivePresetFor } from './competitivePresets.js';
import { randRange } from '../utils/MathUtils.js';

const GRAVITY = 12;

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const READY_COLOR = new THREE.Color(0x35e06a);

export class BounceTrackingScenario extends BounceScenario {
  constructor(opts) {
    super(opts); // resolves preset/defaults/settings via this.name
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const b = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.bouncetracking;
    this.bounceHeight = preset?.bounceHeight ?? this.config.bounceHeight ?? b.bounceHeight ?? 2.2;
    // Crosshair hold (s) required before a ball can be clicked.
    this.holdTime = preset?.holdTime ?? this.config.holdTime ?? b.holdTime ?? 0.5;
  }

  get name() {
    return 'bouncetracking';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return BounceTrackingScenario.configKeyFor(this.settings, this.variant);
  }

  /** Bounces are 2–3× the configured apex height. */
  _bounceVel() {
    const h = this.bounceHeight * randRange(2, 3);
    return Math.sqrt(2 * GRAVITY * h * randRange(0.9, 1.1));
  }

  _spawnApexY() {
    return this.bounceHeight * randRange(2, 3);
  }

  _setBallReady(target, ready) {
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

  _hoveredBall() {
    _raycaster.setFromCamera(_center, this.camera);
    const hits = _raycaster.intersectObjects(this.activeColliders(), false);
    if (!hits.length) return null;
    const tgt = hits[0].object.userData.target;
    return tgt && tgt.state !== 'dying' ? tgt : null;
  }

  onUpdate(dt) {
    super.onUpdate(dt); // ball physics + respawns

    const hovered = this._hoveredBall();
    let progress = 0;
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      if (t._hold == null) t._hold = 0;
      if (t === hovered) {
        t._hold += dt;
        progress = Math.min(1, t._hold / this.holdTime);
        if (t._hold >= this.holdTime && !t._ready) {
          t._ready = true;
          this._setBallReady(t, true);
        }
      } else if (t._hold > 0 || t._ready) {
        // Interrupted — the hold must be continuous.
        t._hold = 0;
        if (t._ready) {
          t._ready = false;
          this._setBallReady(t, false);
        }
      }
    }
    this.crosshair?.setTrackProgress(progress);
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    if (!hit) {
      this._penalizeMiss();
      return;
    }
    const target = hit.object.userData.target;
    if (!target || target.state === 'dying') {
      this._penalizeMiss();
      return;
    }
    // Only a tracked-ready (green) ball can be clicked.
    if (!target._ready) return;
    this._registerHit(target);
  }
}
