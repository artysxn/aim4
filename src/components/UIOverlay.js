// ---------------------------------------------------------------------------
// UIOverlay.js
// All HTML/CSS UI layered over the canvas: main menu, settings, leaderboards,
// in-run HUD, pause + results screens. Holds the screen state machine and coordinates pointer-lock with
// the run lifecycle. The core game loop never touches UI state.
//
// States: menu | settings | leaderboard | auth | await-start | countdown | playing | paused
//         | results
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { RESOLUTIONS, clampResolutionDim } from '../core/SettingsManager.js';
import { SCENARIOS } from '../core/SceneManager.js';
import * as Storage from '../utils/Storage.js';
import {
  fetchLeaderboardWithMeta,
  fetchEloLeaderboardWithMeta,
  fetchUserScoreHistory,
  submitScore
} from '../lib/cloudScores.js';
import {
  fetchAllAccountStats,
  formatModeStat,
  formatRankLabel
} from '../lib/accountStats.js';
import { countryOptionsHtml, flagEmoji } from '../lib/countries.js';
import { fetchPublicProfile, fetchPublicSettings } from '../lib/userProfile.js';
import { logAimRun, fetchAimComparison, fetchAimStats, fetchAimRuns, AIM_STAT_FILTERS, AIM_RATING_BEST_FILTERS } from '../lib/aimStats.js';
import { resetGamemodeStats } from '../lib/gamemodeStats.js';
import {
  parseGamemodePath,
  replaceGamemodePath,
  clearGamemodePath
} from '../lib/gamemodeRoutes.js';
import { incrementPlayTime, formatPlayTime } from '../lib/playTime.js';
import {
  fetchAimRatingLeaderboard,
  fetchAimRatingRank,
  lookupProfileByUsername,
  syncOverallAimRating
} from '../lib/aimRating.js';
import {
  RATING_CATEGORIES,
  RATING_LABELS,
  RATED_GAMEMODES,
  loadBaselines,
  syncBaselinesFromServer,
  baselinesForGamemode,
  calculateAim4Ratings,
  telemetryFromAimStats,
  telemetryFromRunAnalytics,
  averageRatingsAcrossModes,
  radarCategoriesForView,
  buildRatingBreakdown,
  composeRatingFromBestRuns,
  qualifiesForOverallAimRating,
  OVERALL_AIM_MIN_MODES
} from '../lib/aim4Ratings.js';
import { computeOverallAimRating } from '../lib/aimRating.js';
import { supabaseConfigured } from '../lib/supabase.js';
import { localDecode } from '../lib/replayCodec.js';
import { ReplayAnalytics } from '../lib/replayAnalytics.js';
import { REPLAY_SPEEDS } from '../core/ReplayPlayer.js';
import { saveReplay, listAccountReplays, loadReplayByPath, createSharedReplay, fetchSharedReplay, isSharedReplayId } from '../lib/replayStore.js';
import { copyText } from '../utils/ConfigCodes.js';
import {
  encodeModeConfig,
  decodeModeConfig
} from '../utils/ModeConfigCodes.js';
import {
  loadPlaylists,
  savePlaylist,
  deletePlaylist,
  createPlaylist,
  playlistConfigKey,
  combinePlaylistResults,
  encodePlaylist,
  decodePlaylist,
  isPlaylistCode,
  PLAYLIST_SCENARIO
} from '../lib/playlists.js';
import { resolveModeDuration } from '../core/SettingsManager.js';
import { MultiplayerController } from '../multiplayer/MultiplayerController.js';
import { SCORE_TARGETS, MM_SCORE_TARGET, TRACKING_DURATION } from '../multiplayer/constants.js';
import { getMap } from '../multiplayer/maps.js';
import { formatServerRegion } from '../multiplayer/regionLabels.js';
import { SCENARIO_ICONS, MATCHMAKING_ICON, TRAINING_ICON, PLAYLISTS_ICON as PLAYLISTS_TILE_ICON, CUSTOM_GAMES_ICON, MULTIPLAYER_ICON, LEADERBOARD_ICON, ACCOUNT_ICON, LOGOUT_ICON, SETTINGS_ICON, PRECISION_ICON, ALL_MODES_ICON, SNIPING_ICON } from '../aim4/icons.js';
import { ARENAS } from '../scenarios/DuelsScenario.js';
import { duelsArenaSelectOptions } from '../scenarios/duelsArenas.js';
import { isKillLeaderboardScenario } from '../scenarios/leaderboardConfig.js';

const SCENARIO_META = {
  gridshot: { title: 'Gridshot', dualPlay: true, tags: ['Speed', 'Accuracy'] },
  stars: { title: 'Stars', dualPlay: true, tags: ['Accuracy'] },
  bounce: { title: 'Bounce (Clicks)', dualPlay: true, tags: ['Speed', 'Reactions'] },
  microflicks: { title: 'Microflicks', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  pasu: { title: 'Pasu (Clicks)', dualPlay: true, tags: ['Accuracy', 'Reactions', 'Control'] },
  spidershot: { title: 'Spidershot', dualPlay: true, tags: ['Speed', 'Reactions'] },
  survival: { title: 'Survival', dualPlay: true, tags: ['Speed', 'Control'] },
  arena: { title: 'Crossfire (Clicks)', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  snipercrossfire: { title: 'Crossfire (AWP)', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  duels: { title: 'Duels', dualPlay: true, tags: ['Movement', 'Reactions'] },
  range: { title: 'Range', dualPlay: true, tags: ['Movement'] },
  tracking: { title: 'Strafes', dualPlay: true, tags: ['Accuracy'] },
  deathmatch: { title: 'Deathmatch', dualPlay: true, tags: ['Movement', 'Speed', 'Control'] },
  sequence: { title: 'Sequence (Clicks)', dualPlay: true, tags: ['Speed', 'Accuracy', 'Reactions'] },
  sequencespeed: { title: 'Sequence (Speed)', dualPlay: true, tags: ['Accuracy', 'Speed'] },
  sequencetracking: { title: 'Sequence (Tracking)', dualPlay: true, tags: ['Control', 'Speed'] },
  double: { title: 'Double (Clicks)', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  doubletracking: { title: 'Double (Tracking)', dualPlay: true, tags: ['Control', 'Speed'] },
  ball: { title: 'Ball', dualPlay: true, tags: ['Accuracy', 'Control'] },
  bouncetracking: { title: 'Bounce (Tracking)', dualPlay: true, tags: ['Control', 'Reactions'] },
  pasutracking: { title: 'Pasu (Tracking)', dualPlay: true, tags: ['Accuracy', 'Control'] },
  turn: { title: 'Turn', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  box: { title: 'Box', dualPlay: true, tags: ['Accuracy', 'Control'] },
  circle: { title: 'Circle', dualPlay: true, tags: ['Accuracy', 'Control'] },
  threeshot: { title: 'Threeshot', dualPlay: true, tags: ['Speed', 'Accuracy'] },
  cover: { title: 'Cover (Rifle)', dualPlay: true, tags: ['Reactions', 'Accuracy'] },
  coverawp: { title: 'Cover (AWP)', dualPlay: true, tags: ['Reactions', 'Accuracy'] },
  drone: { title: 'Drone', dualPlay: true, tags: ['Accuracy', 'Control'] },
  line: { title: 'Line', dualPlay: true, tags: ['Control', 'Speed'] },
  galaxy: { title: 'Galaxy', dualPlay: false, challenge: true, tags: ['Control', 'Speed', 'Accuracy'] },
  waves: { title: 'Waves', dualPlay: false, challenge: true, tags: ['Control', 'Speed', 'Accuracy'] },
  sequenceultra: { title: 'Sequence (Ultra)', dualPlay: false, challenge: true, tags: ['Control', 'Reactions', 'Accuracy'] },
  reactiontime: { title: 'Reaction time', dualPlay: false, challenge: true, tags: ['Speed', 'Reactions'] },
  sniperholds: { title: 'Duels (AWP)', dualPlay: true, tags: ['Accuracy', 'Control'] },
  sniperquickscopes: { title: 'Pit (AWP)', dualPlay: true, tags: ['Reactions', 'Control'] },
  pitrifle: { title: 'Pit (Rifle)', dualPlay: true, tags: ['Reactions', 'Control'] },
  sniperflicks: { title: 'Flicks (AWP)', dualPlay: true, tags: ['Reactions', 'Accuracy'] },
  snipertracking: { title: 'Tracking (AWP)', dualPlay: true, tags: ['Control'] },
  doorsawp: { title: 'Doors (AWP)', dualPlay: true, tags: ['Speed', 'Reactions'] }
};

/** Scenarios with practice-only tuning (gear on training card). */
const SCENARIO_SETTING_IDS = new Set([
  'gridshot',
  'stars',
  'bounce',
  'microflicks',
  'pasu',
  'spidershot',
  'survival',
  'arena',
  'snipercrossfire',
  'duels',
  'deathmatch',
  'range',
  'tracking',
  'sequence',
  'sequencespeed',
  'sequencetracking',
  'double',
  'doubletracking',
  'ball',
  'bouncetracking',
  'pasutracking',
  'turn',
  'box',
  'circle',
  'threeshot',
  'cover',
  'coverawp',
  'drone',
  'line',
  'sniperholds',
  'sniperquickscopes',
  'pitrifle',
  'sniperflicks',
  'snipertracking',
  'doorsawp'
]);

// Training sub-menus. A mode may appear in several categories; any registered
// non-challenge mode not placed anywhere is appended to General so nothing
// goes missing. "all" browses every non-challenge mode; "challenges" houses
// the hard fixed-rule variants and only ever shows those.
const TRAINING_CATEGORIES = [
  { id: 'precision', title: 'Precision', modes: ['microflicks', 'stars', 'threeshot', 'survival', 'pasu', 'arena', 'snipercrossfire', 'turn', 'sequencespeed', 'sequencetracking', 'sniperholds'] },
  { id: 'tracking', title: 'Tracking', modes: ['tracking', 'ball', 'drone', 'line', 'box', 'circle', 'bouncetracking', 'pasutracking', 'doubletracking', 'sequencetracking', 'snipertracking'] },
  { id: 'speed', title: 'Speed', modes: ['gridshot', 'stars', 'threeshot', 'bounce', 'spidershot', 'sequence', 'sequencespeed', 'line', 'sniperquickscopes', 'pitrifle', 'doorsawp'] },
  { id: 'flicking', title: 'Flicking', modes: ['spidershot', 'microflicks', 'sequence', 'sequencespeed', 'double', 'doubletracking', 'cover', 'coverawp', 'sniperflicks', 'snipercrossfire'] },
  { id: 'sniping', title: 'Sniping', modes: ['sniperquickscopes', 'coverawp', 'sniperholds', 'sniperflicks', 'snipertracking', 'snipercrossfire', 'doorsawp'] },
  { id: 'general', title: 'General', modes: ['deathmatch', 'range', 'duels', 'cover', 'coverawp', 'sniperholds', 'sniperquickscopes', 'pitrifle', 'sniperflicks', 'snipertracking', 'snipercrossfire', 'doorsawp'] },
  { id: 'challenges', title: 'Challenges', modes: ['galaxy', 'sequenceultra', 'waves', 'reactiontime'] },
  { id: 'all', title: 'All', modes: [] }
];

/** Navigation screens that show the footer credit below the menu panel. */
const MENU_CREDIT_SCREENS = new Set([
  'menu',
  'multiplayer',
  'singleplayer',
  'training-categories',
  'training',
  'playlists',
  'playlist-edit',
  'settings',
  'scenario-settings',
  'auth',
  'account',
  'leaderboard',
  'mp',
  'mp-lobby',
  'mp-results',
  'results',
  'playlist-results'
]);

const isChallengeMode = (m) => !!SCENARIO_META[m]?.challenge;

function scenarioTitle(id) {
  return (SCENARIO_META[id]?.title || id).toLowerCase();
}

function sortModesByTitle(modes) {
  return [...modes].sort((a, b) => scenarioTitle(a).localeCompare(scenarioTitle(b)));
}

function scenarioOptionsHtml(filter = () => true) {
  return sortModesByTitle(Object.keys(SCENARIOS).filter(filter))
    .map((k) => `<option value="${k}">${SCENARIO_META[k].title}</option>`)
    .join('');
}

function trainingCategoryModes(id) {
  const cat = TRAINING_CATEGORIES.find((c) => c.id === id);
  if (!cat) return [];
  if (id === 'all') {
    return sortModesByTitle(Object.keys(SCENARIOS).filter((m) => !isChallengeMode(m)));
  }
  if (id !== 'general') {
    return sortModesByTitle(cat.modes.filter((m) => SCENARIOS[m]));
  }
  const placed = new Set(TRAINING_CATEGORIES.flatMap((c) => c.modes));
  const strays = Object.keys(SCENARIOS).filter((m) => !placed.has(m) && !isChallengeMode(m));
  return sortModesByTitle([...cat.modes.filter((m) => SCENARIOS[m]), ...strays]);
}

function modeCountLabel(n) {
  return `${n} mode${n === 1 ? '' : 's'}`;
}

const GEAR_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66z"/></svg>`;

const PLAYLIST_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v6l5-3z"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>`;
const PENCIL_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>`;

/** Slider paired with a number box; stored value is not clamped to the slider range. */
function rf(id, label, min, max, step) {
  return `
    <div class="field">
      <div class="field-top">
        <span class="field-label">${label}</span>
        <input type="number" id="${id}-num" class="field-num" step="${step}" />
      </div>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" />
    </div>`;
}

function botDifficultyField(id) {
  return `
    <div class="field field-plain">
      <div class="field-top"><span class="field-label">Bot difficulty</span></div>
      <select id="${id}">
        <option value="hard">Hard</option>
        <option value="medium">Medium</option>
        <option value="easy">Easy</option>
      </select>
    </div>`;
}

function numField(id, label, step) {
  return `
    <div class="field field-plain">
      <div class="field-top">
        <span class="field-label">${label}</span>
        <input type="number" id="${id}" class="field-num" step="${step}" />
      </div>
    </div>`;
}

function colorRow(id, label) {
  return `
    <div class="color-row">
      <span>${label}</span>
      <input type="color" id="${id}" />
    </div>`;
}

function settingsTab(id, label, active) {
  return `<button type="button" class="settings-tab${active ? ' active' : ''}" data-settings-cat="${id}">${label}</button>`;
}

function settingsPanel(id, body, active) {
  return `<div class="settings-panel${active ? ' active' : ''}" data-settings-cat="${id}">${body}</div>`;
}

function scenarioSettingsPanel(id, body) {
  return `<div class="scenario-settings-panel" data-scenario-settings-panel="${id}">${body}</div>`;
}

export class UIOverlay {
  constructor({ engine, input, settings, crosshair, sceneManager, auth, replayRecorder, replayPlayer }) {
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.auth = auth;
    this.crosshair = crosshair;
    this.sceneManager = sceneManager;
    this.replayRecorder = replayRecorder;
    this.replayPlayer = replayPlayer;
    this.replaying = false; // engine loop checks this to drive playback
    this._lastReplay = null; // decoded view of the run that just finished
    this._replayReturn = 'menu'; // screen to restore when leaving playback
    this._replayShareCtx = null; // { sourcePath, userId, username, shareMeta }
    this._lastReplayShare = null;
    this._analysisLabels = [];

    this.root = document.getElementById('ui-root');
    this.state = 'menu';
    this.currentScenario = 'gridshot';
    this.scenarioConfig = {};
    this._authMode = 'login';
    this._lbCache = {};
    this._returnAfterSettings = null;
    this._returnAfterAccount = 'menu';
    this._viewingAccount = null; // null = own account; else { userId, username, countryCode, elo }
    this._settingsExploreMode = false;
    this._settingsExplorePayload = null;
    this._settingsExploreUser = null;
    this._returnAfterScenarioSettings = null;
    this._scenarioSettingsLive = false;
    this._returnAfterLeaderboard = 'menu';
    this._activeScenarioSettings = null;
    this._suppressLockPause = false;
    this._mpTabStats = {};
    this._mpTabBoardHeld = false;
    this._aimHintShown = false;
    this._unlockSince = null;
    this._countdownRemaining = 0;
    this._menuTipDismissed = false;
    // Active playlist run: { playlist, index, results: [] } | null
    this._playlistRun = null;
    // Items being assembled in the playlist editor: [{ scenario, config }]
    this._playlistDraft = [];
    // Editor target: null = closed, { id: null } = new, { id, createdAt } = editing
    this._playlistEdit = null;
    // Index of the playlist item whose settings are open in the mode panel.
    this._playlistItemEditing = null;
    this._lastPlaylist = null; // most recent playlist run, for "Play again"
  }

  init() {
    this.root.innerHTML = this._template();
    this._cache();
    this._bind();
    this._bindAuth();
    this.auth?.onChange(() => this.refreshAccountBar());
    this._populateSettings();
    const hasReplayLink = !!new URLSearchParams(window.location.search).get('replay');
    const pathRoute = !hasReplayLink ? parseGamemodePath() : null;
    if (!pathRoute) this.showScreen('menu');
    this.refreshAccountBar();

    this.mp = new MultiplayerController({
      ui: this,
      engine: this.engine,
      input: this.input,
      settings: this.settings,
      sceneManager: this.sceneManager,
      crosshair: this.crosshair
    });
    this._bindMultiplayer();
    this._bindMatchmaking();
    this._bindMpChat();
    this._bindMpTabScoreboard();

    this.mp.net.onNetStats = () => this._refreshMpNetStats();
    setInterval(() => this._refreshMpNetStats(), 500);

    this.input.onLockChange = (locked) => this._onLockChange(locked);
    this.input.onUnlockedClick = () => this._onUnlockedClick();
    this.sceneManager.onFinish = (results) => this._onFinish(results);
    this._bindReplay();
    this._bindResultsInfographics();
    this._bindAimStats();
    this._menuTipDismissed = !!Storage.read('menuTipDismissed', false);
    this._bindFullscreenTip();
    this._updateFullscreenTip();
    this.settings.onDraftChange(() => {
      if (this._scenarioSettingsLive) this._applyScenarioSettingsLive();
    });

    // Shared link: ?lobby=CODE opens multiplayer and auto-joins if there's space.
    if (this.mp.urlLobbyCode()) {
      const name = this._mpName ? this._mpName() : this._defaultName();
      this.mp.autoJoinFromUrl(name);
    }
    this._maybeOpenReplayFromUrl();
    this._bindGamemodeRoutes();
    if (pathRoute && !this.mp.urlLobbyCode() && !hasReplayLink) {
      this.play(pathRoute.scenario, { variant: pathRoute.variant });
    }
  }

  /** Path deep links: /survival, /gridshot/competitive, etc. */
  _bindGamemodeRoutes() {
    this._routeFromPopstate = false;
    window.addEventListener('popstate', () => {
      if (this.mp?.urlLobbyCode?.()) return;
      if (new URLSearchParams(window.location.search).get('replay')) return;
      const route = parseGamemodePath();
      if (route) {
        if (this.currentScenario !== route.scenario || this.scenarioConfig?.variant !== route.variant) {
          this._routeFromPopstate = true;
          this.play(route.scenario, { variant: route.variant });
          this._routeFromPopstate = false;
        }
        return;
      }
      if (this.state === 'playing' || this.state === 'await-start' || this.state === 'countdown' || this.state === 'paused') {
        this.quit();
      } else if (this.state !== 'replay') {
        this.showScreen('menu');
      }
    });
  }

  /**
   * Render a dismissable error banner so a runtime failure is visible without
   * opening DevTools. Called by the engine's guarded update loop.
   */
  showError(err) {
    let el = document.getElementById('error-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'error-banner';
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:9999;pointer-events:auto;' +
        'background:#7a1020;color:#fff;font:13px/1.4 "Host Grotesk",sans-serif;padding:10px 44px 10px 14px;' +
        'white-space:pre-wrap;word-break:break-word;box-shadow:0 4px 20px rgba(0,0,0,.5);';
      const close = document.createElement('button');
      close.textContent = 'X';
      close.style.cssText =
        'position:absolute;top:8px;right:10px;background:none;border:none;color:#fff;font-size:16px;cursor:pointer;';
      close.onclick = () => el.remove();
      this._errMsg = document.createElement('span');
      el.appendChild(this._errMsg);
      el.appendChild(close);
      this.root.appendChild(el);
    }
    const msg = (err && (err.stack || err.message)) || String(err);
    this._errMsg.textContent = 'Runtime error (game still rendering):\n' + msg;
  }

  _globalSettingsSections(resOptions) {
    return [
      {
        id: 'display',
        label: 'Game settings',
        body: `
          ${numField('set-sensitivity', 'Sensitivity', '0.001')}
          ${rf('set-fov', 'Horizontal FOV (°)', 60, 130, 1)}
          <div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Resolution</span>
            </div>
            <select id="set-res">${resOptions}<option value="custom">Custom</option></select>
          </div>
          <div id="set-res-custom" class="res-custom-row" hidden>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Width</span></div>
              <input type="number" id="set-res-w" class="config-code-input" min="320" max="7680" step="1" inputmode="numeric" />
            </div>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Height</span></div>
              <input type="number" id="set-res-h" class="config-code-input" min="320" max="7680" step="1" inputmode="numeric" />
            </div>
          </div>
          ${numField('set-dur', 'Run duration (s)', '1')}
          <label class="field-check"><input type="checkbox" id="set-raw" /> Raw input (no OS acceleration)</label>
          <label class="field-check"><input type="checkbox" id="set-copy-replay-config" /> Copy config when watching replays</label>
          ${colorRow('set-col-bg', 'Background')}
          ${colorRow('set-col-floor', 'Floor')}
          ${colorRow('set-col-ebody', 'Enemy body')}
          ${colorRow('set-col-ehead', 'Enemy head')}
          ${colorRow('set-col-cover', 'Cover / columns')}
          ${colorRow('set-col-target', 'Gridshot target')}
          <button type="button" class="btn btn-block" data-reset-colors>Reset colors</button>`
      },
      {
        id: 'crosshair',
        label: 'Crosshair',
        body: `
          <div class="xh-preview">
            <canvas id="xh-preview-canvas" width="216" height="216"></canvas>
          </div>
          <div class="color-row">
            <span>Color</span>
            <input type="color" id="set-xh-color" />
          </div>
          ${rf('set-xh-gap', 'Inner gap', 0, 30, 1)}
          ${rf('set-xh-len', 'Length', 0, 30, 1)}
          ${rf('set-xh-thick', 'Thickness', 1, 8, 1)}
            ${rf('set-xh-dot', 'Center dot (%)', 0, 100, 5)}
            <label class="field-check"><input type="checkbox" id="set-xh-hitmarker" /> Hitmarker</label>
            <label class="field-check"><input type="checkbox" id="set-xh-dyn" /> Dynamic gap (movement + spray bloom)</label>
            ${rf('set-xh-outline-thick', 'Outline thickness', 0, 4, 0.5)}
            <div class="color-row">
              <span>Outline color</span>
              <input type="color" id="set-xh-outline-color" />
            </div>
            ${rf('set-xh-outline-opacity', 'Outline opacity', 0, 100, 5)}`
      },
      {
        id: 'viewmodel',
        label: 'Viewmodel',
        body: `
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Hand</span></div>
            <select id="set-vm-hand">
              <option value="right">Right</option>
              <option value="left">Left</option>
            </select>
          </div>
          ${rf('set-vm-fov', 'Viewmodel FOV', 50, 90, 1)}
          ${rf('set-vm-ox', 'Offset X (right)', -0.5, 0.5, 0.01)}
          ${rf('set-vm-oy', 'Offset Y (up)', -0.5, 0.5, 0.01)}
          ${rf('set-vm-oz', 'Offset Z (forward)', 0.2, 1.0, 0.01)}
          <label class="field-check"><input type="checkbox" id="set-vm-bob" /> Weapon bob while moving</label>
          <label class="field-check"><input type="checkbox" id="set-vm-aimpunch" /> Aimpunch (view-punch recoil)</label>`
      },
      {
        id: 'sniperscope',
        label: 'Sniper scope',
        body: `
          ${rf('set-sniper-thick', 'Scope line thickness', 1, 8, 1)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Unscope bind 1</span></div>
            <button type="button" class="btn btn-block" id="set-sniper-bind1"></button>
          </div>
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Unscope bind 2</span></div>
            <button type="button" class="btn btn-block" id="set-sniper-bind2"></button>
          </div>
          <p class="muted">Right-click cycles the scope. Either bind unscopes instantly.</p>`
      },

    ];
  }

  _scenarioSettingsSections() {
    return [
      {
        id: 'gridshot',
        label: 'Gridshot',
        body: `
${rf('set-grid-size', 'Target size', 0.25, 1.2, 0.05)}
          ${rf('set-grid-count', 'Target count', 1, 6, 1)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Mode</span></div>
            <select id="set-grid-mode">
              <option value="clicking">Clicking</option>
              <option value="tracking">Tracking</option>
            </select>
          </div>
          ${rf('set-grid-track-time', 'Track time (s)', 0.1, 2.0, 0.05)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Tracking resolve</span></div>
            <select id="set-grid-track-resolve">
              <option value="click">Click when ready</option>
              <option value="auto">Auto hit</option>
            </select>
          </div>
          <label class="field-check"><input type="checkbox" id="set-grid-float" /> Horizontal drift</label>
          ${rf('set-grid-float-speed', 'Max drift speed (m/s)', 0.5, 8, 0.5)}
          ${rf('set-grid-bounds-y', 'Vertical spawn scale', 0.25, 2, 0.05)}
          ${rf('set-grid-bounds-x', 'Horizontal spawn scale', 0.25, 2, 0.05)}
          <label class="field-check"><input type="checkbox" id="set-grid-tl" /> Per-target time limit</label>
          ${rf('set-grid-age', 'Max target age (ms)', 400, 3000, 100)}
          <label class="field-check"><input type="checkbox" id="set-grid-infinite-ammo" /> Infinite ammo</label>
          <label class="field-check"><input type="checkbox" id="set-grid-vm-recoil" /> Viewmodel recoil</label>
          ${rf('set-grid-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'stars',
        label: 'Stars',
        body: `
${rf('set-stars-size', 'Dot size', 0.05, 0.5, 0.01)}
          ${rf('set-stars-count', 'Dot count', 1, 400, 1)}
          ${rf('set-stars-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'bounce',
        label: 'Bounce',
        body: `
${rf('set-bounce-size', 'Ball size', 0.15, 0.9, 0.05)}
          ${rf('set-bounce-count', 'Ball count', 1, 8, 1)}
          ${rf('set-bounce-speed', 'Travel speed (°/s)', 10, 120, 5)}
          ${rf('set-bounce-min-dist', 'Min distance (m)', 3, 14, 0.5)}
          ${rf('set-bounce-max-dist', 'Max distance (m)', 4, 20, 0.5)}
          ${rf('set-bounce-strength', 'Bounce strength', 1, 15, 0.5)}
          <label class="field-check"><input type="checkbox" id="set-bounce-infinite-ammo" /> Infinite ammo</label>
          ${rf('set-bounce-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'microflicks',
        label: 'Microflicks',
        body: `
${rf('set-mf-size', 'Dot size', 0.05, 0.5, 0.01)}
          ${rf('set-mf-count', 'Dots at a time', 1, 8, 1)}
          <label class="field-check"><input type="checkbox" id="set-mf-float" /> Horizontal drift</label>
          ${rf('set-mf-float-speed', 'Max drift speed (m/s)', 0.5, 8, 0.5)}
          ${rf('set-mf-bounds-y', 'Vertical spawn scale', 0.25, 2, 0.05)}
          ${rf('set-mf-bounds-x', 'Horizontal spawn scale', 0.25, 4, 0.05)}
          ${rf('set-mf-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'pasu',
        label: 'Pasu',
        body: `
${rf('set-pasu-size', 'Target size', 0.15, 0.9, 0.05)}
          ${rf('set-pasu-count', 'Target count', 1, 6, 1)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Mode</span></div>
            <select id="set-pasu-mode">
              <option value="clicking">Clicking</option>
              <option value="tracking">Tracking</option>
            </select>
          </div>
          ${rf('set-pasu-track-time', 'Track time (s)', 0.1, 2.0, 0.05)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Tracking resolve</span></div>
            <select id="set-pasu-track-resolve">
              <option value="click">Click when ready</option>
              <option value="auto">Auto hit</option>
            </select>
          </div>
          ${rf('set-pasu-travel-speed', 'Max travel speed (m/s)', 0.5, 8, 0.5)}
          ${rf('set-pasu-bounds-y', 'Vertical spawn scale', 0.25, 2, 0.05)}
          ${rf('set-pasu-bounds-x', 'Horizontal spawn scale', 0.25, 2, 0.05)}
          ${rf('set-pasu-angle', 'Angle offset (°)', 15, 360, 15)}
          <label class="field-check"><input type="checkbox" id="set-pasu-tl" /> Per-target time limit</label>
          ${rf('set-pasu-age', 'Max target age (ms)', 400, 3000, 100)}
          <label class="field-check"><input type="checkbox" id="set-pasu-infinite-ammo" /> Infinite ammo</label>
          ${rf('set-pasu-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'spidershot',
        label: 'Spidershot',
        body: `
${rf('set-spider-size', 'Target size', 0.25, 0.9, 0.05)}
          ${rf('set-spider-ttk', 'Time to kill (ms)', 400, 4000, 50)}
          ${rf('set-spider-max-dist', 'Max distance (m)', 2, 12, 0.5)}
          ${rf('set-spider-min-dist', 'Min distance (m)', 0.5, 6, 0.25)}
          ${rf('set-spider-height', 'Height spread', 0.25, 2, 0.05)}
          ${rf('set-spider-angle', 'Angle spread (°)', 0, 45, 1)}
          ${rf('set-spider-streak', 'Streak chance (% per cycle)', 0, 100, 5)}
          ${rf('set-spider-streak-min', 'Streak extra waves (min)', 1, 6, 1)}
          ${rf('set-spider-streak-max', 'Streak extra waves (max)', 1, 8, 1)}
          ${rf('set-spider-double', 'Double spawn chance (% per cycle)', 0, 100, 5)}
          <label class="field-check"><input type="checkbox" id="set-spider-drift" /> Horizontal drift</label>
          ${rf('set-spider-drift-speed', 'Max drift speed (m/s)', 0.25, 4, 0.25)}
          <label class="field-check"><input type="checkbox" id="set-spider-random-size" /> Random target size</label>
          ${rf('set-spider-size-min', 'Random size min', 0.2, 0.8, 0.05)}
          ${rf('set-spider-size-max', 'Random size max', 0.2, 1.0, 0.05)}
          <label class="field-check"><input type="checkbox" id="set-spider-infinite-ammo" /> Infinite ammo</label>
          <label class="field-check"><input type="checkbox" id="set-spider-vm-recoil" /> Viewmodel recoil</label>
          <label class="field-check"><input type="checkbox" id="set-spider-decoys" /> Decoy dots</label>
          ${rf('set-spider-decoy-chance', 'Decoy chance (% per extra dot)', 0, 100, 5)}
          ${rf('set-spider-decoy-min', 'Decoy count (min)', 0, 6, 1)}
          ${rf('set-spider-decoy-max', 'Decoy count (max)', 0, 8, 1)}
          ${rf('set-spider-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'survival',
        label: 'Survival',
        body: `
${rf('set-surv-spawn', 'Spawn interval (ms)', 300, 3000, 50)}
          ${rf('set-surv-despawn', 'Despawn time (ms)', 500, 5000, 50)}
          ${rf('set-surv-max-size', 'Max target size', 0.25, 1.0, 0.05)}
          ${rf('set-surv-strikes', 'Misses allowed (Practice)', 0, 10, 1)}`
      },
      {
        id: 'arena',
        label: 'Crossfire (Clicks)',
        body: `
${rf('set-arena-botdist-min', 'Bot distance min (m)', 0, 5, 0.1)}
          ${rf('set-arena-botdist-max', 'Bot distance max (m)', 0, 5, 0.1)}
          ${rf('set-arena-col', 'Columns', 4, 10, 1)}
          ${rf('set-arena-colr', 'Column width (m)', 0.2, 1.2, 0.05)}
          ${rf('set-arena-ring', 'Ring distance (m)', 5, 16, 0.5)}
          ${rf('set-arena-enemy', 'Enemy size', 0.5, 2.0, 0.1)}
          ${rf('set-arena-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'snipercrossfire',
        label: 'Crossfire (AWP)',
        body: `
${rf('set-snxf-botdist-min', 'Bot distance min (m)', 0, 5, 0.1)}
          ${rf('set-snxf-botdist-max', 'Bot distance max (m)', 0, 5, 0.1)}
          ${rf('set-snxf-col', 'Columns', 4, 10, 1)}
          ${rf('set-snxf-colr', 'Column width (m)', 0.2, 1.2, 0.05)}
          ${rf('set-snxf-ring', 'Ring distance (m)', 5, 16, 0.5)}
          ${rf('set-snxf-enemy', 'Enemy size', 0.5, 2.0, 0.1)}
          ${rf('set-snxf-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'duels',
        label: 'Duels',
        body: `
${botDifficultyField('set-duels-bot-difficulty')}
<div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Arena</span>
            </div>
            <select id="set-duels-arena">
              ${duelsArenaSelectOptions(ARENAS)}
            </select>
          </div>
          ${rf('set-duels-ttk', 'Time to kill (s)', 0.2, 2.0, 0.1)}
          ${rf('set-duels-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'deathmatch',
        label: 'Deathmatch',
        body: `
${botDifficultyField('set-dm-bot-difficulty')}
${rf('set-dm-bots', 'Bots', 1, 6, 1)}
          ${rf('set-dm-speed', 'Bot speed', 0.25, 2.0, 0.05)}
          ${rf('set-dm-body', 'Bot body hit %', 5, 50, 1)}
          ${rf('set-dm-head', 'Bot head hit %', 1, 20, 1)}
          ${rf('set-dm-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'range',
        label: 'Range',
        body: `
<div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Weapon</span>
            </div>
            <select id="set-range-weapon" class="config-code-input">
              <option value="rifle">Rifle</option>
              <option value="sniper">AWP</option>
            </select>
          </div>
          <div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Arc</span>
            </div>
            <select id="set-range-arc">
              <option value="90">90°</option>
              <option value="180">180°</option>
              <option value="360">360°</option>
            </select>
          </div>
          ${rf('set-range-count', 'Enemies', 2, 8, 1)}
          ${rf('set-range-rad', 'Ring radius (m)', 7, 20, 1)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Bot movement</span></div>
            <select id="set-range-bot-move">
              <option value="strafe">Strafe</option>
              <option value="static">Static</option>
            </select>
          </div>
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Bot crouch</span></div>
            <select id="set-range-bot-crouch">
              <option value="tap">Tap crouch</option>
              <option value="off">Off</option>
            </select>
          </div>
          <label class="field-check"><input type="checkbox" id="set-range-infinite-ammo" /> Infinite ammo</label>
          <label class="field-check"><input type="checkbox" id="set-range-cover" /> Cover boxes</label>
          ${rf('set-range-cover-count', 'Cover amount', 1, 6, 1)}
          ${rf('set-range-cover-dist', 'Cover distance (m)', 2, 15, 0.5)}
          ${rf('set-range-cover-thick', 'Cover thickness (m)', 0.4, 3, 0.1)}
          ${rf('set-range-cover-height', 'Cover height (m)', 1, 6, 0.2)}
          ${rf('set-range-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'tracking',
        label: 'Strafes',
        body: `
${rf('set-tracking-width', 'Bot width', 0.5, 2.0, 0.05)}
          ${rf('set-tracking-speed', 'Bot speed', 0.25, 2.0, 0.05)}
          <label class="field-check"><input type="checkbox" id="set-tracking-crouch" /> Tap crouch</label>
          ${rf('set-tracking-strafe', 'Strafe rate', 0.25, 3.0, 0.05)}
          ${rf('set-tracking-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'sequence',
        label: 'Sequence (Clicks)',
        body: `
${rf('set-seq-size', 'Dot size', 0.1, 0.6, 0.05)}
          ${rf('set-seq-time', 'Time per dot (ms)', 500, 4000, 100)}
          ${rf('set-seq-start-dist', 'Chain start distance (m)', 0.3, 3, 0.1)}
          ${rf('set-seq-step', 'Distance step per kill (m)', 0.1, 1.5, 0.05)}
          <label class="field-check"><input type="checkbox" id="set-seq-infinite-ammo" /> Infinite ammo</label>`
      },
      {
        id: 'sequencespeed',
        label: 'Sequence (Speed)',
        body: `
${rf('set-ss-start-size', 'Start size', 0.05, 0.35, 0.01)}
          ${rf('set-ss-max-size', 'Max size', 0.2, 0.8, 0.05)}
          ${rf('set-ss-grow', 'Grow time (ms)', 500, 4000, 100)}
          ${rf('set-ss-start-dist', 'Chain start distance (m)', 0.3, 3, 0.1)}
          ${rf('set-ss-step', 'Distance step per kill (m)', 0.1, 1.5, 0.05)}
          <label class="field-check"><input type="checkbox" id="set-ss-infinite-ammo" /> Infinite ammo</label>`
      },
      {
        id: 'sequencetracking',
        label: 'Sequence (Tracking)',
        body: `
${rf('set-st-size', 'Dot size', 0.1, 0.6, 0.05)}
          ${rf('set-st-time', 'Time per dot (ms)', 500, 4000, 100)}
          ${rf('set-st-hold', 'Hold time (s)', 0.1, 2.0, 0.05)}
          ${rf('set-st-float', 'Float speed', 0.25, 3.0, 0.05)}
          ${rf('set-st-start-dist', 'Chain start distance (m)', 0.3, 3, 0.1)}
          ${rf('set-st-step', 'Distance step per kill (m)', 0.1, 1.5, 0.05)}
          <label class="field-check"><input type="checkbox" id="set-st-infinite-ammo" /> Infinite ammo</label>`
      },
      {
        id: 'double',
        label: 'Double (Clicks)',
        body: `
${rf('set-double-size', 'Dot size', 0.1, 0.6, 0.05)}
          ${rf('set-double-canvas', 'Canvas size (m)', 1.5, 6, 0.25)}
          ${rf('set-double-dist', 'Canvas distance (m)', 1, 12, 0.5)}
          ${rf('set-double-count', 'Canvas count', 2, 6, 1)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Layout</span></div>
            <select id="set-double-layout">
              <option value="flat">Flat on the wall</option>
              <option value="around">Around you</option>
            </select>
          </div>
          <label class="field-check"><input type="checkbox" id="set-double-infinite-ammo" /> Infinite ammo</label>
          ${rf('set-double-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'doubletracking',
        label: 'Double (Tracking)',
        body: `
${rf('set-dt-size', 'Dot size', 0.1, 0.6, 0.05)}
          ${rf('set-dt-hold', 'Hold time (s)', 0.1, 2.0, 0.05)}
          ${rf('set-dt-float', 'Float speed', 0.25, 3.0, 0.05)}
          ${rf('set-dt-canvas', 'Canvas size (m)', 1.5, 6, 0.25)}
          ${rf('set-dt-dist', 'Canvas distance (m)', 1, 12, 0.5)}
          ${rf('set-dt-count', 'Canvas count', 2, 6, 1)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Layout</span></div>
            <select id="set-dt-layout">
              <option value="flat">Flat on the wall</option>
              <option value="around">Around you</option>
            </select>
          </div>
          <label class="field-check"><input type="checkbox" id="set-dt-infinite-ammo" /> Infinite ammo</label>
          ${rf('set-dt-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'ball',
        label: 'Ball',
        body: `
${rf('set-ball-size', 'Ball size', 0.2, 1.0, 0.05)}
          ${rf('set-ball-speed', 'Travel speed (°/s)', 20, 140, 5)}
          ${rf('set-ball-min-dist', 'Min distance (m)', 4, 14, 0.5)}
          ${rf('set-ball-max-dist', 'Max distance (m)', 6, 22, 0.5)}
          ${rf('set-ball-height', 'Bounce height (m)', 0.5, 5, 0.1)}`
      },
      {
        id: 'bouncetracking',
        label: 'Bounce (Tracking)',
        body: `
${rf('set-bt-size', 'Ball size', 0.2, 1.0, 0.05)}
          ${rf('set-bt-count', 'Ball count', 1, 6, 1)}
          ${rf('set-bt-speed', 'Travel speed (°/s)', 10, 100, 5)}
          ${rf('set-bt-hold', 'Hold time (s)', 0.2, 2.0, 0.05)}
          ${rf('set-bt-height', 'Bounce height (m)', 0.5, 5, 0.1)}
          ${rf('set-bt-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'pasutracking',
        label: 'Pasu (Tracking)',
        body: `
${rf('set-pt-size', 'Target size', 0.15, 0.9, 0.05)}
          ${rf('set-pt-count', 'Target count', 1, 6, 1)}
          ${rf('set-pt-hold', 'Hold time (s)', 0.2, 2.0, 0.05)}
          ${rf('set-pt-travel-speed', 'Max travel speed (m/s)', 0.5, 8, 0.5)}
          ${rf('set-pt-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'turn',
        label: 'Turn',
        body: `
${rf('set-turn-size', 'Dot size', 0.05, 0.5, 0.01)}
          ${rf('set-turn-time', 'Dot lifetime (ms)', 800, 5000, 100)}
          <label class="field-check"><input type="checkbox" id="set-turn-despawn-miss" checked /> Despawn dot on miss</label>
          <label class="field-check"><input type="checkbox" id="set-turn-infinite-ammo" /> Infinite ammo</label>`
      },
      {
        id: 'box',
        label: 'Box',
        body: `
${rf('set-box-size', 'Dot size', 0.1, 0.8, 0.05)}
          ${rf('set-box-w', 'Box size X (m)', 2, 14, 0.5)}
          ${rf('set-box-h', 'Box size Y (m)', 1, 10, 0.5)}
          ${rf('set-box-speed', 'Speed (u/s)', 50, 400, 5)}
          ${rf('set-box-variance', 'Speed variance (± u/s)', 0, 150, 5)}
${rf('set-box-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'circle',
        label: 'Circle',
        body: `
${rf('set-circle-size', 'Dot size', 0.1, 0.8, 0.05)}
          ${rf('set-circle-w', 'Circle size X (m)', 2, 14, 0.5)}
          ${rf('set-circle-h', 'Circle size Y (m)', 1, 10, 0.5)}
          ${rf('set-circle-speed', 'Speed (u/s)', 50, 400, 5)}
          ${rf('set-circle-variance', 'Speed variance (± u/s)', 0, 150, 5)}
${rf('set-circle-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'threeshot',
        label: 'Threeshot',
        body: `
${rf('set-3s-size', 'Dot size', 0.05, 0.5, 0.005)}
          ${rf('set-3s-count', 'Dot count', 1, 10, 1)}
          <label class="field-check"><input type="checkbox" id="set-3s-float" /> Horizontal drift</label>
          ${rf('set-3s-float-speed', 'Max drift speed (m/s)', 0.5, 8, 0.5)}
          ${rf('set-3s-bounds-x', 'Horizontal spawn scale', 0.25, 4, 0.05)}
          ${rf('set-3s-bounds-y', 'Vertical spawn scale', 0.25, 4, 0.05)}
          ${rf('set-3s-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'cover',
        label: 'Cover (Rifle)',
        body: `
${rf('set-cover-rows', 'Rows', 1, 3, 1)}
          ${rf('set-cover-boxes', 'Cover per row', 1, 5, 1)}
          ${rf('set-cover-dist', 'Row distance (m)', 8, 28, 1)}
          ${rf('set-cover-spacing', 'Row spacing (m)', 6, 16, 1)}
          ${rf('set-cover-botspeed', 'Bot movement speed', 0.25, 2, 0.05)}
          ${rf('set-cover-react-min', 'Bot reaction min (ms)', 0, 500, 5)}
          ${rf('set-cover-react-max', 'Bot reaction max (ms)', 25, 1000, 5)}
          ${rf('set-cover-hp', 'Hits you can take', 1, 10, 1)}
          ${rf('set-cover-bothp', 'Bot body shots to kill', 1, 5, 1)}
          ${rf('set-cover-misslimit', 'Allowed misses (0 = unlimited)', 0, 50, 1)}
          <label class="field-check"><input type="checkbox" id="set-cover-spawn-hint" checked /> Highlight spawn box before peek</label>`
      },
      {
        id: 'coverawp',
        label: 'Cover (AWP)',
        body: `
${rf('set-cvawp-rows', 'Rows', 1, 3, 1)}
          ${rf('set-cvawp-boxes', 'Cover per row', 1, 5, 1)}
          ${rf('set-cvawp-dist', 'Row distance (m)', 8, 28, 1)}
          ${rf('set-cvawp-spacing', 'Row spacing (m)', 6, 16, 1)}
          ${rf('set-cvawp-botspeed', 'Bot movement speed', 0.25, 2, 0.05)}
          ${rf('set-cvawp-react-min', 'Bot reaction min (ms)', 0, 500, 5)}
          ${rf('set-cvawp-react-max', 'Bot reaction max (ms)', 25, 1000, 5)}
          ${rf('set-cvawp-hp', 'Hits you can take', 1, 10, 1)}
          ${rf('set-cvawp-misslimit', 'Allowed misses (0 = unlimited)', 0, 50, 1)}
          <label class="field-check"><input type="checkbox" id="set-cvawp-spawn-hint" checked /> Highlight spawn box before peek</label>`
      },
      {
        id: 'drone',
        label: 'Drone',
        body: `
${rf('set-drone-size', 'Target size', 0.2, 1.0, 0.05)}
          ${rf('set-drone-speed', 'Travel speed (°/s)', 20, 140, 5)}
          ${rf('set-drone-min-dist', 'Min distance (m)', 4, 14, 0.5)}
          ${rf('set-drone-max-dist', 'Max distance (m)', 6, 22, 0.5)}
          ${rf('set-drone-height', 'Bounce height (m)', 0.5, 10, 0.1)}`
      },
      {
        id: 'line',
        label: 'Line',
        body: `
${rf('set-line-size', 'Dot size', 0.1, 0.8, 0.05)}
          ${rf('set-line-speed', 'Travel speed (u/s)', 50, 400, 5)}
          ${rf('set-line-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'sniperholds',
        label: 'Duels (AWP)',
        body: `
${botDifficultyField('set-snholds-bot-difficulty')}
<div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Arena</span>
            </div>
            <select id="set-snholds-arena">
              ${duelsArenaSelectOptions(ARENAS)}
            </select>
          </div>
          ${rf('set-snholds-ttk', 'Time to kill (s)', 0.2, 2.0, 0.1)}
          ${rf('set-snholds-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'sniperquickscopes',
        label: 'Pit (AWP)',
        body: `
${rf('set-snqs-rings', 'Rings', 1, 3, 1)}
          ${rf('set-snqs-boxes', 'Boxes per ring', 4, 12, 1)}
          ${rf('set-snqs-dist', 'First ring distance (m)', 8, 24, 1)}
          ${rf('set-snqs-spacing', 'Ring spacing (m)', 5, 14, 1)}
          ${rf('set-snqs-botspeed', 'Bot movement speed', 0.25, 2, 0.05)}
          ${rf('set-snqs-react-min', 'Bot reaction min (ms)', 0, 500, 5)}
          ${rf('set-snqs-react-max', 'Bot reaction max (ms)', 25, 1000, 5)}
          ${rf('set-snqs-hp', 'Hits you can take', 1, 10, 1)}
          ${rf('set-snqs-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}
          <label class="field-check"><input type="checkbox" id="set-snqs-spawn-hint" checked /> Highlight spawn box before peek</label>`
      },
      {
        id: 'pitrifle',
        label: 'Pit (Rifle)',
        body: `
${rf('set-pit-rings', 'Rings', 1, 3, 1)}
          ${rf('set-pit-boxes', 'Boxes per ring', 4, 12, 1)}
          ${rf('set-pit-dist', 'First ring distance (m)', 8, 24, 1)}
          ${rf('set-pit-spacing', 'Ring spacing (m)', 5, 14, 1)}
          ${rf('set-pit-botspeed', 'Bot movement speed', 0.25, 2, 0.05)}
          ${rf('set-pit-react-min', 'Bot reaction min (ms)', 0, 500, 5)}
          ${rf('set-pit-react-max', 'Bot reaction max (ms)', 25, 1000, 5)}
          ${rf('set-pit-hp', 'Hits you can take', 1, 10, 1)}
          ${rf('set-pit-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}
          <label class="field-check"><input type="checkbox" id="set-pit-spawn-hint" checked /> Highlight spawn box before peek</label>`
      },
      {
        id: 'sniperflicks',
        label: 'Flicks (AWP)',
        body: `
${rf('set-snfl-radius-x', 'Horizontal spawn scale', 0.25, 2, 0.05)}
          ${rf('set-snfl-radius-y', 'Vertical spawn scale', 0.25, 2, 0.05)}
          ${rf('set-snfl-size', 'Bot size', 0.5, 2.0, 0.05)}
          ${rf('set-snfl-min-dist', 'Min distance (m)', 20, 70, 1)}
          ${rf('set-snfl-max-dist', 'Max distance (m)', 30, 120, 1)}
          <label class="field-check"><input type="checkbox" id="set-snfl-move" /> Bots strafe horizontally</label>
          ${rf('set-snfl-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'snipertracking',
        label: 'Tracking (AWP)',
        body: `
${rf('set-sntr-width', 'Bot size', 0.5, 2.0, 0.05)}
          ${rf('set-sntr-speed', 'Bot speed', 0.25, 2.0, 0.05)}
          ${rf('set-sntr-hold', 'Hold time before shot (s)', 0, 2.0, 0.05)}
          ${rf('set-sntr-respawn', 'Respawn delay (s)', 0.25, 3.0, 0.25)}
          ${rf('set-sntr-min-dist', 'Min distance (m)', 6, 20, 1)}
          ${rf('set-sntr-max-dist', 'Max distance (m)', 8, 30, 1)}
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Bot crouch</span></div>
            <select id="set-sntr-bot-crouch">
              <option value="tap">Tap crouch</option>
              <option value="off">Off</option>
            </select>
          </div>
          ${rf('set-sntr-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      },
      {
        id: 'doorsawp',
        label: 'Doors (AWP)',
        body: `
<div class="field field-plain">
            <div class="field-top"><span class="field-label">Cross direction</span></div>
            <select id="set-doors-cross" class="config-code-input">
              <option value="rightToLeft">Right → left</option>
              <option value="leftToRight">Left → right</option>
            </select>
          </div>
          ${rf('set-doors-speed', 'Bot cross speed', 0.5, 2.0, 0.05)}
          <label class="field-check"><input type="checkbox" id="set-doors-feedback" /> Shot feedback (practice)</label>
          ${rf('set-doors-feedback-dur', 'Feedback duration (s)', 0.2, 2.0, 0.1)}
          ${rf('set-doors-misslimit', 'Miss limit (0 = unlimited)', 0, 50, 1)}`
      }
    ];
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------
  _template() {
    const resOptions = Object.entries(RESOLUTIONS)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join('');
    const globalSettingsSections = this._globalSettingsSections(resOptions);
    const scenarioSettingsSections = this._scenarioSettingsSections();

    return `
    <!-- MATCHMAKING QUEUE CHIP (visible while queued + in SP/menu) -->
    <div id="mm-queue-chip" class="mm-queue-chip" hidden>
      <span id="mm-queue-text">Finding ranked match…</span>
      <button type="button" class="btn btn-sm" id="mm-queue-cancel">Leave queue</button>
    </div>

    <!-- HUD -->
    <div id="hud" class="hud">
      <div class="hud-row">
        <div class="chip"><span class="chip-label">TIME</span><span id="hud-time" class="chip-val">60.0</span></div>
        <div class="chip big"><span class="chip-label">SCORE</span><span id="hud-score" class="chip-val">0</span></div>
        <div class="chip"><span class="chip-label">ACC</span><span id="hud-acc" class="chip-val">100%</span></div>
        <div class="chip"><span class="chip-label">KPS</span><span id="hud-kps" class="chip-val">0.0</span></div>
        <div class="chip"><span class="chip-label">HITS</span><span id="hud-hits" class="chip-val">0/0</span></div>
        <div class="chip" id="hud-crit-chip"><span class="chip-label">CRIT</span><span id="hud-crit" class="chip-val">0%</span></div>
      </div>
    </div>

    <!-- AMMO COUNTER (bottom-right, weapon scenarios) -->
    <div id="hud-ammo" class="hud-ammo">
      <span id="hud-ammo-mag" class="hud-ammo-mag">30</span>
      <span id="hud-ammo-sep">/</span>
      <span id="hud-ammo-size">30</span>
    </div>

    <!-- MULTIPLAYER LIVE SCOREBOARD -->
    <div id="mp-scoreboard" class="mp-scoreboard"></div>

    <!-- DEATHMATCH KILL FEED -->
    <div id="dm-killfeed" class="dm-killfeed"></div>

    <!-- MULTIPLAYER CHAT (Enter / Y to open · Tab to return to game) -->
    <div id="mp-chat" class="mp-chat">
      <div id="mp-chat-log" class="mp-chat-log"></div>
      <input id="mp-chat-input" type="text" class="mp-chat-input" maxlength="120" placeholder="" spellcheck="false" autocomplete="off" />
    </div>

    <!-- CLICK-TO-AIM PROMPT (multiplayer, when pointer lock is not held) -->
    <div id="mp-aim-hint" class="mp-aim-hint"><span>Click</span></div>

    <!-- COMPETITIVE START COUNTDOWN -->
    <div id="run-countdown" class="run-countdown" hidden><span id="run-countdown-num">1</span></div>

    <!-- HOLD-TAB SCOREBOARD -->
    <div id="mp-tab-scoreboard" class="mp-tab-scoreboard"></div>

    <!-- MAIN MENU -->
    <div class="screen menu" data-screen="menu">
      <div class="panel wide menu-panel menu-panel-main" id="menu-main-panel">
        <div class="menu-panel-body menu-panel-body-main">
        <h1 class="logo text-big">AIM4<span>.io</span></h1>
        <div class="menu-modes">
          <button type="button" class="mode-tile mode-tile-training" data-goto="singleplayer">
            <img src="${ACCOUNT_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Singleplayer</span>
          </button>
          <button type="button" class="mode-tile mode-tile-multiplayer" data-goto="multiplayer">
            <img src="${MULTIPLAYER_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Multiplayer</span>
          </button>
          <button type="button" class="mode-tile mode-tile-leaderboard" data-goto="leaderboard">
            <img src="${LEADERBOARD_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Leaderboards</span>
          </button>
        </div>
        <div class="menu-secondary">
          <button type="button" class="menu-icon-btn" data-goto="settings" aria-label="Settings">
            <img src="${SETTINGS_ICON}" alt="" width="22" height="22" aria-hidden="true" />
          </button>
          <div class="menu-auth" id="menu-auth">
            <div class="menu-auth-actions" id="menu-auth-guest">
              <button type="button" class="btn btn-sm" id="menu-login-btn">Log in</button>
              <button type="button" class="btn btn-sm primary" id="menu-signup-btn">Sign up</button>
            </div>
            <div class="menu-auth-actions hidden" id="menu-auth-user">
              <button type="button" class="menu-icon-btn" id="menu-account-btn" aria-label="My account">
                <img src="${ACCOUNT_ICON}" alt="" width="22" height="22" aria-hidden="true" />
              </button>
              <button type="button" class="menu-icon-btn" id="menu-logout-btn" aria-label="Log out">
                <img src="${LOGOUT_ICON}" alt="" width="22" height="22" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
          <div class="menu-fullscreen-tip-shell" id="menu-fullscreen-tip-shell">
            <section class="menu-fullscreen-tip" id="menu-fullscreen-tip" aria-label="Fullscreen recommendation">
              <button type="button" class="menu-fullscreen-tip-close" id="menu-fullscreen-tip-close" aria-label="Dismiss notice">&times;</button>
              <p class="menu-fullscreen-tip-title">Important:</p>
              <ol class="menu-fullscreen-tip-list">
                <li>Press <kbd>F11</kbd> to enter fullscreen. In a normal browser window, shortcuts like <kbd>Ctrl</kbd>+<kbd>W</kbd> can close the tab while you are playing.</li>
                <li>It is highly recommended to use Google Chrome. Different browsers handle mouse input in 3D environments differently. For example, using Firefox may cause issues with steadiness.</li>
                <li>For best performance, enable GPU acceleration in your browser.</li>
              </ol>
            </section>
          </div>
        </div>
      </div>
    </div>

    <!-- MULTIPLAYER (matchmaking + custom games) -->
    <div class="screen multiplayer" data-screen="multiplayer">
      <div class="panel wide menu-panel">
        <h2 class="text-big">Multiplayer</h2>
        <div class="menu-panel-body">
        <div class="menu-modes menu-modes-sub">
          <button type="button" class="mode-tile mode-tile-mm" id="menu-mm-tile">
            <img src="${MATCHMAKING_ICON}" alt="" class="mode-tile-icon mode-tile-icon-mm" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Matchmaking</span>
          </button>
          <button type="button" class="mode-tile mode-tile-custom" data-goto="mp">
            <img src="${CUSTOM_GAMES_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Custom games</span>
          </button>
        </div>
        </div>
        <div class="menu-actions">
          <button class="btn primary" data-goto="menu">Back</button>
        </div>
      </div>
    </div>

    <!-- SINGLEPLAYER (playlists + training hub) -->
    <div class="screen singleplayer" data-screen="singleplayer">
      <div class="panel wide menu-panel">
        <h2 class="text-big">Singleplayer</h2>
        <div class="menu-panel-body">
        <div class="menu-modes menu-modes-sub">
          <button type="button" class="mode-tile" data-goto="playlists">
            <img src="${PLAYLISTS_TILE_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Playlists</span>
          </button>
          <button type="button" class="mode-tile" data-goto="training-categories">
            <img src="${TRAINING_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Training</span>
            <span class="mode-tile-sub">${modeCountLabel(trainingCategoryModes('all').length)}</span>
          </button>
        </div>
        </div>
        <div class="menu-actions">
          <button class="btn primary" data-goto="menu">Back</button>
        </div>
      </div>
    </div>

    <!-- TRAINING CATEGORIES -->
    <div class="screen training-categories" data-screen="training-categories">
      <div class="panel wide menu-panel">
        <h2 class="text-big">Training</h2>
        <div class="menu-panel-body">
        <div class="menu-modes menu-modes-sub training-cat-tiles">
          ${TRAINING_CATEGORIES.map((cat) => {
            const modes = trainingCategoryModes(cat.id);
            const catIcons = {
              precision: PRECISION_ICON,
              tracking: SCENARIO_ICONS.tracking, // the previous Control-menu icon
              speed: SCENARIO_ICONS.gridshot,
              flicking: SCENARIO_ICONS.spidershot,
              sniping: SNIPING_ICON,
              general: SCENARIO_ICONS.range,
              challenges: SCENARIO_ICONS.waves,
              all: ALL_MODES_ICON
            };
            return `
          <button type="button" class="mode-tile" data-training-cat="${cat.id}">
            <img src="${catIcons[cat.id]}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">${cat.title}</span>
            <span class="mode-tile-sub">${modeCountLabel(modes.length)}</span>
          </button>`;
          }).join('')}
        </div>
        </div>
        <div class="menu-actions">
          <button class="btn primary" data-goto="singleplayer">Back</button>
        </div>
      </div>
    </div>

    <!-- TRAINING (mode list for the selected category) -->
    <div class="screen training" data-screen="training">
      <div class="panel wide menu-panel training-panel">
        <h2 class="text-big training-heading" id="training-heading">Training</h2>
        <div class="training-search-wrap hidden" id="training-search-wrap">
          <input type="search" id="training-search" class="config-code-input training-search-input" placeholder="Search by name or tag…" spellcheck="false" autocomplete="off" aria-label="Search gamemodes" />
        </div>
        <div class="menu-panel-body menu-panel-scroll training-list-wrap">
        <div class="training-list" id="training-list"></div>
        </div>
        <div class="menu-actions training-back">
          <button class="btn primary" data-goto="training-categories">Back</button>
        </div>
      </div>
    </div>

    <!-- PLAYLISTS (viewer: run / edit / share saved playlists) -->
    <div class="screen playlists" data-screen="playlists">
      <div class="panel wide menu-panel playlists-panel">
        <h2 class="text-big training-heading">Playlists</h2>
        <div class="menu-panel-body menu-panel-scroll playlists-scroll">
          <div id="playlists-list" class="playlists-list"></div>
          <p class="readout" id="playlist-status"></p>
          <div class="playlist-add-row playlist-import-row">
            <input type="text" id="playlist-import-code" class="config-code-input" placeholder="Import playlist code (AIM4P-…)" spellcheck="false" autocomplete="off" />
            <button type="button" class="btn" id="playlist-import-btn">Import</button>
          </div>
        </div>
        <div class="menu-actions">
          <button type="button" class="btn" id="playlist-new-btn">New playlist</button>
          <button type="button" class="btn primary" data-goto="singleplayer">Back</button>
        </div>
      </div>
    </div>

    <!-- PLAYLIST EDITOR (create a new playlist or edit an existing one) -->
    <div class="screen playlist-edit" data-screen="playlist-edit">
      <div class="panel wide menu-panel playlists-panel">
        <h2 class="text-big training-heading" id="playlist-edit-title">New playlist</h2>
        <div class="menu-panel-body menu-panel-scroll playlists-scroll">
          <section class="playlist-builder playlist-builder-edit">
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Name</span></div>
              <input type="text" id="playlist-name" class="config-code-input" maxlength="60" placeholder="Playlist name" spellcheck="false" autocomplete="off" />
            </div>
            <div class="playlist-add-row">
              <select id="playlist-add-mode" class="config-code-input">
                ${scenarioOptionsHtml((k) => !isChallengeMode(k))}
              </select>
              <button type="button" class="btn" id="playlist-add-current">Add mode</button>
            </div>
            <div class="playlist-add-row">
              <input type="text" id="playlist-add-code" class="config-code-input" placeholder="Paste mode code (AIM4M-…)" spellcheck="false" autocomplete="off" />
              <button type="button" class="btn" id="playlist-add-code-btn">Add code</button>
            </div>
            <div id="playlist-draft-items" class="playlist-draft-items"></div>
            <p class="readout" id="playlist-edit-status"></p>
          </section>
        </div>
        <div class="menu-actions">
          <button type="button" class="btn primary" id="playlist-save-btn">Save playlist</button>
          <button type="button" class="btn" id="playlist-edit-cancel">Cancel</button>
        </div>
      </div>
    </div>

    <!-- SETTINGS -->
    <div class="screen settings" data-screen="settings">
      <div class="settings-layout">
        <header class="settings-bar">
          <div class="settings-gear" aria-label="Settings">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66z"/>
            </svg>
          </div>
          <nav class="settings-nav">
            ${globalSettingsSections.map((s, i) => settingsTab(s.id, s.label, i === 0)).join('')}
          </nav>
          <div class="settings-bar-actions">
            <span class="settings-explore-banner muted" id="settings-explore-banner" hidden>Viewing <strong id="settings-explore-name"></strong>'s settings</span>
            <div class="settings-edit-actions" id="settings-edit-actions">
            <span class="settings-unsaved-hint muted" id="settings-unsaved-hint" hidden>Unsaved changes</span>
            <button type="button" class="btn" id="settings-undo-btn" disabled>Undo</button>
            <button class="btn" data-reset>Reset all</button>
            <button type="button" class="btn primary" id="settings-done-btn">Done</button>
            </div>
          </div>
        </header>
        <div class="settings-drawer">
          ${globalSettingsSections.map((s, i) => settingsPanel(s.id, s.body, i === 0)).join('')}
        </div>
      </div>
    </div>

    <!-- PER-MODE SETTINGS (gear on training cards) -->
    <div class="screen scenario-settings" data-screen="scenario-settings">
      <div class="panel wide menu-panel scenario-settings-layout">
        <header class="scenario-settings-bar">
          <h2 class="text-big scenario-settings-title" id="scenario-settings-title">Mode settings</h2>
        </header>
        <div class="scenario-settings-drawer menu-panel-body menu-panel-scroll">
          ${scenarioSettingsSections.map((s) => scenarioSettingsPanel(s.id, s.body)).join('')}
          <div class="scenario-settings-footer">
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Run ends on</span></div>
              <div class="playlist-add-row">
                <select id="scn-dur-type" class="config-code-input"></select>
                <input type="number" id="scn-dur-value" class="field-num scn-dur-value" min="1" step="1" />
                <span id="scn-dur-unit" class="scn-dur-unit muted">sec</span>
              </div>
            </div>
            <div class="config-code-block">
              <div class="field-top"><span class="field-label">Config code</span></div>
              <code class="config-export-code" id="scn-code-export">—</code>
              <div class="config-actions">
                <button type="button" class="btn" id="scn-code-copy">Copy code</button>
              </div>
              <div class="playlist-add-row">
                <input type="text" id="scn-code-import" class="config-code-input" placeholder="Paste AIM4M-… code" spellcheck="false" autocomplete="off" />
                <button type="button" class="btn" id="scn-code-import-btn">Import</button>
              </div>
              <p class="readout" id="scn-code-status"></p>
            </div>
          </div>
        </div>
        <div class="menu-actions scenario-settings-actions">
          <button type="button" class="btn" id="scenario-settings-undo-btn" disabled>Undo</button>
          <span class="scenario-settings-actions-spacer" aria-hidden="true"></span>
          <button type="button" class="btn btn-danger" id="scn-stats-reset-btn" hidden>Reset statistics</button>
          <button type="button" class="btn primary" id="scenario-settings-back-btn">Back</button>
        </div>
      </div>
    </div>

    <!-- AUTH -->
    <div class="screen auth" data-screen="auth">
      <div class="panel">
        <h2 class="text-big" id="auth-title">Sign in</h2>
        <div class="tabs auth-tabs" id="auth-tabs">
          <button type="button" class="tab active" data-auth-tab="login">Sign in</button>
          <button type="button" class="tab" data-auth-tab="register">Register</button>
        </div>
        <button type="button" class="btn btn-google btn-block" id="auth-google">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Continue with Google
        </button>
        <p class="auth-divider">or</p>
        <div class="field field-plain" id="auth-username-wrap">
          <div class="field-top"><span class="field-label">Username</span></div>
          <input type="text" id="auth-username" class="config-code-input" maxlength="20" spellcheck="false" autocomplete="username" />
        </div>
        <div class="field field-plain">
          <div class="field-top"><span class="field-label">Email</span></div>
          <input type="email" id="auth-email" class="config-code-input" maxlength="120" spellcheck="false" autocomplete="email" />
        </div>
        <div class="field field-plain">
          <div class="field-top"><span class="field-label">Password</span></div>
          <input type="password" id="auth-password" class="config-code-input" autocomplete="current-password" />
        </div>
        <div class="field field-plain" id="auth-confirm-wrap" hidden>
          <div class="field-top"><span class="field-label">Confirm password</span></div>
          <input type="password" id="auth-password2" class="config-code-input" autocomplete="new-password" />
        </div>
        <p class="readout" id="auth-status"></p>
        <div class="menu-actions">
          <button type="button" class="btn primary" id="auth-submit">Sign in</button>
          <button type="button" class="btn" data-goto="menu">Back</button>
        </div>
      </div>
    </div>

    <!-- ACCOUNT -->
    <div class="screen account" data-screen="account">
      <div class="panel wide menu-panel account-panel">
        <div class="menu-panel-body menu-panel-scroll">
        <section class="account-section" id="account-profile-own">
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Username</span></div>
            <div class="account-inline">
              <input type="text" id="account-username" class="config-code-input" maxlength="20" spellcheck="false" autocomplete="username" />
              <button type="button" class="btn btn-sm" id="account-username-save">Save</button>
            </div>
          </div>
          <div class="field field-plain">
            <div class="field-top"><span class="field-label">Country flag</span></div>
            <div class="account-inline">
              <select id="account-country" class="config-code-input"></select>
              <button type="button" class="btn btn-sm" id="account-country-save">Save</button>
            </div>
          </div>
          <div id="account-google-wrap" class="account-google-wrap">
            <button type="button" class="btn btn-google btn-block" id="account-link-google">
              Link Google account
            </button>
          </div>
          <p class="readout" id="account-profile-status"></p>
          <p class="readout muted" id="account-play-time"></p>
          <p class="readout account-aim-summary" id="account-aim-summary"></p>
        </section>

        <section class="account-section" id="account-profile-other" hidden>
          <p class="account-head-readonly">
            <span class="account-flag" id="account-ro-flag"></span>
            <span class="account-username" id="account-ro-username"></span>
          </p>
          <p class="readout muted" id="account-ro-elo"></p>
          <p class="readout muted" id="account-ro-play-time"></p>
          <p class="readout account-aim-summary" id="account-ro-aim-summary"></p>
          <p class="readout" id="account-profile-status-other"></p>
        </section>

        <section class="account-section" id="account-rating-section">
          <div class="account-aim-head">
            <h4>Aim4 Rating</h4>
            <div class="account-rating-controls">
              <select id="account-rating-filter" class="config-code-input account-aim-filter" aria-label="Gamemode"></select>
              <select id="account-rating-time" class="config-code-input account-aim-filter" aria-label="Time range"></select>
              <select id="account-rating-best" class="config-code-input account-aim-filter" aria-label="Best runs per category"></select>
            </div>
          </div>
          <div class="account-rating-compare">
            <input type="text" id="account-rating-compare" class="config-code-input" placeholder="Compare player username" spellcheck="false" maxlength="20" />
            <button type="button" class="btn btn-sm" id="account-rating-compare-btn">Add</button>
            <label class="field-check account-rating-global-check"><input type="checkbox" id="account-rating-global" /> Global avg</label>
            <button type="button" class="btn btn-sm" id="account-rating-clear-compare" hidden>Clear</button>
          </div>
          <div id="account-rating" class="account-rating">
            <div id="account-rating-chart" class="account-rating-canvas"></div>
            <div id="account-rating-legend" class="account-rating-legend"></div>
            <div id="account-rating-tooltip" class="radar-tooltip" hidden></div>
          </div>
        </section>

        <details class="account-section account-dropdown">
          <summary>Show placements</summary>
          <div id="account-stats" class="account-stats">
            <p class="center lb-hint">Loading…</p>
          </div>
        </details>

        <details class="account-section account-dropdown" id="account-aim-section">
          <summary>Aim analysis</summary>
          <div class="account-aim-head account-aim-head-nested">
            <select id="account-aim-filter" class="config-code-input account-aim-filter"></select>
          </div>
          <div id="account-aim-stats" class="account-aim-stats">
            <p class="center lb-hint">Loading…</p>
          </div>
        </details>

        <details class="account-section account-dropdown" id="account-replays-section">
          <summary>Replays</summary>
          <div id="account-replays" class="account-replays">
            <p class="center lb-hint">Loading…</p>
          </div>
        </details>

        </div>
        <div class="menu-actions">
          <button type="button" class="btn" id="account-view-settings-btn" hidden>Settings</button>
          <button type="button" class="btn" id="account-back-btn">Back</button>
        </div>
      </div>
    </div>

    <!-- LEADERBOARD -->
    <div class="screen leaderboard" data-screen="leaderboard">
      <div class="panel wide menu-panel">
        <div class="lb-header" id="lb-tabs">
          <span class="lb-playlist-title text-big" id="lb-playlist-title" hidden></span>
          <button type="button" class="tab active" id="lb-tab-elo" data-lb="elo">Ranked ELO</button>
          <button type="button" class="tab" id="lb-tab-aim" data-lb="aim-rating">Aim Rating</button>
          <div class="lb-mode-select-wrap">
            <select id="lb-mode-select" class="config-code-input" aria-label="Gamemode leaderboard">
              ${scenarioOptionsHtml()}
            </select>
          </div>
        </div>
        <div class="menu-panel-body menu-panel-scroll lb-body-wrap">
        <div id="lb-body" class="lb-body"></div>
        </div>
        <div class="menu-actions">
          <button type="button" class="btn primary" id="lb-back-btn">Back</button>
        </div>
      </div>
    </div>

    <!-- PAUSE -->
    <div class="screen pause" data-screen="paused">
      <div class="panel pause-panel">
        <button type="button" class="pause-gear" id="pause-settings-btn" aria-label="Settings">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path fill="currentColor" d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66z"/>
          </svg>
        </button>
        <h2 class="text-big pause-title">Paused</h2>
        <div class="menu-actions pause-actions">
          <button type="button" class="btn primary" data-resume>Resume</button>
          <button type="button" class="btn" id="pause-restart-btn" data-restart>Restart</button>
          <button type="button" class="btn" id="pause-leave-lobby-btn" hidden>Leave to lobby</button>
          <button type="button" class="btn" data-quit>Quit to menu</button>
        </div>
      </div>
    </div>

    <!-- MULTIPLAYER HOME (create / join) -->
    <div class="screen mp" data-screen="mp">
      <div class="panel wide menu-panel">
        <h2 class="text-big custom-games-title">Custom games</h2>
        <div class="menu-panel-body menu-panel-scroll">
        <div class="field field-plain">
          <div class="field-top"><span class="field-label">Display name</span></div>
          <input type="text" id="mp-name" class="config-code-input" maxlength="24" placeholder="Your name" spellcheck="false" autocomplete="off" />
        </div>
        <div class="mp-browser">
          <div class="mp-browser-head">
            <h4>Public lobbies</h4>
            <button type="button" class="btn mp-refresh" id="mp-refresh-btn">Refresh</button>
          </div>
          <div id="mp-lobby-list" class="mp-lobby-list"></div>
        </div>
        <div class="mp-cols">
          <div class="mp-col">
            <h4>Create a lobby</h4>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Win condition</span></div>
              <select id="mp-create-target">${this._targetOptions()}</select>
            </div>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Mode</span></div>
              <select id="mp-create-weapon"><option value="rifle">Rifle</option><option value="pistol">Pistol</option><option value="tracking">Tracking</option><option value="deathmatch">Deathmatch</option></select>
            </div>
            <label class="field-check"><input type="checkbox" id="mp-create-private" /> Private</label>
            <button type="button" class="btn primary btn-block" id="mp-create-btn">Create lobby</button>
          </div>
          <div class="mp-col">
            <h4>Join by code</h4>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Lobby code</span></div>
              <input type="text" id="mp-join-code" class="config-code-input" maxlength="4" placeholder="ABCD" spellcheck="false" autocomplete="off" />
            </div>
            <button type="button" class="btn btn-block" id="mp-join-btn">Join lobby</button>
          </div>
        </div>
        <p class="readout" id="mp-status"></p>
        </div>
        <div class="menu-actions">
          <button class="btn" id="mp-back-btn">Back</button>
        </div>
      </div>
    </div>

    <!-- MULTIPLAYER LOBBY -->
    <div class="screen mp-lobby" data-screen="mp-lobby">
      <div class="panel wide menu-panel">
        <h2 class="text-big">Lobby <span id="mp-lobby-code" class="mp-code"></span></h2>
        <div class="menu-panel-body menu-panel-scroll">
        <div id="mp-players" class="mp-players"></div>
        <div class="mp-invite" id="mp-invite">
          <code class="config-export-code" id="mp-invite-url"></code>
          <button type="button" class="btn btn-block" id="mp-invite-copy">Copy link</button>
        </div>
        <div class="mp-cols">
          <div class="mp-col">
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Win condition</span></div>
              <select id="mp-lobby-target">${this._targetOptions()}</select>
            </div>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Mode</span></div>
              <select id="mp-lobby-weapon"><option value="rifle">Rifle</option><option value="pistol">Pistol</option><option value="tracking">Tracking</option><option value="deathmatch">Deathmatch</option></select>
            </div>
            <label class="field-check"><input type="checkbox" id="mp-lobby-private" /> Private</label>
          </div>
          <div class="mp-col mp-col-actions">
            <button type="button" class="btn primary btn-block" id="mp-ready-btn">Ready</button>
            <button type="button" class="btn btn-block" id="mp-start-btn">Start match</button>
            <button type="button" class="btn btn-block" id="mp-leave-btn">Leave lobby</button>
          </div>
        </div>
        <p class="readout" id="mp-lobby-status"></p>
        </div>
      </div>
    </div>

    <!-- MULTIPLAYER RESULTS -->
    <div class="screen mp-results" data-screen="mp-results">
      <div class="panel">
        <h2 class="text-big" id="mp-res-title">Match Complete</h2>
        <div id="mp-res-score" class="res-stats"></div>
        <div class="menu-actions">
          <button class="btn primary" id="mp-res-rematch">Back to lobby</button>
          <button class="btn" id="mp-res-leave">Leave</button>
        </div>
      </div>
    </div>

    <!-- RESULTS -->
    <div class="screen results" data-screen="results">
      <div class="panel wide menu-panel">
        <h2 class="text-big" id="res-title">Run Complete</h2>
        <div class="menu-panel-body menu-panel-scroll">
        <div id="res-stats" class="res-stats"></div>
        <section id="res-infographics" class="res-infographics" hidden>
          <div class="res-info-header">
            <button type="button" class="res-info-nav" id="res-info-prev" aria-label="Previous infographic">‹</button>
            <h3 class="res-info-title" id="res-info-title">Aim4 Rating</h3>
            <button type="button" class="res-info-nav" id="res-info-next" aria-label="Next infographic">›</button>
          </div>
          <div id="res-rating-panel" class="res-info-panel">
            <div class="account-rating">
              <div id="res-rating-chart" class="account-rating-canvas"></div>
              <div id="res-rating-legend" class="account-rating-legend"></div>
              <div id="res-rating-tooltip" class="radar-tooltip" hidden></div>
            </div>
          </div>
          <div id="res-history-panel" class="res-info-panel" hidden>
            <div id="res-history-chart" class="res-history-canvas"></div>
            <div id="res-history-legend" class="account-rating-legend"></div>
          </div>
        </section>
        <div id="res-lb" class="lb-body"></div>
        </div>
        <div class="menu-actions">
          <button class="btn primary" data-restart>Play again</button>
          <button class="btn" id="res-watch-replay" hidden>Watch replay</button>
          <button class="btn" id="res-share-replay" hidden>Share replay</button>
          <button class="btn" data-quit>Menu</button>
        </div>
      </div>
    </div>

    <!-- PLAYLIST RESULTS (between modes + final combined screen) -->
    <div class="screen playlist-results" data-screen="playlist-results">
      <div class="panel wide menu-panel">
        <h2 class="text-big" id="pl-res-title">Playlist</h2>
        <div class="menu-panel-body menu-panel-scroll">
        <p class="readout muted" id="pl-res-progress"></p>
        <div id="pl-res-stats" class="res-stats"></div>
        <div id="pl-res-lb" class="lb-body"></div>
        </div>
        <div class="menu-actions">
          <button type="button" class="btn primary" id="pl-res-continue">Next mode</button>
          <button type="button" class="btn" id="pl-res-again" hidden>Play again</button>
          <button type="button" class="btn" id="pl-res-quit">Quit</button>
        </div>
      </div>
    </div>

    <!-- REPLAY PLAYBACK -->
    <canvas id="replay-analysis-canvas" class="replay-analysis-canvas"></canvas>
    <div id="replay-stats" class="replay-stats" hidden></div>
    <div id="replay-overlay" class="replay-overlay">
      <div class="replay-controls">
        <button type="button" class="btn btn-sm replay-playpause" id="replay-playpause">▶</button>
        <input type="range" id="replay-scrub" class="replay-scrub" min="0" max="1000" value="0" />
        <span id="replay-time" class="replay-time">0.0 / 0.0s</span>
        <div class="replay-speeds" id="replay-speeds"></div>
        <button type="button" class="btn btn-sm" id="replay-share-btn">Share</button>
        <span id="replay-share-status" class="replay-share-status muted" hidden></span>
        <div class="replay-analytics">
          <button type="button" class="btn btn-sm replay-gear" id="replay-settings-btn" title="Analysis settings" aria-label="Analysis settings">⚙</button>
          <div id="replay-settings-pop" class="replay-settings-pop" hidden>
            <h4>Analysis</h4>
            <label class="field-check"><input type="checkbox" id="ra-optimalPath" /> Optimal path</label>
            <label class="field-check"><input type="checkbox" id="ra-flicks" /> Flick adjustments</label>
            <label class="field-check"><input type="checkbox" id="ra-trajectory" /> Trajectory</label>
            <label class="field-check"><input type="checkbox" id="ra-tension" /> Tension %</label>
            <label class="field-check"><input type="checkbox" id="ra-clickTiming" /> Click timing</label>
            <label class="field-check"><input type="checkbox" id="ra-flickSpeed" /> Flick speed</label>
            <label class="field-check"><input type="checkbox" id="ra-flickAccuracy" /> Flick accuracy</label>
          </div>
        </div>
        <button type="button" class="btn btn-sm" id="replay-exit">Exit replay</button>
      </div>
    </div>

    <a href="https://x.com/artys4n" class="menu-credit" id="menu-credit" target="_blank" rel="noopener noreferrer" hidden>by @artys4n</a>
    `;
  }

  _cache() {
    this.screens = {};
    this.root.querySelectorAll('[data-screen]').forEach((el) => {
      this.screens[el.dataset.screen] = el;
    });
    this.hud = this.root.querySelector('#hud');
    this.mpScoreboard = this.root.querySelector('#mp-scoreboard');
    this.dmKillfeed = this.root.querySelector('#dm-killfeed');
    this._mpKillFeed = [];
    this.mpChat = this.root.querySelector('#mp-chat');
    this.mpChatLog = this.root.querySelector('#mp-chat-log');
    this.mpChatInput = this.root.querySelector('#mp-chat-input');
    this.mpTabScoreboard = this.root.querySelector('#mp-tab-scoreboard');
    this.mpAimHint = this.root.querySelector('#mp-aim-hint');
    this.runCountdown = this.root.querySelector('#run-countdown');
    this.runCountdownNum = this.root.querySelector('#run-countdown-num');
    this.menuCredit = this.root.querySelector('#menu-credit');

    this.hudTime = this.root.querySelector('#hud-time');
    this.hudScore = this.root.querySelector('#hud-score');
    this.hudAcc = this.root.querySelector('#hud-acc');
    this.hudKps = this.root.querySelector('#hud-kps');
    this.hudHits = this.root.querySelector('#hud-hits');
    this.hudCrit = this.root.querySelector('#hud-crit');
    this.hudCritChip = this.root.querySelector('#hud-crit-chip');
    this.mmQueueChip = this.root.querySelector('#mm-queue-chip');
    this.mmQueueText = this.root.querySelector('#mm-queue-text');
    this.hudAmmo = this.root.querySelector('#hud-ammo');
    this.hudAmmoMag = this.root.querySelector('#hud-ammo-mag');
    this.hudAmmoSize = this.root.querySelector('#hud-ammo-size');
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------
  _bind() {
    this.root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-play],[data-goto],[data-resume],[data-quit],[data-restart],[data-reset],[data-reset-colors],[data-lb]');
      if (!t) return;
      if (t.dataset.play) {
        const variant = t.dataset.variant;
        this.play(t.dataset.play, variant ? { variant } : {});
      }
      else if (t.dataset.goto) {
        if (t.dataset.goto === 'leaderboard') {
          this._returnAfterLeaderboard = 'menu';
          this._openLeaderboard();
        }
        if (t.dataset.goto === 'multiplayer') this.refreshAccountBar();
        if (t.dataset.goto === 'settings') this._returnAfterSettings = this.state;
        if (t.dataset.goto === 'playlists') this._renderPlaylists();
        this.showScreen(t.dataset.goto);
        if (t.dataset.goto === 'mp') this.mp.openBrowser();
        if (t.dataset.goto === 'auth') this._openAuth('login');
      } else if (t.hasAttribute('data-resume')) this.resume();
      else if (t.hasAttribute('data-quit')) this.quit();
      else if (t.hasAttribute('data-restart')) {
        if (this._playlistRun) this._playPlaylistItem();
        else this.play(this.currentScenario, this.scenarioConfig);
      }
      else if (t.hasAttribute('data-reset')) {
        if (this._settingsExploreMode || this.settings.isExploreMode) return;
        this.settings.resetDraft();
        this._populateSettings();
        this._updateSettingsBar();
      } else if (t.hasAttribute('data-reset-colors')) {
        if (this._settingsExploreMode || this.settings.isExploreMode) return;
        this.settings.resetColorsDraft();
        this._populateSettings();
        this._updateSettingsBar();
      } else if (t.dataset.lb === 'elo') {
        this._setLeaderboardView('elo');
        this._renderLeaderboard('elo');
      } else if (t.dataset.lb === 'aim-rating') {
        this._setLeaderboardView('aim-rating');
        this._renderLeaderboard('aim-rating');
      }
    });

    this._bindLeaderboard();
    this._trainingCategory = TRAINING_CATEGORIES[0].id;
    this._trainingSearchQuery = '';

    // Category tiles open the mode list for that category.
    this.root.querySelectorAll('[data-training-cat]').forEach((tile) => {
      tile.addEventListener('click', () => {
        this._trainingCategory = tile.dataset.trainingCat;
        if (this._trainingCategory !== 'all') this._trainingSearchQuery = '';
        this.showScreen('training');
      });
    });

    const trainingSearch = this.root.querySelector('#training-search');
    trainingSearch?.addEventListener('input', (e) => {
      this._trainingSearchQuery = e.target.value;
      this._renderTrainingList();
    });

    // The training list re-renders per category, so its events are delegated.
    const trainingList = this.root.querySelector('#training-list');
    trainingList?.addEventListener('click', (e) => {
      const gear = e.target.closest('[data-scenario-settings-open]');
      if (gear) {
        e.stopPropagation();
        this._openScenarioSettings(gear.dataset.scenarioSettingsOpen);
        return;
      }
      const lb = e.target.closest('[data-training-lb]');
      if (lb) {
        e.stopPropagation();
        this._openLeaderboardForScenario(lb.dataset.trainingLb);
      }
    });
    // Hovering a row previews which leaderboard is active.
    trainingList?.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.training-row');
      if (row) this.currentScenario = row.dataset.scenario;
    });

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || e.repeat) return;
      if (this.replaying) return;
      if (this.state !== 'leaderboard') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      this._leaveLeaderboard();
    });

    this._bindSettings();
    this._bindSettingsTabs();
    this._bindScenarioSettings();
    this._bindScenarioFooter();
    this._bindPlaylists();
    this._bindPauseMenu();
  }

  /** Render the training rows for the active category into #training-list. */
  _renderTrainingList() {
    const list = this.root.querySelector('#training-list');
    if (!list) return;
    const cat = TRAINING_CATEGORIES.find((c) => c.id === this._trainingCategory) || TRAINING_CATEGORIES[0];
    const heading = this.root.querySelector('#training-heading');
    if (heading) heading.textContent = cat.title;

    const searchWrap = this.root.querySelector('#training-search-wrap');
    const searchInput = this.root.querySelector('#training-search');
    const showSearch = cat.id === 'all';
    searchWrap?.classList.toggle('hidden', !showSearch);
    if (searchInput) {
      if (!showSearch) searchInput.value = '';
      else if (searchInput.value !== this._trainingSearchQuery) searchInput.value = this._trainingSearchQuery;
    }

    const modes = trainingCategoryModes(cat.id).filter((key) => this._trainingSearchMatch(key));
    if (modes.length === 0) {
      list.innerHTML = '<p class="readout training-search-empty">No gamemodes match your search.</p>';
      return;
    }
    list.innerHTML = modes.map((key) => this._trainingRowHtml(key)).join('');
  }

  _trainingSearchMatch(key) {
    const q = this._trainingSearchQuery.trim().toLowerCase();
    if (!q) return true;
    const meta = SCENARIO_META[key] || { title: key, tags: [] };
    if (meta.title.toLowerCase().includes(q)) return true;
    return (meta.tags || []).some((tag) => tag.toLowerCase().includes(q));
  }

  _trainingRowHtml(key) {
    const meta = SCENARIO_META[key] || { title: key, tags: [] };
    const hasSettings = SCENARIO_SETTING_IDS.has(key);
    const playBtns = meta.dualPlay
      ? `<button type="button" class="btn training-row-play" data-play="${key}" data-variant="practice">Training</button>
    <button type="button" class="btn training-row-play" data-play="${key}" data-variant="competitive">Competitive</button>`
      : `<button type="button" class="btn training-row-play" data-play="${key}"${meta.challenge ? ' data-variant="competitive"' : ''} aria-label="Play ${meta.title}">Play</button>`;
    const lbBtn = `<button type="button" class="training-row-lb" data-training-lb="${key}" aria-label="${meta.title} leaderboard"><img src="${LEADERBOARD_ICON}" alt="" class="aim4-icon" width="16" height="16" /></button>`;
    const gearBtn = hasSettings
      ? `<button type="button" class="training-row-gear" data-scenario-settings-open="${key}" aria-label="${meta.title} settings">${GEAR_ICON}</button>`
      : `<span class="training-row-gear-spacer" aria-hidden="true"></span>`;
    const tagHtml = (meta.tags || [])
      .map((tag) => `<span class="training-row-tag">${tag}</span>`)
      .join('');
    return `
  <div class="training-row" data-scenario="${key}">
    <div class="training-row-main">
      <div class="training-row-icon">
        <img src="${SCENARIO_ICONS[key]}" alt="" class="aim4-icon" width="24" height="24" />
      </div>
      <span class="training-row-title">${meta.title}</span>
      ${tagHtml ? `<div class="training-row-tags">${tagHtml}</div>` : ''}
    </div>
    <div class="training-row-actions">
      ${playBtns}
      ${lbBtn}
      ${gearBtn}
    </div>
  </div>`;
  }

  _bindSettingsTabs() {
    const tabs = this.root.querySelectorAll('.settings-tab');
    const panels = this.root.querySelectorAll('.settings-panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const cat = tab.dataset.settingsCat;
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        panels.forEach((p) => p.classList.toggle('active', p.dataset.settingsCat === cat));
        if (cat === 'crosshair') this.crosshair.drawPreview();
      });
    });
  }

  _bindRange(id, apply, { parse = parseFloat, after } = {}) {
    const s = this.settings;
    const slider = this.root.querySelector(`#${id}`);
    const num = this.root.querySelector(`#${id}-num`);
    if (!slider || !num) return;

    const syncUi = (v) => {
      num.value = v;
      slider.value = Math.min(+slider.max, Math.max(+slider.min, v));
    };

    const commit = (v) => {
      if (Number.isNaN(v)) return;
      s.mutateDraft((d) => apply(v, d));
      syncUi(v);
      after?.();
      this._updateSettingsBar();
    };

    slider.addEventListener('input', (e) => commit(parse(e.target.value)));
    num.addEventListener('change', (e) => commit(parse(e.target.value)));
  }

  _setRange(id, value) {
    const slider = this.root.querySelector(`#${id}`);
    const num = this.root.querySelector(`#${id}-num`);
    if (num) num.value = value;
    if (slider) slider.value = Math.min(+slider.max, Math.max(+slider.min, value));
  }

  /** Human label for a KeyboardEvent.code ("Digit3" → "3", "KeyQ" → "Q"). */
  _keyCodeLabel(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    return code;
  }

  _syncKeyCaptureLabel(id, code) {
    const btn = this.root.querySelector(`#${id}`);
    if (btn && !btn.dataset.capturing) btn.textContent = this._keyCodeLabel(code);
  }

  /**
   * Bind button: click arms capture, the next key press becomes the bind
   * (Escape cancels). `apply(code, draft)` writes it onto the settings draft.
   */
  _bindKeyCapture(id, apply) {
    const btn = this.root.querySelector(`#${id}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (btn.dataset.capturing) return;
      const prev = btn.textContent;
      btn.dataset.capturing = '1';
      btn.textContent = 'Press a key…';
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('keydown', onKey, true);
        delete btn.dataset.capturing;
        if (e.code === 'Escape') {
          btn.textContent = prev;
          return;
        }
        this.settings.mutateDraft((d) => apply(e.code, d));
        btn.textContent = this._keyCodeLabel(e.code);
        this._updateSettingsBar();
      };
      document.addEventListener('keydown', onKey, true);
    });
  }

  _updateSettingsBar() {
    const explore = this._settingsExploreMode || this.settings.isExploreMode;
    const undoBtn = this.root.querySelector('#settings-undo-btn');
    const resetBtn = this.root.querySelector('[data-reset]');
    const hint = this.root.querySelector('#settings-unsaved-hint');
    if (undoBtn) {
      undoBtn.disabled = !this.settings.canUndoDraft();
      undoBtn.hidden = explore;
    }
    if (resetBtn) resetBtn.hidden = explore;
    if (hint) hint.hidden = explore || !this.settings.hasDraftChanges();
    this._updateScenarioSettingsBar();
  }

  _updateScenarioSettingsBar() {
    const undoBtn = this.root.querySelector('#scenario-settings-undo-btn');
    if (undoBtn) undoBtn.disabled = !this.settings.canUndoDraft();
  }

  _applyScenarioSettingsLive() {
    this.settings.commitDraftLive();
    this.settings.save();
    this.sceneManager.applyLiveScenarioSettings();
    if (this._activeScenarioSettings) {
      this._populateScenarioFooter(this._activeScenarioSettings);
    }
  }

  _canOpenInRunScenarioSettings() {
    const sc = this.sceneManager.current;
    if (!sc || sc.isMultiplayer || sc.competitive) return null;
    const id = sc.name;
    return SCENARIO_SETTING_IDS.has(id) ? id : null;
  }

  _updateScenarioSettingsBackLabel() {
    const back = this.root.querySelector('#scenario-settings-back-btn');
    if (!back) return;
    if (this._returnAfterScenarioSettings === 'paused') back.textContent = 'Back to game';
    else if (this._returnAfterScenarioSettings === 'playlist-edit') back.textContent = 'Back to playlist';
    else back.textContent = 'Back to Training';
  }

  _openSettings() {
    if (this.settings.isExploreMode) {
      this._setSettingsExploreUi(false);
      this.settings.closeExploreDraft();
      this._settingsExploreMode = false;
      this._settingsExplorePayload = null;
      this._settingsExploreUser = null;
    }
    this.settings.openDraft();
    this._populateSettings();
    this.crosshair.drawPreview();
    this._updateSettingsBar();
  }

  _openScenarioSettings(scenarioId, { live = false, returnTo = 'training' } = {}) {
    if (!SCENARIO_SETTING_IDS.has(scenarioId)) return;
    this._scenarioSettingsLive = !!live;
    this.settings.openDraft();
    this._activeScenarioSettings = scenarioId;
    this._populateSettings();
    this._showScenarioSettingsPanel(scenarioId);
    this._populateScenarioFooter(scenarioId);
    this._updateScenarioSettingsBar();
    this._returnAfterScenarioSettings = returnTo;
    this._updateScenarioSettingsBackLabel();
    this.showScreen('scenario-settings');
  }

  /**
   * Edit one playlist item's mode settings with the same per-mode panel the
   * Training gear opens. The item's config is loaded onto a throwaway settings
   * draft; on Done the edited config is captured back INTO THE ITEM and the
   * draft is discarded, so the player's own Training settings never change.
   */
  _openPlaylistItemSettings(idx) {
    const item = this._playlistDraft[idx];
    if (!item || !SCENARIO_SETTING_IDS.has(item.scenario)) return;
    this.settings.openDraft();
    this.settings.applyModeConfigToDraft(item.scenario, item.config);
    this._playlistItemEditing = idx;
    this._activeScenarioSettings = item.scenario;
    this._populateSettings();
    this._showScenarioSettingsPanel(item.scenario);
    this._populateScenarioFooter(item.scenario);
    this._updateScenarioSettingsBar();
    this._returnAfterScenarioSettings = 'playlist-edit';
    this._scenarioSettingsLive = false;
    this._updateScenarioSettingsBackLabel();
    this.showScreen('scenario-settings');
  }

  _showScenarioSettingsPanel(scenarioId) {
    const title = SCENARIO_META[scenarioId]?.title ?? 'Mode';
    const titleEl = this.root.querySelector('#scenario-settings-title');
    if (titleEl) titleEl.textContent = `${title} settings`;
    this.root.querySelectorAll('.scenario-settings-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.scenarioSettingsPanel === scenarioId);
    });
  }

  _closeScenarioSettings() {
    if (this._playlistItemEditing != null) {
      // Playlist-item edit: capture the edited config into the item, then
      // throw the draft away so the user's own settings are untouched.
      const idx = this._playlistItemEditing;
      const item = this._playlistDraft[idx];
      if (item) {
        const { config } = this.settings.getModeConfig(item.scenario);
        item.config = config;
      }
      this.settings.discardDraft();
      this._playlistItemEditing = null;
      this._activeScenarioSettings = null;
      this._updateSettingsBar();
      this._updateScenarioSettingsBar();
      const ret = this._returnAfterScenarioSettings ?? 'playlist-edit';
      this._returnAfterScenarioSettings = null;
      this._renderPlaylistDraft();
      if (item) this._setPlaylistEditStatus(`Updated ${SCENARIO_META[item.scenario]?.title || item.scenario} settings for this playlist.`);
      this.showScreen(ret);
      return;
    }
    if (this._scenarioSettingsLive) {
      this.settings.commitDraftLive();
      this.settings.save();
      this.settings.discardDraft();
      this._scenarioSettingsLive = false;
    } else {
      this.settings.confirmDraft();
    }
    this._activeScenarioSettings = null;
    this._updateSettingsBar();
    this._updateScenarioSettingsBar();
    const ret = this._returnAfterScenarioSettings ?? 'training';
    this._returnAfterScenarioSettings = null;
    this.showScreen(ret);
  }

  _bindScenarioSettings() {
    const $ = (id) => this.root.querySelector(id);
    $('#scenario-settings-undo-btn')?.addEventListener('click', () => {
      if (this.settings.undoDraft()) {
        this._populateSettings();
        if (this._activeScenarioSettings) this._populateScenarioFooter(this._activeScenarioSettings);
        this._updateSettingsBar();
        if (this._scenarioSettingsLive) this._applyScenarioSettingsLive();
      }
    });
    $('#scenario-settings-back-btn')?.addEventListener('click', () => this._closeScenarioSettings());
  }

  // -------------------------------------------------------------------------
  // Scenario settings footer — per-mode duration + config code share
  // -------------------------------------------------------------------------

  /** Fill the duration + config-code controls for the active scenario. */
  _populateScenarioFooter(scenarioId) {
    const $ = (id) => this.root.querySelector(id);
    const data = this.settings.activeSettings()?.[scenarioId] || {};
    const dur = resolveModeDuration(data, this.settings.activeSettings()?.runDuration);
    const killable = isKillLeaderboardScenario(scenarioId);

    const typeSel = $('#scn-dur-type');
    if (typeSel) {
      const opts = ['<option value="time">Time</option>'];
      if (killable) opts.push('<option value="kills">Kills</option>');
      typeSel.innerHTML = opts.join('');
      typeSel.value = killable && dur.type === 'kills' ? 'kills' : 'time';
      typeSel.disabled = !killable;
    }
    const valInput = $('#scn-dur-value');
    if (valInput) valInput.value = dur.value;
    const unit = $('#scn-dur-unit');
    if (unit) unit.textContent = typeSel?.value === 'kills' ? 'kills' : 'sec';

    const codeEl = $('#scn-code-export');
    if (codeEl) {
      try {
        const mode = this.settings.getModeConfig(scenarioId);
        codeEl.textContent = encodeModeConfig(mode);
      } catch {
        codeEl.textContent = '—';
      }
    }
    const status = $('#scn-code-status');
    if (status) { status.textContent = ''; status.classList.remove('is-error'); }
    const importInput = $('#scn-code-import');
    if (importInput) importInput.value = '';

    const resetBtn = $('#scn-stats-reset-btn');
    const canReset =
      this.auth?.isLoggedIn && this.auth?.isConfigured && this._playlistItemEditing == null;
    if (resetBtn) resetBtn.hidden = !canReset;
  }

  /** Refresh just the live config-code readout (after a settings edit). */
  _refreshScenarioCode() {
    const scenarioId = this._activeScenarioSettings;
    if (!scenarioId) return;
    const codeEl = this.root.querySelector('#scn-code-export');
    if (!codeEl) return;
    try {
      codeEl.textContent = encodeModeConfig(this.settings.getModeConfig(scenarioId));
    } catch {
      codeEl.textContent = '—';
    }
  }

  async _resetScenarioStats() {
    const scenarioId = this._activeScenarioSettings;
    const userId = this.auth?.user?.id;
    if (!scenarioId || !userId) return;

    const title = SCENARIO_META[scenarioId]?.title || scenarioId;
    const ok = window.confirm(
      `Reset all statistics and replays for ${title}?\n\n` +
        'This permanently deletes your aim analytics, leaderboard scores, and recordings for this mode. ' +
        'This cannot be undone.'
    );
    if (!ok) return;

    const btn = this.root.querySelector('#scn-stats-reset-btn');
    if (btn) btn.disabled = true;

    try {
      await resetGamemodeStats(userId, scenarioId);
      if (this._viewingAccount?.id === userId || !this._viewingAccount) {
        this._loadAimSummary(userId).catch(() => {});
      }
    } catch (e) {
      window.alert(e?.message || 'Reset failed.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  _bindScenarioFooter() {
    const $ = (id) => this.root.querySelector(id);
    const setStatus = (msg, isError = false) => {
      const el = $('#scn-code-status');
      if (!el) return;
      el.textContent = msg || '';
      el.classList.toggle('is-error', !!isError);
    };

    $('#scn-dur-type')?.addEventListener('change', (e) => {
      const scenarioId = this._activeScenarioSettings;
      if (!scenarioId) return;
      const type = e.target.value === 'kills' ? 'kills' : 'time';
      this.settings.mutateDraft((d) => {
        const cur = d[scenarioId]?.duration?.value;
        const value = Number(cur) > 0 ? Number(cur) : (type === 'kills' ? 100 : 60);
        d[scenarioId] = d[scenarioId] || {};
        d[scenarioId].duration = { type, value };
      });
      const unit = $('#scn-dur-unit');
      if (unit) unit.textContent = type === 'kills' ? 'kills' : 'sec';
      this._refreshScenarioCode();
      this._updateScenarioSettingsBar();
    });

    $('#scn-dur-value')?.addEventListener('change', (e) => {
      const scenarioId = this._activeScenarioSettings;
      if (!scenarioId) return;
      const value = Math.max(1, Math.round(parseFloat(e.target.value)));
      if (!Number.isFinite(value)) return;
      this.settings.mutateDraft((d) => {
        const type = d[scenarioId]?.duration?.type === 'kills' ? 'kills' : 'time';
        d[scenarioId] = d[scenarioId] || {};
        d[scenarioId].duration = { type, value };
      });
      e.target.value = value;
      this._refreshScenarioCode();
      this._updateScenarioSettingsBar();
    });

    $('#scn-code-copy')?.addEventListener('click', async () => {
      const scenarioId = this._activeScenarioSettings;
      if (!scenarioId) return;
      try {
        const code = encodeModeConfig(this.settings.getModeConfig(scenarioId));
        const codeEl = $('#scn-code-export');
        if (codeEl) codeEl.textContent = code;
        await copyText(code);
        setStatus('Config code copied to clipboard.');
      } catch (err) {
        setStatus(err.message || 'Could not copy code', true);
      }
    });

    $('#scn-stats-reset-btn')?.addEventListener('click', () => this._resetScenarioStats());

    $('#scn-code-import-btn')?.addEventListener('click', () => {
      const scenarioId = this._activeScenarioSettings;
      if (!scenarioId) return;
      const raw = $('#scn-code-import')?.value;
      if (!raw || !raw.trim()) { setStatus('Paste a config code first.', true); return; }
      let decoded;
      try {
        decoded = decodeModeConfig(raw);
      } catch (err) {
        setStatus(err.message || 'Invalid config code', true);
        return;
      }
      if (decoded.scenario !== scenarioId) {
        const other = SCENARIO_META[decoded.scenario]?.title || decoded.scenario;
        const here = SCENARIO_META[scenarioId]?.title || scenarioId;
        setStatus(`That code is for ${other}, not ${here}.`, true);
        return;
      }
      this.settings.applyModeConfigToDraft(scenarioId, decoded.config);
      this._populateSettings();
      this._populateScenarioFooter(scenarioId);
      this._updateScenarioSettingsBar();
      setStatus('Config imported.');
    });
  }

  _bindSettings() {
    const s = this.settings;
    const $ = (id) => this.root.querySelector(id);
    const draft = (fn) => {
      s.mutateDraft(fn);
      this._updateSettingsBar();
    };

    const numOnly = (id, apply, { parse = parseFloat, after } = {}) => {
      $(id).addEventListener('change', (e) => {
        const v = parse(e.target.value);
        if (Number.isNaN(v)) return;
        draft((d) => apply(v, d));
        after?.();
      });
    };

    numOnly('#set-sensitivity', (v, d) => { d.sensitivity = v; });

    this._bindRange('set-fov', (v, d) => { d.hFov = v; });
    numOnly('#set-dur', (v, d) => { d.runDuration = v; }, { parse: (v) => parseInt(v, 10) });

    $('#set-res').addEventListener('change', (e) => {
      const val = e.target.value;
      draft((d) => {
        if (val === 'custom') {
          d.resolution = 'custom';
          d.resolutionWidth = clampResolutionDim(d.resolutionWidth, 1920);
          d.resolutionHeight = clampResolutionDim(d.resolutionHeight, 1080);
        } else {
          d.resolution = val;
          const preset = RESOLUTIONS[val];
          if (preset?.size) {
            d.resolutionWidth = preset.size[0];
            d.resolutionHeight = preset.size[1];
          }
        }
      });
      this._syncResolutionCustomUi();
    });
    numOnly('#set-res-w', (v, d) => {
      d.resolution = 'custom';
      d.resolutionWidth = clampResolutionDim(v, 1920);
      const h = parseInt($('#set-res-h')?.value, 10);
      d.resolutionHeight = clampResolutionDim(h, d.resolutionHeight ?? 1080);
    }, {
      parse: (v) => parseInt(v, 10),
      after: () => {
        $('#set-res').value = 'custom';
        this._syncResolutionCustomUi();
      }
    });
    numOnly('#set-res-h', (v, d) => {
      d.resolution = 'custom';
      d.resolutionHeight = clampResolutionDim(v, 1080);
      const w = parseInt($('#set-res-w')?.value, 10);
      d.resolutionWidth = clampResolutionDim(w, d.resolutionWidth ?? 1920);
    }, {
      parse: (v) => parseInt(v, 10),
      after: () => {
        $('#set-res').value = 'custom';
        this._syncResolutionCustomUi();
      }
    });
    $('#set-raw').addEventListener('change', (e) => {
      draft((d) => { d.rawInput = e.target.checked; });
    });
    $('#set-copy-replay-config').addEventListener('change', (e) => {
      draft((d) => { d.copyConfigOnReplay = e.target.checked; });
    });

    $('#set-xh-color').addEventListener('input', (e) => {
      draft((d) => { d.crosshair.color = e.target.value; });
    });
    this._bindRange('set-xh-gap', (v, d) => { d.crosshair.innerGap = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-xh-len', (v, d) => { d.crosshair.length = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-xh-thick', (v, d) => { d.crosshair.thickness = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-xh-dot', (v, d) => { d.crosshair.dotPercentage = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-xh-hitmarker').addEventListener('change', (e) => {
      draft((d) => { d.crosshair.hitmarker = e.target.checked; });
      this.crosshair.drawPreview(e.target.checked);
    });
    $('#set-xh-dyn').addEventListener('change', (e) => {
      draft((d) => { d.crosshair.dynamicGap = e.target.checked; });
    });
    this._bindRange('set-xh-outline-thick', (v, d) => { d.crosshair.outlineThickness = v; });
    $('#set-xh-outline-color')?.addEventListener('input', (e) => {
      draft((d) => { d.crosshair.outlineColor = e.target.value; });
    });
    this._bindRange('set-xh-outline-opacity', (v, d) => {
      d.crosshair.outlineOpacity = v / 100;
    }, { parse: (v) => parseInt(v, 10) });

    $('#set-vm-hand').addEventListener('change', (e) => {
      draft((d) => { d.viewmodel.hand = e.target.value === 'left' ? 'left' : 'right'; });
    });
    this._bindRange('set-vm-fov', (v, d) => { d.viewmodel.fov = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-vm-ox', (v, d) => { d.viewmodel.offsetX = v; });
    this._bindRange('set-vm-oy', (v, d) => { d.viewmodel.offsetY = v; });
    this._bindRange('set-vm-oz', (v, d) => { d.viewmodel.offsetZ = v; });
    $('#set-vm-bob').addEventListener('change', (e) => {
      draft((d) => { d.viewmodel.bob = e.target.checked; });
    });
    $('#set-vm-aimpunch').addEventListener('change', (e) => {
      draft((d) => { d.weapon.aimpunch = e.target.checked; });
    });

    this._bindRange('set-sniper-thick', (v, d) => { d.sniper.lineThickness = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindKeyCapture('set-sniper-bind1', (code, d) => { d.sniper.unscopeKey1 = code; });
    this._bindKeyCapture('set-sniper-bind2', (code, d) => { d.sniper.unscopeKey2 = code; });

    this._bindRange('set-grid-size', (v, d) => { d.gridshot.targetSize = v; });
    this._bindRange('set-grid-count', (v, d) => { d.gridshot.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-grid-mode').addEventListener('change', (e) => {
      draft((d) => { d.gridshot.mode = e.target.value; });
    });
    this._bindRange('set-grid-track-time', (v, d) => { d.gridshot.trackTime = v; });
    $('#set-grid-track-resolve').addEventListener('change', (e) => {
      draft((d) => { d.gridshot.trackResolve = e.target.value; });
    });
    $('#set-grid-float').addEventListener('change', (e) => {
      draft((d) => { d.gridshot.floatEnabled = e.target.checked; });
    });
    this._bindRange('set-grid-float-speed', (v, d) => { d.gridshot.floatSpeedMax = v; });
    this._bindRange('set-grid-bounds-y', (v, d) => { d.gridshot.boundsScaleY = v; });
    this._bindRange('set-grid-bounds-x', (v, d) => { d.gridshot.boundsScaleX = v; });
    $('#set-grid-tl').addEventListener('change', (e) => {
      draft((d) => { d.gridshot.enableTimeLimit = e.target.checked; });
    });
    this._bindRange('set-grid-age', (v, d) => { d.gridshot.maxTargetAge = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-grid-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.gridshot.infiniteAmmo = e.target.checked; });
    });
    $('#set-grid-vm-recoil')?.addEventListener('change', (e) => {
      draft((d) => { d.gridshot.viewmodelRecoil = e.target.checked; });
    });
    this._bindRange('set-grid-misslimit', (v, d) => { d.gridshot.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-stars-size', (v, d) => { d.stars.targetSize = v; });
    this._bindRange('set-stars-count', (v, d) => { d.stars.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-stars-misslimit', (v, d) => { d.stars.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-bounce-size', (v, d) => { d.bounce.targetSize = v; });
    this._bindRange('set-bounce-count', (v, d) => { d.bounce.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-bounce-speed', (v, d) => { d.bounce.travelSpeed = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-bounce-min-dist', (v, d) => { d.bounce.minDistance = v; });
    this._bindRange('set-bounce-max-dist', (v, d) => { d.bounce.maxDistance = v; });
    this._bindRange('set-bounce-strength', (v, d) => { d.bounce.bounceStrength = v; });
    $('#set-bounce-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.bounce.infiniteAmmo = e.target.checked; });
    });
    this._bindRange('set-bounce-misslimit', (v, d) => { d.bounce.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-mf-size', (v, d) => { d.microflicks.targetSize = v; });
    this._bindRange('set-mf-count', (v, d) => { d.microflicks.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-mf-float')?.addEventListener('change', (e) => {
      draft((d) => { d.microflicks.floatEnabled = e.target.checked; });
    });
    this._bindRange('set-mf-float-speed', (v, d) => { d.microflicks.floatSpeedMax = v; });
    this._bindRange('set-mf-bounds-y', (v, d) => { d.microflicks.boundsScaleY = v; });
    this._bindRange('set-mf-bounds-x', (v, d) => { d.microflicks.boundsScaleX = v; });
    this._bindRange('set-mf-misslimit', (v, d) => { d.microflicks.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-pasu-size', (v, d) => { d.pasu.targetSize = v; });
    this._bindRange('set-pasu-count', (v, d) => { d.pasu.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-pasu-mode').addEventListener('change', (e) => {
      draft((d) => { d.pasu.mode = e.target.value; });
    });
    this._bindRange('set-pasu-track-time', (v, d) => { d.pasu.trackTime = v; });
    $('#set-pasu-track-resolve').addEventListener('change', (e) => {
      draft((d) => { d.pasu.trackResolve = e.target.value; });
    });
    this._bindRange('set-pasu-travel-speed', (v, d) => { d.pasu.travelSpeedMax = v; });
    this._bindRange('set-pasu-bounds-y', (v, d) => { d.pasu.boundsScaleY = v; });
    this._bindRange('set-pasu-bounds-x', (v, d) => { d.pasu.boundsScaleX = v; });
    this._bindRange('set-pasu-angle', (v, d) => { d.pasu.angleOffset = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-pasu-tl').addEventListener('change', (e) => {
      draft((d) => { d.pasu.enableTimeLimit = e.target.checked; });
    });
    this._bindRange('set-pasu-age', (v, d) => { d.pasu.maxTargetAge = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-pasu-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.pasu.infiniteAmmo = e.target.checked; });
    });
    this._bindRange('set-pasu-misslimit', (v, d) => { d.pasu.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-spider-size', (v, d) => { d.spidershot.targetSize = v; });
    this._bindRange('set-spider-ttk', (v, d) => { d.spidershot.timeToKill = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-spider-max-dist', (v, d) => { d.spidershot.maxDistance = v; });
    this._bindRange('set-spider-min-dist', (v, d) => { d.spidershot.minDistance = v; });
    this._bindRange('set-spider-height', (v, d) => { d.spidershot.heightSpread = v; });
    this._bindRange('set-spider-angle', (v, d) => { d.spidershot.angleSpread = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-spider-streak', (v, d) => { d.spidershot.streakChance = v / 100; });
    this._bindRange('set-spider-streak-min', (v, d) => { d.spidershot.streakLengthMin = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-spider-streak-max', (v, d) => { d.spidershot.streakLengthMax = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-spider-double', (v, d) => { d.spidershot.doubleSpawnChance = v / 100; });
    $('#set-spider-drift').addEventListener('change', (e) => {
      draft((d) => { d.spidershot.horizontalDrift = e.target.checked; });
    });
    this._bindRange('set-spider-drift-speed', (v, d) => { d.spidershot.driftSpeedMax = v; });
    $('#set-spider-random-size').addEventListener('change', (e) => {
      draft((d) => { d.spidershot.randomSize = e.target.checked; });
    });
    this._bindRange('set-spider-size-min', (v, d) => { d.spidershot.randomSizeMin = v; });
    this._bindRange('set-spider-size-max', (v, d) => { d.spidershot.randomSizeMax = v; });
    $('#set-spider-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.spidershot.infiniteAmmo = e.target.checked; });
    });
    $('#set-spider-vm-recoil')?.addEventListener('change', (e) => {
      draft((d) => { d.spidershot.viewmodelRecoil = e.target.checked; });
    });
    $('#set-spider-decoys')?.addEventListener('change', (e) => {
      draft((d) => { d.spidershot.decoyEnabled = e.target.checked; });
    });
    this._bindRange('set-spider-decoy-chance', (v, d) => { d.spidershot.decoyChancePer = v / 100; });
    this._bindRange('set-spider-decoy-min', (v, d) => { d.spidershot.decoyMin = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-spider-decoy-max', (v, d) => { d.spidershot.decoyMax = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-spider-misslimit', (v, d) => { d.spidershot.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-surv-spawn', (v, d) => { d.survival.spawnInterval = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-surv-despawn', (v, d) => { d.survival.despawnTime = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-surv-max-size', (v, d) => { d.survival.maxSize = v; });
    this._bindRange('set-surv-strikes', (v, d) => { d.survival.missesAllowed = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-arena-botdist-min', (v, d) => { d.arena.botDistMin = v; });
    this._bindRange('set-arena-botdist-max', (v, d) => { d.arena.botDistMax = v; });
    this._bindRange('set-arena-col', (v, d) => { d.arena.columns = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-arena-colr', (v, d) => { d.arena.columnRadius = v; });
    this._bindRange('set-arena-ring', (v, d) => { d.arena.ringRadius = v; });
    this._bindRange('set-arena-enemy', (v, d) => { d.arena.enemyScale = v; });
    this._bindRange('set-arena-misslimit', (v, d) => { d.arena.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-snxf-botdist-min', (v, d) => { d.snipercrossfire.botDistMin = v; });
    this._bindRange('set-snxf-botdist-max', (v, d) => { d.snipercrossfire.botDistMax = v; });
    this._bindRange('set-snxf-col', (v, d) => { d.snipercrossfire.columns = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-snxf-colr', (v, d) => { d.snipercrossfire.columnRadius = v; });
    this._bindRange('set-snxf-ring', (v, d) => { d.snipercrossfire.ringRadius = v; });
    this._bindRange('set-snxf-enemy', (v, d) => { d.snipercrossfire.enemyScale = v; });
    this._bindRange('set-snxf-misslimit', (v, d) => { d.snipercrossfire.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    $('#set-duels-arena').addEventListener('change', (e) => {
      draft((d) => { d.duels.arena = parseInt(e.target.value, 10); });
    });
    $('#set-duels-bot-difficulty')?.addEventListener('change', (e) => {
      draft((d) => { d.duels.botDifficulty = e.target.value; });
    });
    this._bindRange('set-duels-ttk', (v, d) => { d.duels.ttk = v; });
    this._bindRange('set-duels-misslimit', (v, d) => { d.duels.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-dm-bots', (v, d) => { d.deathmatch.botCount = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-dm-bot-difficulty')?.addEventListener('change', (e) => {
      draft((d) => { d.deathmatch.botDifficulty = e.target.value; });
    });
    this._bindRange('set-dm-speed', (v, d) => { d.deathmatch.botSpeed = v; });
    this._bindRange('set-dm-body', (v, d) => { d.deathmatch.botBodyHit = v / 100; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-dm-head', (v, d) => { d.deathmatch.botHeadHit = v / 100; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-dm-misslimit', (v, d) => { d.deathmatch.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    const col = (id, key) =>
      $(id).addEventListener('input', (e) => {
        draft((d) => { d.colors[key] = e.target.value; });
      });
    col('#set-col-bg', 'bg');
    col('#set-col-floor', 'floor');
    col('#set-col-ebody', 'enemyBody');
    col('#set-col-ehead', 'enemyHead');
    col('#set-col-cover', 'cover');
    col('#set-col-target', 'target');

    $('#set-range-arc').addEventListener('change', (e) => {
      draft((d) => { d.range.arc = parseInt(e.target.value, 10); });
    });
    $('#set-range-weapon')?.addEventListener('change', (e) => {
      draft((d) => { d.range.weapon = e.target.value; });
    });
    this._bindRange('set-range-count', (v, d) => { d.range.enemyCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-range-rad', (v, d) => { d.range.radius = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-range-bot-move')?.addEventListener('change', (e) => {
      draft((d) => { d.range.botStrafe = e.target.value === 'strafe'; });
    });
    $('#set-range-bot-crouch')?.addEventListener('change', (e) => {
      draft((d) => { d.range.botCrouchTap = e.target.value === 'tap'; });
    });
    $('#set-range-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.range.infiniteAmmo = e.target.checked; });
    });
    $('#set-range-cover').addEventListener('change', (e) => {
      draft((d) => { d.range.coverEnabled = e.target.checked; });
    });
    this._bindRange('set-range-cover-count', (v, d) => { d.range.coverCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-range-cover-dist', (v, d) => { d.range.coverDistance = v; });
    this._bindRange('set-range-cover-thick', (v, d) => { d.range.coverThickness = v; });
    this._bindRange('set-range-cover-height', (v, d) => { d.range.coverHeight = v; });
    this._bindRange('set-range-misslimit', (v, d) => { d.range.missLimit = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-tracking-width', (v, d) => { d.tracking.botWidth = v; });
    this._bindRange('set-tracking-speed', (v, d) => { d.tracking.botSpeed = v; });
    $('#set-tracking-crouch')?.addEventListener('change', (e) => {
      draft((d) => { d.tracking.botCrouchTap = e.target.checked; });
    });
    this._bindRange('set-tracking-strafe', (v, d) => { d.tracking.strafeRate = v; });
    this._bindRange('set-tracking-misslimit', (v, d) => { d.tracking.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    // Duels (AWP)
    $('#set-snholds-bot-difficulty')?.addEventListener('change', (e) => {
      draft((d) => { d.sniperholds.botDifficulty = e.target.value; });
    });
    $('#set-snholds-arena')?.addEventListener('change', (e) => {
      draft((d) => { d.sniperholds.arena = parseInt(e.target.value, 10); });
    });
    this._bindRange('set-snholds-ttk', (v, d) => { d.sniperholds.ttk = v; });
    this._bindRange('set-snholds-misslimit', (v, d) => { d.sniperholds.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    // Pit (AWP)
    this._bindRange('set-snqs-rings', (v, d) => { d.sniperquickscopes.rowCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-snqs-boxes', (v, d) => { d.sniperquickscopes.coverPerRow = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-snqs-dist', (v, d) => { d.sniperquickscopes.rowDistance = v; });
    this._bindRange('set-snqs-spacing', (v, d) => { d.sniperquickscopes.rowSpacing = v; });
    this._bindRange('set-snqs-botspeed', (v, d) => { d.sniperquickscopes.botSpeed = v; });
    this._bindRange('set-snqs-react-min', (v, d) => { d.sniperquickscopes.reactMin = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-snqs-react-max', (v, d) => { d.sniperquickscopes.reactMax = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-snqs-hp', (v, d) => { d.sniperquickscopes.playerHp = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-snqs-misslimit', (v, d) => { d.sniperquickscopes.missLimit = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-snqs-spawn-hint')?.addEventListener('change', (e) => {
      draft((d) => { d.sniperquickscopes.spawnHint = e.target.checked; });
    });

    // Pit (Rifle)
    this._bindRange('set-pit-rings', (v, d) => { d.pitrifle.rowCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-pit-boxes', (v, d) => { d.pitrifle.coverPerRow = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-pit-dist', (v, d) => { d.pitrifle.rowDistance = v; });
    this._bindRange('set-pit-spacing', (v, d) => { d.pitrifle.rowSpacing = v; });
    this._bindRange('set-pit-botspeed', (v, d) => { d.pitrifle.botSpeed = v; });
    this._bindRange('set-pit-react-min', (v, d) => { d.pitrifle.reactMin = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-pit-react-max', (v, d) => { d.pitrifle.reactMax = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-pit-hp', (v, d) => { d.pitrifle.playerHp = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-pit-misslimit', (v, d) => { d.pitrifle.missLimit = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-pit-spawn-hint')?.addEventListener('change', (e) => {
      draft((d) => { d.pitrifle.spawnHint = e.target.checked; });
    });

    // Flicks (AWP)
    this._bindRange('set-snfl-radius-x', (v, d) => { d.sniperflicks.spawnScaleX = v; });
    this._bindRange('set-snfl-radius-y', (v, d) => { d.sniperflicks.spawnScaleY = v; });
    this._bindRange('set-snfl-size', (v, d) => { d.sniperflicks.botScale = v; });
    this._bindRange('set-snfl-min-dist', (v, d) => { d.sniperflicks.minDistance = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-snfl-max-dist', (v, d) => { d.sniperflicks.maxDistance = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-snfl-move')?.addEventListener('change', (e) => {
      draft((d) => { d.sniperflicks.botsMove = e.target.checked; });
    });
    this._bindRange('set-snfl-misslimit', (v, d) => { d.sniperflicks.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    // Tracking (AWP)
    this._bindRange('set-sntr-width', (v, d) => { d.snipertracking.botWidth = v; });
    this._bindRange('set-sntr-speed', (v, d) => { d.snipertracking.botSpeed = v; });
    this._bindRange('set-sntr-hold', (v, d) => { d.snipertracking.holdTime = v; });
    this._bindRange('set-sntr-respawn', (v, d) => { d.snipertracking.respawnDelay = v; });
    this._bindRange('set-sntr-min-dist', (v, d) => { d.snipertracking.minDistance = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-sntr-max-dist', (v, d) => { d.snipertracking.maxDistance = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-sntr-bot-crouch')?.addEventListener('change', (e) => {
      draft((d) => { d.snipertracking.botCrouchTap = e.target.value !== 'off'; });
    });
    this._bindRange('set-sntr-misslimit', (v, d) => { d.snipertracking.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    // Doors (AWP)
    $('#set-doors-cross')?.addEventListener('change', (e) => {
      draft((d) => { d.doorsawp.crossFrom = e.target.value; });
    });
    this._bindRange('set-doors-speed', (v, d) => { d.doorsawp.botSpeed = v; });
    $('#set-doors-feedback')?.addEventListener('change', (e) => {
      draft((d) => { d.doorsawp.shotFeedback = e.target.checked; });
    });
    this._bindRange('set-doors-feedback-dur', (v, d) => { d.doorsawp.shotFeedbackDur = v; });
    this._bindRange('set-doors-misslimit', (v, d) => { d.doorsawp.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-seq-size', (v, d) => { d.sequence.targetSize = v; });
    this._bindRange('set-seq-time', (v, d) => { d.sequence.dotTime = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-seq-start-dist', (v, d) => { d.sequence.startDistance = v; });
    this._bindRange('set-seq-step', (v, d) => { d.sequence.distanceStep = v; });
    $('#set-seq-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.sequence.infiniteAmmo = e.target.checked; });
    });

    this._bindRange('set-double-size', (v, d) => { d.double.targetSize = v; });
    this._bindRange('set-double-canvas', (v, d) => { d.double.canvasSize = v; });
    this._bindRange('set-double-dist', (v, d) => { d.double.canvasDistance = v; });
    this._bindRange('set-double-count', (v, d) => { d.double.canvasCount = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-double-layout')?.addEventListener('change', (e) => {
      draft((d) => { d.double.layout = e.target.value === 'around' ? 'around' : 'flat'; });
    });
    $('#set-double-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.double.infiniteAmmo = e.target.checked; });
    });
    this._bindRange('set-double-misslimit', (v, d) => { d.double.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-ss-start-size', (v, d) => { d.sequencespeed.startSize = v; });
    this._bindRange('set-ss-max-size', (v, d) => { d.sequencespeed.maxSize = v; });
    this._bindRange('set-ss-grow', (v, d) => { d.sequencespeed.growTime = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-ss-start-dist', (v, d) => { d.sequencespeed.startDistance = v; });
    this._bindRange('set-ss-step', (v, d) => { d.sequencespeed.distanceStep = v; });
    $('#set-ss-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.sequencespeed.infiniteAmmo = e.target.checked; });
    });

    this._bindRange('set-st-size', (v, d) => { d.sequencetracking.targetSize = v; });
    this._bindRange('set-st-time', (v, d) => { d.sequencetracking.dotTime = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-st-hold', (v, d) => { d.sequencetracking.holdTime = v; });
    this._bindRange('set-st-float', (v, d) => { d.sequencetracking.floatSpeed = v; });
    this._bindRange('set-st-start-dist', (v, d) => { d.sequencetracking.startDistance = v; });
    this._bindRange('set-st-step', (v, d) => { d.sequencetracking.distanceStep = v; });
    $('#set-st-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.sequencetracking.infiniteAmmo = e.target.checked; });
    });

    this._bindRange('set-dt-size', (v, d) => { d.doubletracking.targetSize = v; });
    this._bindRange('set-dt-hold', (v, d) => { d.doubletracking.holdTime = v; });
    this._bindRange('set-dt-float', (v, d) => { d.doubletracking.floatSpeed = v; });
    this._bindRange('set-dt-canvas', (v, d) => { d.doubletracking.canvasSize = v; });
    this._bindRange('set-dt-dist', (v, d) => { d.doubletracking.canvasDistance = v; });
    this._bindRange('set-dt-count', (v, d) => { d.doubletracking.canvasCount = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-dt-layout')?.addEventListener('change', (e) => {
      this.settings.mutateDraft((d) => { d.doubletracking.layout = e.target.value; });
    });
    $('#set-dt-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.doubletracking.infiniteAmmo = e.target.checked; });
    });
    this._bindRange('set-dt-misslimit', (v, d) => { d.doubletracking.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-ball-size', (v, d) => { d.ball.targetSize = v; });
    this._bindRange('set-ball-speed', (v, d) => { d.ball.travelSpeed = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-ball-min-dist', (v, d) => { d.ball.minDistance = v; });
    this._bindRange('set-ball-max-dist', (v, d) => { d.ball.maxDistance = v; });
    this._bindRange('set-ball-height', (v, d) => { d.ball.bounceHeight = v; });

    this._bindRange('set-bt-size', (v, d) => { d.bouncetracking.targetSize = v; });
    this._bindRange('set-bt-count', (v, d) => { d.bouncetracking.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-bt-speed', (v, d) => { d.bouncetracking.travelSpeed = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-bt-hold', (v, d) => { d.bouncetracking.holdTime = v; });
    this._bindRange('set-bt-height', (v, d) => { d.bouncetracking.bounceHeight = v; });
    this._bindRange('set-bt-misslimit', (v, d) => { d.bouncetracking.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-pt-size', (v, d) => { d.pasutracking.targetSize = v; });
    this._bindRange('set-pt-count', (v, d) => { d.pasutracking.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-pt-hold', (v, d) => { d.pasutracking.trackTime = v; });
    this._bindRange('set-pt-travel-speed', (v, d) => { d.pasutracking.travelSpeedMax = v; });
    this._bindRange('set-pt-misslimit', (v, d) => { d.pasutracking.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-turn-size', (v, d) => { d.turn.targetSize = v; });
    this._bindRange('set-turn-time', (v, d) => { d.turn.dotTime = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-turn-despawn-miss')?.addEventListener('change', (e) => {
      this.settings.mutateDraft((d) => { d.turn.despawnOnMiss = e.target.checked; });
    });
    $('#set-turn-infinite-ammo')?.addEventListener('change', (e) => {
      draft((d) => { d.turn.infiniteAmmo = e.target.checked; });
    });

    this._bindRange('set-box-size', (v, d) => { d.box.targetSize = v; });
    this._bindRange('set-box-w', (v, d) => { d.box.sizeX = v; });
    this._bindRange('set-box-h', (v, d) => { d.box.sizeY = v; });
    this._bindRange('set-box-speed', (v, d) => { d.box.travelSpeed = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-box-variance', (v, d) => { d.box.speedVariance = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-box-misslimit', (v, d) => { d.box.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-circle-size', (v, d) => { d.circle.targetSize = v; });
    this._bindRange('set-circle-w', (v, d) => { d.circle.sizeX = v; });
    this._bindRange('set-circle-h', (v, d) => { d.circle.sizeY = v; });
    this._bindRange('set-circle-speed', (v, d) => { d.circle.travelSpeed = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-circle-variance', (v, d) => { d.circle.speedVariance = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-circle-misslimit', (v, d) => { d.circle.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-3s-size', (v, d) => { d.threeshot.targetSize = v; });
    this._bindRange('set-3s-count', (v, d) => { d.threeshot.targetCount = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-3s-float')?.addEventListener('change', (e) => {
      draft((d) => { d.threeshot.floatEnabled = e.target.checked; });
    });
    this._bindRange('set-3s-float-speed', (v, d) => { d.threeshot.floatSpeedMax = v; });
    this._bindRange('set-3s-bounds-x', (v, d) => { d.threeshot.boundsScaleX = v; });
    this._bindRange('set-3s-bounds-y', (v, d) => { d.threeshot.boundsScaleY = v; });
    this._bindRange('set-3s-misslimit', (v, d) => { d.threeshot.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-cover-rows', (v, d) => { d.cover.rowCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-boxes', (v, d) => { d.cover.coverPerRow = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-dist', (v, d) => { d.cover.rowDistance = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-spacing', (v, d) => { d.cover.rowSpacing = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-botspeed', (v, d) => { d.cover.botSpeed = v; });
    this._bindRange('set-cover-react-min', (v, d) => { d.cover.reactMin = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-react-max', (v, d) => { d.cover.reactMax = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-hp', (v, d) => { d.cover.playerHp = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-bothp', (v, d) => { d.cover.botHp = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cover-misslimit', (v, d) => { d.cover.missLimit = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-cover-spawn-hint')?.addEventListener('change', (e) => {
      this.settings.mutateDraft((d) => { d.cover.spawnHint = e.target.checked; });
    });

    this._bindRange('set-cvawp-rows', (v, d) => { d.coverawp.rowCount = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cvawp-boxes', (v, d) => { d.coverawp.coverPerRow = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cvawp-dist', (v, d) => { d.coverawp.rowDistance = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cvawp-spacing', (v, d) => { d.coverawp.rowSpacing = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cvawp-botspeed', (v, d) => { d.coverawp.botSpeed = v; });
    this._bindRange('set-cvawp-react-min', (v, d) => { d.coverawp.reactMin = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cvawp-react-max', (v, d) => { d.coverawp.reactMax = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cvawp-hp', (v, d) => { d.coverawp.playerHp = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-cvawp-misslimit', (v, d) => { d.coverawp.missLimit = v; }, { parse: (v) => parseInt(v, 10) });
    $('#set-cvawp-spawn-hint')?.addEventListener('change', (e) => {
      this.settings.mutateDraft((d) => { d.coverawp.spawnHint = e.target.checked; });
    });

    this._bindRange('set-drone-size', (v, d) => { d.drone.targetSize = v; });
    this._bindRange('set-drone-speed', (v, d) => { d.drone.travelSpeed = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-drone-min-dist', (v, d) => { d.drone.minDistance = v; });
    this._bindRange('set-drone-max-dist', (v, d) => { d.drone.maxDistance = v; });
    this._bindRange('set-drone-height', (v, d) => { d.drone.bounceHeight = v; });

    this._bindRange('set-line-size', (v, d) => { d.line.targetSize = v; });
    this._bindRange('set-line-speed', (v, d) => { d.line.travelSpeed = v; }, { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-line-misslimit', (v, d) => { d.line.missLimit = v; }, { parse: (v) => parseInt(v, 10) });

    $('#settings-undo-btn')?.addEventListener('click', () => {
      if (this._settingsExploreMode || this.settings.isExploreMode) return;
      if (s.undoDraft()) {
        this._populateSettings();
        this._updateSettingsBar();
      }
    });
    $('#settings-done-btn')?.addEventListener('click', () => this._closeSettings());
  }

  // -------------------------------------------------------------------------
  // Playlists
  // -------------------------------------------------------------------------

  _setPlaylistStatus(msg, isError = false) {
    const el = this.root.querySelector('#playlist-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  _setPlaylistEditStatus(msg, isError = false) {
    const el = this.root.querySelector('#playlist-edit-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  /** Short label like "Gridshot · 60s" / "Gridshot · 100 kills". */
  _modeSummary(item) {
    const title = SCENARIO_META[item.scenario]?.title || item.scenario;
    const dur = resolveModeDuration(item.config, 60);
    const tail = dur.type === 'kills' ? `${dur.value} kills` : `${dur.value}s`;
    return `${title} · ${tail}`;
  }

  _bindPlaylists() {
    const $ = (id) => this.root.querySelector(id);

    // ---- Viewer -----------------------------------------------------------
    $('#playlist-new-btn')?.addEventListener('click', () => this._openPlaylistEditor(null));

    $('#playlist-import-btn')?.addEventListener('click', () => {
      const raw = $('#playlist-import-code')?.value;
      if (!raw || !raw.trim()) { this._setPlaylistStatus('Paste a playlist code first.', true); return; }
      let playlist;
      try {
        playlist = decodePlaylist(raw);
      } catch (err) {
        this._setPlaylistStatus(err.message || 'Invalid playlist code', true);
        return;
      }
      const usable = playlist.items.filter((it) => SCENARIOS[it.scenario]);
      if (!usable.length) { this._setPlaylistStatus('That playlist has no known modes.', true); return; }
      playlist.items = usable;
      savePlaylist(playlist);
      if ($('#playlist-import-code')) $('#playlist-import-code').value = '';
      this._renderPlaylists();
      this._setPlaylistStatus(`Imported "${playlist.name}".`);
    });

    $('#playlists-list')?.addEventListener('click', (e) => {
      const el = e.target.closest('[data-playlist-play],[data-playlist-lb],[data-playlist-share],[data-playlist-edit],[data-playlist-del]');
      if (!el) return;
      const id =
        el.dataset.playlistPlay || el.dataset.playlistLb || el.dataset.playlistShare ||
        el.dataset.playlistEdit || el.dataset.playlistDel;
      const playlist = loadPlaylists().find((p) => p.id === id);
      if (!playlist) return;
      if (el.dataset.playlistPlay != null) this._startPlaylist(playlist);
      else if (el.dataset.playlistLb != null) this._openPlaylistLeaderboard(playlist);
      else if (el.dataset.playlistShare != null) this._sharePlaylist(playlist);
      else if (el.dataset.playlistEdit != null) this._openPlaylistEditor(playlist);
      else if (el.dataset.playlistDel != null) {
        deletePlaylist(id);
        this._renderPlaylists();
        this._setPlaylistStatus(`Deleted "${playlist.name}".`);
      }
    });

    // ---- Editor -----------------------------------------------------------
    $('#playlist-add-current')?.addEventListener('click', () => {
      const scenario = $('#playlist-add-mode')?.value;
      if (!scenario || !SCENARIOS[scenario]) return;
      const { config } = this.settings.getModeConfig(scenario);
      this._playlistDraft.push({ scenario, config });
      this._renderPlaylistDraft();
      this._setPlaylistEditStatus(`Added ${SCENARIO_META[scenario]?.title || scenario} with its current settings.`);
    });

    $('#playlist-add-code-btn')?.addEventListener('click', () => {
      const raw = $('#playlist-add-code')?.value;
      if (!raw || !raw.trim()) { this._setPlaylistEditStatus('Paste a mode code first.', true); return; }
      let decoded;
      try {
        decoded = decodeModeConfig(raw);
      } catch (err) {
        this._setPlaylistEditStatus(err.message || 'Invalid mode code', true);
        return;
      }
      if (!SCENARIOS[decoded.scenario]) {
        this._setPlaylistEditStatus('That code is for an unknown mode.', true);
        return;
      }
      this._playlistDraft.push({ scenario: decoded.scenario, config: decoded.config });
      $('#playlist-add-code').value = '';
      this._renderPlaylistDraft();
      this._setPlaylistEditStatus(`Added ${SCENARIO_META[decoded.scenario]?.title || decoded.scenario} from code.`);
    });

    $('#playlist-draft-items')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-playlist-settings],[data-playlist-remove],[data-playlist-up],[data-playlist-down]');
      if (!btn) return;
      const items = this._playlistDraft;
      if (btn.dataset.playlistSettings != null) {
        const idx = parseInt(btn.dataset.playlistSettings, 10);
        if (Number.isInteger(idx) && items[idx]) this._openPlaylistItemSettings(idx);
        return;
      }
      if (btn.dataset.playlistRemove != null) {
        const idx = parseInt(btn.dataset.playlistRemove, 10);
        if (Number.isInteger(idx)) items.splice(idx, 1);
      } else if (btn.dataset.playlistUp != null) {
        const idx = parseInt(btn.dataset.playlistUp, 10);
        if (idx > 0) [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
      } else if (btn.dataset.playlistDown != null) {
        const idx = parseInt(btn.dataset.playlistDown, 10);
        if (idx >= 0 && idx < items.length - 1) [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
      }
      this._renderPlaylistDraft();
    });

    $('#playlist-save-btn')?.addEventListener('click', () => this._savePlaylistEditor());
    $('#playlist-edit-cancel')?.addEventListener('click', () => {
      this._playlistEdit = null;
      this._playlistDraft = [];
      this._renderPlaylists();
      this.showScreen('playlists');
    });

    // Playlist results screen (between modes + final).
    $('#pl-res-continue')?.addEventListener('click', () => this._playlistContinue());
    $('#pl-res-again')?.addEventListener('click', () => {
      if (this._lastPlaylist) this._startPlaylist(this._lastPlaylist);
    });
    $('#pl-res-quit')?.addEventListener('click', () => this._quitPlaylist());
  }

  /** Open the editor for an existing playlist, or empty for a new one. */
  _openPlaylistEditor(playlist) {
    this._playlistEdit = playlist
      ? { id: playlist.id, createdAt: playlist.createdAt }
      : { id: null };
    this._playlistDraft = structuredClone(playlist?.items || []);
    const title = this.root.querySelector('#playlist-edit-title');
    if (title) title.textContent = playlist ? `Edit — ${playlist.name}` : 'New playlist';
    const name = this.root.querySelector('#playlist-name');
    if (name) name.value = playlist?.name || '';
    const code = this.root.querySelector('#playlist-add-code');
    if (code) code.value = '';
    this._setPlaylistEditStatus('');
    this._renderPlaylistDraft();
    this.showScreen('playlist-edit');
  }

  _savePlaylistEditor() {
    if (!this._playlistDraft.length) {
      this._setPlaylistEditStatus('Add at least one mode before saving.', true);
      return;
    }
    const name = this.root.querySelector('#playlist-name')?.value?.trim() || 'Untitled playlist';
    let playlist;
    if (this._playlistEdit?.id) {
      // Editing keeps the id so the saved list entry is replaced in place. Note
      // the leaderboard key is derived from the items, so changing modes moves
      // the playlist onto a different (matching) shared board.
      playlist = {
        id: this._playlistEdit.id,
        name: name.slice(0, 60),
        items: structuredClone(this._playlistDraft),
        createdAt: this._playlistEdit.createdAt ?? Date.now()
      };
    } else {
      playlist = createPlaylist(name, this._playlistDraft);
    }
    savePlaylist(playlist);
    this._playlistEdit = null;
    this._playlistDraft = [];
    this._renderPlaylists();
    this._setPlaylistStatus(`Saved "${playlist.name}".`);
    this.showScreen('playlists');
  }

  async _sharePlaylist(playlist) {
    try {
      await copyText(encodePlaylist(playlist));
      this._setPlaylistStatus(`Copied share code for "${playlist.name}".`);
    } catch (err) {
      this._setPlaylistStatus(err.message || 'Could not copy code', true);
    }
  }

  _renderPlaylists() {
    const el = this.root.querySelector('#playlists-list');
    if (el) {
      const list = loadPlaylists();
      if (!list.length) {
        el.innerHTML = '<p class="center lb-hint">No playlists yet — press “New playlist” to build one.</p>';
      } else {
        el.innerHTML = list.map((p) => {
          const chain = (p.items || [])
            .map((it) => SCENARIO_META[it.scenario]?.title || it.scenario)
            .join(' → ');
          return `
          <div class="playlist-row" data-playlist-id="${p.id}">
            <div class="playlist-row-main">
              <span class="playlist-row-title">${this._esc(p.name)}</span>
              <span class="playlist-row-sub">${(p.items || []).length} mode${(p.items || []).length === 1 ? '' : 's'} · ${this._esc(chain)}</span>
            </div>
            <div class="playlist-row-actions">
              <button type="button" class="btn training-row-play" data-playlist-play="${p.id}">Play</button>
              <button type="button" class="training-row-lb" data-playlist-lb="${p.id}" aria-label="Playlist leaderboard"><img src="${LEADERBOARD_ICON}" alt="" class="aim4-icon" width="16" height="16" /></button>
              <button type="button" class="training-row-gear" data-playlist-edit="${p.id}" aria-label="Edit playlist">${PENCIL_ICON}</button>
              <button type="button" class="training-row-gear" data-playlist-share="${p.id}" aria-label="Copy share code">${PLAYLIST_ICON}</button>
              <button type="button" class="training-row-gear" data-playlist-del="${p.id}" aria-label="Delete playlist">${TRASH_ICON}</button>
            </div>
          </div>`;
        }).join('');
      }
    }
    this._setPlaylistStatus('');
  }

  _renderPlaylistDraft() {
    const el = this.root.querySelector('#playlist-draft-items');
    if (!el) return;
    if (!this._playlistDraft.length) {
      el.innerHTML = '<p class="lb-hint">No modes added yet.</p>';
      return;
    }
    const last = this._playlistDraft.length - 1;
    el.innerHTML = this._playlistDraft.map((it, i) => {
      const gear = SCENARIO_SETTING_IDS.has(it.scenario)
        ? `<button type="button" class="training-row-gear" data-playlist-settings="${i}" aria-label="Edit mode settings">${GEAR_ICON}</button>`
        : '';
      return `
      <div class="playlist-draft-item">
        <span class="playlist-draft-idx">${i + 1}</span>
        <span class="playlist-draft-name">${this._esc(this._modeSummary(it))}</span>
        ${gear}
        <button type="button" class="training-row-gear" data-playlist-up="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="training-row-gear" data-playlist-down="${i}" aria-label="Move down" ${i === last ? 'disabled' : ''}>▼</button>
        <button type="button" class="training-row-gear" data-playlist-remove="${i}" aria-label="Remove">${TRASH_ICON}</button>
      </div>`;
    }).join('');
  }

  // ---- Playlist run lifecycle ----

  _startPlaylist(playlist) {
    if (!playlist?.items?.length) {
      this._setPlaylistStatus('That playlist is empty.', true);
      return;
    }
    this._playlistRun = { playlist, index: 0, results: [] };
    this._lastPlaylist = playlist;
    this._playPlaylistItem();
  }

  /** Load + start the current playlist item with its own settings + duration. */
  _playPlaylistItem() {
    const run = this._playlistRun;
    if (!run) return;
    const item = run.playlist.items[run.index];
    if (!item) return;
    const cfg = item.config || {};
    // The item's config is passed straight to the scenario (ctors prefer
    // config over settings) AND temporarily merged onto live settings for the
    // few reads that bypass config. Restored right after construction.
    this.settings.beginModeOverride(item.scenario, cfg);
    try {
      const runCfg = structuredClone(cfg);
      delete runCfg.variant; // playlist items always run as practice
      this.play(item.scenario, runCfg);
    } finally {
      this.settings.endModeOverride();
    }
  }

  _playlistContinue() {
    const run = this._playlistRun;
    if (!run) return;
    run.index += 1;
    this._playPlaylistItem();
  }

  _quitPlaylist() {
    this._playlistRun = null;
    this.settings.endModeOverride();
    this.sceneManager.unload();
    this.input.exitLock();
    this._renderPlaylists();
    this.showScreen('playlists');
  }

  _onPlaylistModeFinish(results) {
    this.state = 'results';
    this.input.exitLock();
    this.replayRecorder?.cancel();
    const run = this._playlistRun;
    run.results.push(results);
    if (this.auth?.isLoggedIn && results.timePlayed > 0) {
      incrementPlayTime(this.auth.user.id, results.timePlayed).catch((e) =>
        console.warn('[ui] play time log failed', e)
      );
    }
    const isLast = run.index >= run.playlist.items.length - 1;
    if (isLast) {
      this._finalizePlaylist();
    } else {
      this._showPlaylistIntermission(results);
    }
  }

  _modeStatHtml(results) {
    const stat = (label, val) =>
      `<div class="stat"><span class="stat-value">${val}</span><label>${label}</label></div>`;
    const isKill = isKillLeaderboardScenario(results.scenario);
    const scoreVal = results.scenario === 'reactiontime'
      ? `${results.score} ms`
      : (isKill ? results.kills : results.score.toLocaleString());
    return (
      stat(isKill ? 'Kills' : 'Score', scoreVal) +
      stat('Accuracy', Math.round(results.accuracy * 100) + '%') +
      stat('Hits / Shots', `${results.hits}/${results.shots}`) +
      stat('Time', this._formatTimePlayed(results.timePlayed))
    );
  }

  _showPlaylistIntermission(results) {
    const run = this._playlistRun;
    const n = run.playlist.items.length;
    const next = run.playlist.items[run.index + 1];
    const $ = (id) => this.root.querySelector(id);
    if ($('#pl-res-title')) $('#pl-res-title').textContent = run.playlist.name;
    if ($('#pl-res-progress')) {
      const title = SCENARIO_META[results.scenario]?.title || results.scenario;
      $('#pl-res-progress').textContent = `${title} done — mode ${run.index + 1} of ${n}`;
    }
    if ($('#pl-res-stats')) $('#pl-res-stats').innerHTML = this._modeStatHtml(results);
    if ($('#pl-res-lb')) $('#pl-res-lb').innerHTML = '';
    const cont = $('#pl-res-continue');
    if (cont) {
      cont.hidden = false;
      cont.textContent = next
        ? `Next: ${SCENARIO_META[next.scenario]?.title || next.scenario}`
        : 'Continue';
    }
    if ($('#pl-res-again')) $('#pl-res-again').hidden = true;
    this.showScreen('playlist-results');
  }

  async _finalizePlaylist() {
    const run = this._playlistRun;
    const playlist = run.playlist;
    const combined = combinePlaylistResults(playlist, run.results);
    const $ = (id) => this.root.querySelector(id);

    if ($('#pl-res-title')) $('#pl-res-title').textContent = `${playlist.name} — complete`;
    if ($('#pl-res-progress')) {
      $('#pl-res-progress').textContent = `${playlist.items.length} modes · combined score`;
    }
    const stat = (label, val) =>
      `<div class="stat"><span class="stat-value">${val}</span><label>${label}</label></div>`;
    if ($('#pl-res-stats')) {
      $('#pl-res-stats').innerHTML =
        stat('Total score', combined.score.toLocaleString()) +
        stat('Kills', combined.kills) +
        stat('Accuracy', Math.round(combined.accuracy * 100) + '%') +
        stat('Hits / Shots', `${combined.hits}/${combined.shots}`) +
        stat('Time', this._formatTimePlayed(combined.timePlayed));
    }
    if ($('#pl-res-continue')) $('#pl-res-continue').hidden = true;
    if ($('#pl-res-again')) $('#pl-res-again').hidden = false;
    if ($('#pl-res-lb')) $('#pl-res-lb').innerHTML = '<p class="center lb-hint">Loading leaderboard…</p>';
    this.showScreen('playlist-results');

    // This run is done; allow "Play again" to start a fresh one.
    this._playlistRun = null;

    let note = '';
    if (this.auth?.isLoggedIn) {
      try {
        await this.auth.ensureProfileReady();
      } catch (e) {
        console.warn('[ui] profile ensure failed (playlist)', e);
      }
      const res = await submitScore(this.auth.user.id, combined);
      if (!res.ok && res.reason !== 'offline') note = `Score not saved: ${res.reason}`;
    } else if (supabaseConfigured()) {
      note = 'Sign in to save to the playlist leaderboard.';
    }

    const { list, error } = await fetchLeaderboardWithMeta(
      PLAYLIST_SCENARIO,
      playlistConfigKey(playlist),
      10
    );
    const board = this._playlistBoardRowsHtml(list, error);
    if ($('#pl-res-lb')) {
      $('#pl-res-lb').innerHTML = note ? `<p class="center lb-hint muted">${note}</p>${board}` : board;
    }
  }

  // ---- Playlist leaderboard ----

  _setLbPlaylistMode(on, name = '') {
    const eloTab = this.root.querySelector('#lb-tab-elo');
    const selWrap = this.root.querySelector('.lb-mode-select-wrap');
    const title = this.root.querySelector('#lb-playlist-title');
    if (eloTab) eloTab.hidden = on;
    if (selWrap) selWrap.hidden = on;
    if (title) {
      title.hidden = !on;
      title.textContent = name || 'Playlist';
    }
  }

  _openPlaylistLeaderboard(playlist) {
    this._returnAfterLeaderboard = 'playlists';
    this._setLbPlaylistMode(true, playlist.name);
    this.showScreen('leaderboard');
    this._renderPlaylistLeaderboard(playlist);
  }

  async _renderPlaylistLeaderboard(playlist) {
    const body = this.root.querySelector('#lb-body');
    if (!body) return;
    body.innerHTML = '<p class="center">…</p>';
    const { list, error } = await fetchLeaderboardWithMeta(
      PLAYLIST_SCENARIO,
      playlistConfigKey(playlist),
      10
    );
    body.innerHTML = this._playlistBoardRowsHtml(list, error);
  }

  _playlistBoardRowsHtml(list, error = null) {
    if (!supabaseConfigured()) {
      return '<p class="center lb-hint">Account leaderboards are not configured.</p>';
    }
    if (error) {
      return `<p class="center lb-hint lb-error">Could not load leaderboard: ${this._esc(error)}</p>`;
    }
    if (!list.length) {
      return `<p class="center lb-hint">${this.auth?.isLoggedIn
        ? 'No scores yet — finish this playlist to appear here.'
        : 'No scores yet — sign in and play to appear here.'}</p>`;
    }
    const rows = list.map((r, i) => {
      const hl = this.auth?.user?.id && r.user_id === this.auth.user.id ? ' class="hl"' : '';
      const date = this._formatLbRunWhen(r.achieved_at);
      return `<tr${hl}>
        <td>${i + 1}</td>
        ${this._lbPlayerCell(r)}
        <td class="score">${Number(r.score).toLocaleString()}</td>
        <td>${Math.round((r.accuracy || 0) * 100)}%</td>
        <td class="lb-when">${date}</td>
      </tr>`;
    }).join('');
    return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Acc</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  _bindPauseMenu() {
    const $ = (id) => this.root.querySelector(id);
    $('#pause-settings-btn')?.addEventListener('click', () => {
      const scenarioId = this._canOpenInRunScenarioSettings();
      if (scenarioId) {
        this._openScenarioSettings(scenarioId, { live: true, returnTo: 'paused' });
        return;
      }
      this._returnAfterSettings = 'paused';
      this.showScreen('settings');
    });
    $('#pause-leave-lobby-btn')?.addEventListener('click', () => {
      this.mp?.returnToLobby();
    });
  }

  _closeSettings() {
    if (this._settingsExploreMode) {
      this._closeSettingsExplore();
      return;
    }
    this.settings.confirmDraft();
    this._updateSettingsBar();
    const ret = this._returnAfterSettings;
    this._returnAfterSettings = null;
    if (ret) {
      this.showScreen(ret);
      if (ret === 'paused') this._updatePauseMenu();
    } else {
      this.showScreen('menu');
    }
  }

  _closeSettingsExplore() {
    this._setSettingsExploreUi(false);
    this.settings.closeExploreDraft();
    this._settingsExploreMode = false;
    this._settingsExplorePayload = null;
    this._settingsExploreUser = null;
    const ret = this._returnAfterSettings ?? 'account';
    this._returnAfterSettings = null;
    this.showScreen(ret, { skipSettingsOpen: true });
  }

  async _openUserSettingsExplore() {
    const acc = this._viewingAccount;
    if (!acc?.userId) return;
    const status = this.root.querySelector('#account-profile-status-other');
    if (status) {
      status.textContent = 'Loading settings…';
      status.classList.remove('is-error');
    }
    let payload = acc.settings;
    if (payload === undefined) {
      try {
        payload = await fetchPublicSettings(acc.userId);
        acc.settings = payload;
      } catch (e) {
        if (status) {
          status.textContent = e.message || 'Could not load settings.';
          status.classList.add('is-error');
        }
        return;
      }
    }
    if (!payload) {
      if (status) {
        status.textContent = 'This player has not saved cloud settings yet.';
        status.classList.remove('is-error');
      }
      return;
    }
    if (status) status.textContent = '';
    this._settingsExploreMode = true;
    this._settingsExplorePayload = payload;
    this._settingsExploreUser = acc.username || 'Player';
    this._returnAfterSettings = 'account';
    this.settings.openExploreDraft(payload);
    this._populateSettings();
    this.crosshair.drawPreview();
    this._setSettingsExploreUi(true);
    this.showScreen('settings', { skipSettingsOpen: true });
  }

  _setSettingsExploreUi(on) {
    const layout = this.root.querySelector('.settings-layout');
    layout?.classList.toggle('is-explore', on);
    const banner = this.root.querySelector('#settings-explore-banner');
    const nameEl = this.root.querySelector('#settings-explore-name');
    if (banner) banner.hidden = !on;
    if (nameEl && on) nameEl.textContent = this._settingsExploreUser || 'Player';
    this._updateSettingsBar();
  }

  _updatePauseMenu() {
    const leaveBtn = this.root.querySelector('#pause-leave-lobby-btn');
    const restartBtn = this.root.querySelector('#pause-restart-btn');
    const gearBtn = this.root.querySelector('#pause-settings-btn');
    const inMpMatch = this.mp?.inMatch && !!this.mp?.lobby;
    if (leaveBtn) leaveBtn.hidden = !inMpMatch;
    if (restartBtn) restartBtn.hidden = !!inMpMatch;
    if (gearBtn) {
      const modeId = this._canOpenInRunScenarioSettings();
      gearBtn.hidden = !this.sceneManager.current;
      gearBtn.setAttribute('aria-label', modeId ? 'Mode settings' : 'Settings');
    }
  }

  // -------------------------------------------------------------------------
  // Account auth
  // -------------------------------------------------------------------------
  _accountLabel() {
    const name = this.auth?.displayName;
    return name ? `@${name}` : 'Signed in';
  }

  refreshAccountBar() {
    const section = this.root.querySelector('#menu-auth');
    const guest = this.root.querySelector('#menu-auth-guest');
    const userRow = this.root.querySelector('#menu-auth-user');
    if (!section) return;
    if (!this.auth?.isConfigured) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    if (this.auth.isLoggedIn) {
      guest?.classList.add('hidden');
      userRow?.classList.remove('hidden');
    } else {
      guest?.classList.remove('hidden');
      userRow?.classList.add('hidden');
    }
  }

  _bindAuth() {
    const $ = (id) => this.root.querySelector(id);
    const status = $('#auth-status');
    const setStatus = (msg, ok = true) => {
      status.textContent = msg || '';
      status.classList.toggle('is-error', !ok);
    };

    $('#menu-login-btn')?.addEventListener('click', () => this._openAuth('login'));
    $('#menu-signup-btn')?.addEventListener('click', () => this._openAuth('register'));
    $('#menu-account-btn')?.addEventListener('click', () => this._openAccount());
    $('#account-back-btn')?.addEventListener('click', () => {
      const dest = this._returnAfterAccount || 'menu';
      if (dest !== 'account') this._viewingAccount = null;
      this.showScreen(dest, { skipSettingsOpen: true });
    });
    $('#account-view-settings-btn')?.addEventListener('click', () => this._openUserSettingsExplore());
    $('#menu-logout-btn')?.addEventListener('click', async () => {
      this.mp?.leaveQueue();
      await this.auth.signOut();
      this.refreshAccountBar();
      this._updateQueueChip({ inQueue: false });
    });

    $('#auth-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-auth-tab]');
      if (!tab) return;
      this._setAuthMode(tab.dataset.authTab);
    });

    $('#auth-google')?.addEventListener('click', async () => {
      setStatus('Redirecting to Google…');
      try {
        await this.auth.signInWithGoogle();
      } catch (e) {
        setStatus(e.message || 'Google sign-in failed.', false);
      }
    });

    $('#auth-submit')?.addEventListener('click', async () => {
      const username = $('#auth-username')?.value?.trim();
      const email = $('#auth-email')?.value?.trim();
      const password = $('#auth-password')?.value || '';
      const password2 = $('#auth-password2')?.value || '';
      setStatus('…');
      try {
        if (this._authMode === 'register') {
          if (password !== password2) throw new Error('Passwords do not match.');
          const result = await this.auth.signUp({ username, email, password });
          if (result.pendingConfirmation) {
            setStatus(`Check ${result.email} for a confirmation link, then sign in.`, true);
            this._setAuthMode('login');
            return;
          }
          setStatus('Account created!', true);
        } else {
          await this.auth.signIn({ email, password });
          setStatus('', true);
        }
        this.refreshAccountBar();
        this._syncMpNameFromAccount();
        this.showScreen('menu');
      } catch (e) {
        setStatus(e.message || 'Authentication failed.', false);
      }
    });

    $('#auth-password')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#auth-submit')?.click();
    });

    this._bindAccount();
  }

  _bindAccount() {
    const $ = (id) => this.root.querySelector(id);
    const profileStatus = $('#account-profile-status');
    const setProfileStatus = (msg, ok = true) => {
      if (!profileStatus) return;
      profileStatus.textContent = msg || '';
      profileStatus.classList.toggle('is-error', !ok);
    };

    $('#account-username-save')?.addEventListener('click', async () => {
      setProfileStatus('Saving…');
      try {
        await this.auth.updateUsername($('#account-username')?.value || '');
        setProfileStatus('Username updated.', true);
        this.refreshAccountBar();
        this._syncMpNameFromAccount();
      } catch (e) {
        setProfileStatus(e.message || 'Could not update username.', false);
      }
    });

    $('#account-country-save')?.addEventListener('click', async () => {
      setProfileStatus('Saving…');
      try {
        const code = $('#account-country')?.value || '';
        await this.auth.updateCountryCode(code || null);
        setProfileStatus('Country flag updated.', true);
        this.refreshAccountBar();
      } catch (e) {
        setProfileStatus(e.message || 'Could not update country.', false);
      }
    });

    $('#account-link-google')?.addEventListener('click', async () => {
      setProfileStatus('Redirecting to Google…');
      try {
        await this.auth.linkGoogle();
      } catch (e) {
        setProfileStatus(e.message || 'Could not link Google.', false);
      }
    });
  }

  _openAccount(userId = null, username = null) {
    if (userId && this.auth?.user?.id === userId) userId = null;
    if (!userId) {
      if (!this.auth?.isLoggedIn) {
        this._openAuth('login');
        return;
      }
      this._viewingAccount = null;
      this._returnAfterAccount = this.state === 'leaderboard' ? 'leaderboard' : 'menu';
      this.showScreen('account', { skipSettingsOpen: true });
      this._refreshAccountScreen();
      return;
    }
    this._viewingAccount = { userId, username: username || 'Player' };
    this._returnAfterAccount = 'leaderboard';
    this.showScreen('account', { skipSettingsOpen: true });
    this._refreshAccountScreen();
    this._loadOtherAccount(userId);
  }

  _refreshAccountScreen() {
    const isOther = !!this._viewingAccount;
    this.root.querySelector('#account-profile-own')?.toggleAttribute('hidden', isOther);
    this.root.querySelector('#account-profile-other')?.toggleAttribute('hidden', !isOther);
    this.root.querySelector('#account-view-settings-btn')?.toggleAttribute('hidden', !isOther);
    if (!isOther) {
      this._populateAccountForm();
      this._loadAccountStats();
      this._aimStatsUserId = this.auth?.user?.id || null;
      this._loadAimStats();
      this._loadRating();
      this._loadAimSummary(this.auth?.user?.id);
      this._loadAccountReplays();
      this._loadAccountPlayTime(this.auth?.user?.id);
    }
  }

  async _loadAccountPlayTime(userId) {
    const ownEl = this.root.querySelector('#account-play-time');
    const otherEl = this.root.querySelector('#account-ro-play-time');
    const el = this._viewingAccount ? otherEl : ownEl;
    if (!el) return;
    if (!userId || !supabaseConfigured()) {
      el.textContent = '';
      return;
    }
    try {
      const profile = await fetchPublicProfile(userId);
      el.textContent = profile
        ? `Time played: ${formatPlayTime(profile.play_time_sec)}`
        : '';
    } catch {
      el.textContent = '';
    }
  }

  async _loadOtherAccount(userId) {
    const roName = this.root.querySelector('#account-ro-username');
    const roFlag = this.root.querySelector('#account-ro-flag');
    const roElo = this.root.querySelector('#account-ro-elo');
    const status = this.root.querySelector('#account-profile-status-other');
    const statsBody = this.root.querySelector('#account-stats');
    if (statsBody) statsBody.innerHTML = '<p class="center lb-hint">Loading…</p>';
    if (status) {
      status.textContent = '';
      status.classList.remove('is-error');
    }
    try {
      const profile = await fetchPublicProfile(userId);
      if (!profile) throw new Error('Player not found.');
      const name = profile.username || this._viewingAccount?.username || 'Player';
      this._viewingAccount = {
        userId,
        username: name,
        countryCode: profile.country_code,
        elo: profile.elo,
        settings: undefined
      };
      if (roName) roName.textContent = name;
      if (roFlag) {
        roFlag.textContent = profile.country_code ? flagEmoji(profile.country_code) : '';
        roFlag.hidden = !profile.country_code;
      }
      if (roElo) {
        roElo.textContent = profile.elo != null ? `${profile.elo} ELO` : '';
      }
      const stats = await fetchAllAccountStats(userId);
      if (statsBody) statsBody.innerHTML = this._accountStatsHtml(stats);
      this._aimStatsUserId = userId;
      this._loadAimStats();
      this._loadRating();
      this._loadAimSummary(userId);
      await this._loadAccountReplays(userId);
      this._loadAccountPlayTime(userId);
    } catch (e) {
      if (statsBody) {
        statsBody.innerHTML = `<p class="center lb-hint is-error">${this._esc(e.message || 'Could not load account.')}</p>`;
      }
      if (status) {
        status.textContent = e.message || 'Could not load account.';
        status.classList.add('is-error');
      }
    }
  }

  _populateAccountForm() {
    const $ = (id) => this.root.querySelector(id);
    const username = $('#account-username');
    if (username) username.value = this.auth.displayName || '';
    const country = $('#account-country');
    if (country) country.innerHTML = countryOptionsHtml(this.auth.countryCode);
    this._renderAccountGoogleLink();
    const st = this.root.querySelector('#account-profile-status');
    if (st) {
      st.textContent = '';
      st.classList.remove('is-error');
    }
  }

  _renderAccountGoogleLink() {
    const wrap = this.root.querySelector('#account-google-wrap');
    const btn = this.root.querySelector('#account-link-google');
    if (!wrap || !this.auth?.isConfigured || !this.auth.canLinkGoogle) {
      wrap?.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    btn?.classList.remove('hidden');
  }

  async _loadAccountStats() {
    const body = this.root.querySelector('#account-stats');
    if (!body || !this.auth?.user) return;
    body.innerHTML = '<p class="center lb-hint">Loading…</p>';
    try {
      await this.auth.refreshProfile();
      this._renderAccountGoogleLink();
      const stats = await fetchAllAccountStats(this.auth.user.id);
      body.innerHTML = this._accountStatsHtml(stats);
    } catch (e) {
      body.innerHTML = `<p class="center lb-hint is-error">${e.message || 'Could not load statistics.'}</p>`;
    }
  }

  _accountStatsHtml(stats) {
    const rows = [];
    const eloRank = formatRankLabel(stats.elo.rank, stats.elo.total);
    const eloVal = stats.elo.elo != null ? `${stats.elo.elo} ELO` : '—';
    rows.push(
      `<tr><td>Ranked matchmaking</td><td class="account-rank">${eloRank}</td><td>${eloVal}</td></tr>`
    );

    for (const m of stats.modes) {
      const title = SCENARIO_META[m.scenario]?.title ?? m.scenario;
      const rank = formatRankLabel(m.rank, m.total);
      const stat = formatModeStat(m.scenario, m);
      rows.push(
        `<tr><td>${title}</td><td class="account-rank">${rank}</td><td>${stat}</td></tr>`
      );
    }

    return `<table class="account-stats-table"><thead><tr><th>Mode</th><th>Rank</th><th>Best</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  /** Populate the aim-stats recency filter + reload on change. */
  _bindAimStats() {
    this._aimFilterId = this._aimFilterId || 'all';
    const sel = this.root.querySelector('#account-aim-filter');
    if (!sel) return;
    sel.innerHTML = AIM_STAT_FILTERS.map(
      (f) => `<option value="${f.id}">${this._esc(f.label)}</option>`
    ).join('');
    sel.value = this._aimFilterId;
    sel.addEventListener('change', () => {
      this._aimFilterId = sel.value;
      this._loadAimStats();
    });
    this._bindRating();
  }

  /** Populate Aim4 Rating filters + comparison controls. */
  _bindRating() {
    this._ratingMode = this._ratingMode || 'all';
    this._ratingTimeId = this._ratingTimeId || 'all';
    this._ratingBestId = this._ratingBestId || 'best1';
    this._ratingCompareOverlays = this._ratingCompareOverlays || [];
    this._ratingShowGlobal = !!this._ratingShowGlobal;

    const modeSel = this.root.querySelector('#account-rating-filter');
    if (modeSel) {
      const opts = [`<option value="all">All modes (average)</option>`]
        .concat(sortModesByTitle(RATED_GAMEMODES).map(
          (m) => `<option value="${m}">${this._esc(SCENARIO_META[m]?.title || m)}</option>`
        ));
      modeSel.innerHTML = opts.join('');
      modeSel.value = this._ratingMode;
      modeSel.addEventListener('change', () => {
        this._ratingMode = modeSel.value;
        this._loadRating();
      });
    }

    const timeSel = this.root.querySelector('#account-rating-time');
    if (timeSel) {
      timeSel.innerHTML = AIM_STAT_FILTERS.map(
        (f) => `<option value="${f.id}">${this._esc(f.label)}</option>`
      ).join('');
      timeSel.value = this._ratingTimeId;
      timeSel.addEventListener('change', () => {
        this._ratingTimeId = timeSel.value;
        this._loadRating();
        this._loadAimSummary(this._aimStatsUserId);
      });
    }

    const bestSel = this.root.querySelector('#account-rating-best');
    if (bestSel) {
      bestSel.innerHTML = AIM_RATING_BEST_FILTERS.map(
        (f) => `<option value="${f.id}">${this._esc(f.label)}</option>`
      ).join('');
      bestSel.value = this._ratingBestId;
      bestSel.addEventListener('change', () => {
        this._ratingBestId = bestSel.value;
        this._loadRating();
        this._loadAimSummary(this._aimStatsUserId);
      });
    }

    this.root.querySelector('#account-rating-global')?.addEventListener('change', (e) => {
      this._ratingShowGlobal = e.target.checked;
      this._loadRating();
    });

    this.root.querySelector('#account-rating-compare-btn')?.addEventListener('click', () => {
      this._addRatingCompareOverlay();
    });
    this.root.querySelector('#account-rating-compare')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._addRatingCompareOverlay();
    });
    this.root.querySelector('#account-rating-clear-compare')?.addEventListener('click', () => {
      this._ratingCompareOverlays = [];
      this._ratingShowGlobal = false;
      const g = this.root.querySelector('#account-rating-global');
      if (g) g.checked = false;
      this._loadRating();
    });
  }

  _ratingFetchOpts() {
    const f = AIM_STAT_FILTERS.find((x) => x.id === this._ratingTimeId) || AIM_STAT_FILTERS[0];
    return { lastN: f.lastN ?? null, sinceHours: f.hours ?? null };
  }

  _ratingBestCount() {
    const f = AIM_RATING_BEST_FILTERS.find((x) => x.id === this._ratingBestId) || AIM_RATING_BEST_FILTERS[0];
    return f.n;
  }

  async _fetchModeRating(userId, mode, config) {
    const runs = await fetchAimRuns({ userId, scenario: mode, ...this._ratingFetchOpts() });
    if (!runs.length) return null;
    const baselines = baselinesForGamemode(mode, config);
    const rating = composeRatingFromBestRuns(runs, { baselines }, this._ratingBestCount());
    if (!rating) return null;
    return { mode, rating, games: runs.length };
  }

  async _loadAimSummary(userId) {
    const isOther = !!this._viewingAccount;
    const el = this.root.querySelector(isOther ? '#account-ro-aim-summary' : '#account-aim-summary');
    if (!el || !userId || !supabaseConfigured()) {
      if (el) el.textContent = '';
      return;
    }
    try {
      await syncBaselinesFromServer();
      const config = loadBaselines();
      const perMode = await Promise.all(
        RATED_GAMEMODES.map((mode) => this._fetchModeRating(userId, mode, config))
      );
      const usable = perMode.filter(Boolean);
      const overall = await computeOverallAimRating(userId, this._ratingTimeId, this._ratingBestCount());
      // Own account: mirror the freshly-computed rating to the profile so the
      // aim-rating leaderboard reflects it immediately.
      if (!isOther && this.auth?.user?.id === userId) {
        await syncOverallAimRating(userId).catch(() => {});
      }
      const rankInfo = await fetchAimRatingRank(userId);
      if (overall == null && !rankInfo?.overallAimRating) {
        const need = OVERALL_AIM_MIN_MODES;
        const have = usable.length;
        if (have > 0 && have < need) {
          el.textContent = `Overall aim rating unlocks at ${need} rated modes — you have ${have}.`;
        } else {
          el.textContent = 'No Aim4 Rating yet — finish competitive runs to build your profile.';
        }
        return;
      }
      const score = overall ?? rankInfo?.overallAimRating;
      let pct = '';
      if (rankInfo?.rank && rankInfo?.total) {
        const top = Math.round((1 - (rankInfo.rank - 1) / rankInfo.total) * 100);
        pct = ` · Top ${top}% (${rankInfo.rank} / ${rankInfo.total})`;
      }
      el.textContent = `Overall aim rating: ${Number(score).toFixed(2)}${pct}`;
    } catch {
      el.textContent = '';
    }
  }

  async _addRatingCompareOverlay() {
    const input = this.root.querySelector('#account-rating-compare');
    const name = input?.value?.trim();
    if (!name || !supabaseConfigured()) return;
    try {
      const profile = await lookupProfileByUsername(name);
      if (!profile) {
        input?.classList.add('is-error');
        return;
      }
      input?.classList.remove('is-error');
      if (this._ratingCompareOverlays.some((o) => o.userId === profile.id)) return;
      if (profile.id === this._aimStatsUserId) return;
      this._ratingCompareOverlays.push({
        userId: profile.id,
        label: profile.username,
        color: ['#a78bfa', '#3ddc6b', '#f5a623', '#46c8ff'][
          this._ratingCompareOverlays.length % 4
        ],
        fill: ['rgba(167,139,250,0.15)', 'rgba(61,220,107,0.15)', 'rgba(245,166,35,0.15)', 'rgba(70,200,255,0.15)'][
          this._ratingCompareOverlays.length % 4
        ]
      });
      if (input) input.value = '';
      this._loadRating();
    } catch (e) {
      console.warn('[ui] compare lookup failed', e);
    }
  }

  /**
   * Compute the Aim4 Rating radar for the viewed account (+ optional overlays).
   */
  async _loadRating() {
    const canvas = this.root.querySelector('#account-rating-chart');
    const legend = this.root.querySelector('#account-rating-legend');
    const clearBtn = this.root.querySelector('#account-rating-clear-compare');
    if (!canvas) return;
    const userId = this._aimStatsUserId;
    if (!supabaseConfigured() || !userId) {
      this._drawRadarChart(canvas, [], '#account-rating-tooltip', 'all');
      if (legend) legend.innerHTML = '<p class="center lb-hint">Aim4 Rating is not available.</p>';
      return;
    }
    if (legend) legend.innerHTML = '<p class="center lb-hint">Loading…</p>';
    await syncBaselinesFromServer();
    const config = loadBaselines();
    const mode = this._ratingMode || 'all';

    try {
      let rating;
      let categories = radarCategoriesForView(mode, null);

      if (mode === 'all') {
        const perMode = await Promise.all(
          RATED_GAMEMODES.map((m) => this._fetchModeRating(userId, m, config))
        );
        const usable = perMode.filter(Boolean);
        if (!usable.length) {
          this._drawRadarChart(canvas, [], '#account-rating-tooltip', mode);
          if (legend) legend.innerHTML = '<p class="center lb-hint">No competitive runs yet.</p>';
          return;
        }
        rating = averageRatingsAcrossModes(usable);
        categories = radarCategoriesForView('all', rating);
        if (!qualifiesForOverallAimRating(usable)) {
          this._drawRadarChart(canvas, [], '#account-rating-tooltip', mode);
          if (legend) {
            legend.innerHTML = `<p class="center lb-hint">Overall rating unlocks at ${OVERALL_AIM_MIN_MODES} rated modes — you have ${usable.length}. Per-mode ratings are available in the filter above.</p>`;
          }
          return;
        }
      } else {
        const one = await this._fetchModeRating(userId, mode, config);
        if (!one) {
          this._drawRadarChart(canvas, [], '#account-rating-tooltip', mode);
          if (legend) legend.innerHTML = '<p class="center lb-hint">No competitive runs for this mode yet.</p>';
          return;
        }
        rating = one.rating;
        categories = radarCategoriesForView(mode, rating);
      }

      const series = [{
        rating,
        color: '#f52525',
        fill: 'rgba(245,37,37,0.25)',
        label: this._viewingAccount?.username || this.auth?.displayName || 'You'
      }];

      if (this._ratingShowGlobal) {
        const bestN = this._ratingBestCount();
        if (mode === 'all') {
          const globalModes = await Promise.all(
            RATED_GAMEMODES.map(async (m) => {
              const runs = await fetchAimRuns({ scenario: m, ...this._ratingFetchOpts() });
              if (!runs.length) return null;
              const rating = composeRatingFromBestRuns(
                runs,
                { baselines: baselinesForGamemode(m, config) },
                bestN
              );
              return rating ? { mode: m, rating } : null;
            })
          );
          const gRating = averageRatingsAcrossModes(globalModes.filter(Boolean));
          if (gRating) {
            series.push({
              rating: gRating,
              color: '#9a9a9a',
              fill: 'rgba(154,154,154,0.12)',
              label: 'Global avg'
            });
          }
        } else {
          const runs = await fetchAimRuns({ scenario: mode, ...this._ratingFetchOpts() });
          const gRating = runs.length
            ? composeRatingFromBestRuns(
              runs,
              { baselines: baselinesForGamemode(mode, config) },
              bestN
            )
            : null;
          if (gRating) {
            series.push({
              rating: gRating,
              color: '#9a9a9a',
              fill: 'rgba(154,154,154,0.12)',
              label: 'Global avg'
            });
          }
        }
      }

      for (const overlay of this._ratingCompareOverlays || []) {
        let oRating;
        if (mode === 'all') {
          const perMode = await Promise.all(
            RATED_GAMEMODES.map((m) => this._fetchModeRating(overlay.userId, m, config))
          );
          oRating = averageRatingsAcrossModes(perMode.filter(Boolean));
        } else {
          const one = await this._fetchModeRating(overlay.userId, mode, config);
          oRating = one?.rating;
        }
        if (oRating) {
          series.push({
            rating: oRating,
            color: overlay.color,
            fill: overlay.fill,
            label: overlay.label
          });
        }
      }

      if (clearBtn) {
        clearBtn.hidden = !(this._ratingCompareOverlays?.length || this._ratingShowGlobal);
      }

      this._drawRadarChart(canvas, series, '#account-rating-tooltip', mode, categories);
      if (legend) legend.innerHTML = this._ratingLegendHtml(rating, categories);
    } catch (e) {
      this._drawRadarChart(canvas, [], '#account-rating-tooltip', mode);
      if (legend) legend.innerHTML = `<p class="center lb-hint is-error">${this._esc(e.message || 'Could not load rating.')}</p>`;
    }
  }

  _ratingLegendHtml(rating, categories = RATING_CATEGORIES) {
    const rows = categories
      .filter((k) => Number.isFinite(rating?.[k]))
      .map((k) => `<tr><td>${RATING_LABELS[k]}</td><td class="account-rank">${(rating[k] ?? 0).toFixed(2)}</td></tr>`)
      .join('');
    if (!rows) return '<p class="center lb-hint">No rating data.</p>';
    return `<table class="account-stats-table"><thead><tr><th>Category</th><th>Rating</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  _ratingCompareLegendHtml(runRating, playerRating, globalRating, mode) {
    const cats = radarCategoriesForView(mode, runRating);
    const fmt = (r, k) => (r && Number.isFinite(r[k]) ? r[k].toFixed(2) : '—');
    const rows = cats.map(
      (k) =>
        `<tr><td>${RATING_LABELS[k]}</td>` +
        `<td class="account-rank run-rating-you">${fmt(runRating, k)}</td>` +
        `<td class="account-rank run-rating-player">${fmt(playerRating, k)}</td>` +
        `<td class="account-rank run-rating-global">${fmt(globalRating, k)}</td></tr>`
    ).join('');
    const runTip = 'Only this run: its telemetry is rated against the current per-mode baselines.';
    const playerTip =
      'Your average: ALL of your logged competitive runs of this mode are aggregated ' +
      '(each stat averaged across runs), then that combined telemetry is rated with the same baselines as this run. ' +
      'Hover a dot on the chart for the numbers behind each axis.';
    const globalTip =
      'Global average: every player’s logged competitive runs of this mode are aggregated the same way ' +
      '(all runs pooled, each stat averaged), then rated with the same baselines. ' +
      'Hover a dot on the chart for the numbers behind each axis.';
    return (
      `<p class="run-rating-key">` +
      `<span class="run-rating-key-item" title="${this._esc(runTip)}"><i class="run-rating-swatch run-rating-swatch-run"></i>This run</span>` +
      `<span class="run-rating-key-item" title="${this._esc(playerTip)}"><i class="run-rating-swatch run-rating-swatch-player"></i>Your avg</span>` +
      `<span class="run-rating-key-item" title="${this._esc(globalTip)}"><i class="run-rating-swatch run-rating-swatch-global"></i>Global avg</span>` +
      `</p>` +
      `<table class="account-stats-table run-rating-table">` +
      `<thead><tr><th>Category</th><th title="${this._esc(runTip)}">This run</th>` +
      `<th title="${this._esc(playerTip)}">Your avg</th>` +
      `<th title="${this._esc(globalTip)}">Global avg</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`
    );
  }

  /**
   * Render the post-run Aim4 Rating radar: this run vs your average vs global
   * average for the same gamemode.
   */
  async _renderRunRating(scenario, analytics) {
    const panel = this.root.querySelector('#res-rating-panel');
    const chart = this.root.querySelector('#res-rating-chart');
    const legend = this.root.querySelector('#res-rating-legend');
    if (!panel || !chart || !legend) return;

    if (!analytics || !RATED_GAMEMODES.includes(scenario)) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    legend.innerHTML = '<p class="center lb-hint">Loading rating…</p>';
    this._drawRadarChart(chart, [], '#res-rating-tooltip', scenario);

    await syncBaselinesFromServer();
    const baselines = baselinesForGamemode(scenario, loadBaselines());
    const runTelemetry = telemetryFromRunAnalytics(analytics);
    const runRating = calculateAim4Ratings(runTelemetry, { baselines });
    const categories = radarCategoriesForView(scenario, runRating);

    let playerRating = null;
    let globalRating = null;
    let playerBreakdown = null;
    let globalBreakdown = null;
    if (supabaseConfigured()) {
      try {
        const userId = this.auth?.user?.id || null;
        const [playerRow, globalRow] = await Promise.all([
          userId ? fetchAimStats({ userId, scenario }) : Promise.resolve(null),
          fetchAimStats({ scenario })
        ]);
        if (playerRow && Number(playerRow.games)) {
          const t = telemetryFromAimStats(playerRow);
          playerRating = calculateAim4Ratings(t, { baselines });
          playerBreakdown = buildRatingBreakdown(t, { baselines });
        }
        if (globalRow && Number(globalRow.games)) {
          const t = telemetryFromAimStats(globalRow);
          globalRating = calculateAim4Ratings(t, { baselines });
          globalBreakdown = buildRatingBreakdown(t, { baselines });
        }
      } catch (e) {
        console.warn('[ui] run rating comparison failed', e);
      }
    }

    const series = [{
      rating: runRating,
      color: '#f52525',
      fill: 'rgba(245,37,37,0.25)',
      label: 'This run',
      breakdown: buildRatingBreakdown(runTelemetry, { baselines })
    }];
    if (globalRating) {
      series.unshift({
        rating: globalRating,
        color: '#9a9a9a',
        fill: 'rgba(154,154,154,0.12)',
        label: 'Global avg',
        breakdown: globalBreakdown
      });
    }
    if (playerRating) {
      series.unshift({
        rating: playerRating,
        color: '#46c8ff',
        fill: 'rgba(70,200,255,0.18)',
        label: 'Your avg',
        breakdown: playerBreakdown
      });
    }
    this._drawRadarChart(chart, series, '#res-rating-tooltip', scenario, categories, true);
    legend.innerHTML = this._ratingCompareLegendHtml(runRating, playerRating, globalRating, scenario);
  }

  _bindResultsInfographics() {
    this._resInfoPanels = [];
    this._resInfoIdx = 0;
    this.root.querySelector('#res-info-prev')?.addEventListener('click', () => this._stepResInfographics(-1));
    this.root.querySelector('#res-info-next')?.addEventListener('click', () => this._stepResInfographics(1));
  }

  _stepResInfographics(delta) {
    if (!this._resInfoPanels?.length) return;
    this._resInfoIdx =
      (this._resInfoIdx + delta + this._resInfoPanels.length) % this._resInfoPanels.length;
    this._syncResInfographicsPanel();
  }

  _syncResInfographicsPanel() {
    const panels = this._resInfoPanels || [];
    const cur = panels[this._resInfoIdx];
    const titleEl = this.root.querySelector('#res-info-title');
    const prevBtn = this.root.querySelector('#res-info-prev');
    const nextBtn = this.root.querySelector('#res-info-next');
    const ratingPanel = this.root.querySelector('#res-rating-panel');
    const historyPanel = this.root.querySelector('#res-history-panel');
    const showNav = panels.length > 1;
    if (prevBtn) prevBtn.hidden = !showNav;
    if (nextBtn) nextBtn.hidden = !showNav;
    if (titleEl) {
      titleEl.textContent = cur === 'history' ? 'Results history' : 'Aim4 Rating';
    }
    if (ratingPanel) ratingPanel.hidden = cur !== 'rating';
    if (historyPanel) historyPanel.hidden = cur !== 'history';
  }

  async _renderResultsInfographics(results, analytics) {
    const wrap = this.root.querySelector('#res-infographics');
    if (!wrap) return;

    this._resInfoPanels = [];
    const ratingOk = analytics && RATED_GAMEMODES.includes(results.scenario);
    const historyOk = !!(this.auth?.isLoggedIn && supabaseConfigured());

    if (ratingOk) this._resInfoPanels.push('rating');
    if (historyOk) this._resInfoPanels.push('history');

    if (!this._resInfoPanels.length) {
      wrap.hidden = true;
      return;
    }

    this._resInfoIdx = 0;
    wrap.hidden = false;

    if (ratingOk) await this._renderRunRating(results.scenario, analytics);
    else {
      const rp = this.root.querySelector('#res-rating-panel');
      if (rp) rp.hidden = true;
    }

    if (historyOk) await this._renderResultsHistory(results);
    else {
      const hp = this.root.querySelector('#res-history-panel');
      if (hp) hp.hidden = true;
    }

    this._syncResInfographicsPanel();
  }

  async _renderResultsHistory(results) {
    const panel = this.root.querySelector('#res-history-panel');
    const chart = this.root.querySelector('#res-history-chart');
    const legend = this.root.querySelector('#res-history-legend');
    if (!panel || !chart || !legend) return;

    panel.hidden = false;
    legend.innerHTML = '<p class="center lb-hint">Loading history…</p>';
    chart.innerHTML = '';

    const userId = this.auth?.user?.id;
    if (!userId) {
      legend.innerHTML = '<p class="center lb-hint">Sign in to see score history.</p>';
      return;
    }

    const configKey =
      results.leaderboardEligible !== false ? results.configKey : this._configKeyFor(results.scenario);
    let rows = await fetchUserScoreHistory(userId, results.scenario, configKey, 30);
    if (!rows.length) {
      legend.innerHTML = '<p class="center lb-hint">No saved runs yet for this mode.</p>';
      return;
    }

    const chronological = [...rows].reverse();
    let peak = -Infinity;
    const points = chronological.map((row, i) => {
      const score = Number(row.score) || 0;
      const isRecord = score > peak;
      if (isRecord) peak = score;
      const gamesAgo = chronological.length - 1 - i;
      return {
        score,
        isRecord,
        isLast: i === chronological.length - 1,
        label: gamesAgo === 0 ? 'Last' : `${gamesAgo} ago`
      };
    });

    this._drawScoreHistoryChart(chart, points);
    const trend = this._scoreHistoryTrend(points);
    const trendText =
      trend == null
        ? ''
        : trend > 0.5
          ? 'Trending up — you\'re improving.'
          : trend < -0.5
            ? 'Trending down — scores dipping lately.'
            : 'Trending flat — holding steady.';
    legend.innerHTML =
      `<p class="run-rating-key">` +
      `<span class="run-rating-key-item"><i class="run-rating-swatch" style="background:#46c8ff"></i>Score</span>` +
      `<span class="run-rating-key-item"><i class="run-rating-swatch" style="background:#f5a623"></i>Trend</span>` +
      `<span class="run-rating-key-item"><i class="run-rating-swatch run-rating-swatch-run"></i>New record</span>` +
      `</p>` +
      (trendText ? `<p class="center lb-hint muted">${trendText}</p>` : '');
  }

  /** Simple least-squares slope (score per game index). */
  _scoreHistoryTrend(points) {
    const n = points.length;
    if (n < 2) return null;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += points[i].score;
      sumXY += i * points[i].score;
      sumXX += i * i;
    }
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-9) return 0;
    return (n * sumXY - sumX * sumY) / denom;
  }

  _drawScoreHistoryChart(host, points) {
    if (!host || !points.length) {
      host.innerHTML = '';
      return;
    }

    const W = 440;
    const H = 220;
    const padL = 44;
    const padR = 16;
    const padT = 16;
    const padB = 36;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const scores = points.map((p) => p.score);
    const minY = Math.min(...scores);
    const maxY = Math.max(...scores);
    const yPad = Math.max(1, (maxY - minY) * 0.08 || maxY * 0.05 || 1);
    const yLo = minY - yPad;
    const yHi = maxY + yPad;
    const ySpan = yHi - yLo || 1;

    const xAt = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const yAt = (v) => padT + plotH - ((v - yLo) / ySpan) * plotH;

    const coords = points.map((p, i) => ({ ...p, x: xAt(i), y: yAt(p.score) }));

    const trend = this._scoreHistoryTrend(points);
    let trendLine = '';
    if (trend != null && points.length >= 2) {
      const n = points.length;
      const meanX = (n - 1) / 2;
      const meanY = scores.reduce((a, b) => a + b, 0) / n;
      const intercept = meanY - trend * meanX;
      const yStart = intercept;
      const yEnd = intercept + trend * (n - 1);
      trendLine =
        `<line x1="${xAt(0).toFixed(1)}" y1="${yAt(yStart).toFixed(1)}" ` +
        `x2="${xAt(n - 1).toFixed(1)}" y2="${yAt(yEnd).toFixed(1)}" ` +
        `stroke="#f5a623" stroke-width="2" stroke-dasharray="6 4" opacity="0.85"/>`;
    }

    const dots = coords
      .map((p) => {
        const r = p.isRecord ? 5.5 : 4;
        const fill = p.isRecord ? '#f52525' : '#46c8ff';
        const stroke = p.isLast ? '#fff' : 'none';
        const sw = p.isLast ? 1.5 : 0;
        return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
      })
      .join('');

    const poly = coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    const yTicks = 4;
    let yGrid = '';
    for (let t = 0; t <= yTicks; t++) {
      const v = yLo + (ySpan * t) / yTicks;
      const y = yAt(v);
      yGrid +=
        `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)"/>` +
        `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#8a8a8a" font-size="10">${Math.round(v)}</text>`;
    }

    const labelIdx = new Set([0, points.length - 1]);
    if (points.length > 4) labelIdx.add(Math.floor((points.length - 1) / 2));
    const xLabels = [...labelIdx]
      .sort((a, b) => a - b)
      .map((i) => {
        const p = coords[i];
        return `<text x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#8a8a8a" font-size="10">${this._esc(p.label)}</text>`;
      })
      .join('');

    host.innerHTML =
      `<svg class="res-history-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Score history">` +
      yGrid +
      trendLine +
      `<polyline points="${poly}" fill="none" stroke="#46c8ff" stroke-width="2" opacity="0.45"/>` +
      dots +
      xLabels +
      `</svg>`;
  }

  /** Render a vector (SVG) 0–2 radar; optional multiple overlaid series. */
  _drawRadarChart(host, series = [], tooltipSel = null, mode = 'all', categories = null, verboseTooltips = false) {
    if (!host) return;
    const tooltip = tooltipSel ? this.root.querySelector(tooltipSel) : null;
    if (tooltip) tooltip.hidden = true;

    const cats = (categories && categories.length)
      ? categories
      : radarCategoriesForView(mode, series.find((s) => s?.rating)?.rating);
    const n = cats.length;
    if (!n) {
      host.innerHTML = '';
      return;
    }

    const W = 440;
    const H = 360;
    const cx = W / 2;
    const cy = H / 2 + 6;
    const R = Math.min(W, H) / 2 - 46;
    const MAX = 2;
    const angleAt = (i) => -Math.PI / 2 + (i / n) * Math.PI * 2;
    const pt = (i, r) => [cx + Math.cos(angleAt(i)) * r, cy + Math.sin(angleAt(i)) * r];

    const rings = [0.5, 1, 1.5, 2].map((lvl) => {
      const d = Array.from({ length: n }, (_, i) => pt(i, R * (lvl / MAX)).map((v) => v.toFixed(1)).join(','))
        .join(' ');
      const hi = lvl === 1;
      return `<polygon points="${d}" fill="none" stroke="${hi ? 'rgba(245,37,37,0.55)' : 'rgba(255,255,255,0.14)'}" stroke-width="${hi ? 1.5 : 1}"/>`;
    }).join('');

    let spokes = '';
    let labels = '';
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i, R);
      spokes += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`;
      const [lx, ly] = pt(i, R + 16);
      const c = Math.cos(angleAt(i));
      const anchor = Math.abs(c) < 0.3 ? 'middle' : (c > 0 ? 'start' : 'end');
      labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#9a9a9a" font-size="11" font-family="'Host Grotesk',sans-serif" text-anchor="${anchor}" dominant-baseline="middle">${RATING_LABELS[cats[i]]}</text>`;
    }

    let overlays = '';
    let dotIdx = 0;
    const dotMeta = [];
    for (const s of series) {
      if (!s?.rating) continue;
      const pts = cats.map((k, i) => {
        const val = Math.max(0, Math.min(MAX, s.rating[k] ?? 0));
        return pt(i, R * (val / MAX));
      });
      overlays += `<polygon points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="${s.fill}" stroke="${s.color}" stroke-width="2"/>`;
      overlays += cats.map((k, i) => {
        const [x, y] = pts[i];
        const id = `rd-${dotIdx++}`;
        dotMeta.push({ id, series: s, category: k });
        return (
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="transparent" class="radar-hit" data-radar-id="${id}"/>` +
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${s.color}" class="radar-dot" pointer-events="none"/>`
        );
      }).join('');
    }

    host.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="account-rating-svg">` +
      rings + spokes + labels + overlays + `</svg>`;

    if (!tooltip || !dotMeta.length) return;

    const showTip = (meta, evt) => {
      const val = meta.series.rating?.[meta.category];
      if (!Number.isFinite(val)) return;
      const entry = verboseTooltips ? meta.series.breakdown?.[meta.category] : null;
      if (entry?.detailLines?.length) {
        tooltip.classList.add('radar-tooltip-verbose');
        const who = meta.series.label ? `${meta.series.label} — ` : '';
        tooltip.innerHTML =
          `<strong>${this._esc(who)}${this._esc(RATING_LABELS[meta.category])}: ${entry.rating.toFixed(2)}</strong>` +
          entry.detailLines.map((l) => `<div class="radar-tooltip-line">${this._esc(l)}</div>`).join('');
      } else {
        tooltip.classList.remove('radar-tooltip-verbose');
        tooltip.innerHTML = `${RATING_LABELS[meta.category]}: ${val.toFixed(2)}`;
      }
      tooltip.hidden = false;
      const rect = host.getBoundingClientRect();
      const tx = evt.clientX - rect.left + 12;
      const ty = evt.clientY - rect.top + 12;
      const maxW = entry?.detailLines?.length ? 280 : 160;
      const maxH = entry?.detailLines?.length ? 180 : 48;
      tooltip.style.left = `${Math.min(tx, W - maxW)}px`;
      tooltip.style.top = `${Math.min(ty, H - maxH)}px`;
    };

    host.querySelectorAll('.radar-hit').forEach((el) => {
      const meta = dotMeta.find((d) => d.id === el.dataset.radarId);
      if (!meta) return;
      el.addEventListener('mouseenter', (e) => showTip(meta, e));
      el.addEventListener('mousemove', (e) => showTip(meta, e));
      el.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    });
  }

  /** Load the current account's aim analytics + the global baseline. */
  async _loadAimStats() {
    const body = this.root.querySelector('#account-aim-stats');
    if (!body) return;
    const userId = this._aimStatsUserId;
    if (!supabaseConfigured() || !userId) {
      body.innerHTML = '<p class="center lb-hint">Aim analysis is not available.</p>';
      return;
    }
    body.innerHTML = '<p class="center lb-hint">Loading…</p>';
    try {
      const { player } = await fetchAimComparison(userId, this._aimFilterId || 'all');
      body.innerHTML = this._aimStatsHtml(player);
    } catch (e) {
      body.innerHTML = `<p class="center lb-hint is-error">${this._esc(e.message || 'Could not load aim analysis.')}</p>`;
    }
  }

  _aimStatsHtml(player) {
    if (!player || !Number(player.games)) {
      return '<p class="center lb-hint">No competitive runs in this range yet.</p>';
    }
    const num = (v, suffix = '', digits = 0) =>
      v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(digits)}${suffix}`;
    const trioPct = (row) => {
      const a = Number(row.flicks_accurate) || 0;
      const o = Number(row.flicks_over) || 0;
      const u = Number(row.flicks_under) || 0;
      const total = a + o + u;
      if (!total) return '—';
      const pct = (n) => `${Math.round((n / total) * 100)}%`;
      return `${pct(a)} / ${pct(o)} / ${pct(u)}`;
    };
    const clkPct = (row) => {
      const e = Number(row.clicks_early) || 0;
      const a = Number(row.clicks_accurate) || 0;
      const l = Number(row.clicks_late) || 0;
      const total = e + a + l;
      if (!total) return '—';
      const pct = (n) => `${Math.round((n / total) * 100)}%`;
      return `${pct(e)} / ${pct(a)} / ${pct(l)}`;
    };
    const rows = [
      ['Games', String(player.games)],
      ['Flick speed', num(player.flick_speed_ms, ' ms/°')],
      ['Flick accuracy', num(player.flick_accuracy_pct, '%')],
      ['Tension', num(player.tension_pct, '%')],
      ['Flicks ✓/↑/↓', trioPct(player)],
      ['Clicks early/on/late', clkPct(player)]
    ];
    const body = rows
      .map(([label, you]) => `<tr><td>${label}</td><td class="account-rank">${you}</td></tr>`)
      .join('');
    return `<table class="account-stats-table"><thead><tr><th>Metric</th><th>You</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  async _loadAccountReplays(userId = null) {
    const body = this.root.querySelector('#account-replays');
    const uid = userId ?? this.auth?.user?.id;
    const viewingOther = !!(userId && userId !== this.auth?.user?.id);
    if (!body) return;
    if (!uid) {
      body.innerHTML = '<p class="center lb-hint">Sign in to save replays.</p>';
      return;
    }
    if (!supabaseConfigured()) {
      body.innerHTML = '<p class="center lb-hint">Replays are not configured.</p>';
      return;
    }
    body.innerHTML = '<p class="center lb-hint">Loading…</p>';
    let rows;
    try {
      rows = await listAccountReplays(uid);
    } catch (e) {
      body.innerHTML = `<p class="center lb-hint is-error">${e.message || 'Could not load replays.'}</p>`;
      return;
    }
    if (!rows.length) {
      body.innerHTML = viewingOther
        ? '<p class="center lb-hint">No replays yet.</p>'
        : '<p class="center lb-hint">No replays yet — finish a run to record one.</p>';
      return;
    }

    // Group by scenario: show its last run + (competitive) best run.
    const byScenario = new Map();
    for (const r of rows) {
      if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, {});
      byScenario.get(r.scenario)[`${r.variant}:${r.slot}`] = r;
    }

    const items = [];
    for (const [scenario, slots] of byScenario) {
      const title = SCENARIO_META[scenario]?.title ?? scenario;
      const last = slots['competitive:last'] || slots['practice:last'];
      const best = slots['competitive:best'];
      const btns = [];
      if (last) btns.push(this._replayBtnHtml(last, 'Last run', title));
      if (best) btns.push(this._replayBtnHtml(best, 'Best run', title));
      if (btns.length) {
        items.push(
          `<div class="account-replay-row"><span class="account-replay-name">${title}</span><span class="account-replay-btns">${btns.join('')}</span></div>`
        );
      }
    }
    body.innerHTML = items.join('') || '<p class="center lb-hint">No replays yet.</p>';
    this._accountReplayRows = rows;

    body.querySelectorAll('[data-replay-path]').forEach((b) => {
      b.addEventListener('click', () => this._openAccountReplay(b.dataset.replayPath, b.dataset.replayTitle));
    });
  }

  _shareMetaFromReplayRow(row) {
    const username = row.user_id === this.auth?.user?.id
      ? (this.auth?.displayName || 'Player')
      : (this._viewingAccount?.username || 'Player');
    return {
      sourcePath: row.replay_file_path,
      userId: row.user_id,
      username,
      shareMeta: {
        scenario: row.scenario,
        config_key: row.config_key,
        variant: row.variant,
        score: row.score,
        accuracy: row.accuracy,
        kills: row.kills,
        duration: row.duration,
        settings: {}
      }
    };
  }

  _replayBtnHtml(row, label, title) {
    return `<button type="button" class="btn btn-sm" data-replay-path="${this._esc(row.replay_file_path)}" data-replay-title="${this._esc(`${title} — ${label}`)}">${label}</button>`;
  }

  async _openAccountReplay(path, title) {
    const decoded = await loadReplayByPath(path);
    if (!decoded) {
      const st = this.root.querySelector(
        this._viewingAccount ? '#account-profile-status-other' : '#account-profile-status'
      );
      if (st) st.textContent = 'Could not load that replay.';
      return;
    }
    const row = this._accountReplayRows?.find((r) => r.replay_file_path === path);
    this._watchReplay(decoded, {
      title: title || 'Replay',
      returnTo: 'account',
      fromOtherPlayer: !!this._viewingAccount,
      shareCtx: row ? this._shareMetaFromReplayRow(row) : null
    });
  }

  _setAuthMode(mode) {
    this._authMode = mode === 'register' ? 'register' : 'login';
    const isReg = this._authMode === 'register';
    this.root.querySelector('#auth-title').textContent = isReg ? 'Create account' : 'Sign in';
    this.root.querySelector('#auth-submit').textContent = isReg ? 'Register' : 'Sign in';
    this.root.querySelector('#auth-username-wrap').hidden = !isReg;
    this.root.querySelector('#auth-confirm-wrap').hidden = !isReg;
    this.root.querySelector('#auth-password').autocomplete = isReg ? 'new-password' : 'current-password';
    this.root.querySelector('#auth-email').autocomplete = 'email';
    this.root.querySelectorAll('#auth-tabs .tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.authTab === this._authMode);
    });
    const st = this.root.querySelector('#auth-status');
    if (st) {
      st.textContent = '';
      st.classList.remove('is-error');
    }
  }

  _openAuth(mode = 'login') {
    this._setAuthMode(mode);
    this.showScreen('auth');
  }

  _syncMpNameFromAccount() {
    if (!this.auth?.isLoggedIn) return;
    const nameInput = this.root.querySelector('#mp-name');
    if (nameInput && this.auth.displayName) nameInput.value = this.auth.displayName;
    if (this.auth.displayName) Storage.write('mpName', this.auth.displayName);
  }

  // -------------------------------------------------------------------------
  // Multiplayer
  // -------------------------------------------------------------------------
  _targetOptions() {
    return SCORE_TARGETS.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
  }

  _defaultName() {
    if (this.auth?.isLoggedIn && this.auth.displayName) return this.auth.displayName;
    const n = Storage.read('mpName', '');
    return typeof n === 'string' && n ? n : `Player ${Math.floor(1000 + Math.random() * 9000)}`;
  }

  _bindMultiplayer() {
    const $ = (id) => this.root.querySelector(id);
    const nameInput = $('#mp-name');
    nameInput.value = this._defaultName();
    const name = () => {
      const n = (nameInput.value.trim() || 'Player').slice(0, 24);
      Storage.write('mpName', n);
      return n;
    };

    this._mpName = name; // reused by auto-join

    // The "Mode" selector mixes gun-feel (rifle/pistol) with game mode
    // (tracking/deathmatch). The chosen value is per-player and persisted; on the
    // wire it is split into { mode, weapon }.
    const applyWeapon = (v) => {
      const val = ['pistol', 'tracking', 'deathmatch'].includes(v) ? v : 'rifle';
      this.settings.data.weapon.customWeapon = val;
      this.settings.save();
      const a = $('#mp-create-weapon');
      const b = $('#mp-lobby-weapon');
      if (a) a.value = val;
      if (b) b.value = val;
      this._syncMpModeFields(val);
    };
    applyWeapon(this.settings.data.weapon?.customWeapon || 'rifle');
    $('#mp-create-weapon')?.addEventListener('change', (e) => applyWeapon(e.target.value));
    $('#mp-lobby-weapon')?.addEventListener('change', (e) => {
      applyWeapon(e.target.value);
      const lobby = this.mp?.lobby;
      if (lobby && lobby.hostId === this.mp.myId) {
        this.mp.setConfig(this._mpSelToConfig(e.target.value));
      }
    });

    $('#mp-create-btn').addEventListener('click', () => {
      this.mp.create({
        name: name(),
        target: parseInt($('#mp-create-target').value, 10),
        isPublic: !$('#mp-create-private').checked,
        ...this._mpSelToConfig($('#mp-create-weapon').value)
      });
    });

    const joinCode = $('#mp-join-code');
    joinCode.addEventListener('input', () => { joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
    $('#mp-join-btn').addEventListener('click', () => {
      const code = joinCode.value.trim();
      if (code.length !== 4) return this.mpStatus('Invalid code', false);
      this.mp.join({ name: name(), code });
    });

    $('#mp-invite-copy')?.addEventListener('click', () => {
      const url = $('#mp-invite-url')?.textContent;
      if (!url) return;
      navigator.clipboard?.writeText(url).then(
        () => this.mpStatus('Copied', true),
        () => this.mpStatus('Copy failed', false)
      );
    });

    $('#mp-refresh-btn').addEventListener('click', () => this.mp.refreshList());
    $('#mp-back-btn').addEventListener('click', () => {
      this.mp.closeBrowser();
      this.showScreen('menu');
    });

    // Join a lobby from the public browser list (event delegation).
    $('#mp-lobby-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-join-code]');
      if (!btn) return;
      this.mp.join({ name: name(), code: btn.dataset.joinCode });
    });

    $('#mp-ready-btn').addEventListener('click', () => {
      const me = this._meInLobby();
      this.mp.setReady(!(me && me.ready));
    });
    $('#mp-start-btn').addEventListener('click', () => this.mp.start());
    $('#mp-leave-btn').addEventListener('click', () => {
      this.mp.leave();
      this.showScreen('mp');
      this.mp.openBrowser();
    });

    $('#mp-lobby-target').addEventListener('change', (e) => this.mp.setConfig({ target: parseInt(e.target.value, 10) }));
    $('#mp-lobby-private').addEventListener('change', (e) => this.mp.setConfig({ isPublic: !e.target.checked }));

    $('#mp-res-rematch').addEventListener('click', () => {
      if (this.mp.lobby) {
        this.showScreen('mp-lobby');
        return;
      }
      // Matchmade match (no persistent lobby): re-enter the ranked queue.
      this.showScreen('menu');
      this._startMatchmakingQueue();
    });
    $('#mp-res-leave').addEventListener('click', () => {
      this.mp.leave();
      this.quit();
    });
  }

  _meInLobby() {
    const lobby = this.mp?.lobby;
    if (!lobby) return null;
    return lobby.players.find((p) => p.id === this.mp.myId) || null;
  }

  /** Split the "Mode" selector value into the wire fields { mode, weapon }. */
  _mpSelToConfig(v) {
    if (v === 'tracking') return { mode: 'tracking', weapon: 'tracking' };
    if (v === 'deathmatch') return { mode: 'deathmatch', weapon: 'rifle' };
    return { mode: 'duel', weapon: v === 'pistol' ? 'pistol' : 'rifle' };
  }

  /** Selector value to display for a lobby (mode wins over raw weapon). */
  _mpSelForLobby(lobby) {
    if (lobby?.gameMode === 'tracking') return 'tracking';
    if (lobby?.gameMode === 'deathmatch') return 'deathmatch';
    return lobby?.weapon || 'rifle';
  }

  _syncMpModeFields(sel) {
    // Tracking has no win condition; duel & deathmatch are first-to-N.
    const tracking = sel === 'tracking';
    const toggle = (id) => {
      const field = this.root.querySelector(id)?.closest('.field');
      if (field) field.classList.toggle('hidden', tracking);
    };
    toggle('#mp-create-target');
    toggle('#mp-lobby-target');
  }

  _mpGoalLabel(lobbyOrMsg) {
    if (lobbyOrMsg?.gameMode === 'tracking' || lobbyOrMsg?.weapon === 'tracking') {
      return `${TRACKING_DURATION}s Tracking`;
    }
    const target = lobbyOrMsg?.target ?? 0;
    return target > 0 ? `First to ${target}` : 'Endless';
  }

  /** Remaining seconds in a tracking duel (server-synchronised). */
  _mpTrackingRemainingSec() {
    const endsAt = this._mpMatchEndsAt;
    if (!endsAt) return TRACKING_DURATION;
    const sc = this.sceneManager.current;
    const offset = sc?._serverTimeOffset ?? 0;
    const serverNow = performance.now() + offset;
    return Math.max(0, (endsAt - serverNow) / 1000);
  }

  setMpMatchEndsAt(ms) {
    if (Number.isFinite(ms)) {
      this._mpMatchEndsAt = ms;
      const sc = this.sceneManager.current;
      sc?.setMatchEndsAt?.(ms);
    }
  }

  mpStatus(msg, ok = true) {
    const elHome = this.root.querySelector('#mp-status');
    const elLobby = this.root.querySelector('#mp-lobby-status');
    for (const el of [elHome, elLobby]) {
      if (!el) continue;
      el.textContent = msg || '';
      el.classList.toggle('is-error', !ok);
    }
  }

  /** Connection / server errors — visible on both custom games and matchmaking. */
  netStatus(msg, ok = true) {
    this.mpStatus(msg, ok);
    this.mmStatus(msg, ok);
  }

  /** Render the public lobby browser list. `lobbies === null` = loading. */
  renderLobbyList(lobbies) {
    const el = this.root.querySelector('#mp-lobby-list');
    if (!el) return;
    if (lobbies === null) {
      el.innerHTML = '<div class="mp-lobby-empty">…</div>';
      return;
    }
    if (!lobbies.length) {
      el.innerHTML = '<div class="mp-lobby-empty">—</div>';
      return;
    }
    el.innerHTML = lobbies
      .map((l) => {
        const goal = this._mpGoalLabel(l);
        return `<div class="mp-lobby-item">
          <div class="mp-lobby-info">
            <span class="mp-lobby-host">${this._esc(l.host)}</span>
            <span class="mp-lobby-meta">${this._esc(l.map)} · ${goal} · ${l.players}/${l.max}</span>
          </div>
          <button type="button" class="btn primary" data-join-code="${l.code}">Join</button>
        </div>`;
      })
      .join('');
  }

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** Full URL friends must open to join this lobby on the host's server. */
  _mpInviteUrl(code) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('lobby', code);
      // If we're viewing on a local/private address but the server told us its
      // public host, rewrite the link so friends over the internet can use it.
      const publicHost = this.mp?.net?.serverPublicHost;
      if (publicHost && this._isLocalHostname(url.hostname)) {
        url.host = publicHost;
      }
      return url.toString();
    } catch {
      return `${location.origin}${location.pathname}?lobby=${code}`;
    }
  }

  _isLocalHostname(host) {
    return (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      /^127\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  }

  renderLobby(lobby) {
    const $ = (id) => this.root.querySelector(id);
    $('#mp-lobby-code').textContent = lobby.code;

    const isHost = lobby.hostId === this.mp.myId;
    const me = lobby.players.find((p) => p.id === this.mp.myId);

    $('#mp-players').innerHTML = lobby.players
      .map((p) => {
        const tags = [];
        if (p.id === lobby.hostId) tags.push('<span class="mp-tag host">HOST</span>');
        tags.push(p.ready ? '<span class="mp-tag ready">READY</span>' : '<span class="mp-tag">NOT READY</span>');
        const youName = p.name;
        return `<div class="mp-player"><span class="mp-side">${p.side || '–'}</span><span class="mp-name">${youName}</span>${tags.join('')}</div>`;
      })
      .join('');

    $('#mp-lobby-target').value = String(lobby.target);
    const lobbyWeapon = $('#mp-lobby-weapon');
    const sel = this._mpSelForLobby(lobby);
    if (lobbyWeapon) {
      lobbyWeapon.value = sel;
      lobbyWeapon.disabled = !isHost;
    }
    this._syncMpModeFields(sel);
    $('#mp-lobby-private').checked = lobby.isPublic === false;
    $('#mp-lobby-target').disabled = !isHost;
    $('#mp-lobby-private').disabled = !isHost;

    const inviteUrl = this._mpInviteUrl(lobby.code);
    $('#mp-invite-url').textContent = inviteUrl;

    const readyBtn = $('#mp-ready-btn');
    readyBtn.textContent = me && me.ready ? 'Unready' : 'Ready';
    readyBtn.classList.toggle('primary', !(me && me.ready));

    const startBtn = $('#mp-start-btn');
    const canStart = isHost && lobby.players.length >= 2 && lobby.players.every((p) => p.ready || p.id === lobby.hostId);
    startBtn.style.display = isHost ? '' : 'none';
    startBtn.disabled = !canStart;
  }

  beginMpMatch(msg, players) {
    this._mpPlayers = players;
    this._mpTarget = msg.target;
    this._mpGameMode = msg.gameMode || 'duel';
    this._mpMatchEndsAt = msg.matchEndsAt ?? null;
    this._mpTabStats = msg.stats || {};
    this._mpMapId = msg.mapId;
    this._resetMpChat();
    this._hideMpTabScoreboard();
    this._updateQueueChip({ inQueue: false });
    this.updateMpScore(msg.scores, this.mp.lobby, msg.mapId);
    this.hudCritChip.style.display = 'none';
    if (msg.isMatchmade && msg.opponentName) {
      this.mmStatus(`Ranked vs ${msg.opponentName} (${msg.opponentElo ?? '?'} ELO)`, true);
    }
    this.showScreen('playing');
    this.sceneManager.begin();
    this.input.requestLock();
  }

  /** Ranked queue status from server — surfaced via the floating queue chip. */
  onQueueStatus(msg) {
    this._updateQueueChip(msg);
  }

  mmStatus(msg, ok = true) {
    const el = this.root.querySelector('#mm-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !ok);
  }

  _updateQueueChip(msg) {
    const chip = this.mmQueueChip;
    if (!chip) return;
    const inQueue = !!msg?.inQueue;
    chip.hidden = !inQueue;
    if (inQueue && this.mmQueueText) {
      const n = msg.queueSize ?? 1;
      const range = Number.isFinite(msg.searchRange) ? ` · ±${msg.searchRange}` : '';
      this.mmQueueText.textContent = `Ranked queue · ${n} waiting · ${msg.elo ?? this.auth?.elo ?? 1000} ELO${range}`;
    }
  }

  _bindMatchmaking() {
    const $ = (id) => this.root.querySelector(id);
    $('#menu-mm-tile')?.addEventListener('click', () => this._onMatchmakingClick());
    $('#mm-queue-cancel')?.addEventListener('click', () => {
      this.mp.leaveQueue();
      this.mmStatus('Left queue.', true);
    });
  }

  /** Main-menu Matchmaking tile: sign in if needed, otherwise enter the ranked queue. */
  async _onMatchmakingClick() {
    if (!this.auth?.isConfigured) {
      this._updateQueueChip({ inQueue: false });
      window.alert('Ranked matchmaking is not configured on this deployment.');
      return;
    }
    if (!this.auth?.isLoggedIn) {
      this._openAuth('login');
      return;
    }
    if (this.mp?.inQueue) {
      this.mp.leaveQueue();
      return;
    }
    await this._startMatchmakingQueue();
  }

  /** Refresh ELO then join the ranked queue. The queue chip surfaces progress. */
  async _startMatchmakingQueue() {
    try {
      await this.auth.refreshElo();
    } catch (e) {
      window.alert(e.message || 'Could not refresh ELO.');
      return false;
    }
    const ok = await this.mp.enterQueue({
      name: this._defaultName(),
      userId: this.auth.user.id,
      elo: this.auth.elo
    });
    if (ok) this._updateQueueChip({ inQueue: true, queueSize: 1, elo: this.auth.elo });
    return ok;
  }

  addMpChatMessage(msg) {
    if (!this.mpChatLog) return;
    const line = document.createElement('div');
    line.className = 'mp-chat-line' + (msg.fromId === this.mp.myId ? ' me' : '');
    const name = this._esc(msg.fromName || 'Player');
    line.innerHTML = `<span class="mp-chat-name">${name}</span><span class="mp-chat-text">${this._esc(msg.text)}</span>`;
    this.mpChatLog.appendChild(line);
    this.mpChatLog.scrollTop = this.mpChatLog.scrollHeight;
  }

  _resetMpChat() {
    if (this.mpChatLog) this.mpChatLog.innerHTML = '';
    this._closeMpChatTyping(false);
  }

  _isMpPlaying() {
    return this.state === 'playing' && !!this.sceneManager.current?.isMultiplayer;
  }

  _isDeathmatchRun() {
    const sc = this.sceneManager.current;
    if (!sc || this.state !== 'playing') return false;
    if (sc.name === 'deathmatch') return true;
    return sc.isMultiplayer && sc.getGameMode?.() === 'deathmatch';
  }

  /** Push a line to the deathmatch kill feed (multiplayer kills). */
  pushKillFeed({ killer, victim, headshot = false }) {
    this._mpKillFeed.unshift({ killer, victim, headshot, at: performance.now() });
    if (this._mpKillFeed.length > 6) this._mpKillFeed.length = 6;
    this._renderKillFeed();
  }

  _killFeedEntries() {
    const now = performance.now();
    const ttl = 9000;
    const sc = this.sceneManager.current;
    const sp = sc?.name === 'deathmatch' && sc.getKillFeedEntries
      ? sc.getKillFeedEntries()
      : [];
    const mp = this._mpKillFeed
      .filter((e) => now - e.at < ttl)
      .map(({ killer, victim, headshot }) => ({ killer, victim, headshot }));
    return [...sp, ...mp].slice(0, 6);
  }

  _renderKillFeed() {
    if (!this.dmKillfeed) return;
    const entries = this._killFeedEntries();
    if (!entries.length) {
      this.dmKillfeed.innerHTML = '';
      return;
    }
    this.dmKillfeed.innerHTML = entries
      .map(({ killer, victim, headshot }) => {
        const hs = headshot ? '<span class="dm-kf-hs">HS</span>' : '';
        return `<div class="dm-kf-row">${hs}<span class="dm-kf-killer">${this._esc(killer)}</span><span class="dm-kf-sep">▸</span><span class="dm-kf-victim">${this._esc(victim)}</span></div>`;
      })
      .join('');
  }

  _updateDmLiveScoreboard(sc) {
    if (!this.mpScoreboard) return;
    const rows = sc.getScoreboardRows?.() || [];
    const time = this._formatHudTime(sc);
    const body = rows
      .map((r) =>
        `<div class="mp-sb-row${r.isPlayer ? ' me' : ''}"><span class="mp-sb-name">${this._esc(r.name)}</span><span class="mp-sb-score">${r.kills} / ${r.deaths}</span></div>`
      )
      .join('');
    this.mpScoreboard.innerHTML = `<div class="mp-sb-goal">Deathmatch · ${time}</div>${body}`;
  }

  _renderDmTabScoreboard({ title, rows, footer = '' }) {
    const statRow = (r, i) =>
      `<tr class="${r.isPlayer || r.me ? 'me' : ''}"><td class="mp-tab-rank">${i + 1}</td><td class="mp-tab-name">${this._esc(r.name)}</td><td class="mp-tab-val">${r.kills ?? 0}</td><td class="mp-tab-val">${r.deaths ?? 0}</td></tr>`;
    this.mpTabScoreboard.innerHTML = `
      <div class="mp-tab-board">
        <div class="mp-tab-board-head">${this._tabFpsHtml()}</div>
        <div class="mp-tab-board-title">${this._esc(title)}</div>
        <table class="mp-tab-table mp-tab-table-ffa">
          <thead><tr><th></th><th>Player</th><th>K</th><th>D</th></tr></thead>
          <tbody>${rows.map((r, i) => statRow(r, i)).join('')}</tbody>
        </table>
        ${footer ? `<div class="mp-tab-net">${footer}</div>` : ''}
      </div>`;
  }

  /** Hold-Tab stats overlay during any active run (SP or MP). */
  _canHoldTabOverlay() {
    return this.state === 'playing' && !!this.sceneManager.current
      && !this.mpChat?.classList.contains('typing');
  }

  /** A click on the canvas while unlocked re-acquires pointer lock. */
  _onUnlockedClick() {
    if (this.mpChat?.classList.contains('typing')) return;
    if (this.state === 'playing' || this.state === 'await-start' || this.state === 'countdown') {
      this.input.requestLock();
    }
  }

  /** Toggle the "click to aim" prompt + restore the cursor while unlocked. */
  _setClickToAim(show) {
    if (show === this._aimHintShown) return;
    this._aimHintShown = show;
    this.mpAimHint?.classList.toggle('visible', show);
    document.body.classList.toggle('mp-unlocked', show);
  }

  _openMpChat() {
    if (!this._isMpPlaying() || !this.mpChat || !this.mpChatInput) return;
    this._suppressLockPause = true;
    this.mpChat.classList.add('active', 'typing');
    document.body.classList.add('mp-chat-open');
    this.input.exitLock();
    this.mpChatInput.focus();
  }

  /** Blur chat input and re-lock the mouse; game keeps running. */
  _mpChatTabOut() {
    if (!this.mpChat || !this.mpChatInput) return;
    this._suppressLockPause = true;
    this.mpChat.classList.remove('typing');
    document.body.classList.remove('mp-chat-open');
    this.mpChatInput.blur();
    if (this._isMpPlaying()) this.input.requestLock();
  }

  _closeMpChatTyping(relock = true) {
    this._suppressLockPause = false;
    if (this.mpChat) this.mpChat.classList.remove('typing');
    document.body.classList.remove('mp-chat-open');
    if (this.mpChatInput) this.mpChatInput.blur();
    if (relock && this._isMpPlaying()) this.input.requestLock();
  }

  _sendMpChat() {
    const text = this.mpChatInput?.value.trim();
    if (!text) return;
    this.mp?.net?.sendChat(text);
    this.mpChatInput.value = '';
    this._mpChatTabOut();
  }

  _bindMpChat() {
    const input = this.mpChatInput;
    if (!input) return;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._sendMpChat();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this._mpChatTabOut();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._closeMpChatTyping(true);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!this._isMpPlaying()) return;
      if (e.target === input) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code !== 'Enter' && e.code !== 'KeyY') return;
      e.preventDefault();
      this._openMpChat();
    });
  }

  _hideMpTabScoreboard() {
    this._mpTabBoardHeld = false;
    this.mpTabScoreboard?.classList.remove('visible');
  }

  _mpNetLine() {
    const net = this.mp?.net;
    if (!net?.connected) return '';
    return `${net.pingMs}ms · ${net.lossPct}% loss`;
  }

  _mpServerFootnote() {
    const region = formatServerRegion(this.mp?.net?.serverRegion);
    return region ? `Server · ${region}` : '';
  }

  _mpNetFooter() {
    const net = this._mpNetLine();
    const region = this._mpServerFootnote();
    if (!net && !region) return '';
    return `${net}${net && region ? '<br>' : ''}${region}`;
  }

  _refreshMpNetStats() {
    if (!this._isMpPlaying()) return;
    if (this._mpTabBoardHeld) this._renderMpTabScoreboard();
    const sc = this.sceneManager.current;
    if (sc?.getScores) this.updateMpScore(sc.getScores(), this.mp.lobby, this._mpMapId);
  }

  updateMpTabScoreboard(stats) {
    this._mpTabStats = stats || {};
    if (this._mpTabBoardHeld) this._renderMpTabScoreboard();
  }

  _tabFpsHtml() {
    const fps = this.engine.fps || 0;
    return `<span class="mp-tab-board-fps">${fps} FPS</span>`;
  }

  _renderSpTabScoreboard(sc) {
    if (sc.name === 'deathmatch' && sc.getScoreboardRows) {
      this._renderDmTabScoreboard({
        title: 'Deathmatch',
        rows: sc.getScoreboardRows().map((r) => ({ ...r, me: r.isPlayer }))
      });
      return;
    }
    const title = SCENARIO_META[this.currentScenario]?.title ?? 'Run';
    const statRow = (label, val) =>
      `<tr><td class="mp-tab-label">${label}</td><td class="mp-tab-val">${val}</td></tr>`;
    const rows = [
      statRow('Time', this._formatHudTime(sc)),
      statRow('Score', this._formatHudScore(sc)),
      statRow('Accuracy', `${Math.round(sc.accuracy * 100)}%`),
      statRow('KPS', sc.kps.toFixed(1)),
      statRow('Hits', `${sc.hits}/${sc.shotsFired}`),
      statRow('Headshot %', `${Math.round(sc.critRatio * 100)}%`),
      statRow('Misses', String(sc.misses))
    ];
    if (!isKillLeaderboardScenario(sc.name) && sc.kills > 0) {
      rows.push(statRow('Kills', String(sc.kills)));
    }

    this.mpTabScoreboard.innerHTML = `
      <div class="mp-tab-board">
        <div class="mp-tab-board-head">
          ${this._tabFpsHtml()}
        </div>
        <table class="mp-tab-table mp-tab-table-solo">
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
  }

  _renderMpTabScoreboard() {
    if (!this.mpTabScoreboard) return;

    if (!this._isMpPlaying()) {
      const sc = this.sceneManager.current;
      if (sc) this._renderSpTabScoreboard(sc);
      return;
    }

    const stats = this._mpTabStats;
    const lobby = this.mp?.lobby;
    if (this._mpGameMode === 'deathmatch') {
      const players = [...(lobby?.players || [])];
      const scores = this.sceneManager.current?.getScores?.() || {};
      const rows = players
        .map((p) => ({
          name: p.id === this.mp.myId ? `${p.name} (you)` : p.name,
          kills: scores[p.id] ?? 0,
          deaths: stats[p.id]?.deaths ?? 0,
          me: p.id === this.mp.myId
        }))
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      this._renderDmTabScoreboard({
        title: this._mpGoalLabel({ target: this._mpTarget, gameMode: 'deathmatch' }),
        rows,
        footer: this._mpNetFooter()
      });
      return;
    }

    const players = [...(lobby?.players || [])].sort((a, b) => {
      if (a.id === this.mp.myId) return -1;
      if (b.id === this.mp.myId) return 1;
      return 0;
    });
    if (!players.length) {
      this.mpTabScoreboard.innerHTML = '';
      return;
    }

    const cols = players
      .map((p) => {
        const me = p.id === this.mp.myId ? ' me' : '';
        return `<th class="mp-tab-name${me}">${this._esc(p.name)}</th>`;
      })
      .join('');

    const row = (label, val) =>
      `<tr><td class="mp-tab-label">${label}</td>${players
        .map((p) => {
          const s = stats[p.id] || {};
          const me = p.id === this.mp.myId ? ' me' : '';
          return `<td class="mp-tab-val${me}">${val(s)}</td>`;
        })
        .join('')}</tr>`;

    const goal = this._mpGameMode === 'tracking'
      ? `${TRACKING_DURATION}s Tracking · head 3 · body 2`
      : this._mpGoalLabel({ target: this._mpTarget, gameMode: this._mpGameMode });
    const net = this._mpNetFooter();
    this.mpTabScoreboard.innerHTML = `
      <div class="mp-tab-board">
        <div class="mp-tab-board-head">
          <div class="mp-tab-board-meta">
            ${this._tabFpsHtml()}
          </div>
        </div>
        <table class="mp-tab-table">
          <thead><tr><th></th>${cols}</tr></thead>
          <tbody>
            ${row('Score', (s) => s.score ?? 0)}
            ${this._mpGameMode === 'tracking' ? '' : `${row('Kills', (s) => s.kills ?? 0)}
            ${row('Deaths', (s) => s.deaths ?? 0)}`}
            ${row('Accuracy', (s) => Math.round((s.accuracy ?? 0) * 100) + '%')}
            ${row('Shots', (s) => s.shots ?? 0)}
            ${row('Hits', (s) => s.hits ?? 0)}
            ${this._mpGameMode === 'tracking' ? '' : row('Avg TTK', (s) => (s.avgTtk != null ? `${s.avgTtk.toFixed(2)}s` : '—'))}
          </tbody>
        </table>
        ${net ? `<div class="mp-tab-net">${net}</div>` : ''}
      </div>`;
  }

  _bindMpTabScoreboard() {
    const hide = () => this._hideMpTabScoreboard();
    const show = () => {
      if (!this._canHoldTabOverlay()) return;
      this._mpTabBoardHeld = true;
      this._renderMpTabScoreboard();
      this.mpTabScoreboard?.classList.add('visible');
    };

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab' || e.repeat) return;
      if (!this._canHoldTabOverlay()) return;
      e.preventDefault();
      show();
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Tab') return;
      hide();
    });
    window.addEventListener('blur', hide);
  }

  updateMpScore(scores, lobby, mapId) {
    if (!this.mpScoreboard) return;
    if (mapId) this._mpMapId = mapId;
    const players = (lobby && lobby.players) || [];
    const targetVal = this._mpTarget ?? 0;

    if (this._mpGameMode === 'deathmatch') {
      const stats = this._mpTabStats || {};
      const sorted = [...players].sort(
        (a, b) => (scores[b.id] || 0) - (scores[a.id] || 0)
      );
      const goal = this._mpGoalLabel({ target: targetVal, gameMode: 'deathmatch' });
      const mapLabel = this._mpMapId ? getMap(this._mpMapId).label : '';
      const goalLine = mapLabel ? `${goal} · ${mapLabel}` : goal;
      const rows = sorted
        .map((p) => {
          const me = p.id === this.mp.myId ? ' me' : '';
          const k = scores[p.id] || 0;
          const d = stats[p.id]?.deaths ?? 0;
          return `<div class="mp-sb-row${me}"><span class="mp-sb-name">${this._esc(p.name)}</span><span class="mp-sb-score">${k} / ${d}</span></div>`;
        })
        .join('');
      const net = this._mpNetFooter();
      this.mpScoreboard.innerHTML = `<div class="mp-sb-goal">${goalLine}</div>${rows}${net ? `<div class="mp-sb-net">${net}</div>` : ''}`;
      return;
    }

    const goal = this._mpGameMode === 'tracking'
      ? `Tracking · ${this._mpTrackingRemainingSec().toFixed(1)}s · head 3 · body 2`
      : this._mpGoalLabel({ target: targetVal, gameMode: this._mpGameMode });
    const mapLabel = this._mpGameMode === 'tracking' ? 'Empty arena' : (this._mpMapId ? getMap(this._mpMapId).label : '');
    const goalLine = mapLabel ? `${goal} · ${mapLabel}` : goal;
    const rows = players
      .map((p) => {
        const s = (scores && scores[p.id]) || 0;
        const me = p.id === this.mp.myId ? ' me' : '';
        return `<div class="mp-sb-row${me}"><span class="mp-sb-name">${p.name}</span><span class="mp-sb-score">${s}</span></div>`;
      })
      .join('');
    const net = this._mpNetFooter();
    this.mpScoreboard.innerHTML = `<div class="mp-sb-goal">${goalLine}</div>${rows}${net ? `<div class="mp-sb-net">${net}</div>` : ''}`;
  }

  showMpResults(msg, lobby, myId) {
    this.state = 'mp-results';
    this._resetMpChat();
    this._hideMpTabScoreboard();
    this._updateQueueChip({ inQueue: false });
    this.input.exitLock();
    const won = msg.winnerId === myId;
    const isTracking = msg.gameMode === 'tracking';
    let title;
    if (msg.aborted) title = 'MATCH ABORTED';
    else if (isTracking && msg.winnerId == null) title = 'DRAW';
    else if (won) title = 'VICTORY';
    else title = 'DEFEAT';
    this.root.querySelector('#mp-res-title').textContent = title;
    const players = (lobby && lobby.players) || [];
    const stat = (label, val) =>
      `<div class="stat"><span class="stat-value">${val}</span><label>${label}</label></div>`;
    let html = players
      .map((p) => stat(p.id === myId ? `${p.name} (you)` : p.name, (msg.scores && msg.scores[p.id]) || 0))
      .join('');
    const myElo = msg.elo?.[myId];
    if (myElo) {
      const sign = myElo.delta >= 0 ? '+' : '';
      html += stat('ELO', `${myElo.newElo} (${sign}${myElo.delta})`);
    }
    this.root.querySelector('#mp-res-score').innerHTML = html;
    const rematch = this.root.querySelector('#mp-res-rematch');
    if (rematch) {
      rematch.textContent = msg.isMatchmade ? 'Queue again' : 'Back to lobby';
    }
    this.showScreen('mp-results');
  }

  mpDisconnected() {
    this.state = 'menu';
    this._resetMpChat();
    this._hideMpTabScoreboard();
    this._updateQueueChip({ inQueue: false });
    this.input.exitLock();
    this.sceneManager.unload();
    this.netStatus('Disconnected', false);
    this.showScreen('mp');
  }

  _syncResolutionCustomUi() {
    const custom = this.root.querySelector('#set-res-custom');
    const sel = this.root.querySelector('#set-res');
    if (custom && sel) custom.hidden = sel.value !== 'custom';
  }

  _populateSettings() {
    const s = this.settings.activeSettings();
    const $ = (id) => this.root.querySelector(id);

    $('#set-sensitivity').value = s.sensitivity;
    this._setRange('set-fov', s.hFov);
    $('#set-res').value = s.resolution === 'custom' || !RESOLUTIONS[s.resolution]
      ? (s.resolution === 'custom' ? 'custom' : 'native')
      : s.resolution;
    const resW = $('#set-res-w');
    const resH = $('#set-res-h');
    if (resW) resW.value = s.resolutionWidth ?? RESOLUTIONS[s.resolution]?.size?.[0] ?? 1920;
    if (resH) resH.value = s.resolutionHeight ?? RESOLUTIONS[s.resolution]?.size?.[1] ?? 1080;
    this._syncResolutionCustomUi();
    $('#set-dur').value = s.runDuration;
    $('#set-raw').checked = s.rawInput;
    $('#set-copy-replay-config').checked = !!s.copyConfigOnReplay;

    $('#set-xh-color').value = s.crosshair.color;
    this._setRange('set-xh-gap', s.crosshair.innerGap);
    this._setRange('set-xh-len', s.crosshair.length);
    this._setRange('set-xh-thick', s.crosshair.thickness);
    this._setRange('set-xh-dot', s.crosshair.dotPercentage);
    $('#set-xh-hitmarker').checked = s.crosshair.hitmarker !== false;
    $('#set-xh-dyn').checked = !!s.crosshair.dynamicGap;
    this._setRange('set-xh-outline-thick', s.crosshair.outlineThickness ?? (s.crosshair.outline ? 1 : 0));
    $('#set-xh-outline-color').value = s.crosshair.outlineColor || '#000000';
    this._setRange('set-xh-outline-opacity', Math.round((s.crosshair.outlineOpacity ?? 1) * 100));
    this.crosshair.drawPreview();

    $('#set-vm-hand').value = s.viewmodel?.hand === 'left' ? 'left' : 'right';
    this._setRange('set-vm-fov', s.viewmodel?.fov ?? 68);
    this._setRange('set-vm-ox', s.viewmodel?.offsetX ?? 0.16);
    this._setRange('set-vm-oy', s.viewmodel?.offsetY ?? -0.15);
    this._setRange('set-vm-oz', s.viewmodel?.offsetZ ?? 0.5);
    $('#set-vm-bob').checked = s.viewmodel?.bob !== false;
    $('#set-vm-aimpunch').checked = s.weapon?.aimpunch !== false;

    this._setRange('set-sniper-thick', s.sniper?.lineThickness ?? 2);
    this._syncKeyCaptureLabel('set-sniper-bind1', s.sniper?.unscopeKey1 ?? 'Digit3');
    this._syncKeyCaptureLabel('set-sniper-bind2', s.sniper?.unscopeKey2 ?? 'KeyQ');

    this._setRange('set-grid-size', s.gridshot.targetSize);
    this._setRange('set-grid-count', s.gridshot.targetCount ?? 3);
    $('#set-grid-mode').value = s.gridshot.mode || 'clicking';
    this._setRange('set-grid-track-time', s.gridshot.trackTime ?? 0.4);
    $('#set-grid-track-resolve').value = s.gridshot.trackResolve || 'click';
    $('#set-grid-float').checked = !!s.gridshot.floatEnabled;
    this._setRange('set-grid-float-speed', s.gridshot.floatSpeedMax ?? 2);
    this._setRange('set-grid-bounds-y', s.gridshot.boundsScaleY ?? 1);
    this._setRange('set-grid-bounds-x', s.gridshot.boundsScaleX ?? 1);
    $('#set-grid-tl').checked = s.gridshot.enableTimeLimit;
    this._setRange('set-grid-age', s.gridshot.maxTargetAge);
    $('#set-grid-infinite-ammo').checked = s.gridshot.infiniteAmmo !== false;
    $('#set-grid-vm-recoil').checked = s.gridshot.viewmodelRecoil === true;
    this._setRange('set-grid-misslimit', s.gridshot.missLimit ?? 0);

    const st = s.stars ?? {};
    this._setRange('set-stars-size', st.targetSize ?? 0.1);
    this._setRange('set-stars-count', st.targetCount ?? 200);
    this._setRange('set-stars-misslimit', st.missLimit ?? 0);

    const bn = s.bounce ?? {};
    this._setRange('set-bounce-size', bn.targetSize ?? 0.35);
    this._setRange('set-bounce-count', bn.targetCount ?? 4);
    this._setRange('set-bounce-speed', bn.travelSpeed ?? 35);
    this._setRange('set-bounce-min-dist', bn.minDistance ?? 6);
    this._setRange('set-bounce-max-dist', bn.maxDistance ?? 12);
    this._setRange('set-bounce-strength', bn.bounceStrength ?? bn.bounceHeight ?? 6);
    $('#set-bounce-infinite-ammo').checked = bn.infiniteAmmo !== false;
    this._setRange('set-bounce-misslimit', bn.missLimit ?? 0);

    const mf = s.microflicks ?? {};
    this._setRange('set-mf-size', mf.targetSize ?? 0.1);
    this._setRange('set-mf-count', mf.targetCount ?? 2);
    $('#set-mf-float').checked = !!mf.floatEnabled;
    this._setRange('set-mf-float-speed', mf.floatSpeedMax ?? 2);
    this._setRange('set-mf-bounds-y', mf.boundsScaleY ?? 1);
    this._setRange('set-mf-bounds-x', mf.boundsScaleX ?? 2);
    this._setRange('set-mf-misslimit', mf.missLimit ?? 0);

    this._setRange('set-pasu-size', s.pasu?.targetSize ?? 0.38);
    this._setRange('set-pasu-count', s.pasu?.targetCount ?? 3);
    $('#set-pasu-mode').value = s.pasu?.mode || 'clicking';
    this._setRange('set-pasu-track-time', s.pasu?.trackTime ?? 0.4);
    $('#set-pasu-track-resolve').value = s.pasu?.trackResolve || 'click';
    this._setRange('set-pasu-travel-speed', s.pasu?.travelSpeedMax ?? 2.5);
    this._setRange('set-pasu-bounds-y', s.pasu?.boundsScaleY ?? 1);
    this._setRange('set-pasu-bounds-x', s.pasu?.boundsScaleX ?? 1);
    this._setRange('set-pasu-angle', s.pasu?.angleOffset ?? 360);
    $('#set-pasu-tl').checked = !!s.pasu?.enableTimeLimit;
    this._setRange('set-pasu-age', s.pasu?.maxTargetAge ?? 1200);
    $('#set-pasu-infinite-ammo').checked = s.pasu?.infiniteAmmo !== false;
    this._setRange('set-pasu-misslimit', s.pasu?.missLimit ?? 0);

    this._setRange('set-spider-size', s.spidershot?.targetSize ?? 0.30);
    this._setRange('set-spider-ttk', s.spidershot?.timeToKill ?? 1500);
    this._setRange('set-spider-max-dist', s.spidershot?.maxDistance ?? 6.4);
    this._setRange('set-spider-min-dist', s.spidershot?.minDistance ?? 1.2);
    this._setRange('set-spider-height', s.spidershot?.heightSpread ?? 1);
    this._setRange('set-spider-angle', s.spidershot?.angleSpread ?? 25);
    this._setRange('set-spider-streak', Math.round((s.spidershot?.streakChance ?? 0.15) * 100));
    this._setRange('set-spider-streak-min', s.spidershot?.streakLengthMin ?? 2);
    this._setRange('set-spider-streak-max', s.spidershot?.streakLengthMax ?? 4);
    this._setRange('set-spider-double', Math.round((s.spidershot?.doubleSpawnChance ?? 0.08) * 100));
    $('#set-spider-drift').checked = !!s.spidershot?.horizontalDrift;
    this._setRange('set-spider-drift-speed', s.spidershot?.driftSpeedMax ?? 1.5);
    $('#set-spider-random-size').checked = !!s.spidershot?.randomSize;
    this._setRange('set-spider-size-min', s.spidershot?.randomSizeMin ?? 0.21);
    this._setRange('set-spider-size-max', s.spidershot?.randomSizeMax ?? 0.35);
    $('#set-spider-infinite-ammo').checked = s.spidershot?.infiniteAmmo !== false;
    $('#set-spider-vm-recoil').checked = s.spidershot?.viewmodelRecoil === true;
    $('#set-spider-decoys').checked = s.spidershot?.decoyEnabled !== false;
    this._setRange('set-spider-decoy-chance', Math.round((s.spidershot?.decoyChancePer ?? 0.1) * 100));
    this._setRange('set-spider-decoy-min', s.spidershot?.decoyMin ?? 0);
    this._setRange('set-spider-decoy-max', s.spidershot?.decoyMax ?? 2);
    this._setRange('set-spider-misslimit', s.spidershot?.missLimit ?? 0);

    this._setRange('set-surv-spawn', s.survival?.spawnInterval ?? 1000);
    this._setRange('set-surv-despawn', s.survival?.despawnTime ?? 2000);
    this._setRange('set-surv-max-size', s.survival?.maxSize ?? 0.55);
    this._setRange('set-surv-strikes', s.survival?.missesAllowed ?? 3);

    this._setRange('set-arena-botdist-min', s.arena.botDistMin ?? 0.5);
    this._setRange('set-arena-botdist-max', s.arena.botDistMax ?? 1.5);
    this._setRange('set-arena-col', s.arena.columns);
    this._setRange('set-arena-colr', s.arena.columnRadius);
    this._setRange('set-arena-ring', s.arena.ringRadius);
    this._setRange('set-arena-enemy', s.arena.enemyScale);
    this._setRange('set-arena-misslimit', s.arena.missLimit ?? 0);

    const snxf = s.snipercrossfire ?? {};
    this._setRange('set-snxf-botdist-min', snxf.botDistMin ?? 0.5);
    this._setRange('set-snxf-botdist-max', snxf.botDistMax ?? 1.5);
    this._setRange('set-snxf-col', snxf.columns ?? 7);
    this._setRange('set-snxf-colr', snxf.columnRadius ?? 0.55);
    this._setRange('set-snxf-ring', snxf.ringRadius ?? 7);
    this._setRange('set-snxf-enemy', snxf.enemyScale ?? 1.0);
    this._setRange('set-snxf-misslimit', snxf.missLimit ?? 0);

    $('#set-duels-arena').value = String(s.duels.arena);
    $('#set-duels-bot-difficulty').value = s.duels.botDifficulty ?? 'hard';
    this._setRange('set-duels-ttk', s.duels.ttk);
    this._setRange('set-duels-misslimit', s.duels.missLimit ?? 0);

    this._setRange('set-dm-bots', s.deathmatch?.botCount ?? 4);
    $('#set-dm-bot-difficulty').value = s.deathmatch?.botDifficulty ?? 'hard';
    this._setRange('set-dm-speed', s.deathmatch?.botSpeed ?? 1);
    this._setRange('set-dm-body', Math.round((s.deathmatch?.botBodyHit ?? 0.2) * 100));
    this._setRange('set-dm-head', Math.round((s.deathmatch?.botHeadHit ?? 0.05) * 100));
    this._setRange('set-dm-misslimit', s.deathmatch?.missLimit ?? 0);

    $('#set-col-bg').value = s.colors.bg;
    $('#set-col-floor').value = s.colors.floor;
    $('#set-col-ebody').value = s.colors.enemyBody;
    $('#set-col-ehead').value = s.colors.enemyHead;
    $('#set-col-cover').value = s.colors.cover;
    $('#set-col-target').value = s.colors.target;

    $('#set-range-arc').value = String(s.range.arc);
    const rangeWeapon = this.root.querySelector('#set-range-weapon');
    if (rangeWeapon) rangeWeapon.value = s.range.weapon === 'sniper' ? 'sniper' : 'rifle';
    this._setRange('set-range-count', s.range.enemyCount);
    this._setRange('set-range-rad', s.range.radius);
    $('#set-range-bot-move').value = s.range.botStrafe !== false ? 'strafe' : 'static';
    $('#set-range-bot-crouch').value = s.range.botCrouchTap !== false ? 'tap' : 'off';
    $('#set-range-infinite-ammo').checked = s.range.infiniteAmmo !== false;
    $('#set-range-cover').checked = !!s.range.coverEnabled;
    this._setRange('set-range-cover-count', s.range.coverCount ?? 4);
    this._setRange('set-range-cover-dist', s.range.coverDistance ?? 4);
    this._setRange('set-range-cover-thick', s.range.coverThickness ?? 1.2);
    this._setRange('set-range-cover-height', s.range.coverHeight ?? 3);
    this._setRange('set-range-misslimit', s.range.missLimit ?? 0);
    this._setRange('set-tracking-width', s.tracking?.botWidth ?? 1);
    this._setRange('set-tracking-speed', s.tracking?.botSpeed ?? 1);
    $('#set-tracking-crouch').checked = s.tracking?.botCrouchTap !== false;
    this._setRange('set-tracking-strafe', s.tracking?.strafeRate ?? 1);
    this._setRange('set-tracking-misslimit', s.tracking?.missLimit ?? 0);

    const snh = s.sniperholds ?? {};
    const snhd = this.root.querySelector('#set-snholds-bot-difficulty');
    if (snhd) snhd.value = snh.botDifficulty ?? 'hard';
    const snha = this.root.querySelector('#set-snholds-arena');
    if (snha) snha.value = String(snh.arena ?? 0);
    this._setRange('set-snholds-ttk', snh.ttk ?? 0.5);
    this._setRange('set-snholds-misslimit', snh.missLimit ?? 0);

    const snq = s.sniperquickscopes ?? {};
    this._setRange('set-snqs-rings', snq.rowCount ?? 3);
    this._setRange('set-snqs-boxes', snq.coverPerRow ?? 8);
    this._setRange('set-snqs-dist', snq.rowDistance ?? 14);
    this._setRange('set-snqs-spacing', snq.rowSpacing ?? 8);
    this._setRange('set-snqs-botspeed', snq.botSpeed ?? 1);
    this._setRange('set-snqs-react-min', snq.reactMin ?? 25);
    this._setRange('set-snqs-react-max', snq.reactMax ?? 200);
    this._setRange('set-snqs-hp', snq.playerHp ?? 4);
    this._setRange('set-snqs-misslimit', snq.missLimit ?? 0);
    const snqh = this.root.querySelector('#set-snqs-spawn-hint');
    if (snqh) snqh.checked = snq.spawnHint !== false;

    const pit = s.pitrifle ?? {};
    this._setRange('set-pit-rings', pit.rowCount ?? 3);
    this._setRange('set-pit-boxes', pit.coverPerRow ?? 8);
    this._setRange('set-pit-dist', pit.rowDistance ?? 14);
    this._setRange('set-pit-spacing', pit.rowSpacing ?? 8);
    this._setRange('set-pit-botspeed', pit.botSpeed ?? 1);
    this._setRange('set-pit-react-min', pit.reactMin ?? 25);
    this._setRange('set-pit-react-max', pit.reactMax ?? 200);
    this._setRange('set-pit-hp', pit.playerHp ?? 4);
    this._setRange('set-pit-misslimit', pit.missLimit ?? 0);
    const pith = this.root.querySelector('#set-pit-spawn-hint');
    if (pith) pith.checked = pit.spawnHint !== false;

    const snf = s.sniperflicks ?? {};
    this._setRange('set-snfl-radius-x', snf.spawnScaleX ?? 1);
    this._setRange('set-snfl-radius-y', snf.spawnScaleY ?? 1);
    this._setRange('set-snfl-size', snf.botScale ?? 1);
    this._setRange('set-snfl-min-dist', snf.minDistance ?? 35);
    this._setRange('set-snfl-max-dist', snf.maxDistance ?? 75);
    const snfm = this.root.querySelector('#set-snfl-move');
    if (snfm) snfm.checked = !!snf.botsMove;
    this._setRange('set-snfl-misslimit', snf.missLimit ?? 0);

    const snt = s.snipertracking ?? {};
    this._setRange('set-sntr-width', snt.botWidth ?? 1);
    this._setRange('set-sntr-speed', snt.botSpeed ?? 1);
    this._setRange('set-sntr-hold', snt.holdTime ?? 0.5);
    this._setRange('set-sntr-respawn', snt.respawnDelay ?? 1);
    this._setRange('set-sntr-min-dist', snt.minDistance ?? 10);
    this._setRange('set-sntr-max-dist', snt.maxDistance ?? 16);
    const sntc = this.root.querySelector('#set-sntr-bot-crouch');
    if (sntc) sntc.value = snt.botCrouchTap !== false ? 'tap' : 'off';
    this._setRange('set-sntr-misslimit', snt.missLimit ?? 0);

    const doors = s.doorsawp ?? {};
    const doorsCross = this.root.querySelector('#set-doors-cross');
    if (doorsCross) doorsCross.value = doors.crossFrom === 'leftToRight' ? 'leftToRight' : 'rightToLeft';
    const doorsFb = this.root.querySelector('#set-doors-feedback');
    if (doorsFb) doorsFb.checked = doors.shotFeedback !== false;
    this._setRange('set-doors-speed', doors.botSpeed ?? 1);
    this._setRange('set-doors-feedback-dur', doors.shotFeedbackDur ?? 0.5);
    this._setRange('set-doors-misslimit', doors.missLimit ?? 0);

    const sq = s.sequence ?? {};
    this._setRange('set-seq-size', sq.targetSize ?? 0.25);
    this._setRange('set-seq-time', sq.dotTime ?? 1500);
    this._setRange('set-seq-start-dist', sq.startDistance ?? 0.8);
    this._setRange('set-seq-step', sq.distanceStep ?? 0.35);
    $('#set-seq-infinite-ammo').checked = sq.infiniteAmmo !== false;

    const ss = s.sequencespeed ?? {};
    this._setRange('set-ss-start-size', ss.startSize ?? 0.12);
    this._setRange('set-ss-max-size', ss.maxSize ?? 0.55);
    this._setRange('set-ss-grow', ss.growTime ?? 1500);
    this._setRange('set-ss-start-dist', ss.startDistance ?? 0.8);
    this._setRange('set-ss-step', ss.distanceStep ?? 0.35);
    $('#set-ss-infinite-ammo').checked = ss.infiniteAmmo !== false;

    const sqtr = s.sequencetracking ?? {};
    this._setRange('set-st-size', sqtr.targetSize ?? 0.2);
    this._setRange('set-st-time', sqtr.dotTime ?? 1500);
    this._setRange('set-st-hold', sqtr.holdTime ?? 0.3);
    this._setRange('set-st-float', sqtr.floatSpeed ?? 1.0);
    this._setRange('set-st-start-dist', sqtr.startDistance ?? 0.8);
    this._setRange('set-st-step', sqtr.distanceStep ?? 0.35);
    $('#set-st-infinite-ammo').checked = sqtr.infiniteAmmo !== false;

    const db = s.double ?? {};
    this._setRange('set-double-size', db.targetSize ?? 0.25);
    this._setRange('set-double-canvas', db.canvasSize ?? 3);
    this._setRange('set-double-dist', db.canvasDistance ?? 4);
    this._setRange('set-double-count', db.canvasCount ?? 2);
    $('#set-double-layout').value = db.layout === 'around' ? 'around' : 'flat';
    $('#set-double-infinite-ammo').checked = db.infiniteAmmo !== false;
    this._setRange('set-double-misslimit', db.missLimit ?? 0);

    const dt = s.doubletracking ?? {};
    this._setRange('set-dt-size', dt.targetSize ?? 0.2);
    this._setRange('set-dt-hold', dt.holdTime ?? 0.3);
    this._setRange('set-dt-float', dt.floatSpeed ?? 1.0);
    this._setRange('set-dt-canvas', dt.canvasSize ?? 3);
    this._setRange('set-dt-dist', dt.canvasDistance ?? 4);
    this._setRange('set-dt-count', dt.canvasCount ?? 2);
    $('#set-dt-layout').value = dt.layout === 'around' ? 'around' : 'flat';
    $('#set-dt-infinite-ammo').checked = dt.infiniteAmmo !== false;
    this._setRange('set-dt-misslimit', dt.missLimit ?? 0);

    const bl = s.ball ?? {};
    this._setRange('set-ball-size', bl.targetSize ?? 0.5);
    this._setRange('set-ball-speed', bl.travelSpeed ?? 60);
    this._setRange('set-ball-min-dist', bl.minDistance ?? 8);
    this._setRange('set-ball-max-dist', bl.maxDistance ?? 16);
    this._setRange('set-ball-height', bl.bounceHeight ?? 2.5);

    const bt = s.bouncetracking ?? {};
    this._setRange('set-bt-size', bt.targetSize ?? 0.225);
    this._setRange('set-bt-count', bt.targetCount ?? 3);
    this._setRange('set-bt-speed', bt.travelSpeed ?? 28);
    this._setRange('set-bt-hold', bt.holdTime ?? 0.5);
    this._setRange('set-bt-height', bt.bounceHeight ?? 2.2);
    this._setRange('set-bt-misslimit', bt.missLimit ?? 0);

    const pt = s.pasutracking ?? {};
    this._setRange('set-pt-size', pt.targetSize ?? 0.33);
    this._setRange('set-pt-count', pt.targetCount ?? 3);
    this._setRange('set-pt-hold', pt.trackTime ?? 0.5);
    this._setRange('set-pt-travel-speed', pt.travelSpeedMax ?? 2.0);
    this._setRange('set-pt-misslimit', pt.missLimit ?? 0);

    const tn = s.turn ?? {};
    this._setRange('set-turn-size', tn.targetSize ?? 0.15);
    this._setRange('set-turn-time', tn.dotTime ?? 2000);
    $('#set-turn-despawn-miss').checked = tn.despawnOnMiss !== false;
    $('#set-turn-infinite-ammo').checked = tn.infiniteAmmo !== false;

    const bx = s.box ?? {};
    this._setRange('set-box-size', bx.targetSize ?? 0.3);
    this._setRange('set-box-w', bx.sizeX ?? 7);
    this._setRange('set-box-h', bx.sizeY ?? 4);
    this._setRange('set-box-speed', bx.travelSpeed ?? 150);
    this._setRange('set-box-variance', bx.speedVariance ?? 50);
    this._setRange('set-box-misslimit', bx.missLimit ?? 0);

    const ci = s.circle ?? {};
    this._setRange('set-circle-size', ci.targetSize ?? 0.3);
    this._setRange('set-circle-w', ci.sizeX ?? 7);
    this._setRange('set-circle-h', ci.sizeY ?? 4);
    this._setRange('set-circle-speed', ci.travelSpeed ?? 150);
    this._setRange('set-circle-variance', ci.speedVariance ?? 50);
    this._setRange('set-circle-misslimit', ci.missLimit ?? 0);

    const ts = s.threeshot ?? {};
    this._setRange('set-3s-size', ts.targetSize ?? 0.075);
    this._setRange('set-3s-count', ts.targetCount ?? 3);
    $('#set-3s-float').checked = !!ts.floatEnabled;
    this._setRange('set-3s-float-speed', ts.floatSpeedMax ?? 2);
    this._setRange('set-3s-bounds-x', ts.boundsScaleX ?? 2);
    this._setRange('set-3s-bounds-y', ts.boundsScaleY ?? 2);
    this._setRange('set-3s-misslimit', ts.missLimit ?? 0);

    const cv = s.cover ?? {};
    this._setRange('set-cover-rows', cv.rowCount ?? 3);
    this._setRange('set-cover-boxes', cv.coverPerRow ?? 3);
    this._setRange('set-cover-dist', cv.rowDistance ?? 16);
    this._setRange('set-cover-spacing', cv.rowSpacing ?? 10);
    this._setRange('set-cover-botspeed', cv.botSpeed ?? 1);
    this._setRange('set-cover-react-min', cv.reactMin ?? 25);
    this._setRange('set-cover-react-max', cv.reactMax ?? 200);
    this._setRange('set-cover-hp', cv.playerHp ?? 4);
    this._setRange('set-cover-bothp', cv.botHp ?? 2);
    this._setRange('set-cover-misslimit', cv.missLimit ?? 0);
    $('#set-cover-spawn-hint').checked = !!cv.spawnHint;

    const cva = s.coverawp ?? {};
    this._setRange('set-cvawp-rows', cva.rowCount ?? 3);
    this._setRange('set-cvawp-boxes', cva.coverPerRow ?? 3);
    this._setRange('set-cvawp-dist', cva.rowDistance ?? 16);
    this._setRange('set-cvawp-spacing', cva.rowSpacing ?? 10);
    this._setRange('set-cvawp-botspeed', cva.botSpeed ?? 1);
    this._setRange('set-cvawp-react-min', cva.reactMin ?? 25);
    this._setRange('set-cvawp-react-max', cva.reactMax ?? 200);
    this._setRange('set-cvawp-hp', cva.playerHp ?? 4);
    this._setRange('set-cvawp-misslimit', cva.missLimit ?? 0);
    const cvah = this.root.querySelector('#set-cvawp-spawn-hint');
    if (cvah) cvah.checked = cva.spawnHint !== false;

    const dr = s.drone ?? {};
    this._setRange('set-drone-size', dr.targetSize ?? 0.5);
    this._setRange('set-drone-speed', dr.travelSpeed ?? 60);
    this._setRange('set-drone-min-dist', dr.minDistance ?? 8);
    this._setRange('set-drone-max-dist', dr.maxDistance ?? 16);
    this._setRange('set-drone-height', dr.bounceHeight ?? 2.5);

    const ln = s.line ?? {};
    this._setRange('set-line-size', ln.targetSize ?? 0.35);
    this._setRange('set-line-speed', ln.travelSpeed ?? 180);
    this._setRange('set-line-misslimit', ln.missLimit ?? 0);
  }

  // -------------------------------------------------------------------------
  // Screen state machine
  // -------------------------------------------------------------------------
  showScreen(name, { skipSettingsOpen = false } = {}) {
    this.state = name;
    for (const key in this.screens) {
      this.screens[key].classList.toggle('active', key === name);
    }
    const inRun = name === 'playing';
    const sc = this.sceneManager.current;
    const isMp = inRun && sc && sc.isMultiplayer;
    const isDm = inRun && this._isDeathmatchRun();
    // Deathmatch uses kill feed + hold-Tab board only (no top score strip).
    this.hud.classList.toggle('active', inRun && !isMp && !isDm);
    if (this.mpScoreboard) {
      this.mpScoreboard.classList.toggle('active', isMp && !isDm);
    }
    if (this.dmKillfeed) this.dmKillfeed.classList.toggle('active', isDm);
    if (!isDm) {
      this._mpKillFeed = [];
      if (this.dmKillfeed) this.dmKillfeed.innerHTML = '';
    }
    if (this.mpChat) {
      this.mpChat.classList.toggle('active', !!isMp);
      if (!isMp) this._closeMpChatTyping(false);
    }
    this.crosshair.setVisible(inRun);
    if (name === 'settings' && !skipSettingsOpen && !this._settingsExploreMode) this._openSettings();
    // Hide the system cursor only while actively playing — when paused (Esc),
    // the cursor must reappear so the menu is clickable.
    document.body.classList.toggle('in-run', inRun);
    if (name === 'training') this._renderTrainingList();
    if (name === 'paused') this._updatePauseMenu();
    if (name === 'menu') {
      this.refreshAccountBar();
      this._updateFullscreenTip();
    }
    if (name === 'account') {
      const uid = this._viewingAccount?.userId ?? this.auth?.user?.id;
      if (uid) this._loadAccountReplays(uid);
    }
    if (this.menuCredit) {
      this.menuCredit.hidden = !name || !MENU_CREDIT_SCREENS.has(name);
    }
  }

  _isFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    const h = screen.availHeight ?? screen.height;
    const w = screen.availWidth ?? screen.width;
    return window.innerHeight >= h - 2 && window.innerWidth >= w - 2;
  }

  _updateFullscreenTip() {
    const shell = this.root.querySelector('#menu-fullscreen-tip-shell');
    if (!shell) return;
    const collapsed = this._menuTipDismissed || this._isFullscreen();
    shell.classList.toggle('is-collapsed', collapsed);
    shell.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
  }

  _bindFullscreenTip() {
    const update = () => this._updateFullscreenTip();
    this.root.querySelector('#menu-fullscreen-tip-close')?.addEventListener('click', () => {
      this._menuTipDismissed = true;
      Storage.write('menuTipDismissed', true);
      this._updateFullscreenTip();
    });
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    window.addEventListener('resize', update);
  }

  /** Singleplayer competitive runs wait briefly before the timer starts. */
  _isCompetitiveRun() {
    return this.scenarioConfig?.variant === 'competitive';
  }

  _startCountdown() {
    this.state = 'countdown';
    this._countdownRemaining = 1;
    this._updateCountdownOverlay();
  }

  _beginRun() {
    this._countdownRemaining = 0;
    this._hideCountdownOverlay();
    this.sceneManager.begin();
    this._startRecording();
    this.state = 'playing';
  }

  /** Begin telemetry capture for a singleplayer run (skips multiplayer + playlists). */
  _startRecording() {
    const sc = this.sceneManager.current;
    if (!this.replayRecorder || !sc || sc.isMultiplayer || this._playlistRun) return;
    this.replayRecorder.begin({
      scenario: sc,
      configKey: sc.configKey(),
      variant: this.scenarioConfig?.variant === 'competitive' ? 'competitive' : 'practice',
      config: this.scenarioConfig || {},
      settings: {
        hFov: this.settings.data.hFov,
        resolution: this.settings.data.resolution,
        resolutionWidth: this.settings.data.resolutionWidth,
        resolutionHeight: this.settings.data.resolutionHeight,
        colors: structuredClone(this.settings.data.colors),
        crosshair: structuredClone(this.settings.data.crosshair),
        viewmodel: structuredClone(this.settings.data.viewmodel),
        weapon: { aimpunch: this.settings.data.weapon?.aimpunch }
      },
      weaponId: sc.weaponId,
      viewmodelRecoil: sc.viewmodelRecoil,
      showViewmodel: sc.showViewmodel
    });
  }

  _updateCountdownOverlay() {
    if (!this.runCountdown || !this.runCountdownNum) return;
    const active = this._countdownRemaining > 0;
    this.runCountdown.hidden = !active;
    if (active) {
      this.runCountdownNum.textContent = String(Math.ceil(this._countdownRemaining));
    }
  }

  _hideCountdownOverlay() {
    if (this.runCountdown) this.runCountdown.hidden = true;
  }

  play(name, config = {}) {
    this._countdownRemaining = 0;
    this._hideCountdownOverlay();
    this.currentScenario = name;
    this.scenarioConfig = config;
    this.sceneManager.load(name, config);
    const noCrit = ['spidershot', 'survival', 'sequence', 'sequencespeed', 'sequencetracking', 'sequenceultra', 'double', 'doubletracking', 'ball', 'line', 'turn', 'box', 'circle', 'threeshot', 'drone', 'galaxy', 'waves', 'reactiontime'].includes(name);
    this.hudCritChip.style.display = noCrit ? 'none' : '';
    this.showScreen('playing');
    this.state = 'await-start';
    if (!this._routeFromPopstate) {
      replaceGamemodePath(name, config.variant || 'practice');
    }
    this.input.requestLock();
  }

  resume() {
    if (this.state !== 'paused') return;
    if (this._countdownRemaining > 0) {
      this.showScreen('playing');
      this.state = 'countdown';
      this._updateCountdownOverlay();
      this.input.requestLock();
      return;
    }
    this.sceneManager.resume();
    this.showScreen('playing');
    this.input.requestLock();
  }

  quit() {
    this._countdownRemaining = 0;
    this._hideCountdownOverlay();
    this.replayRecorder?.cancel(); // abandoned run — discard its recording
    this._playlistRun = null; // abandon any in-progress playlist
    this.settings.endModeOverride();
    this.state = 'menu';
    this._resetMpChat();
    this._hideMpTabScoreboard();
    this.input.exitLock();
    if (this.mp?.inMatch || this.mp?.lobby) {
      this.mp.leave();
    } else {
      this.sceneManager.unload();
    }
    this._updateQueueChip({
      inQueue: this.mp?.inQueue,
      queueSize: 0,
      elo: this.mp?.queueElo ?? this.auth?.elo
    });
    clearGamemodePath();
    this.showScreen('menu');
  }

  _onLockChange(locked) {
    if (locked) {
      this.engine.audio?.resume();
      this._suppressLockPause = false;
      if (this.state === 'await-start') {
        if (this._isCompetitiveRun()) {
          this._startCountdown();
        } else {
          this._beginRun();
        }
      }
    } else {
      // Chat input steals pointer lock — keep the match running so remotes keep moving.
      if (this._suppressLockPause) return;
      if (this.state === 'countdown') {
        this._closeMpChatTyping(false);
        this._hideMpTabScoreboard();
        this._updatePauseMenu();
        this.showScreen('paused');
      } else if (this.state === 'playing') {
        this._closeMpChatTyping(false);
        this._hideMpTabScoreboard();
        this.sceneManager.pause();
        this._updatePauseMenu();
        this.showScreen('paused');
      }
    }
  }

  async _onFinish(results) {
    if (this._playlistRun) {
      this._onPlaylistModeFinish(results);
      return;
    }
    this.state = 'results';
    this.input.exitLock();
    const title = this.root.querySelector('#res-title');
    if (title) {
      title.textContent =
        results.scenario === 'survival' ? 'Game Over' : 'Run Complete';
    }
    this.showScreen('results');
    const replayRes = await this._finalizeRecording(results);
    await this._saveAndRenderResults(results, replayRes);
    if (this.auth?.isLoggedIn && results.timePlayed > 0) {
      incrementPlayTime(this.auth.user.id, results.timePlayed).catch((e) =>
        console.warn('[ui] play time log failed', e)
      );
    }
    if (replayRes?.ok) {
      await this._loadAccountReplays(this.auth?.user?.id);
    }
  }

  /** Finalize telemetry: keep it for instant replay + sync to Supabase. */
  async _finalizeRecording(results) {
    const watchBtn = this.root.querySelector('#res-watch-replay');
    const shareBtn = this.root.querySelector('#res-share-replay');
    if (watchBtn) watchBtn.hidden = true;
    if (shareBtn) shareBtn.hidden = true;
    this._lastReplay = null;
    this._lastReplayShare = null;
    if (!this.replayRecorder?.active) return { ok: false, reason: 'no recording', analytics: null };

    const recording = this.replayRecorder.finish();
    if (!recording) return { ok: false, reason: 'no recording', analytics: null };

    // Always measure aim analytics for the run (independent of viewer toggles).
    let analytics = null;
    try {
      this._lastReplay = localDecode(recording);
      analytics = new ReplayAnalytics(this._lastReplay).aggregate();
      if (watchBtn) watchBtn.hidden = false;
    } catch (e) {
      console.warn('[ui] local replay decode/analytics failed', e);
    }

    if (!this.auth?.isLoggedIn || !supabaseConfigured()) {
      return { ok: false, reason: 'not signed in', analytics };
    }

    try {
      await this.auth.ensureProfileReady();
    } catch (e) {
      console.warn('[ui] profile ensure failed before replay save', e);
    }

    // Log competitive runs to the cross-player aim-stats table (fire-and-forget).
    if (analytics && recording.variant === 'competitive') {
      logAimRun(this.auth.user.id, recording, analytics).catch((e) =>
        console.warn('[ui] aim-run log failed', e)
      );
    }

    const res = await saveReplay(this.auth.user.id, recording, results, analytics);
    if (res.ok && res.lastPath) {
      this._lastReplayShare = {
        sourcePath: res.lastPath,
        userId: this.auth.user.id,
        username: this.auth.displayName,
        shareMeta: res.shareMeta
      };
      if (shareBtn) shareBtn.hidden = false;
    }
    if (!res.ok && res.reason && res.reason !== 'offline') {
      console.warn('[ui] replay not saved:', res.reason);
    }
    return { ...res, analytics };
  }

  // -------------------------------------------------------------------------
  // Replay playback
  // -------------------------------------------------------------------------
  _bindReplay() {
    this.replayOverlay = this.root.querySelector('#replay-overlay');
    this.replayScrub = this.root.querySelector('#replay-scrub');
    this.replayTime = this.root.querySelector('#replay-time');
    this.replayPlayPause = this.root.querySelector('#replay-playpause');
    const speedWrap = this.root.querySelector('#replay-speeds');

    if (speedWrap) {
      speedWrap.innerHTML = REPLAY_SPEEDS.map(
        (s) => `<button type="button" class="btn btn-sm replay-speed" data-speed="${s}">${s}×</button>`
      ).join('');
      speedWrap.querySelectorAll('[data-speed]').forEach((b) => {
        b.addEventListener('click', () => {
          this.engine.audio?.resume();
          this.replayPlayer.setSpeed(Number(b.dataset.speed));
        });
      });
    }

    this.replayPlayPause?.addEventListener('click', () => {
      this.engine.audio?.resume();
      this.replayPlayer.togglePlay();
    });
    this.root.querySelector('#replay-exit')?.addEventListener('click', () => this._exitReplay());
    this.root.querySelector('#replay-share-btn')?.addEventListener('click', () => {
      this._shareReplay(this._replayShareCtx, this.root.querySelector('#replay-share-btn'));
    });
    this.root.querySelector('#res-share-replay')?.addEventListener('click', () => {
      this._shareReplay(this._lastReplayShare, this.root.querySelector('#res-share-replay'));
    });
    this.root.querySelector('#res-watch-replay')?.addEventListener('click', () => {
      const t = SCENARIO_META[this._lastReplay?.scenario]?.title || 'Replay';
      this._watchReplay(this._lastReplay, {
        title: `${t} — last run`,
        returnTo: 'results',
        shareCtx: this._lastReplayShare
      });
    });
    this.replayScrub?.addEventListener('input', () => {
      this.replayPlayer.seekFraction(Number(this.replayScrub.value) / 1000);
    });

    this._replayWheel = (e) => {
      if (!this.replaying) return;
      e.preventDefault();
      this.replayPlayer.adjustZoom(e.deltaY);
    };
    window.addEventListener('wheel', this._replayWheel, { passive: false });

    if (this.replayPlayer) {
      this.replayPlayer.onProgress = (st) => this._updateReplayUI(st);
      this.replayPlayer.onSample = (sample, camera) => this._renderAnalysis(sample, camera);
      this.replayPlayer.onEnd = () => this._updateReplayUI({ playing: false });
    }

    this._bindReplayAnalytics();
    this._analysisLabels = [];

    // Esc leaves the replay (pointer lock is never engaged during playback).
    document.addEventListener('keydown', (e) => {
      if (this.replaying && e.code === 'Escape') this._exitReplay();
    });

    this._replayFromOtherPlayer = false;
    this._updateReplayShareButton();
  }

  // -------------------------------------------------------------------------
  // Replay analysis overlay (optimal path / flicks / trajectory / tension /
  // click timing). Toggles gate visuals only — the engine measures everything.
  // -------------------------------------------------------------------------
  _bindReplayAnalytics() {
    this.replayStats = this.root.querySelector('#replay-stats');
    this.replayAnalysisCanvas = this.root.querySelector('#replay-analysis-canvas');
    this._analysisCtx = this.replayAnalysisCanvas?.getContext('2d') || null;
    const pop = this.root.querySelector('#replay-settings-pop');
    const btn = this.root.querySelector('#replay-settings-btn');

    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop) pop.hidden = !pop.hidden;
    });
    // Click outside closes the popover.
    document.addEventListener('click', (e) => {
      if (!pop || pop.hidden) return;
      if (pop.contains(e.target) || btn?.contains(e.target)) return;
      pop.hidden = true;
    });

    const ra = this.settings.data.replayAnalytics || {};
    for (const key of ['optimalPath', 'flicks', 'trajectory', 'tension', 'clickTiming', 'flickSpeed', 'flickAccuracy']) {
      const cb = this.root.querySelector(`#ra-${key}`);
      if (!cb) continue;
      cb.checked = !!ra[key];
      cb.addEventListener('change', () => {
        if (!this.settings.data.replayAnalytics) this.settings.data.replayAnalytics = {};
        this.settings.data.replayAnalytics[key] = cb.checked;
        this.settings.save();
        this._applyAnalyticsVisibility();
      });
    }
  }

  /** Show/hide the overlay canvas + stats panel based on enabled toggles. */
  _applyAnalyticsVisibility() {
    const ra = this.settings.data.replayAnalytics || {};
    const anyCanvas = ra.optimalPath || ra.trajectory || ra.flicks || ra.clickTiming;
    if (this.replayAnalysisCanvas) this.replayAnalysisCanvas.hidden = !this.replaying || !anyCanvas;
    // The stats panel always shows during playback: it carries the live
    // on-target indicator + adjustment counters on top of the optional toggles.
    if (this.replayStats) this.replayStats.hidden = !this.replaying;
    if (!this.replaying || !anyCanvas) this._clearAnalysisCanvas();
  }

  _clearAnalysisCanvas() {
    const c = this.replayAnalysisCanvas;
    if (c && this._analysisCtx) this._analysisCtx.clearRect(0, 0, c.width, c.height);
  }

  /** Draw the per-tick overlay lines + refresh the stats panel. */
  _renderAnalysis(sample, camera) {
    if (!this.replaying || !sample) return;
    const ra = this.settings.data.replayAnalytics || {};

    // --- stats panel (always visible during playback) ---
    if (this.replayStats) {
      const rows = [];
      const trio = (over, good, under) =>
        `<span class="rs-metrics"><span class="rs-over">${over}↑</span><span class="rs-good">${good}✓</span><span class="rs-under">${under}↓</span></span>`;

      // Live motion category (idle | tracking | flicking | reacting).
      const MOTION_UI = {
        idle: ['Idle', '#8a8a8a'],
        tracking: ['Tracking', '#35e06a'],
        flicking: ['Flicking', '#f5a623'],
        reacting: ['Reacting', '#f52525']
      };
      const [motionLabel, motionColor] = MOTION_UI[sample.motionState] || MOTION_UI.idle;
      rows.push(`<div class="rs-row"><span>Motion</span><span class="rs-val" style="color:${motionColor}">● ${motionLabel}</span></div>`);

      // Crosshair on-target indicator (live, per tick).
      rows.push(
        sample.onTarget
          ? `<div class="rs-row"><span>Crosshair</span><span class="rs-val" style="color:#35e06a">● On target</span></div>`
          : `<div class="rs-row"><span>Crosshair</span><span class="rs-val" style="color:#f52525">○ Off target</span></div>`
      );

      // Adjustment counters: run total + current target (resets on each kill).
      rows.push(`<div class="rs-row"><span>Adjustments</span><span class="rs-val">${sample.adjustmentsTotal ?? 0} total</span></div>`);
      rows.push(`<div class="rs-row"><span>This target</span><span class="rs-val">${sample.adjustmentsSinceKill ?? 0}</span></div>`);

      if (ra.flicks) {
        const f = sample.flicks;
        rows.push(`<div class="rs-row"><span>Flicks</span>${trio(f.over, f.accurate, f.under)}</div>`);
      }
      if (ra.flickSpeed) {
        rows.push(`<div class="rs-row"><span>Flick speed</span><span class="rs-val">${sample.flicksMeasured ? sample.flickSpeedMsPerDeg.toFixed(1) + ' ms/°' : '—'}</span></div>`);
      }
      if (ra.flickAccuracy) {
        rows.push(`<div class="rs-row"><span>Flick acc</span><span class="rs-val">${sample.flicksMeasured ? sample.flickAccuracyPct.toFixed(0) + '%' : '—'}</span></div>`);
      }
      if (ra.tension) {
        rows.push(`<div class="rs-row"><span>Tension</span><span class="rs-val">${sample.tensionPct.toFixed(0)}%</span></div>`);
      }
      if (ra.clickTiming) {
        const c = sample.clicks;
        rows.push(`<div class="rs-row"><span>Clicks</span>${trio(c.early, c.accurate, c.late)}</div>`);
        const clickTotal = c.early + c.accurate + c.late;
        rows.push(`<div class="rs-row"><span>Click acc</span><span class="rs-val">${clickTotal ? sample.clickAccuracyPct.toFixed(0) + '%' : '—'}</span></div>`);
      }
      this.replayStats.innerHTML = rows.join('');
    }

    const raCanvas = this.settings.data.replayAnalytics || {};
    const anyCanvas = raCanvas.optimalPath || raCanvas.trajectory || raCanvas.flicks || raCanvas.clickTiming;
    if (!anyCanvas || !this._analysisCtx || !camera) {
      if (this.replayAnalysisCanvas && !this.replayAnalysisCanvas.hidden) this._clearAnalysisCanvas();
      return;
    }
    const c = this.replayAnalysisCanvas;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this._analysisCtx;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const refDist = sample.flickRefDist || sample.target
      ? Math.hypot(
          (sample.target?.x ?? 0) - camera.position.x,
          (sample.target?.y ?? 0) - camera.position.y,
          (sample.target?.z ?? 0) - camera.position.z
        ) || 10
      : 10;

    // Optimal path: green line to target; red paintball trail during flicks.
    if (raCanvas.optimalPath) {
      if (sample.target) {
        const p = this._projectToScreen(sample.target, camera, w, h);
        if (p) this._drawLine(ctx, cx, cy, p.x, p.y, '#3ddc6b', 2.5);
      }
      if (sample.flickTrail?.length) {
        let prevPx = null;
        for (const pt of sample.flickTrail) {
          const dir = this._dirFromAngles(pt.pitch, pt.yaw);
          const off = this._aimDirToScreenOffset(dir, refDist, camera, w, h);
          if (!off) continue;
          const px = cx + off.x;
          const py = cy + off.y;
          if (prevPx) this._drawLine(ctx, prevPx.x, prevPx.y, px, py, '#f54a4a', 2.5);
          ctx.beginPath();
          ctx.arc(px, py, 1.25, 0, Math.PI * 2);
          ctx.fillStyle = '#f54a4a';
          ctx.fill();
          prevPx = { x: px, y: py };
        }
      }
    }

    // Trajectory: flick start → crosshair → extended prediction.
    if (raCanvas.trajectory && sample.flickActive && sample.flickStartDir) {
      const startOff = this._aimDirToScreenOffset(sample.flickStartDir, refDist, camera, w, h);
      if (startOff) {
        const sx = cx + startOff.x;
        const sy = cy + startOff.y;
        this._drawLine(ctx, sx, sy, cx, cy, '#46c8ff', 2);
        const dx = cx - sx;
        const dy = cy - sy;
        const edge = this._extendToScreenEdge(cx, cy, dx, dy, w, h);
        if (edge) this._drawLine(ctx, cx, cy, edge.x, edge.y, '#46c8ff', 2);
      }
    }

    // Ephemeral flick / click labels beside the crosshair.
    const now = performance.now();
    for (const ev of sample.flashEvents || []) {
      if (ev.type === 'flick' && raCanvas.flicks) {
        const color = ev.bucket === 'accurate' ? '#3ddc6b' : ev.bucket === 'over' ? '#f5a623' : '#46c8ff';
        this._pushAnalysisLabel({ text: ev.text, side: 'right', color, until: now + 1200 });
      }
      if (ev.type === 'click' && raCanvas.clickTiming) {
        const color = ev.kind === 'accurate' ? '#3ddc6b' : ev.kind === 'early' ? '#f5a623' : '#46c8ff';
        this._pushAnalysisLabel({ text: ev.text, side: 'left', color, until: now + 1200 });
      }
    }
    this._analysisLabels = this._analysisLabels.filter((l) => l.until > now);
    ctx.font = '500 14px "Host Grotesk", sans-serif';
    ctx.textBaseline = 'middle';
    const labelLineH = 18;
    for (const l of this._analysisLabels) {
      const fade = Math.min(1, (l.until - now) / 400);
      ctx.globalAlpha = fade;
      ctx.fillStyle = l.color;
      const y = cy - 6 - (l.stack || 0) * labelLineH;
      if (l.side === 'right') {
        ctx.textAlign = 'left';
        ctx.fillText(l.text, cx + 52, y);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(l.text, cx - 52, y);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Push a label beside the crosshair; older labels on the same side shift up. */
  _pushAnalysisLabel(label) {
    for (const l of this._analysisLabels) {
      if (l.side === label.side) l.stack = (l.stack || 0) + 1;
    }
    label.stack = 0;
    this._analysisLabels.push(label);
  }

  _dirFromAngles(pitch, yaw) {
    const cp = Math.cos(pitch);
    return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  }

  /** Screen offset from center for an aim direction viewed through the current camera. */
  _aimDirToScreenOffset(dir, refDist, camera, w, h) {
    if (!this._aimWorldPt) this._aimWorldPt = new THREE.Vector3();
    this._aimWorldPt.set(dir[0], dir[1], dir[2]).multiplyScalar(refDist).add(camera.position);
    const p = this._projectToScreen(this._aimWorldPt, camera, w, h);
    if (!p) return null;
    return { x: p.x - w / 2, y: p.y - h / 2 };
  }

  /** Extend a ray from (x0,y0) along (dx,dy) to the screen edge. */
  _extendToScreenEdge(x0, y0, dx, dy, w, h) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const ux = dx / len;
    const uy = dy / len;
    let best = 0;
    const ts = [];
    if (Math.abs(ux) > 1e-6) {
      ts.push((0 - x0) / ux, (w - x0) / ux);
    }
    if (Math.abs(uy) > 1e-6) {
      ts.push((0 - y0) / uy, (h - y0) / uy);
    }
    for (const t of ts) {
      if (t > 0 && t > best) best = t;
    }
    if (best <= 0) return null;
    return { x: x0 + ux * best, y: y0 + uy * best };
  }

  /** Project a world point to pixel coords, or null if behind the camera. */
  _projectToScreen(p, camera, w, h) {
    if (!this._projVec) this._projVec = new THREE.Vector3();
    this._projVec.set(p.x, p.y, p.z);
    this._projVec.project(camera);
    if (this._projVec.z > 1) return null; // behind / beyond the far plane
    return {
      x: (this._projVec.x * 0.5 + 0.5) * w,
      y: (-this._projVec.y * 0.5 + 0.5) * h
    };
  }

  _drawLine(ctx, x0, y0, x1, y1, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  _setReplayShareContext(ctx) {
    this._replayShareCtx = ctx?.sourcePath ? ctx : null;
    this._updateReplayShareButton();
    this._setReplayShareStatus('');
  }

  _updateReplayShareButton() {
    const btn = this.root.querySelector('#replay-share-btn');
    if (!btn) return;
    btn.hidden = !this.replaying;
    btn.disabled = !this._replayShareCtx?.sourcePath;
  }

  _setReplayShareStatus(msg, isError = false) {
    const el = this.root.querySelector('#replay-share-status');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('is-error');
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle('is-error', isError);
  }

  async _shareReplay(ctx, triggerBtn = null) {
    if (!ctx?.sourcePath) return;
    if (!this.auth?.isLoggedIn) {
      this._openAuth('login');
      return;
    }
    if (!supabaseConfigured()) {
      this._setReplayShareStatus('Replays are not configured.', true);
      return;
    }
    if (triggerBtn) triggerBtn.disabled = true;
    this._setReplayShareStatus('Creating link…');
    try {
      await this.auth.ensureProfileReady();
      const { url } = await createSharedReplay({
        userId: this.auth.user.id,
        username: ctx.username || this.auth.displayName,
        sourcePath: ctx.sourcePath,
        shareMeta: ctx.shareMeta
      });
      await copyText(url);
      if (triggerBtn?.id === 'res-share-replay') {
        const prev = triggerBtn.textContent;
        triggerBtn.textContent = 'Link copied!';
        setTimeout(() => { triggerBtn.textContent = prev; }, 2200);
      } else {
        this._setReplayShareStatus('Link copied!');
      }
    } catch (e) {
      console.warn('[ui] replay share failed', e);
      this._setReplayShareStatus(e.message || 'Could not share replay.', true);
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  _clearReplayUrlParam() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('replay')) return;
    url.searchParams.delete('replay');
    window.history.replaceState(null, '', url);
  }

  async _maybeOpenReplayFromUrl() {
    const id = new URLSearchParams(window.location.search).get('replay');
    if (!isSharedReplayId(id)) return;
    this._clearReplayUrlParam();
    this.showScreen('menu');
    const menuBody = this.root.querySelector('.menu-panel-body-main');
    const loading = document.createElement('p');
    loading.className = 'center lb-hint';
    loading.textContent = 'Loading shared replay…';
    if (menuBody) menuBody.appendChild(loading);
    try {
      const data = await fetchSharedReplay(id);
      loading.remove();
      if (!data?.replay) {
        this.showError(new Error('Shared replay not found or expired.'));
        return;
      }
      const mode = SCENARIO_META[data.meta.scenario]?.title ?? data.meta.scenario;
      const variant = data.meta.variant === 'competitive' ? 'Competitive' : 'Training';
      this._setReplayShareContext(null);
      this._watchReplay(data.replay, {
        title: `${data.meta.username} — ${mode} (${variant})`,
        returnTo: 'menu',
        fromOtherPlayer: true,
        sharedSettings: data.meta.settings
      });
    } catch (e) {
      loading.remove();
      this.showError(e);
    }
  }

  /** Enter playback for a decoded replay. `returnTo` is the screen to restore. */
  _watchReplay(decoded, { title = 'Replay', returnTo = 'results', fromOtherPlayer = false, sharedSettings = null, shareCtx = null } = {}) {
    if (!decoded || !this.replayPlayer) return;
    this._replayReturn = returnTo;
    this._replayFromOtherPlayer = fromOtherPlayer;
    this.input.exitLock();
    this.sceneManager.pause();
    // Hide the live (paused) scenario so only the replay ghosts render.
    this._hiddenSceneRoot = this.sceneManager.current?.root || null;
    if (this._hiddenSceneRoot) this._hiddenSceneRoot.visible = false;
    this.showScreen(null); // hide every panel; the canvas + control bar show through
    // showScreen() resets state + crosshair — apply replay state afterwards.
    this.replaying = true;
    this.state = 'replay';
    this.engine.audio?.resume();
    this.replayOverlay?.classList.add('active');
    if (fromOtherPlayer && this.settings.data.copyConfigOnReplay) {
      const rs = this.settings.mergeReplaySettings(decoded.settings, sharedSettings);
      if (Object.keys(rs).length) {
        this.settings.beginReplayView(rs);
        this.crosshair.draw();
      }
    }
    const baselineVFov = this.engine.camera.fov;
    this.crosshair.setVisible(true);
    this.replayPlayer.load(decoded, { baselineVFov });
    this.replayPlayer.play();
    this._applyAnalyticsVisibility();
    if (shareCtx?.sourcePath) {
      this._setReplayShareContext(shareCtx);
    } else {
      this._updateReplayShareButton();
    }
  }

  _exitReplay() {
    if (!this.replaying) return;
    this.replaying = false;
    this._replayFromOtherPlayer = false;
    if (this._replayWheel) window.removeEventListener('wheel', this._replayWheel);
    this._analysisLabels = [];
    this.replayPlayer?.dispose();
    this.replayOverlay?.classList.remove('active');
    this._applyAnalyticsVisibility();
    const pop = this.root.querySelector('#replay-settings-pop');
    if (pop) pop.hidden = true;
    this._setReplayShareContext(null);
    if (this.settings.isReplayView) {
      this.settings.endReplayView();
      this.engine.applyResolution();
      this.engine.applyColors();
      this.crosshair.draw();
    }
    this.crosshair.setVisible(false);
    if (this._hiddenSceneRoot) {
      this._hiddenSceneRoot.visible = true;
      this._hiddenSceneRoot = null;
    }
    this.showScreen(this._replayReturn);
  }

  _updateReplayUI(st) {
    if (this.replayPlayPause) this.replayPlayPause.textContent = st.playing ? '❚❚' : '▶';
    if (st.time != null && st.duration && this.replayTime) {
      this.replayTime.textContent = `${st.time.toFixed(1)} / ${st.duration.toFixed(1)}s`;
    }
    if (st.time != null && st.duration && this.replayScrub && document.activeElement !== this.replayScrub) {
      this.replayScrub.value = String(Math.round((st.time / st.duration) * 1000));
    }
    if (st.speed != null) {
      this.root.querySelectorAll('#replay-speeds [data-speed]').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.speed) === st.speed);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame updates (HUD)
  // -------------------------------------------------------------------------
  frame(dt) {
    if (this.state === 'countdown') {
      this._countdownRemaining = Math.max(0, this._countdownRemaining - dt);
      this._updateCountdownOverlay();
      if (this._countdownRemaining <= 0) {
        this._beginRun();
      }
    }

    const sc = this.sceneManager.current;
    const isDm = this._isDeathmatchRun();
    if (this.mpScoreboard) {
      this.mpScoreboard.classList.toggle('active', this._isMpPlaying() && !isDm);
    }
    if (this.dmKillfeed) {
      this.dmKillfeed.classList.toggle('active', isDm);
    }
    if (this.hud) {
      this.hud.classList.toggle(
        'active',
        this.state === 'playing' && sc && !sc.isMultiplayer && !isDm
      );
    }
    // Multiplayer: when unlocked mid-match (not paused), prompt click-to-aim.
    if (
      this._isMpPlaying() &&
      this.state === 'playing' &&
      !this.input.locked &&
      !this.mpChat?.classList.contains('typing')
    ) {
      if (this._unlockSince == null) this._unlockSince = performance.now();
      this._setClickToAim(performance.now() - this._unlockSince > 250);
    } else {
      this._unlockSince = null;
      if (this._aimHintShown) this._setClickToAim(false);
    }
    if (this.hud.classList.contains('active') && sc) {
      this.hudTime.textContent = this._formatHudTime(sc);
      this.hudScore.textContent = this._formatHudScore(sc);
      this.hudAcc.textContent = Math.round(sc.accuracy * 100) + '%';
      this.hudKps.textContent = sc.kps.toFixed(1);
      this.hudHits.textContent = `${sc.hits}/${sc.shotsFired}`;
      this.hudCrit.textContent = Math.round(sc.critRatio * 100) + '%';
    }
    if (this._mpTabBoardHeld) this._renderMpTabScoreboard();
    this._updateAmmo(sc);
    if (this._isDeathmatchRun()) {
      this._renderKillFeed();
    }
  }

  /** Ammo counter (bottom-right) — only for weapon scenarios. */
  _updateAmmo(sc) {
    if (!this.hudAmmo) return;
    const weapon = this.engine.weapon;
    const show = this.state === 'playing' && sc?.usesWeapon && !!weapon && sc.showViewmodel !== false;
    this.hudAmmo.classList.toggle('active', !!show);
    if (!show) return;
    if (sc.infiniteAmmo) {
      this.hudAmmo.classList.remove('reloading');
      this.hudAmmoMag.textContent = '∞';
      this.hudAmmoSize.textContent = '∞';
      return;
    }
    if (weapon.reloading) {
      this.hudAmmo.classList.add('reloading');
      this.hudAmmoMag.textContent = '·';
    } else {
      this.hudAmmo.classList.remove('reloading');
      this.hudAmmoMag.textContent = String(weapon.ammo);
    }
    this.hudAmmoSize.textContent = String(weapon.magSize);
  }

  // -------------------------------------------------------------------------
  // Leaderboards
  // -------------------------------------------------------------------------
  _bindLeaderboard() {
    this.root.querySelector('#lb-back-btn')?.addEventListener('click', () => this._leaveLeaderboard());
    this.root.querySelector('#lb-mode-select')?.addEventListener('change', (e) => {
      const scenario = e.target.value;
      if (!scenario) return;
      this._setLeaderboardView(scenario);
      this._renderLeaderboard(scenario);
    });
    this.root.querySelector('#lb-body')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lb-user-id]');
      if (!btn) return;
      this._openAccount(btn.dataset.lbUserId, btn.dataset.lbUsername);
    });
    this.root.querySelector('#res-lb')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lb-user-id]');
      if (!btn) return;
      this._openAccount(btn.dataset.lbUserId, btn.dataset.lbUsername);
    });
  }

  _lbPlayerCell(row) {
    if (!row.user_id) return `<td class="lb-player">${this._esc(row.username)}</td>`;
    return `<td class="lb-player"><button type="button" class="lb-player-link" data-lb-user-id="${this._esc(row.user_id)}" data-lb-username="${this._esc(row.username)}">${this._esc(row.username)}</button></td>`;
  }

  _setLeaderboardView(scenario) {
    const eloTab = this.root.querySelector('#lb-tab-elo');
    const aimTab = this.root.querySelector('#lb-tab-aim');
    const selWrap = this.root.querySelector('.lb-mode-select-wrap');
    const sel = this.root.querySelector('#lb-mode-select');
    if (scenario === 'elo') {
      eloTab?.classList.add('active');
      aimTab?.classList.remove('active');
      selWrap?.removeAttribute('hidden');
      return;
    }
    if (scenario === 'aim-rating') {
      eloTab?.classList.remove('active');
      aimTab?.classList.add('active');
      selWrap?.setAttribute('hidden', '');
      return;
    }
    eloTab?.classList.remove('active');
    aimTab?.classList.remove('active');
    selWrap?.removeAttribute('hidden');
    if (sel && SCENARIOS[scenario]) sel.value = scenario;
  }

  _openLeaderboard() {
    this._setLbPlaylistMode(false);
    const fromTraining =
      this.currentScenario && SCENARIOS[this.currentScenario]
        ? this.currentScenario
        : 'elo';
    this._setLeaderboardView(fromTraining);
    this._renderLeaderboard(fromTraining);
  }

  _openLeaderboardForScenario(scenario) {
    if (!SCENARIOS[scenario]) return;
    this._setLbPlaylistMode(false);
    this._returnAfterLeaderboard = 'training';
    this.currentScenario = scenario;
    this._setLeaderboardView(scenario);
    this._renderLeaderboard(scenario);
    this.showScreen('leaderboard');
  }

  _leaveLeaderboard() {
    const dest = this._returnAfterLeaderboard || 'menu';
    this._returnAfterLeaderboard = 'menu';
    this._setLbPlaylistMode(false);
    this.showScreen(dest);
  }

  _configKeyFor(scenario) {
    const Cls = SCENARIOS[scenario];
    if (!Cls?.configKeyFor) return 'competitive';
    return Cls.configKeyFor(this.settings, 'competitive');
  }

  _hudScoreValue(sc) {
    if (sc.name === 'reactiontime') return sc.reactionHudMs ?? 0;
    return isKillLeaderboardScenario(sc.name) ? sc.kills : sc.score;
  }

  _formatHudScore(sc) {
    if (sc.name === 'reactiontime') {
      const ms = sc.reactionHudMs;
      if (ms == null) return '—';
      return `${ms} ms`;
    }
    return Math.round(this._hudScoreValue(sc)).toLocaleString();
  }

  _formatHudTime(sc) {
    if (sc?.enableTimeLimit) return sc.modeSeconds.toFixed(1);
    if (sc?.showElapsedTime) return sc.elapsed.toFixed(1);
    const remaining = this.sceneManager.timeRemaining;
    return Number.isFinite(remaining) ? remaining.toFixed(1) : '∞';
  }

  _formatTimePlayed(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}:${s.toFixed(1).padStart(4, '0')}`;
    }
    return `${seconds.toFixed(1)}s`;
  }

  /** Leaderboard run timestamp: `12.34 CEST, 29.06.2026` in the viewer's local timezone. */
  _formatLbRunWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const parts = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false,
      timeZoneName: 'short'
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('hour')}.${get('minute')} ${get('timeZoneName')}, ${get('day')}.${get('month')}.${get('year')}`;
  }

  _leaderboardRowsHtml(list, scenario, highlightUserId = null, fetchError = null) {
    if (!supabaseConfigured()) {
      return `<p class="center lb-hint">Account leaderboards are not configured.</p>`;
    }
    if (fetchError) {
      return `<p class="center lb-hint lb-error">Could not load leaderboard: ${this._esc(fetchError)}</p>`;
    }
    if (!list.length) {
      const hint = scenario === 'elo'
        ? (this.auth?.isLoggedIn
          ? 'No ranked accounts yet — sign in and play matchmaking to appear here.'
          : 'No ranked accounts yet — sign in to track your ELO.')
        : scenario === 'aim-rating'
          ? (this.auth?.isLoggedIn
            ? `No aim ratings yet — rank in at least ${OVERALL_AIM_MIN_MODES} rated modes (Duels, Range, and Deathmatch excluded) to appear here.`
            : 'No aim ratings yet — sign in and play to appear here.')
        : (this.auth?.isLoggedIn
          ? 'No scores for these settings yet — finish a run to appear here.'
          : 'No scores yet — sign in and play to appear here.');
      return `<p class="center lb-hint">${hint}</p>`;
    }

    if (scenario === 'aim-rating') {
      const rows = list
        .map((r, i) => {
          const hl = highlightUserId && r.user_id === highlightUserId ? ' class="hl"' : '';
          const rating = r.overall_aim_rating != null
            ? Number(r.overall_aim_rating).toFixed(2)
            : '—';
          return `<tr${hl}>
          <td>${i + 1}</td>
          ${this._lbPlayerCell(r)}
          <td class="score">${rating}</td>
        </tr>`;
        })
        .join('');
      return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Aim Rating</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    }

    if (scenario === 'elo') {
      const pct = (v) => (v != null && Number.isFinite(v) ? Math.round(v * 100) + '%' : '—');
      const rows = list
        .map((r, i) => {
          const hl = highlightUserId && r.user_id === highlightUserId ? ' class="hl"' : '';
          const games = r.games ?? r.games_played ?? '—';
          const wl = r.wins != null && r.losses != null ? `${r.wins}–${r.losses}` : '—';
          const kd = r.kd != null
            ? Number(r.kd).toFixed(2)
            : (r.kills != null && r.deaths != null
              ? (r.kills / Math.max(1, r.deaths)).toFixed(2)
              : '—');
          return `<tr${hl}>
          <td>${i + 1}</td>
          ${this._lbPlayerCell(r)}
          <td class="score">${Number(r.elo ?? 1000).toLocaleString()}</td>
          <td>${games}</td>
          <td>${wl}</td>
          <td>${kd}</td>
          <td>${pct(r.accuracy)}</td>
          <td>${pct(r.hs_accuracy ?? r.headshot_accuracy)}</td>
        </tr>`;
        })
        .join('');
      return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>ELO</th><th>Games</th><th>W–L</th><th>K/D</th><th>Acc</th><th>HS%</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    }

    if (isKillLeaderboardScenario(scenario)) {
      const rows = list
        .map((r, i) => {
          const hl = highlightUserId && r.user_id === highlightUserId ? ' class="hl"' : '';
          const kills = r.kills ?? r.score ?? 0;
          const date = this._formatLbRunWhen(r.achieved_at);
          return `<tr${hl}>
          <td>${i + 1}</td>
          ${this._lbPlayerCell(r)}
          <td class="score">${Number(kills).toLocaleString()}</td>
          <td>${Math.round((r.accuracy || 0) * 100)}%</td>
          <td>${this._formatTimePlayed(r.time_played)}</td>
          <td class="lb-when">${date}</td>
        </tr>`;
        })
        .join('');
      return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Kills</th><th>Acc</th><th>Time</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    }

    const rows = list
      .map((r, i) => {
        const hl = highlightUserId && r.user_id === highlightUserId ? ' class="hl"' : '';
        const crit = scenario !== 'survival'
          ? `<td>${Math.round((r.crit_ratio || 0) * 100)}%</td>`
          : '<td>—</td>';
        const date = this._formatLbRunWhen(r.achieved_at);
        return `<tr${hl}>
          <td>${i + 1}</td>
          ${this._lbPlayerCell(r)}
          <td class="score">${Number(r.score).toLocaleString()}</td>
          <td>${Math.round((r.accuracy || 0) * 100)}%</td>
          ${crit}
          <td>${r.kills ?? '—'}</td>
          <td class="lb-when">${date}</td>
        </tr>`;
      })
      .join('');
    return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Acc</th><th>Crit</th><th>Kills</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  async _fetchLeaderboard(scenario, configKeyOverride = null) {
    if (scenario === 'elo') {
      const { list, error } = await fetchEloLeaderboardWithMeta(50);
      this._lbCache.elo = list;
      return { list, error, configKey: null };
    }
    if (scenario === 'aim-rating') {
      try {
        // Push the viewer's own freshly-computed rating first so the board is
        // live for them (no-op offline / signed out).
        if (this.auth?.isLoggedIn) {
          await syncOverallAimRating(this.auth.user.id).catch(() => {});
        }
        const list = await fetchAimRatingLeaderboard(50);
        this._lbCache['aim-rating'] = list;
        return { list, error: null, configKey: null };
      } catch (e) {
        return { list: [], error: e.message || 'Failed to load aim rating leaderboard.', configKey: null };
      }
    }
    const key = configKeyOverride ?? this._configKeyFor(scenario);
    const cacheKey = `${scenario}:${key}`;
    const { list, error } = await fetchLeaderboardWithMeta(scenario, key, 10);
    this._lbCache[cacheKey] = list;
    return { list, error, configKey: key };
  }

  async _renderLeaderboard(scenario) {
    const body = this.root.querySelector('#lb-body');
    if (!body) return;
    body.innerHTML = `<p class="center">…</p>`;
    const { list, error } = await this._fetchLeaderboard(scenario);
    body.innerHTML = this._leaderboardRowsHtml(list, scenario, this.auth?.user?.id, error);
  }

  async _saveAndRenderResults(results, replayRes = null) {
    let submitNote = '';

    const infoWrap = this.root.querySelector('#res-infographics');
    if (infoWrap) infoWrap.hidden = true;

    this.root.querySelector('#res-lb').innerHTML =
      `<p class="center lb-hint">${this.auth?.isLoggedIn ? 'Saving score…' : 'Loading leaderboard…'}</p>`;

    if (replayRes?.ok) {
      submitNote = 'Replay saved to your account.';
    } else if (replayRes?.reason === 'not signed in') {
      submitNote = 'Sign in to save replays to your account.';
    } else if (
      replayRes?.reason &&
      replayRes.reason !== 'no recording' &&
      replayRes.reason !== 'offline'
    ) {
      submitNote = `Replay not saved: ${replayRes.reason}`;
    }

    if (this.auth?.isLoggedIn && results.leaderboardEligible !== false) {
      try {
        await this.auth.ensureProfileReady();
      } catch (e) {
        console.warn('[ui] profile ensure failed', e);
      }
      const res = await submitScore(this.auth.user.id, results);
      if (res.ok) {
        console.info('[leaderboard] score saved', results.scenario, results.configKey);
      } else {
        const scoreNote =
          res.reason === 'offline'
            ? ''
            : `Score not saved: ${res.reason}`;
        submitNote = submitNote ? `${submitNote} ${scoreNote}` : scoreNote;
      }
    } else if (results.leaderboardEligible === false) {
      const practiceNote =
        results.variant === 'practice'
          ? 'Practice — not saved to leaderboards'
          : 'Competitive — not saved to leaderboards yet';
      submitNote = submitNote ? `${submitNote} ${practiceNote}` : practiceNote;
    } else if (supabaseConfigured()) {
      const signInNote = 'Sign in to save to leaderboards';
      submitNote = submitNote ? `${submitNote} ${signInNote}` : signInNote;
    }

    const showCrit = !isKillLeaderboardScenario(results.scenario) && results.scenario !== 'survival';
    const stat = (label, val) =>
      `<div class="stat"><span class="stat-value">${val}</span><label>${label}</label></div>`;
    const killStats =
      stat('Kills', results.kills) +
      stat('Time', this._formatTimePlayed(results.timePlayed)) +
      stat('Accuracy', Math.round(results.accuracy * 100) + '%') +
      stat('Hits / Shots', `${results.hits}/${results.shots}`) +
      stat('Misses', results.misses);
    const trackingStats =
      stat('Score', results.score.toLocaleString()) +
      stat('Time', this._formatTimePlayed(results.timePlayed)) +
      stat('Accuracy', Math.round(results.accuracy * 100) + '%') +
      stat('Hits / Shots', `${results.hits}/${results.shots}`) +
      stat('Headshot %', Math.round(results.critRatio * 100) + '%');
    const defaultStats =
      stat('Score', results.score.toLocaleString()) +
      stat('Accuracy', Math.round(results.accuracy * 100) + '%') +
      stat('Kills', results.kills) +
      stat('Hits / Shots', `${results.hits}/${results.shots}`) +
      (showCrit ? stat('Crit ratio', Math.round(results.critRatio * 100) + '%') : '') +
      stat('Misses', results.misses);
    const reactionStats =
      stat('Average', `${results.score} ms`) +
      (results.reactionTimes || []).map((ms, i) => stat(`Attempt ${i + 1}`, `${Math.round(ms)} ms`)).join('') +
      stat('Time', this._formatTimePlayed(results.timePlayed));
    this.root.querySelector('#res-stats').innerHTML =
      isKillLeaderboardScenario(results.scenario)
        ? killStats
        : results.scenario === 'tracking'
          ? trackingStats
          : results.scenario === 'reactiontime'
            ? reactionStats
            : defaultStats;

    const { list, error } = await this._fetchLeaderboard(
      results.scenario,
      results.leaderboardEligible !== false ? results.configKey : this._configKeyFor(results.scenario)
    );
    const lbHtml = this._leaderboardRowsHtml(
      list,
      results.scenario,
      this.auth?.user?.id,
      error
    );
    this.root.querySelector('#res-lb').innerHTML = submitNote
      ? `<p class="center lb-hint muted">${submitNote}</p>${lbHtml}`
      : lbHtml;

    this._renderResultsInfographics(results, replayRes?.analytics ?? null);
  }
}
