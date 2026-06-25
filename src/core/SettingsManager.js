// ---------------------------------------------------------------------------
// SettingsManager.js
// Single source of truth for all user-configurable settings: true sensitivity
// (cm/360 + DPI), FOV, resolution, crosshair appearance, run duration and
// per-scenario parameters. Persists to localStorage and notifies listeners.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import { radiansPerCount } from '../utils/MathUtils.js';

export const RESOLUTIONS = {
  native: { label: 'Native', size: null },
  '1920x1080': { label: '1920 × 1080 (16:9)', size: [1920, 1080] },
  '1280x960': { label: '1280 × 960 (4:3 stretched)', size: [1280, 960] },
  '1024x768': { label: '1024 × 768 (4:3 stretched)', size: [1024, 768] },
  '1280x720': { label: '1280 × 720 (16:9)', size: [1280, 720] }
};

const DEFAULTS = {
  cm360: 40,
  dpi: 800,
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
    customWeapon: 'rifle' // weapon used in custom games ('rifle' | 'pistol')
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
    infiniteAmmo: true
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
    streakLengthMin: 2,
    streakLengthMax: 4,
    doubleSpawnChance: 0.08, // 0–1 chance for two active targets
    horizontalDrift: false,
    driftSpeedMax: 1.5,
    randomSize: false,
    randomSizeMin: 0.32,
    randomSizeMax: 0.52,
    infiniteAmmo: true
  },
  survival: {
    spawnInterval: 1000, // ms between spawns (Practice)
    despawnTime: 2000, // ms before a dot explodes (Practice)
    maxSize: 0.55,
    startSize: 0.12,
    missesAllowed: 3 // missed shots before game over (Practice only)
  },
  arena: {
    crossDuration: 700, // ms for the bot to cross a gap (exposure window)
    peekHold: 450, // ms the bot holds an open peek before crossing
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
  }
};

export class SettingsManager {
  constructor() {
    this.data = this._load();
    this._listeners = [];
    this._cloudSaveHandler = null;
    this._cloudSyncPaused = false;
  }

  _load() {
    const saved = Storage.read('settings', {});
    return this._deepMerge(structuredClone(DEFAULTS), saved);
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

  _emit() {
    for (const fn of this._listeners) fn(this.data);
  }

  /** Radians of yaw/pitch to apply per raw mouse count. */
  get radiansPerCount() {
    return radiansPerCount(this.data.cm360, this.data.dpi);
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
    return structuredClone(this.data);
  }

  /** Replace local settings from an imported snapshot. */
  applyPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid settings data');
    }
    this.data = this._deepMerge(structuredClone(DEFAULTS), payload);
    this._cloudSyncPaused = true;
    Storage.write('settings', this.data);
    this._cloudSyncPaused = false;
    this._emit();
  }
}
