// ---------------------------------------------------------------------------
// src/cs3d/controls.js
// Pointer lock + keyboard for the explorer. Writes into player.input; the
// page-level keys (mode toggle, spawn, help) fire callbacks so main.js owns
// what they mean. Mouse sensitivity is CS convention: degrees per count =
// 0.022 × sens, persisted in localStorage.
// ---------------------------------------------------------------------------

const SENS_KEY = 'cs3d_sens';
const CS_DEG_PER_COUNT = 0.022;

export class Controls {
  constructor(canvas, player, hooks = {}) {
    this.canvas = canvas;
    this.player = player;
    this.hooks = hooks;
    this.locked = false;
    this.sens = Number(localStorage.getItem(SENS_KEY)) || 1.0;
    this.keys = new Set();
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onLockChange = this._onLockChange.bind(this);

    canvas.addEventListener('click', () => {
      if (!this.locked) canvas.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    window.addEventListener('blur', () => this._releaseAll());
  }

  setSensitivity(v) {
    this.sens = Math.max(0.05, Math.min(10, Number(v) || 1));
    localStorage.setItem(SENS_KEY, String(this.sens));
    this.hooks.onSensitivity?.(this.sens);
  }

  _onLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this._releaseAll();
    this.hooks.onLock?.(this.locked);
  }

  _onMouseMove(e) {
    if (!this.locked) return;
    this.player.look(e.movementX, e.movementY, CS_DEG_PER_COUNT * this.sens);
  }

  _releaseAll() {
    this.keys.clear();
    this._applyKeys();
  }

  _onKey(e) {
    const down = e.type === 'keydown';
    const code = e.code;
    // Typing in a field (sensitivity box) must not move the player.
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (down && e.repeat) return;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    if (down) {
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
      if (this.locked && /^(Space|Key[WASDCF]|Digit[12]|ShiftLeft|ControlLeft)$/.test(code)) e.preventDefault();
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
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
  }
}
