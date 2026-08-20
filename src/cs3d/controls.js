// ---------------------------------------------------------------------------
// src/cs3d/controls.js
// Pointer lock + keyboard for the explorer. Writes into player.input; the
// page-level keys (mode toggle, spawn, help) fire callbacks so main.js owns
// what they mean.
//
// Look is InputManager's path, not a second one: mousemove counts, the
// trainer's radians-per-count, and Pointer Lock with unadjustedMovement when
// raw input is on. pointerrawupdate was tried here to beat coalescing on a
// heavy WebGPU frame and made the view jitter while moving; the trainer
// stays on mousemove, so this page does too.
// ---------------------------------------------------------------------------

import { SettingsManager } from '../core/SettingsManager.js';
import { SENSITIVITY_DEFAULT } from '../utils/MathUtils.js';

export class Controls {
  constructor(canvas, player, hooks = {}) {
    this.canvas = canvas;
    this.player = player;
    this.hooks = hooks;
    this.locked = false;
    this.enabled = true;
    // Timeline 3D viewer owns F/G/V; Map Practice keeps the page keys.
    this.pageKeys = hooks.pageKeys !== false;
    // Same store InputManager reads: sensitivity, rawInput, the v2 migration.
    this.settings = new SettingsManager();
    this.keys = new Set();
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
    this._onCanvasClick = () => {
      if (this.enabled && !this.locked) this.requestLock();
    };

    if (hooks.lockOnClick !== false) {
      canvas.addEventListener('click', this._onCanvasClick);
    }
    // Firing. Only while locked, and preventDefault so the right button does
    // not open a context menu over the map.
    this._onMouseDown = (e) => {
      if (!this.enabled || !this.locked) return;
      if (e.button === 0 || e.button === 2) {
        e.preventDefault();
        if (this.pageKeys) this.hooks.onAttack?.(e.button === 2 ? 'secondary' : 'primary', true);
      }
    };
    this._onMouseUp = (e) => {
      if (this.pageKeys && (e.button === 0 || e.button === 2)) {
        this.hooks.onAttack?.(e.button === 2 ? 'secondary' : 'primary', false);
      }
    };
    this._onContextMenu = (e) => {
      if (this.locked) e.preventDefault();
    };
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    canvas.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('pointerlockerror', this._onLockChange);
    document.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    window.addEventListener('blur', () => this._releaseAll());
  }

  /** Unified sensitivity the HUD shows and the trainer stores. */
  get sens() {
    return this.settings.data.sensitivity;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) {
      this._releaseAll();
      this.exitLock();
    }
  }

  requestLock() {
    this._requestLock();
  }

  exitLock() {
    if (document.pointerLockElement === this.canvas && document.exitPointerLock) {
      document.exitPointerLock();
    }
  }

  /**
   * Pointer lock, copied from InputManager.requestLock: raw unadjusted
   * movement when the trainer setting is on, plain lock if that option rejects.
   */
  _requestLock() {
    if (!this.enabled) return;
    const el = this.canvas;
    if (!el.requestPointerLock) return;
    if (!document.hasFocus()) return;
    const useRaw = this.settings.data.rawInput;
    let res;
    try {
      res = useRaw ? el.requestPointerLock({ unadjustedMovement: true }) : el.requestPointerLock();
    } catch {
      return;
    }
    if (res && typeof res.catch === 'function') {
      res.catch(() => {
        if (!useRaw || !document.hasFocus()) return;
        try {
          const r2 = el.requestPointerLock();
          if (r2 && typeof r2.catch === 'function') r2.catch(() => {});
        } catch {
          /* ignore */
        }
      });
    }
  }

  setSensitivity(v) {
    const n = Number(v);
    this.settings.data.sensitivity = Number.isFinite(n) && n > 0 ? n : SENSITIVITY_DEFAULT;
    this.settings.save();
    this.hooks.onSensitivity?.(this.sens);
  }

  _onLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this._releaseAll();
    this.hooks.onLock?.(this.locked);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.locked) return;
    // InputManager._onMouseMove, same counts and the same radians-per-count.
    this.player.look(e.movementX, e.movementY, this.settings.radiansPerCount);
  }

  _releaseAll() {
    const qHeld = this.pageKeys && this.keys.has('KeyQ');
    this.keys.clear();
    this._applyKeys();
    if (qHeld) this.hooks.onWeaponHold?.(false, { cancel: true });
  }

  _onKey(e) {
    if (!this.enabled) return;
    const down = e.type === 'keydown';
    const code = e.code;
    // Typing in a field (sensitivity box) must not move the player.
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (down && e.repeat) return;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    if (down) {
      if (!this.pageKeys) {
        if (code === 'Space' && this.locked) this.player.input.jump = true;
        if (this.locked && /^(Space|Tab|Key[WASDCQ]|ShiftLeft|ControlLeft)$/.test(code)) e.preventDefault();
        this._applyKeys();
        return;
      }
      // Digits: demo POV when a demo is loaded, otherwise weapon slots 1-4.
      const digit = /^Digit(\d)$/.exec(code);
      if (digit) this.hooks.onDigit?.(Number(digit[1]));
      switch (code) {
        case 'CapsLock':
          e.preventDefault();
          this.hooks.onToggleMode?.();
          break;
        case 'KeyN':
          this.hooks.onSpawn?.(null);
          break;
        case 'KeyQ':
          this.hooks.onWeaponHold?.(true);
          break;
        case 'KeyB':
          this.hooks.onBuy?.();
          break;
        case 'KeyE':
          this.hooks.onUse?.();
          break;
        case 'KeyG':
          this.hooks.onDropWeapon?.();
          break;
        case 'KeyR':
          this.hooks.onReload?.();
          break;
        case 'Escape':
          // Pointer lock exits on Escape by itself; this is for the panels that
          // are open while it is not held.
          this.hooks.onCancel?.();
          break;
        // Demo playback (no-ops until a demo is loaded; main.js decides).
        case 'KeyP':
          this.hooks.onPlayPause?.();
          break;
        case 'Comma':
          this.hooks.onStep?.(e.shiftKey ? -32 : -1);
          break;
        case 'Period':
          this.hooks.onStep?.(e.shiftKey ? 32 : 1);
          break;
        case 'BracketLeft':
          this.hooks.onRound?.(-1);
          break;
        case 'BracketRight':
          this.hooks.onRound?.(1);
          break;
        case 'KeyM':
          this.hooks.onSpeed?.();
          break;
        case 'KeyJ':
          // A loaded round takes J/K/L for pause / restart / exit. Otherwise J
          // still plants a frozen bot.
          if (this.hooks.onRoundKey?.('pause')) break;
          this.hooks.onPlaceBot?.();
          break;
        case 'KeyH':
          this.hooks.onBoostBot?.();
          break;
        case 'KeyK':
          if (this.hooks.onRoundKey?.('restart')) break;
          this.hooks.onDeleteBot?.();
          break;
        case 'KeyL':
          this.hooks.onRoundKey?.('exit');
          break;
        case 'KeyO':
          this.hooks.onSkipNades?.();
          break;
        case 'KeyX':
          this.hooks.onXray?.();
          break;
        case 'KeyY':
          e.preventDefault();
          this.hooks.onChat?.();
          break;
        case 'Space':
          if (this.locked) this.player.input.jump = true;
          break;
        default:
          break;
      }
      if (this.locked && /^(Space|Key[WASDCQBNEGJHKORXL]|Digit[1-4]|ShiftLeft|ControlLeft|CapsLock)$/.test(code)) e.preventDefault();
    } else if (code === 'Space') {
      this.player.input.jump = false;
    } else if (code === 'KeyQ' && this.pageKeys) {
      this.hooks.onWeaponHold?.(false);
    }
    this._applyKeys();
  }

  _applyKeys() {
    const k = this.keys;
    const inp = this.player.input;
    const on = this.locked;
    inp.fwd = on ? (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) : 0;
    inp.side = on ? (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) : 0;
    // Fly: Space up, C down. Walk: Space is jump (edge-triggered above), Ctrl crouch.
    inp.up = on ? (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0) : 0;
    inp.crouch = on && (k.has('ControlLeft') || k.has('ControlRight'));
    inp.walk = on && (k.has('ShiftLeft') || k.has('ShiftRight')) && this.player.mode === 'walk';
    inp.fast = on && (k.has('ShiftLeft') || k.has('ShiftRight')) && this.player.mode === 'fly';
    if (!on) inp.jump = false;
  }

  dispose() {
    this.canvas.removeEventListener('click', this._onCanvasClick);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('pointerlockerror', this._onLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
  }
}
