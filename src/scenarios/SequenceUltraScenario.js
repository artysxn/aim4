// ---------------------------------------------------------------------------
// SequenceUltraScenario.js  ("Sequence (Ultra)" — challenge)
//
// Sequence chain with 25% smaller drifting dots, a 0.3 s crosshair hold, and
// Survival-style growth (pop breaks the chain). Missed shots break the chain.
// Fixed rules — no practice/competitive split.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { SequenceScenario } from './SequenceScenario.js';
import { beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, lerp } from '../utils/MathUtils.js';

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const READY_COLOR = new THREE.Color(0x35e06a);

const ULTRA_DOT_SIZE = 0.25 * 0.75; // 25% smaller than Sequence (Clicks)
const ULTRA_START_SIZE = 0.12 * 0.75;
const ULTRA_MAX_SIZE = 0.55 * 0.75;
const ULTRA_GROW_TIME = 1.5; // s
const ULTRA_HOLD_TIME = 0.3;
const ULTRA_FLOAT_SPEED = 1.0;

export class SequenceUltraScenario extends SequenceScenario {
  constructor(opts) {
    super({
      ...opts,
      config: {
        ...opts.config,
        variant: 'competitive'
      }
    });
    this.targetSize = ULTRA_DOT_SIZE;
    this.holdTime = ULTRA_HOLD_TIME;
    this.floatSpeed = ULTRA_FLOAT_SPEED;
    this.startSize = ULTRA_START_SIZE;
    this.maxSize = ULTRA_MAX_SIZE;
    this.growTime = ULTRA_GROW_TIME;
  }

  get name() {
    return 'sequenceultra';
  }

  static configKeyFor() {
    return 'challenge';
  }

  configKey() {
    return 'challenge';
  }

  _setDotReady(target, ready) {
    const mesh = target._mesh;
    if (!mesh?.material) return;
    if (ready) {
      mesh.material.color.copy(READY_COLOR);
      mesh.material.emissive.set(0x1a8840);
    } else {
      mesh.material.color.set(this.settings.data.colors.target);
      mesh.material.emissive.set(0xff2a10);
    }
  }

  _hoveredDot() {
    _raycaster.setFromCamera(_center, this.camera);
    const hits = _raycaster.intersectObjects(this.activeColliders(), false);
    if (!hits.length) return null;
    const tgt = hits[0].object.userData.target;
    return tgt && tgt.state !== 'dying' ? tgt : null;
  }

  _spawnDot(pos) {
    const size = this.startSize;
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 24, 18),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: 0xff2a10,
        emissiveIntensity: 0.45,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(pos);
    target._grow = { startSize: size, maxSize: this.maxSize };
    const speed = this.floatSpeed * randRange(0.75, 1.25);
    const angle = randRange(0, Math.PI * 2);
    target._float = {
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      hold: 0,
      ready: false
    };
    this.addTarget(target);
    this._dotAge = 0;
  }

  _updateFloat(target, dt) {
    const f = target._float;
    if (!f) return;
    const halfW = this.boundsW / 2 - this.maxSize;
    const halfH = this.boundsH / 2 - this.maxSize;
    const pos = target.object.position;
    pos.x += f.vx * dt;
    pos.y += f.vy * dt;
    if (pos.x < -halfW) {
      pos.x = -halfW;
      f.vx = Math.abs(f.vx);
    } else if (pos.x > halfW) {
      pos.x = halfW;
      f.vx = -Math.abs(f.vx);
    }
    const yMin = this.centerY - halfH;
    const yMax = this.centerY + halfH;
    if (pos.y < yMin) {
      pos.y = yMin;
      f.vy = Math.abs(f.vy);
    } else if (pos.y > yMax) {
      pos.y = yMax;
      f.vy = -Math.abs(f.vy);
    }
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

  onUpdate(dt) {
    if (this._phase === 'cooldown') {
      this._cooldownLeft -= dt;
      if (this._cooldownLeft <= 0) {
        this._phase = 'chain';
        this._spawnDot(this._randomWallPos());
      }
      this.crosshair?.setTrackProgress(0);
      return;
    }

    this._dotAge += dt;
    this._updateGrowth();

    const dot = this._activeDot();
    if (!dot) {
      this.crosshair?.setTrackProgress(0);
      return;
    }

    if (dot.age >= this.growTime) {
      this.misses++;
      this._breakChain();
      this.crosshair?.setTrackProgress(0);
      return;
    }

    this._updateFloat(dot, dt);
    const f = dot._float;
    const hovered = this._hoveredDot();
    if (hovered === dot) {
      f.hold += dt;
      if (f.hold >= this.holdTime && !f.ready) {
        f.ready = true;
        this._setDotReady(dot, true);
      }
    } else if (f.hold > 0 || f.ready) {
      f.hold = 0;
      if (f.ready) {
        f.ready = false;
        this._setDotReady(dot, false);
      }
    }
    this.crosshair?.setTrackProgress(Math.min(1, f.hold / this.holdTime));
  }

  onShoot(raycaster) {
    if (this._phase !== 'chain') return;
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      this.misses++;
      this._breakChain();
      return;
    }
    if (!target._float?.ready) return;
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
