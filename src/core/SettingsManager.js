// ---------------------------------------------------------------------------
// SettingsManager.js
// Single source of truth for all user-configurable settings: sensitivity,
// FOV, resolution, crosshair appearance, run duration and per-scenario
// parameters. Persists to localStorage and notifies listeners.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import {
  SENSITIVITY_DEFAULT,
  radiansPerCountFromSensitivity,
  sensitivityFromLegacy
} from '../utils/MathUtils.js';

const SETTINGS_VERSION = 2;

export const RESOLUTIONS = {
  native: { label: 'Native', size: null },
  '1920x1080': { label: '1920 × 1080 (16:9)', size: [1920, 1080] },
  '1280x960': { label: '1280 × 960 (4:3 stretched)', size: [1280, 960] },
  '1024x768': { label: '1024 × 768 (4:3 stretched)', size: [1024, 768] },
  '1280x720': { label: '1280 × 720 (16:9)', size: [1280, 720] }
};

const DEFAULTS = {
  sensitivity: SENSITIVITY_DEFAULT,
  hFov: 90,
  resolution: 'native',
  rawInput: true, // request unadjusted (raw) mouse movement under Pointer Lock
  runDuration: 60, // seconds
  crosshair: {
    color: '#f52525',
    innerGap: 6,
    length: 10,
    thickness: 2,
    dotPercentage: 35,
    hitmarker: true, // brief X flash on hit
    dynamicGap: false // gap grows with movement + weapon bloom (airborne/fast = wider)
  },
  viewmodel: {
    hand: 'right', // 'right' | 'left'
    fov: 68, // viewmodel field of view (approx; lower = bigger/closer)
    offsetX: 0.16, // metres right of centre (flipped for left hand)
    offsetY: -0.15, // metres below the eye
    offsetZ: 0.5, // metres forward
    bob: true // weapon bob while moving
  },
  weapon: {
    aimpunch: true, // view-punch camera kick when firing (toggle for those who dislike it)
    customWeapon: 'rifle' // custom games: 'rifle' | 'pistol' | 'tracking'
  },
  gridshot: {
    targetSize: 0.55,
    targetCount: 3,
    enableTimeLimit: false,
    maxTargetAge: 1200, // ms
    mode: 'clicking', // clicking | tracking
    trackTime: 0.4, // s on target before resolve (tracking mode)
    trackResolve: 'click', // click = change color then click; auto = auto hit
    floatEnabled: false,
    floatSpeedMax: 2.0, // m/s cap for horizontal drift
    boundsScaleX: 1.0, // horizontal spawn spread multiplier
    boundsScaleY: 1.0, // vertical spawn spread multiplier (0.5 = tighter)
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  pasu: {
    targetSize: 0.38,
    targetCount: 3,
    enableTimeLimit: false,
    maxTargetAge: 1200,
    mode: 'clicking',
    trackTime: 0.4,
    trackResolve: 'click',
    travelSpeedMax: 2.5,
    boundsScaleX: 1.0,
    boundsScaleY: 1.0,
    angleOffset: 360,
    infiniteAmmo: true
  },
  spidershot: {
    targetSize: 0.45,
    timeToKill: 1500, // ms per sideward target
    maxDistance: 8.0, // metres from centre at the wall
    minDistance: 1.2,
    heightSpread: 1.0, // vertical spawn multiplier
    angleSpread: 25, // degrees above/below horizontal
    streakChance: 0.15, // 0–1 chance to chain extra targets after a kill
    streakLengthMin: 1,
    streakLengthMax: 3,
    doubleSpawnChance: 0.08, // 0–1 chance for two active targets
    horizontalDrift: false,
    driftSpeedMax: 1.5,
    randomSize: false,
    randomSizeMin: 0.32,
    randomSizeMax: 0.52,
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  survival: {
    spawnInterval: 800, // ms between spawns (Practice)
    despawnTime: 1800, // ms before a dot explodes (Practice)
    maxSize: 0.55,
    startSize: 0.12,
    missesAllowed: 3 // missed shots before game over (Practice only)
  },
  arena: {
    crossDuration: 775, // ms for the bot to cross a gap (exposure window)
    peekHold: 525, // ms the bot holds an open peek before crossing
    columns: 7, // number of columns spread across the 80° arc
    columnRadius: 0.55, // metres, cylinder half-width of each cover column
    ringRadius: 9, // metres from player to column arc
    enemyScale: 1.0 // uniform scale applied to bot body/head dimensions
  },
  duels: {
    arena: 0, // 0 = random each run, 1..10 = a fixed arena
    ttk: 0.5  // seconds to kill enemy once exposed; lower = harder
  },
  colors: {
    bg:        '#0a0a0a', // scene background + fog
    floor:     '#101010', // floor surface
    enemyBody: '#8a8a8a', // bot body cylinder
    enemyHead: '#ffcf4d', // bot head sphere
    cover:     '#4a4a4a', // cover boxes / columns
    target:    '#ff5a3c'  // Gridshot spheres
  },
  range: {
    arc: 180, // degrees the bots are spread across: 90 | 180 | 360
    enemyCount: 5, // bots kept alive at once
    radius: 12, // metres from player centre to the bot ring
    botStrafe: true, // false = bots stand still on the arc
    botCrouchTap: true, // false = bots stay standing
    infiniteAmmo: true,
    coverEnabled: false,
    coverCount: 2,
    coverDistance: 4, // metres from player centre
    coverThickness: 1.2, // box depth (m)
    coverHeight: 3.0 // box height (m)
  },
  tracking: {
    botWidth: 1.0, // uniform scale on bot body/head radius (0.5–2.0)
    botSpeed: 1.0 // multiplier on default run speed (215 u/s)
  },
  stars: {
    boundsScaleX: 2.0,
    boundsScaleY: 1.0
  },
  microflicks: {
    targetSize: 0.1,
    targetCount: 2,
    floatEnabled: false,
    floatSpeedMax: 2.0,
    boundsScaleX: 2.0,
    boundsScaleY: 1.0
  }
};

export class SettingsManager {
  constructor() {
    this.data = this._load();
    this.draft = null;
    this._undoStack = [];
    this._undoCap = 50;
    this._listeners = [];
    this._draftListeners = [];
    this._cloudSaveHandler = null;
    this._cloudSyncPaused = false;
  }

  _load() {
    const saved = Storage.read('settings', {});
    const merged = this._deepMerge(structuredClone(DEFAULTS), saved);
    this._normalizeSensitivity(merged);
    return merged;
  }

  /** Migrate legacy cm/360 + DPI and pre-v2 sensitivity scale (÷3). */
  _normalizeSensitivity(data) {
    const sens = Number(data.sensitivity);
    if (!Number.isFinite(sens) || sens <= 0) {
      const cm = Number(data.cm360);
      const dpi = Number(data.dpi);
      if (Number.isFinite(cm) && Number.isFinite(dpi) && cm > 0 && dpi > 0) {
        data.sensitivity = sensitivityFromLegacy(cm, dpi);
      } else {
        data.sensitivity = SENSITIVITY_DEFAULT;
      }
    }
    delete data.cm360;
    delete data.dpi;

    const version = data.settingsVersion ?? 0;
    if (version < SETTINGS_VERSION) {
      if (Number.isFinite(data.sensitivity) && data.sensitivity >= 1) {
        data.sensitivity = data.sensitivity / 3;
      }
      data.settingsVersion = SETTINGS_VERSION;
    }
  }

  _deepMerge(base, over) {
    for (const k in over) {
      const v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        base[k] = this._deepMerge(base[k] || {}, v);
      } else if (v !== undefined) {
        base[k] = v;
      }
    }
    return base;
  }

  save() {
    Storage.write('settings', this.data);
    this._emit();
    if (!this._cloudSyncPaused && this._cloudSaveHandler) {
      this._cloudSaveHandler();
    }
  }

  /** Register debounced cloud push (AuthManager). Pass null to clear. */
  setCloudSaveHandler(fn) {
    this._cloudSaveHandler = fn;
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  onDraftChange(fn) {
    this._draftListeners.push(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this.data);
  }

  _emitDraft() {
    if (!this.draft) return;
    for (const fn of this._draftListeners) fn(this.draft);
  }

  /** Settings visible in the UI — draft while editing, otherwise persisted data. */
  activeSettings() {
    return this.draft ?? this.data;
  }

  openDraft() {
    this.draft = structuredClone(this.data);
    this._undoStack = [];
    this._emitDraft();
  }

  recordUndo() {
    if (!this.draft) return;
    this._undoStack.push(structuredClone(this.draft));
    if (this._undoStack.length > this._undoCap) this._undoStack.shift();
  }

  mutateDraft(fn) {
    if (!this.draft) this.openDraft();
    this.recordUndo();
    fn(this.draft);
    this._emitDraft();
  }

  confirmDraft() {
    if (!this.draft) return;
    this.data = structuredClone(this.draft);
    this.draft = null;
    this._undoStack = [];
    this.save();
  }

  undoDraft() {
    if (!this._undoStack.length || !this.draft) return false;
    this.draft = this._undoStack.pop();
    this._emitDraft();
    return true;
  }

  resetDraft() {
    if (!this.draft) this.openDraft();
    this.recordUndo();
    this.draft = structuredClone(DEFAULTS);
    this._emitDraft();
  }

  resetColorsDraft() {
    this.mutateDraft((d) => {
      d.colors = structuredClone(DEFAULTS.colors);
    });
  }

  discardDraft() {
    this.draft = null;
    this._undoStack = [];
  }

  hasDraftChanges() {
    if (!this.draft) return false;
    return JSON.stringify(this.draft) !== JSON.stringify(this.data);
  }

  canUndoDraft() {
    return this._undoStack.length > 0;
  }

  /** Radians of yaw/pitch to apply per raw mouse count. */
  get radiansPerCount() {
    return radiansPerCountFromSensitivity(this.data.sensitivity);
  }

  reset() {
    this.data = structuredClone(DEFAULTS);
    this.save();
  }

  resetColors() {
    this.data.colors = structuredClone(DEFAULTS.colors);
    this.save();
  }

  /** Snapshot of all user settings for export. */
  getExportPayload() {
    return structuredClone(this.activeSettings());
  }

  /** Replace local settings from an imported snapshot. */
  applyPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid settings data');
    }
    this.data = this._deepMerge(structuredClone(DEFAULTS), payload);
    this._normalizeSensitivity(this.data);
    if (this.draft) {
      this.draft = structuredClone(this.data);
      this._undoStack = [];
      this._emitDraft();
    }
    this._cloudSyncPaused = true;
    Storage.write('settings', this.data);
    this._cloudSyncPaused = false;
    this._emit();
  }
}
