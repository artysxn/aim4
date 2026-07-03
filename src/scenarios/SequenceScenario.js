// ---------------------------------------------------------------------------
// SequenceScenario.js  ("Sequence")
//
// Phase-based flick chain on a single wall:
//   Phase 1 (cooldown) — nothing happens for a random 0.75–2.5 s.
//   Phase 2 (chain)    — one dot spawns somewhere on the wall; shoot it within
//                        the per-dot time limit. Each kill spawns the next dot
//                        near the last kill, a little further away every time.
// A missed shot or a timed-out dot breaks the chain and returns to phase 1.
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

const BOUNDS_W = 12;
const BOUNDS_H = 6;
const COOLDOWN_MIN = 0.75; // s — phase 1 duration window
const COOLDOWN_MAX = 2.5;

export class SequenceScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const s = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.sequence;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? s.targetSize;
    // Per-dot time limit (ms in settings → s here).
    this.dotTime = (preset?.dotTime ?? this.config.dotTime ?? s.dotTime) / 1000;
    this.startDistance = preset?.startDistance ?? this.config.startDistance ?? s.startDistance;
    this.distanceStep = preset?.distanceStep ?? this.config.distanceStep ?? s.distanceStep;
    this.infiniteAmmo = this.config.infiniteAmmo ?? s.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil =
      preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? s.viewmodelRecoil ?? false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;

    this.wallDistance = 16;
    this.boundsW = BOUNDS_W;
    this.boundsH = BOUNDS_H;
    this.centerY = EYE_HEIGHT;

    this._phase = 'cooldown';
    this._cooldownLeft = randRange(COOLDOWN_MIN, COOLDOWN_MAX);
    this._chainIdx = 0; // kills in the current chain (drives spawn distance)
    this._dotAge = 0;
    this._lastKillPos = null;

    this._buildEnvironment();
  }

  get name() {
    return 'sequence';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return SequenceScenario.configKeyFor(this.settings, this.variant);
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(this.boundsW + 8, this.boundsH + 8),
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

  _clampToBounds(x, y) {
    const halfW = this.boundsW / 2 - this.targetSize;
    const halfH = this.boundsH / 2 - this.targetSize;
    return [
      Math.max(-halfW, Math.min(halfW, x)),
      Math.max(this.centerY - halfH, Math.min(this.centerY + halfH, y))
    ];
  }

  _spawnDot(pos) {
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
    target.object.position.copy(pos);
    this.addTarget(target);
    this._dotAge = 0;
  }

  _randomWallPos() {
    const [x, y] = this._clampToBounds(
      randRange(-this.boundsW / 2, this.boundsW / 2),
      randRange(this.centerY - this.boundsH / 2, this.centerY + this.boundsH / 2)
    );
    return new THREE.Vector3(x, y, -this.wallDistance + this.targetSize + 0.05);
  }

  /** Next chain dot: a ring around the last kill whose radius grows per kill. */
  _nextChainPos() {
    const dist = this.startDistance + this.distanceStep * this._chainIdx;
    const a = randRange(0, Math.PI * 2);
    const [x, y] = this._clampToBounds(
      this._lastKillPos.x + Math.cos(a) * dist,
      this._lastKillPos.y + Math.sin(a) * dist
    );
    return new THREE.Vector3(x, y, -this.wallDistance + this.targetSize + 0.05);
  }

  _activeDot() {
    return this.targets.find((t) => t.state !== 'dying') || null;
  }

  _breakChain() {
    const dot = this._activeDot();
    if (dot) dot.startDying(0xff2222);
    this._phase = 'cooldown';
    this._cooldownLeft = randRange(COOLDOWN_MIN, COOLDOWN_MAX);
    this._chainIdx = 0;
    this._lastKillPos = null;
    beep(220, 0.08, 'sawtooth', 0.05);
  }

  onStart() {
    this._phase = 'cooldown';
    this._cooldownLeft = randRange(COOLDOWN_MIN, COOLDOWN_MAX);
  }

  onUpdate(dt) {
    if (this._phase === 'cooldown') {
      this._cooldownLeft -= dt;
      if (this._cooldownLeft <= 0) {
        this._phase = 'chain';
        this._spawnDot(this._randomWallPos());
      }
      return;
    }
    // Chain phase: the active dot times out if not shot fast enough.
    this._dotAge += dt;
    if (this._dotAge >= this.dotTime && this._activeDot()) {
      this.misses++;
      this._breakChain();
    }
  }

  onShoot(raycaster) {
    if (this._phase !== 'chain') return;
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      // A missed shot breaks the chain (and still counts as a miss).
      this.misses++;
      this._breakChain();
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
