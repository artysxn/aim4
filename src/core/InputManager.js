// ---------------------------------------------------------------------------
// InputManager.js
// Pointer Lock + raw mouse delta handling. Converts movementX/Y into yaw/pitch
// using the true-sensitivity scale from SettingsManager and writes the result
// directly onto the camera's Euler angles. Pitch is clamped to ±89°.
// ---------------------------------------------------------------------------

import { clamp, degToRad } from '../utils/MathUtils.js';

const MAX_PITCH = degToRad(89);

// Movement / crouch keys we capture (and swallow) while pointer-locked.
const MOVE_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'KeyC'
]);

export class InputManager {
  constructor(engine, settings) {
    this.engine = engine;
    this.settings = settings;
    this.camera = engine.camera;

    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.keys = new Set(); // currently-held movement keys (only while locked)
    this.jumpQueued = false; // consumed once per press by PlayerController
    this.spawnGraceRemaining = 0; // keyboard locked briefly after spawn
    this.fireHeld = false; // LMB held — drives full-auto in weapon scenarios

    // Decoupled callbacks — managers/UI subscribe, InputManager knows nothing
    // about game or UI state.
    this.onLockChange = null; // (locked: boolean) => void
    this.onShoot = null; // () => void — single click (non-weapon scenarios)
    this.onReload = null; // () => void — R pressed
    this.onUnlockedClick = null; // () => void — canvas clicked while not locked

    document.addEventListener('pointerlockchange', () => this._handleLockChange());
    document.addEventListener('pointerlockerror', () => this._handleLockChange());
    document.addEventListener('mousemove', (e) => this._onMouseMove(e));
    document.addEventListener('mousedown', (e) => this._onMouseDown(e));
    document.addEventListener('mouseup', (e) => this._onMouseUp(e));
    document.addEventListener('keydown', (e) => this._onKey(e, true));
    document.addEventListener('keyup', (e) => this._onKey(e, false));
  }

  /** WASD intent as forward/right axes in [-1, 1]. */
  moveAxis() {
    if (this.spawnGraceRemaining > 0) return { f: 0, r: 0 };
    const k = this.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    return { f, r };
  }

  get crouchHeld() {
    if (this.spawnGraceRemaining > 0) return false;
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC');
  }

  get walkHeld() {
    if (this.spawnGraceRemaining > 0) return false;
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** Lock keyboard movement briefly after spawn; mouse look still works. */
  beginSpawnGrace(seconds) {
    this.jumpQueued = false;
    this.spawnGraceRemaining = Math.max(0, seconds);
  }

  tickSpawnGrace(dt) {
    if (this.spawnGraceRemaining <= 0) return;
    this.spawnGraceRemaining = Math.max(0, this.spawnGraceRemaining - dt);
    if (this.spawnGraceRemaining <= 0) {
      this.jumpQueued = false;
    }
  }

  requestLock() {
    const el = this.engine.canvas;
    if (!el.requestPointerLock) return;
    // requestPointerLock() rejects (and logs an uncaught DOMException) when the
    // document isn't focused — e.g. a match starts while the user is on another
    // window/monitor. Bail out quietly; a later click on the canvas will lock.
    if (!document.hasFocus()) return;

    const useRaw = this.settings.data.rawInput;
    let res;
    try {
      // Prefer raw, unaccelerated mouse movement when enabled + supported.
      res = useRaw ? el.requestPointerLock({ unadjustedMovement: true }) : el.requestPointerLock();
    } catch (e) {
      return; // older browsers throw synchronously on the options form
    }
    // Swallow async rejections so they never surface as uncaught promise errors.
    if (res && typeof res.catch === 'function') {
      res.catch(() => {
        // The unadjustedMovement option can reject on its own; retry plainly.
        if (!useRaw || !document.hasFocus()) return;
        try {
          const r2 = el.requestPointerLock();
          if (r2 && typeof r2.catch === 'function') r2.catch(() => {});
        } catch (e) {
          /* ignore */
        }
      });
    }
  }

  exitLock() {
    if (document.pointerLockElement && document.exitPointerLock) {
      document.exitPointerLock();
    }
  }

  /** Re-read yaw/pitch from the camera (after the camera is reset). */
  syncFromCamera() {
    this.yaw = this.camera.rotation.y;
    this.pitch = this.camera.rotation.x;
  }

  _handleLockChange() {
    this.locked = document.pointerLockElement === this.engine.canvas;
    if (!this.locked) {
      this.keys.clear(); // never leave a key "stuck" after Esc
      this.jumpQueued = false;
      this.fireHeld = false; // never leave the trigger "stuck" after Esc
    }
    if (this.onLockChange) this.onLockChange(this.locked);
  }

  _onKey(e, down) {
    const grace = this.spawnGraceRemaining > 0;
    if (e.code === 'Space') {
      if (!this.locked) return;
      e.preventDefault();
      if (!grace && down) this.jumpQueued = true;
      return;
    }
    if (e.code === 'KeyR') {
      if (!this.locked) return;
      e.preventDefault();
      if (down && this.onReload) this.onReload();
      return;
    }
    if (!MOVE_CODES.has(e.code)) return;
    if (!this.locked) {
      this.keys.delete(e.code);
      return;
    }
    // Swallow so e.g. Ctrl-based browser shortcuts don't fire mid-run.
    e.preventDefault();
    // Always track held keys while locked — spawn grace only blocks moveAxis().
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  }

  _onMouseMove(e) {
    if (!this.locked) return;
    const rpc = this.settings.radiansPerCount;
    this.yaw -= e.movementX * rpc;
    this.pitch -= e.movementY * rpc;
    this.pitch = clamp(this.pitch, -MAX_PITCH, MAX_PITCH);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    if (!this.locked) {
      // Use the click gesture to (re)acquire pointer lock — clicking back into
      // the game after tabbing/clicking out, or after a start while unfocused.
      if (this.onUnlockedClick) this.onUnlockedClick();
      return;
    }
    this.fireHeld = true;
    if (this.onShoot) this.onShoot();
  }

  _onMouseUp(e) {
    if (e.button !== 0) return;
    this.fireHeld = false;
  }
}
