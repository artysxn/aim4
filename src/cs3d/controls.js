// ---------------------------------------------------------------------------
// src/cs3d/controls.js
// Pointer lock + keyboard for the explorer. Writes into player.input; the
// page-level keys (mode toggle, spawn, help) fire callbacks so main.js owns
// what they mean.
//
// Sensitivity is the trainer's, not a second number: this page reads and
// writes `aimtrainer:settings`.sensitivity on the unified scale, so a turn
// here is the same turn as a turn in a gamemode. The explorer used to keep
// its own `cs3d_sens` on the CS 0.022°/count convention, which meant two
// settings that looked alike, read alike and moved the camera differently.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import { SettingsManager } from '../core/SettingsManager.js';
import { SENSITIVITY_DEFAULT, radiansPerCountFromSensitivity } from '../utils/MathUtils.js';

/** Same migrated sensitivity / raw-input flags the trainer's InputManager uses. */
function trainerMouse() {
  const s = new SettingsManager();
  return {
    sens: s.data.sensitivity,
    rawInput: s.data.rawInput !== false
  };
}

export class Controls {
  constructor(canvas, player, hooks = {}) {
    this.canvas = canvas;
    this.player = player;
    this.hooks = hooks;
    this.locked = false;
    this.enabled = true;
    // Timeline 3D viewer owns F/G/V; Map Practice keeps the page keys.
    this.pageKeys = hooks.pageKeys !== false;
    const mouse = trainerMouse();
    this.sens = mouse.sens;
    this.rawInput = mouse.rawInput;
    this.keys = new Set();
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
    this._onCanvasClick = () => {
      if (this.enabled && !this.locked) this.requestLock();
    };
    // pointerrawupdate is the un-coalesced path. mousemove merges deltas across
    // a long WebGPU frame into one jump; the trainer stays smooth because its
    // frames are cheap. Same handler, different event.
    this._lookEvent = 'onpointerrawupdate' in document ? 'pointerrawupdate' : 'mousemove';

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
    document.addEventListener(this._lookEvent, this._onMouseMove);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    window.addEventListener('blur', () => this._releaseAll());
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
   * Lock with unadjusted movement when the trainer asks for it.
   *
   * Without it the browser hands over pointer-accelerated deltas, and a fast
   * flick arrives as a few enormous jumps rather than a smooth sweep — the
   * "skipping and spinning" the gamemodes fixed the same way. The option can
   * reject on its own (older Chrome, some platforms), so the plain form is the
   * fallback rather than the primary.
   */
  _requestLock() {
    if (!this.enabled) return;
    const el = this.canvas;
    if (!el.requestPointerLock) return;
    // requestPointerLock rejects, loudly, when the document is not focused.
    if (!document.hasFocus()) return;
    let res;
    try {
      res = this.rawInput ? el.requestPointerLock({ unadjustedMovement: true }) : el.requestPointerLock();
    } catch {
      return; // older browsers throw synchronously on the options form
    }
    if (res && typeof res.catch === 'function') {
      res.catch(() => {
        if (!this.rawInput || !document.hasFocus()) return;
        try {
          const plain = el.requestPointerLock();
          if (plain && typeof plain.catch === 'function') plain.catch(() => {});
        } catch {
          /* ignore */
        }
      });
    }
  }

  setSensitivity(v) {
    const n = Number(v);
    this.sens = Number.isFinite(n) && n > 0 ? n : SENSITIVITY_DEFAULT;
    // Merged, not replaced: this page owns one field of the trainer's settings.
    const data = Storage.read('settings', {}) || {};
    data.sensitivity = this.sens;
    Storage.write('settings', data);
    this.hooks.onSensitivity?.(this.sens);
  }

  _onLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this._releaseAll();
    this.hooks.onLock?.(this.locked);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.locked) return;
    this.player.look(e.movementX, e.movementY, radiansPerCountFromSensitivity(this.sens));
  }

  _releaseAll() {
    this.keys.clear();
    this._applyKeys();
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
        if (this.locked && /^(Space|Key[WASDC]|ShiftLeft|ControlLeft)$/.test(code)) e.preventDefault();
        this._applyKeys();
        return;
      }
      // Digits are context-dependent: main.js routes them to demo POV when a
      // demo is loaded, or to T/CT spawns in the plain explorer.
      const digit = /^Digit(\d)$/.exec(code);
      if (digit) this.hooks.onDigit?.(Number(digit[1]));
      switch (code) {
        case 'KeyF':
          this.hooks.onToggleMode?.();
          break;
        case 'KeyR':
          this.hooks.onSpawn?.(null);
          break;
        case 'KeyH':
          this.hooks.onHelp?.();
          break;
        case 'KeyI':
          this.hooks.onInspect?.();
          break;
        case 'KeyG':
          this.hooks.onGrade?.();
          break;
        case 'KeyV':
          this.hooks.onFpsView?.();
          break;
        case 'KeyQ':
          this.hooks.onWeapon?.();
          break;
        case 'KeyT':
          this.hooks.onThirdPerson?.();
          break;
        case 'KeyB':
          this.hooks.onBuy?.();
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
        case 'KeyX':
          this.hooks.onPovExit?.();
          break;
        case 'Space':
          if (this.locked) this.player.input.jump = true;
          break;
        default:
          break;
      }
      if (this.locked && /^(Space|Key[WASDCFQTB]|Digit[12]|ShiftLeft|ControlLeft)$/.test(code)) e.preventDefault();
    } else if (code === 'Space') {
      this.player.input.jump = false;
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
    document.removeEventListener(this._lookEvent, this._onMouseMove);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
  }
}
