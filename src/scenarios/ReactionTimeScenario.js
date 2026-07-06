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
import { canvasCenterY } from '../utils/canvasWall.js';

const BOUNDS_W = 12;
const BOUNDS_H = 6;
const WALL_DISTANCE = 16;
const DOT_SIZE = 0.55;
const READY_DOT_SIZE = 0.38;
const WAIT_MIN = 2;
const WAIT_MAX = 6;
const ATTEMPTS = 3;
const READY_COLOR = new THREE.Color(0x35e06a);
const READY_DOT_COLOR = 0xff3b3b;
const FALSE_FLASH_DUR = 0.22;
const FALSE_FLASH_PEAK = 0.09;

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
    this.centerY = canvasCenterY(BOUNDS_H);

    this._phase = 'waiting'; // waiting | go | ready
    this._delayLeft = 0;
    this._goAt = 0;
    this._validAttempts = 0;
    this._times = [];
    this._mainDot = null;
    this._readyDot = null;
    this._bigLabel = null;
    this._progressSlots = [];
    this._flashT = 0;

    this._buildEnvironment();
    this._buildProgressUI();
    this.engine.camera.position.y = this.centerY;
  }

  get name() {
    return 'reactiontime';
  }

  get showElapsedTime() {
    return true;
  }

  /** HUD: latest attempt ms until all three are done, then average. */
  get reactionHudMs() {
    if (!this._times.length) return null;
    if (this._validAttempts >= ATTEMPTS) {
      return Math.round(this._times.reduce((a, b) => a + b, 0) / this._times.length);
    }
    return Math.round(this._times[this._times.length - 1]);
  }

  static configKeyFor() {
    return 'challenge';
  }

  configKey() {
    return 'challenge';
  }

  _wallZ() {
    return -this.wallDistance + 0.08;
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

  _buildProgressUI() {
    const y = this.centerY + this.boundsH / 2 - 0.55;
    const z = this._wallZ();
    const xs = [-1.5, 0, 1.5];
    for (let i = 0; i < ATTEMPTS; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.16, 0.24, 40),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.4,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      ring.position.set(xs[i], y, z);
      this.root.add(ring);
      this._progressSlots.push({ ring, fill: null, label: null, x: xs[i], y });
    }
  }

  _dotPos() {
    return new THREE.Vector3(0, this.centerY, -this.wallDistance + DOT_SIZE + 0.05);
  }

  _readyPos() {
    const halfH = this.boundsH / 2 - READY_DOT_SIZE - 0.15;
    const y = this.centerY - halfH;
    return new THREE.Vector3(0, y, -this.wallDistance + READY_DOT_SIZE + 0.12);
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
      new THREE.SphereGeometry(READY_DOT_SIZE, 24, 18),
      new THREE.MeshStandardMaterial({
        color: READY_DOT_COLOR,
        emissive: 0xcc2222,
        emissiveIntensity: 0.85,
        roughness: 0.35,
        metalness: 0.05
      })
    );
    mesh.renderOrder = 2;
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

  _makeTextSprite(text, { fontSize = 48, bold = true, color = '#ffffff' } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const weight = bold ? '700' : '500';
    ctx.font = `${weight} ${fontSize}px system-ui, sans-serif`;
    const pad = Math.round(fontSize * 0.35);
    canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    canvas.height = fontSize + pad;
    ctx.font = `${weight} ${fontSize}px system-ui, sans-serif`;
    ctx.fillStyle = color;
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
    const h = fontSize / 96;
    sprite.scale.set(h * aspect, h, 1);
    return { sprite, tex, canvas };
  }

  _setBigLabel(ms) {
    this._disposeBigLabel();
    const pos = this._dotPos();
    const { sprite, tex, canvas } = this._makeTextSprite(`${Math.round(ms)} ms`, { fontSize: 88 });
    sprite.position.set(pos.x, pos.y + DOT_SIZE + 0.65, pos.z - 0.02);
    sprite.renderOrder = 0;
    this.root.add(sprite);
    this._bigLabel = { sprite, tex, canvas };
  }

  _disposeBigLabel() {
    if (!this._bigLabel) return;
    this._bigLabel.tex?.dispose();
    this._bigLabel.sprite?.material?.dispose();
    this.root.remove(this._bigLabel.sprite);
    this._bigLabel = null;
  }

  _fillProgressSlot(index, ms) {
    const slot = this._progressSlots[index];
    if (!slot || slot.fill) return;
    const z = this._wallZ();
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 40),
      new THREE.MeshBasicMaterial({
        color: READY_COLOR,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    fill.position.set(slot.x, slot.y, z + 0.01);
    this.root.add(fill);
    slot.fill = fill;

    const { sprite, tex, canvas } = this._makeTextSprite(`${Math.round(ms)} ms`, { fontSize: 30 });
    sprite.position.set(slot.x, slot.y - 0.44, z - 0.01);
    this.root.add(sprite);
    slot.label = { sprite, tex, canvas };
  }

  _startAttempt() {
    this._phase = 'waiting';
    this._delayLeft = randRange(WAIT_MIN, WAIT_MAX);
    this._spawnMainDot();
  }

  _falseStart() {
    this._delayLeft = randRange(WAIT_MIN, WAIT_MAX);
    this._setMainGreen(false);
    beep(160, 0.14, 'sawtooth', 0.09);
    this._flashT = FALSE_FLASH_DUR;
  }

  _recordValidHit() {
    const ms = performance.now() - this._goAt;
    const idx = this._validAttempts;
    this._times.push(ms);
    this._validAttempts++;
    this.hits++;
    this.kills++;
    this.crosshair?.hit();
    beep(820, 0.04, 'square', 0.05);

    this._fillProgressSlot(idx, ms);
    this._clearMainDot(0x35e06a);

    if (this._validAttempts >= ATTEMPTS) {
      const avg = Math.round(this._times.reduce((a, b) => a + b, 0) / this._times.length);
      this.score = avg;
      this._setBigLabel(avg);
      this._requestFinish?.();
      return;
    }

    this.score = Math.round(ms);
    this._setBigLabel(ms);
    this._phase = 'ready';
    this._spawnReadyDot();
  }

  onStart() {
    this._startAttempt();
  }

  onUpdate(dt) {
    if (this._flashT > 0) {
      this._flashT = Math.max(0, this._flashT - dt);
      const p = this._flashT / FALSE_FLASH_DUR;
      this.engine.setDeathOverlay(FALSE_FLASH_PEAK * p);
      if (this._flashT <= 0) this.engine.setDeathOverlay(0);
    }

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
    this.engine.setDeathOverlay(0);
    this._disposeBigLabel();
    for (const slot of this._progressSlots) {
      slot.ring?.geometry?.dispose();
      slot.ring?.material?.dispose();
      this.root.remove(slot.ring);
      slot.fill?.geometry?.dispose();
      slot.fill?.material?.dispose();
      if (slot.fill) this.root.remove(slot.fill);
      slot.label?.tex?.dispose();
      slot.label?.sprite?.material?.dispose();
      if (slot.label) this.root.remove(slot.label.sprite);
    }
    this._progressSlots.length = 0;
    super.dispose();
  }
}
