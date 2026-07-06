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
  '1280x960': { label: '1280 × 960 (4:3 stretched)', size: [1280, 960], stretched: true },
  '1024x768': { label: '1024 × 768 (4:3 stretched)', size: [1024, 768], stretched: true },
  '1280x720': { label: '1280 × 720 (16:9)', size: [1280, 720] }
};

const RES_MIN = 320;
const RES_MAX = 7680;

/** Clamp a custom resolution dimension to sane backbuffer bounds. */
export function clampResolutionDim(n, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < RES_MIN) return fallback;
  return Math.min(v, RES_MAX);
}

/**
 * Resolve the active backbuffer size from settings.
 * @returns {{ size: [number, number] | null, stretched?: boolean }}
 */
export function getResolutionSpec(data) {
  if (!data) return { size: null };
  const key = data.resolution;
  if (!key || key === 'native') return { size: null };
  if (key === 'custom') {
    const w = clampResolutionDim(data.resolutionWidth, 1920);
    const h = clampResolutionDim(data.resolutionHeight, 1080);
    return { size: [w, h] };
  }
  const preset = RESOLUTIONS[key];
  if (preset) return preset;
  return { size: null };
}

export const DEFAULTS = {
  sensitivity: SENSITIVITY_DEFAULT,
  hFov: 90,
  resolution: 'native',
  resolutionWidth: 1920,
  resolutionHeight: 1080,
  rawInput: true, // request unadjusted (raw) mouse movement under Pointer Lock
  copyConfigOnReplay: false, // when ON, use the recorded player's resolution/colors/crosshair on their replays
  // Replay analysis overlays (viewer-side; gate on-screen visuals only — stats
  // are always measured & stored regardless of these toggles).
  replayAnalytics: {
    optimalPath: false, // green line to nearest target + red actual-motion line
    flicks: false, // accurate / over / under flick counters
    trajectory: false, // short line leading the crosshair's current motion
    tension: false, // jitter-vs-optimal-path percentage
    clickTiming: false, // early / accurate / late click tallies
    flickSpeed: false, // avg ms/° from flick start to first click
    flickAccuracy: false // avg first-click placement along start→target
  },
  runDuration: 60, // seconds
  crosshair: {
    color: '#f52525',
    innerGap: 6,
    length: 10,
    thickness: 2,
    dotPercentage: 35,
    hitmarker: true, // brief X flash on hit
    dynamicGap: false, // gap grows with movement + weapon bloom (airborne/fast = wider)
    outlineThickness: 0, // 0 = off; 0.5 = 1px drop shadow (+1,+1); 1+ = px padding all around
    outlineColor: '#000000',
    outlineOpacity: 1
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
    customWeapon: 'rifle', // custom games: 'rifle' | 'pistol' | 'tracking' | 'sniper'
    shootBind: 'Mouse0' // Mouse0|Mouse1|Mouse2 or a KeyboardEvent.code
  },
  sniper: {
    lineThickness: 2, // px — scope hairline thickness
    unscopeKey1: 'Digit3', // instant-unscope binds (rebindable)
    unscopeKey2: 'KeyQ'
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
    viewmodelRecoil: false,
    missLimit: 0 // missed shots before the run ends (0 = unlimited)
  },
  bounce: {
    targetSize: 0.35,
    targetCount: 4,
    travelSpeed: 35, // deg/s angular travel around the player
    minDistance: 10, // metres — nearest a ball drifts
    maxDistance: 18, // metres — furthest a ball drifts
    bounceStrength: 6, // upward jump speed (m/s) on each floor bounce
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
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
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  spidershot: {
    targetSize: 0.30,
    timeToKill: 1500, // ms per sideward target
    maxDistance: 6.4, // metres from centre at the wall (was 8.0)
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
    randomSizeMin: 0.21,
    randomSizeMax: 0.35,
    infiniteAmmo: true,
    viewmodelRecoil: false,
    decoyEnabled: true,
    decoyRoundChance: 1,
    decoyChancePer: 0.1,
    decoyMin: 0,
    decoyMax: 2,
    missLimit: 0
  },
  survival: {
    spawnInterval: 800, // ms between spawns (Practice)
    despawnTime: 1800, // ms before a dot explodes (Practice)
    maxSize: 0.55,
    startSize: 0.12,
    missesAllowed: 3, // missed shots before game over (Practice only)
    viewmodelRecoil: false
  },
  arena: {
    columns: 7, // number of columns spread across the 80° arc
    columnRadius: 0.55, // metres, cylinder half-width of each cover column
    ringRadius: 7, // metres from player to column arc
    botDistMin: 0.5, // m beyond ringRadius — min bot spawn distance from pillar
    botDistMax: 1.5, // m beyond ringRadius — max bot spawn distance from pillar
    enemyScale: 1.0, // uniform scale applied to bot body/head dimensions
    missLimit: 0
  },
  snipercrossfire: {
    columns: 7,
    columnRadius: 0.55,
    ringRadius: 7,
    botDistMin: 0.5,
    botDistMax: 1.5,
    enemyScale: 1.0,
    missLimit: 0
  },
  duels: {
    arena: 0, // 0 = random each run, 1..N = fixed arena (legacy + MP duel maps)
    botDifficulty: 'hard', // training only — hard | medium | easy
    ttk: 0.5,  // seconds to kill enemy once exposed; lower = harder
    missLimit: 0
  },
  deathmatch: {
    botCount: 4, // bots hunting the player at once (1..6)
    botDifficulty: 'hard', // training only — hard | medium | easy
    botSpeed: 1.0, // multiplier on default run speed (215 u/s)
    botBodyHit: 0.2, // per-bullet body hit chance vs player/bots
    botHeadHit: 0.05, // per-bullet head hit chance (checked before body)
    missLimit: 0
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
    weapon: 'rifle', // rifle | sniper (AWP)
    botStrafe: true, // false = bots stand still on the arc
    botCrouchTap: true, // false = bots stay standing
    infiniteAmmo: true,
    coverEnabled: false,
    coverCount: 4,
    coverDistance: 4, // metres from player centre
    coverThickness: 1.2, // box depth (m)
    coverHeight: 3.0, // box height (m)
    missLimit: 0
  },
  tracking: {
    botWidth: 1.0, // uniform scale on bot body/head radius (0.5–2.0)
    botSpeed: 1.0, // multiplier on tracking strafe cap (210 u/s)
    botCrouchTap: true,
    strafeRate: 1.0, // direction-change frequency (1 = default ADAD)
    missLimit: 0
  },
  stars: {
    targetSize: 0.1,
    targetCount: 200,
    boundsScaleX: 2.0,
    boundsScaleY: 1.0,
    missLimit: 0
  },
  microflicks: {
    targetSize: 0.1,
    targetCount: 2,
    floatEnabled: false,
    floatSpeedMax: 2.0,
    boundsScaleX: 2.0,
    boundsScaleY: 1.0,
    missLimit: 0
  },
  sequence: {
    targetSize: 0.25,
    dotTime: 1500, // ms to shoot each chain dot before it despawns
    startDistance: 0.8, // m — first follow-up dot's distance from the kill
    distanceStep: 0.35, // m — added distance per kill in the chain
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  double: {
    targetSize: 0.25,
    canvasSize: 3.0, // m — square canvas edge
    canvasDistance: 4.0, // m — gap between neighbouring canvases
    canvasCount: 2,
    layout: 'flat', // flat = side by side on the wall | around = curved ring
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  doubletracking: {
    targetSize: 0.2, // 20% smaller than Double (Clicks)
    holdTime: 0.3,
    floatSpeed: 1.0,
    canvasSize: 3.0,
    canvasDistance: 4.0,
    canvasCount: 2,
    layout: 'flat',
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  sequencespeed: {
    startSize: 0.12,
    maxSize: 0.55,
    growTime: 1500, // ms until the dot pops
    startDistance: 0.8,
    distanceStep: 0.35,
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  sequencetracking: {
    targetSize: 0.2, // 20% smaller than Sequence (Clicks)
    holdTime: 0.3,
    floatSpeed: 1.0,
    dotTime: 1500,
    startDistance: 0.8,
    distanceStep: 0.35,
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  ball: {
    targetSize: 0.5,
    travelSpeed: 60, // deg/s — quicker than Bounce
    minDistance: 8,
    maxDistance: 16,
    bounceHeight: 2.5
  },
  bouncetracking: {
    targetSize: 0.225, // half of legacy Bounce (Tracking) size
    targetCount: 3, // fewer balls
    travelSpeed: 28, // slightly slower
    minDistance: 10,
    maxDistance: 16,
    bounceHeight: 2.2, // base height — actual bounces are 2–3× this
    holdTime: 0.5, // s of uninterrupted crosshair time before a ball is clickable
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  pasutracking: {
    targetSize: 0.33, // slightly smaller than Pasu
    targetCount: 3,
    enableTimeLimit: false,
    maxTargetAge: 1200,
    mode: 'tracking',
    trackTime: 0.5, // s on target before the shot is allowed
    trackResolve: 'click',
    travelSpeedMax: 2.0, // slower drift than Pasu
    boundsScaleX: 1.0,
    boundsScaleY: 1.0,
    angleOffset: 360,
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  turn: {
    targetSize: 0.15,
    dotTime: 2000, // ms before an unkilled dot despawns
    despawnOnMiss: true, // false = missed shots leave the dot alive
    infiniteAmmo: true,
    viewmodelRecoil: false,
    missLimit: 0
  },
  box: {
    targetSize: 0.3,
    sizeX: 7, // m — path width (the dot's centre travels this rectangle)
    sizeY: 4, // m — path height
    travelSpeed: 150, // u/s — each dot rolls speed ± variance (default 100–200)
    speedVariance: 50, // u/s
    infiniteAmmo: true,
    missLimit: 0
  },
  circle: {
    targetSize: 0.3,
    sizeX: 7, // m — ellipse width
    sizeY: 4, // m — ellipse height
    travelSpeed: 150,
    speedVariance: 50,
    infiniteAmmo: true,
    missLimit: 0
  },
  threeshot: {
    targetSize: 0.075,
    targetCount: 3,
    floatEnabled: false,
    floatSpeedMax: 2.0,
    boundsScaleX: 2.0,
    boundsScaleY: 2.0, // twice as tall as Stars
    missLimit: 0
  },
  cover: {
    rowCount: 3, // rows of cover, each further back + 200 u higher
    coverPerRow: 3,
    rowDistance: 16, // m — player to the first row
    rowSpacing: 10, // m — between rows
    botSpeed: 1.0, // multiplier on the bot's strafe speed
    reactMin: 25, // ms after FULL line-of-sight before the bot may shoot
    reactMax: 200,
    playerHp: 4, // hits you can take; resets on every kill
    botHp: 2, // body shots to drop a bot (head is always instant)
    missLimit: 0,
    spawnHint: true // highlight the next spawn box 0.5 s before the bot peeks
  },
  drone: {
    targetSize: 0.5,
    travelSpeed: 60, // deg/s — how fast YOU orbit the static target
    minDistance: 8,
    maxDistance: 16,
    bounceHeight: 2.5
  },
  line: {
    targetSize: 0.35,
    travelSpeed: 180, // u/s — horizontal travel along the 180° field
    missLimit: 0
  },
  sniperholds: {
    arena: 0,
    botDifficulty: 'hard',
    ttk: 0.5,
    botHp: 1,
    missLimit: 0
  },
  pitrifle: {
    rowCount: 3,
    coverPerRow: 8,
    rowDistance: 14,
    rowSpacing: 8,
    botSpeed: 1.0,
    reactMin: 25,
    reactMax: 200,
    playerHp: 4,
    botHp: 1,
    missLimit: 0,
    spawnHint: true
  },
  coverawp: {
    rowCount: 3,
    coverPerRow: 3,
    rowDistance: 16,
    rowSpacing: 10,
    botSpeed: 1.0,
    reactMin: 25,
    reactMax: 200,
    playerHp: 4,
    botHp: 1,
    missLimit: 0,
    spawnHint: true,
    losMissPenalty: true // visible miss: bot despawns, next peek scheduled
  },
  sniperquickscopes: {
    rowCount: 3, // rings around the pit
    coverPerRow: 8, // boxes per ring
    rowDistance: 14, // m — pit centre to the first ring
    rowSpacing: 8, // m — between rings
    botSpeed: 1.0,
    reactMin: 25, // ms after full line-of-sight before the bot may shoot
    reactMax: 200,
    playerHp: 4,
    botHp: 1,
    missLimit: 0,
    spawnHint: true,
    losMissPenalty: true
  },
  sniperflicks: {
    spawnScaleX: 1.0, // horizontal spawn radius multiplier
    spawnScaleY: 1.0, // vertical spawn radius multiplier
    botScale: 1.0, // bot size multiplier
    minDistance: 35, // m — bots spawn between far…
    maxDistance: 75, // …and very far away
    botsMove: false, // practice option: bots strafe horizontally
    missLimit: 0
  },
  snipertracking: {
    botWidth: 1.0,
    botSpeed: 1.0,
    botCrouchTap: true,
    holdTime: 0, // s of uninterrupted crosshair time before a shot may kill (0 = instant)
    respawnDelay: 1.0, // s after a kill before the next bot spawns
    minDistance: 10, // m — random-ish spawn distance range
    maxDistance: 16,
    missLimit: 0
  },
  doorsawp: {
    botSpeed: 1.0, // cross-speed multiplier
    crossFrom: 'rightToLeft', // rightToLeft | leftToRight — spawn flank + cross direction
    shotFeedback: true, // practice: red bot snapshot + yellow hit marker
    shotFeedbackDur: 0.5, // seconds both markers stay visible
    duration: { type: 'time', value: 60 },
    missLimit: 0
  }
};

// Per-mode run length. Absent by default — the global runDuration is the
// effective length until a mode sets an explicit override here. `time` ends on
// the clock (seconds); `kills` ends when the kill target is reached. Baked into
// mode config codes / playlist items so a shared playlist runs identically for
// everyone (independent of the runner's own global duration).
export const DURATION_DEFAULT = { type: 'time', value: 60 };

// Modes that expose a practice duration control (and ship in playlists).
export const DURATION_MODES = [
  'gridshot', 'stars', 'threeshot', 'bounce', 'microflicks', 'pasu', 'spidershot',
  'survival', 'arena', 'snipercrossfire', 'cover', 'duels', 'range', 'tracking', 'deathmatch',
  'sequence', 'sequencespeed', 'sequencetracking', 'double', 'doubletracking', 'ball', 'drone', 'line', 'bouncetracking', 'pasutracking', 'turn',
  'box', 'circle',
  'sniperholds', 'sniperquickscopes', 'pitrifle', 'coverawp', 'sniperflicks', 'snipertracking', 'doorsawp'
];

/** Resolve a usable duration ({ type, value }) from a scenario settings blob. */
export function resolveModeDuration(modeData, fallbackSeconds = 60) {
  const d = modeData?.duration;
  const value = Number(d?.value);
  if (d && (d.type === 'kills' || d.type === 'time') && Number.isFinite(value) && value > 0) {
    return { type: d.type, value };
  }
  return { type: 'time', value: Number(fallbackSeconds) || 60 };
}

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
    this._exploreMode = false;
    this._replayViewPatch = null;
    this._modeOverride = null;
  }

  _load() {
    const saved = Storage.read('settings', {});
    const merged = this._deepMerge(structuredClone(DEFAULTS), saved);
    this._normalizeSensitivity(merged);
    this._normalizeCrosshair(merged);
    return merged;
  }

  /** Migrate legacy crosshair.outline boolean → outlineThickness. */
  _normalizeCrosshair(data) {
    const xh = data.crosshair;
    if (!xh) return;
    if (xh.outlineThickness == null) {
      xh.outlineThickness = xh.outline ? 1 : 0;
    }
    delete xh.outline;
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
    const base = this.draft ?? this.data;
    if (!this._replayViewPatch) return base;
    return this._deepMerge(structuredClone(base), structuredClone(this._replayViewPatch));
  }

  openDraft() {
    if (this._exploreMode) this.closeExploreDraft();
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
    if (this._exploreMode) return;
    if (!this.draft) this.openDraft();
    this.recordUndo();
    fn(this.draft);
    this._emitDraft();
  }

  /** Read-only draft for browsing another user's settings (not persisted). */
  openExploreDraft(payload) {
    this.discardDraft();
    this.draft = this._deepMerge(structuredClone(DEFAULTS), structuredClone(payload || {}));
    this._normalizeSensitivity(this.draft);
    this._undoStack = [];
    this._exploreMode = true;
    this._emitDraft();
  }

  closeExploreDraft() {
    this._exploreMode = false;
    this.discardDraft();
  }

  get isExploreMode() {
    return this._exploreMode;
  }

  get isReplayView() {
    return !!this._replayViewPatch;
  }

  /** Temporarily overlay a recorded run's display settings while watching a replay. */
  beginReplayView(replaySettings) {
    this.endReplayView();
    const patch = this._replaySettingsPatch(replaySettings);
    if (!Object.keys(patch).length) return;
    this._replayViewPatch = patch;
    if (this.draft) this.discardDraft();
    this._emit();
  }

  /** Merge replay-file settings with optional shared-row metadata (file wins). */
  mergeReplaySettings(fromReplay, fromMeta) {
    const patch = {};
    Object.assign(patch, this._replaySettingsPatch(fromMeta));
    Object.assign(patch, this._replaySettingsPatch(fromReplay));
    return patch;
  }

  /** Drop replay overlay and restore the viewer's normal settings. */
  endReplayView() {
    if (!this._replayViewPatch) return;
    this._replayViewPatch = null;
    this._emit();
  }

  _replaySettingsPatch(rs) {
    if (!rs || typeof rs !== 'object') return {};
    const patch = {};
    if (rs.hFov != null) patch.hFov = rs.hFov;
    if (rs.resolution != null) patch.resolution = rs.resolution;
    if (rs.resolutionWidth != null) patch.resolutionWidth = rs.resolutionWidth;
    if (rs.resolutionHeight != null) patch.resolutionHeight = rs.resolutionHeight;
    if (rs.colors) patch.colors = structuredClone(rs.colors);
    if (rs.crosshair) patch.crosshair = structuredClone(rs.crosshair);
    if (rs.viewmodel) patch.viewmodel = structuredClone(rs.viewmodel);
    if (rs.weapon) {
      patch.weapon = structuredClone(this.data?.weapon || {});
      if (rs.weapon.aimpunch != null) patch.weapon.aimpunch = rs.weapon.aimpunch;
    }
    return patch;
  }

  commitDraftLive() {
    if (this._exploreMode || !this.draft) return;
    this.data = structuredClone(this.draft);
    this._emit();
  }

  confirmDraft() {
    if (this._exploreMode) return;
    if (!this.draft) return;
    this.data = structuredClone(this.draft);
    this.draft = null;
    this._undoStack = [];
    this.save();
  }

  undoDraft() {
    if (this._exploreMode) return false;
    if (!this._undoStack.length || !this.draft) return false;
    this.draft = this._undoStack.pop();
    this._emitDraft();
    return true;
  }

  resetDraft() {
    if (this._exploreMode) return;
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

  /** Snapshot one mode's config for a mode share code, with duration baked in. */
  getModeConfig(scenario) {
    const src = this.activeSettings() || {};
    const config = structuredClone(src[scenario] || {});
    config.duration = resolveModeDuration(config, src.runDuration);
    return { scenario, config };
  }

  /** Merge an imported mode config onto the editing draft for that scenario. */
  applyModeConfigToDraft(scenario, config) {
    this.mutateDraft((d) => {
      d[scenario] = this._deepMerge(d[scenario] || {}, structuredClone(config || {}));
    });
  }

  /**
   * Temporarily merge a mode config onto live data so a scenario constructed
   * right now reads the playlist's settings instead of the user's. Scenarios
   * cache their config at construction, so this only needs to span the load()
   * call — endModeOverride() restores the user's saved settings immediately
   * after. Never persisted (no save()), so localStorage is untouched.
   */
  beginModeOverride(scenario, config) {
    this.endModeOverride();
    this._modeOverride = { scenario, data: structuredClone(this.data[scenario]) };
    this.data[scenario] = this._deepMerge(
      structuredClone(this.data[scenario] || {}),
      structuredClone(config || {})
    );
  }

  endModeOverride() {
    if (!this._modeOverride) return;
    this.data[this._modeOverride.scenario] = this._modeOverride.data;
    this._modeOverride = null;
  }

  /** Resolved run length for a standalone practice run of this scenario. */
  durationForScenario(scenario) {
    return resolveModeDuration(this.data?.[scenario], this.data?.runDuration);
  }

  /** Replace local settings from an imported snapshot. */
  applyPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid settings data');
    }
    this.endReplayView();
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
