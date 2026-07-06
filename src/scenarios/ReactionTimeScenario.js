// ---------------------------------------------------------------------------
// ReactionTimeScenario.js  ("Reaction time" — challenge)
//
// Three valid attempts: a big dot waits a random 2–6 s, turns green, and the
// player shoots it as fast as possible. Early shots restart the wait without
// counting. After each valid hit a small ready dot spawns at the bottom; shoot
// it to begin the next attempt. Final score = average reaction time (ms).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario, beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { EYE_HEIGHT } from '../core/Engine.js';

const BOUNDS_W = 12;
const BOUNDS_H = 6;
const WALL_DISTANCE = 16;
const DOT_SIZE = 0.55;
const READY_DOT_SIZE = 0.22;
const WAIT_MIN = 2;
const WAIT_MAX = 6;
const ATTEMPTS = 3;
const READY_COLOR = new THREE.Color(0x35e06a);
const READY_DOT_COLOR = 0xff3b3b;

export class ReactionTimeScenario extends BaseScenario {
  constructor(opts) {
    super({
      ...opts,
      config: { ...opts.config, variant: 'competitive' }
    });
    this.weaponId = 'pistol';
    this.infiniteAmmo = true;
    this.weaponBloom = false;
    this.viewmodelRecoil = false;
    this.runDuration = Infinity;

    this.wallDistance = WALL_DISTANCE;
    this.boundsW = BOUNDS_W;
    this.boundsH = BOUNDS_H;
    this.centerY = EYE_HEIGHT;

    this._phase = 'waiting'; // waiting | go | ready
    this._delayLeft = 0;
    this._goAt = 0;
    this._validAttempts = 0;
    this._times = [];
    this._mainDot = null;
    this._readyDot = null;
    this._labels = [];

    this._buildEnvironment();
  }

  get name() {
    return 'reactiontime';
  }

  get showElapsedTime() {
    return true;
  }

  static configKeyFor() {
    return 'challenge';
  }

  configKey() {
    return 'challenge';
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

  _dotPos() {
    return new THREE.Vector3(0, this.centerY, -this.wallDistance + DOT_SIZE + 0.05);
  }

  _readyPos() {
    const halfH = this.boundsH / 2 - READY_DOT_SIZE;
    const y = this.centerY - halfH;
    return new THREE.Vector3(0, y, -this.wallDistance + READY_DOT_SIZE + 0.05);
  }

  _spawnMainDot() {
    this._clearMainDot();
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(DOT_SIZE, 28, 20),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    mesh.renderOrder = 1;
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(this._dotPos());
    this.addTarget(target);
    this._mainDot = target;
    this._setMainGreen(false);
  }

  _spawnReadyDot() {
    this._clearReadyDot();
    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(READY_DOT_SIZE, 20, 16),
      new THREE.MeshStandardMaterial({
        color: READY_DOT_COLOR,
        emissive: 0x991111,
        emissiveIntensity: 0.45,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(this._readyPos());
    this.addTarget(target);
    this._readyDot = target;
  }

  _setMainGreen(green) {
    const mesh = this._mainDot?._mesh;
    if (!mesh?.material) return;
    if (green) {
      mesh.material.color.copy(READY_COLOR);
      mesh.material.emissive.set(0x1a8840);
    } else {
      mesh.material.color.set(this.settings.data.colors.target);
      mesh.material.emissive.set(this.settings.data.colors.target);
    }
  }

  _clearMainDot(color = null) {
    if (!this._mainDot) return;
    if (color && this._mainDot.state !== 'dying') {
      this._mainDot.startDying(color);
    } else if (this._mainDot.state !== 'dying') {
      this.targets = this.targets.filter((t) => t !== this._mainDot);
      this._mainDot.dispose();
    }
    this._mainDot = null;
  }

  _clearReadyDot() {
    if (!this._readyDot) return;
    if (this._readyDot.state !== 'dying') {
      this.targets = this.targets.filter((t) => t !== this._readyDot);
      this._readyDot.dispose();
    }
    this._readyDot = null;
  }

  _makeMsLabel(ms, pos) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const text = `${Math.round(ms)} ms`;
    const fontSize = 72;
    ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
    const pad = 28;
    canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    canvas.height = fontSize + pad;
    ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    const aspect = canvas.width / canvas.height;
    const h = 0.75;
    sprite.scale.set(h * aspect, h, 1);
    sprite.position.set(pos.x, pos.y + DOT_SIZE + 0.55, pos.z - 0.02);
    sprite.renderOrder = 0;
    this.root.add(sprite);
    this._labels.push({ sprite, tex, canvas });
  }

  _startAttempt() {
    this._phase = 'waiting';
    this._delayLeft = randRange(WAIT_MIN, WAIT_MAX);
    this._spawnMainDot();
  }

  _falseStart() {
    this._delayLeft = randRange(WAIT_MIN, WAIT_MAX);
    this._setMainGreen(false);
    beep(220, 0.06, 'sawtooth', 0.04);
  }

  _recordValidHit() {
    const ms = performance.now() - this._goAt;
    this._times.push(ms);
    this._validAttempts++;
    this.hits++;
    this.kills++;
    this.crosshair?.hit();
    beep(820, 0.04, 'square', 0.05);

    const pos = this._mainDot.object.position.clone();
    this._makeMsLabel(ms, pos);
    this._clearMainDot(0x35e06a);

    const avg = Math.round(this._times.reduce((a, b) => a + b, 0) / this._times.length);
    this.score = avg;

    if (this._validAttempts >= ATTEMPTS) {
      this._requestFinish?.();
      return;
    }

    this._phase = 'ready';
    this._spawnReadyDot();
  }

  onStart() {
    this._startAttempt();
  }

  onUpdate(dt) {
    if (this._phase !== 'waiting') return;
    this._delayLeft -= dt;
    if (this._delayLeft <= 0) {
      this._phase = 'go';
      this._setMainGreen(true);
      this._goAt = performance.now();
    }
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster);
    const target = hit?.object?.userData?.target;

    if (this._phase === 'ready') {
      if (target === this._readyDot) {
        this._clearReadyDot();
        this._startAttempt();
      }
      return;
    }

    if (!this._mainDot || target !== this._mainDot || this._mainDot.state === 'dying') {
      return;
    }

    if (this._phase === 'waiting') {
      this._falseStart();
      return;
    }

    if (this._phase === 'go') {
      this._recordValidHit();
    }
  }

  results() {
    const avg = this._times.length
      ? Math.round(this._times.reduce((a, b) => a + b, 0) / this._times.length)
      : 0;
    return {
      ...super.results(),
      score: avg,
      reactionTimes: [...this._times]
    };
  }

  dispose() {
    for (const l of this._labels) {
      l.tex?.dispose();
      l.sprite?.material?.dispose();
      this.root.remove(l.sprite);
    }
    this._labels.length = 0;
    super.dispose();
  }
}
