// ---------------------------------------------------------------------------
// UIOverlay.js
// All HTML/CSS UI layered over the canvas: main menu, settings, leaderboards,
// in-run HUD, pause + results screens, and the off-screen threat chevrons for
// the Arena. Holds the screen state machine and coordinates pointer-lock with
// the run lifecycle. The core game loop never touches UI state.
//
// States: menu | settings | leaderboard | auth | await-start | playing | paused
//         | results
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { degToRad } from '../utils/MathUtils.js';
import { RESOLUTIONS } from '../core/SettingsManager.js';
import { DEFAULT_SPRAY_TUNE, getSprayTune } from '../weapons/ak47.js';
import { SCENARIOS } from '../core/SceneManager.js';
import * as Storage from '../utils/Storage.js';
import { exportConfig, importConfig, copyText, normalizeCode } from '../utils/ConfigCodes.js';
import {
  fetchLeaderboardWithMeta,
  fetchEloLeaderboardWithMeta,
  submitScore,
  fetchUserRank
} from '../lib/cloudScores.js';
import { supabaseConfigured } from '../lib/supabase.js';
import { MultiplayerController } from '../multiplayer/MultiplayerController.js';
import { SCORE_TARGETS, MM_SCORE_TARGET } from '../multiplayer/constants.js';
import { getMap } from '../multiplayer/maps.js';
import { formatServerRegion } from '../multiplayer/regionLabels.js';
import { SCENARIO_ICONS, MATCHMAKING_ICON, TRAINING_ICON, CUSTOM_GAMES_ICON } from '../aim4/icons.js';

const SCENARIO_META = {
  gridshot: { title: 'Gridshot' },
  arena: { title: 'Crossfire' },
  duels: { title: 'Duels' },
  range: { title: 'Range' }
};

const _v = new THREE.Vector3();

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

export class UIOverlay {
  constructor({ engine, input, settings, crosshair, sceneManager, auth }) {
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.auth = auth;
    this.crosshair = crosshair;
    this.sceneManager = sceneManager;

    this.root = document.getElementById('ui-root');
    this.state = 'menu';
    this.currentScenario = 'gridshot';
    this._authMode = 'login';
    this._lbCache = {};
    this._returnAfterSettings = null;
    this._suppressLockPause = false;
    this._mpTabStats = {};
    this._mpTabBoardHeld = false;
    this._aimHintShown = false;
    this._unlockSince = null;
  }

  init() {
    this.root.innerHTML = this._template();
    this._cache();
    this._bind();
    this._bindAuth();
    this.auth?.onChange(() => this.refreshAccountBar());
    this._populateSettings();
    this.showScreen('menu');
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

    // Shared link: ?lobby=CODE opens multiplayer and auto-joins if there's space.
    if (this.mp.urlLobbyCode()) {
      const name = this._mpName ? this._mpName() : this._defaultName();
      this.mp.autoJoinFromUrl(name);
    }
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

  _settingsSections(resOptions) {
    return [
      {
        id: 'mouse',
        label: 'Mouse',
        body: `
          ${numField('set-cm360', 'Sensitivity (cm / 360°)', '0.5')}
          ${numField('set-dpi', 'Mouse DPI / CPI', '50')}`
      },
      {
        id: 'display',
        label: 'Display',
        body: `
          ${rf('set-fov', 'Horizontal FOV (°)', 60, 130, 1)}
          <div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Resolution</span>
            </div>
            <select id="set-res">${resOptions}</select>
          </div>
          ${numField('set-dur', 'Run duration (s)', '1')}
          <label class="field-check"><input type="checkbox" id="set-raw" /> Raw input (no OS acceleration)</label>`
      },
      {
        id: 'crosshair',
        label: 'Crosshair',
        body: `
          <div class="xh-preview">
            <canvas id="xh-preview-canvas" width="180" height="180"></canvas>
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
            <label class="field-check"><input type="checkbox" id="set-xh-dyn" /> Dynamic gap (movement spread)</label>`
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
        id: 'spray-tune',
        label: 'Spray tune',
        body: `
          <p class="settings-note">Temporary dev tuning. Copy values when dialed in — we'll hard-code them and remove this tab.</p>
          <p class="settings-subhead">Bullet pattern</p>
          ${rf('set-spray-pattern', 'Pattern scale', 0.25, 2.0, 0.05)}
          <p class="settings-subhead">View punch (aimpunch)</p>
          ${rf('set-spray-punch-scale', 'Punch scale', 0.5, 10, 0.05)}
          ${rf('set-spray-punch-base', 'Punch base (°)', 0, 2, 0.01)}
          ${rf('set-spray-punch-ramp', 'Punch ramp / bullet (°)', 0, 0.2, 0.005)}
          ${rf('set-spray-punch-ramp-max', 'Punch ramp max shots', 1, 30, 1)}
          ${rf('set-spray-tau-spray', 'Punch τ spray (s)', 0.01, 0.5, 0.001)}
          ${rf('set-spray-tau-recover', 'Punch τ recover (s)', 0.01, 0.5, 0.001)}
          <button type="button" class="btn btn-block" id="btn-spray-tune-copy">Copy values for report</button>
          <pre id="spray-tune-readout" class="spray-tune-readout"></pre>`
      },
      {
        id: 'colors',
        label: 'Colors',
        body: `
          ${colorRow('set-col-bg', 'Background')}
          ${colorRow('set-col-floor', 'Floor')}
          ${colorRow('set-col-ebody', 'Enemy body')}
          ${colorRow('set-col-ehead', 'Enemy head')}
          ${colorRow('set-col-cover', 'Cover / columns')}
          ${colorRow('set-col-target', 'Gridshot target')}
          <button type="button" class="btn btn-block" data-reset-colors>Reset colors</button>`
      },
      {
        id: 'gridshot',
        label: 'Gridshot',
        body: `
          ${rf('set-grid-size', 'Target size', 0.25, 1.2, 0.05)}
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
          ${rf('set-grid-age', 'Max target age (ms)', 400, 3000, 100)}`
      },
      {
        id: 'arena',
        label: 'Crossfire',
        body: `
          ${rf('set-arena-cross', 'Cross speed (ms)', 350, 1500, 50)}
          ${rf('set-arena-peek', 'Peek hold (ms)', 150, 1000, 50)}
          ${rf('set-arena-col', 'Columns', 4, 10, 1)}
          ${rf('set-arena-colr', 'Column width (m)', 0.2, 1.2, 0.05)}
          ${rf('set-arena-ring', 'Ring distance (m)', 5, 16, 0.5)}
          ${rf('set-arena-enemy', 'Enemy size', 0.5, 2.0, 0.1)}`
      },
      {
        id: 'duels',
        label: 'Duels',
        body: `
          <div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Arena</span>
            </div>
            <select id="set-duels-arena">
              <option value="0">Random each run</option>
              <option value="1">1 · Long Lane</option>
              <option value="2">2 · CQB</option>
              <option value="3">3 · High Ground</option>
              <option value="4">4 · The Pit</option>
              <option value="5">5 · Split</option>
              <option value="6">6 · Left Corner</option>
              <option value="7">7 · Right Corner</option>
              <option value="8">8 · Left Rampart</option>
              <option value="9">9 · Right Loft</option>
              <option value="10">10 · Left Bulwark</option>
            </select>
          </div>
          ${rf('set-duels-ttk', 'Time to kill (s)', 0.2, 2.0, 0.1)}`
      },
      {
        id: 'range',
        label: 'Range',
        body: `
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
          <label class="field-check"><input type="checkbox" id="set-range-cover" /> Cover boxes</label>
          ${rf('set-range-cover-count', 'Cover amount', 1, 6, 1)}
          ${rf('set-range-cover-dist', 'Cover distance (m)', 2, 15, 0.5)}
          ${rf('set-range-cover-thick', 'Cover thickness (m)', 0.4, 3, 0.1)}
          ${rf('set-range-cover-height', 'Cover height (m)', 1, 6, 0.2)}`
      },
      {
        id: 'share',
        label: 'Share',
        body: `
          <div class="field field-plain">
            <div class="field-top">
              <span class="field-label">Settings code</span>
            </div>
            <input type="text" id="set-config-code" class="config-code-input" placeholder="AIM4-XXXX-YYYY-ZZZZ-000000" spellcheck="false" autocomplete="off" />
          </div>
          <div class="config-actions">
            <button type="button" class="btn" id="btn-config-import">Import</button>
            <button type="button" class="btn primary" id="btn-config-export">Export</button>
          </div>
          <div class="config-export-box" id="config-export-box" hidden>
            <code class="config-export-code" id="config-export-code"></code>
            <button type="button" class="btn btn-block" id="btn-config-copy">Copy to clipboard</button>
          </div>
          <p class="readout" id="config-status"></p>`
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
    const settingsSections = this._settingsSections(resOptions);

    return `
    <!-- THREAT CHEVRONS (Arena) -->
    <div id="threats" class="threats"></div>

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

    <!-- MULTIPLAYER CHAT (Enter / Y to open · Tab to return to game) -->
    <div id="mp-chat" class="mp-chat">
      <div id="mp-chat-log" class="mp-chat-log"></div>
      <input id="mp-chat-input" type="text" class="mp-chat-input" maxlength="120" placeholder="" spellcheck="false" autocomplete="off" />
    </div>

    <!-- CLICK-TO-AIM PROMPT (multiplayer, when pointer lock is not held) -->
    <div id="mp-aim-hint" class="mp-aim-hint"><span>Click</span></div>

    <!-- HOLD-TAB SCOREBOARD -->
    <div id="mp-tab-scoreboard" class="mp-tab-scoreboard"></div>

    <!-- MAIN MENU -->
    <div class="screen menu" data-screen="menu">
      <div class="panel wide">
        <h1 class="logo text-big">AIM4<span>.io</span></h1>
        <div class="menu-modes">
          <button type="button" class="mode-tile mode-tile-training" data-goto="training">
            <img src="${TRAINING_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Training</span>
            <span class="mode-tile-sub">Solo aim drills</span>
          </button>
          <button type="button" class="mode-tile mode-tile-mm" id="menu-mm-tile">
            <svg class="mode-tile-icon mode-tile-icon-mm" viewBox="0 -960 960 960" width="40" height="40" aria-hidden="true"><path fill="currentColor" d="M233.08-200v-40h493.84v40H233.08Zm-2.31-115.38L172.85-621q-2 .77-4.5.88-2.5.12-4.5.12-18.85 0-31.35-12.79T120-663.85q0-18.91 12.5-32.14 12.5-13.24 31.39-13.24t32.12 13.24q13.22 13.23 13.22 32.14 0 4.17-.35 7.74-.34 3.57-2.34 7.03l128.08 51.39 118.84-161.77q-8.69-5.69-13.77-15.04-5.07-9.34-5.07-20.12 0-18.91 13.22-32.14Q461.06-840 479.95-840q18.9 0 32.17 13.19 13.26 13.19 13.26 32.04 0 11.31-5.07 20.46-5.08 9.16-13.77 14.85l118.84 161.77 128.08-51.39q-1.08-3.19-1.88-7.02-.81-3.82-.81-7.75 0-18.91 12.5-32.14 12.5-13.24 31.39-13.24t32.12 13.24Q840-682.76 840-663.85q0 18.16-13.28 31Q813.44-620 794.47-620q-1.52 0-3.42-.5t-4.16-.5l-57.66 305.62H230.77Zm34.15-40h430.16l49.07-245.47-132.69 52.93L480-727.85 348.54-547.92l-132.69-52.93 49.07 245.47Zm215.08 0Z"/></svg>
            <span class="mode-tile-title">Matchmaking</span>
            <span class="mode-tile-sub" id="menu-mm-userline">Ranked 1v1 duels</span>
          </button>
          <button type="button" class="mode-tile mode-tile-custom" data-goto="mp">
            <img src="${CUSTOM_GAMES_ICON}" alt="" class="mode-tile-icon" width="40" height="40" aria-hidden="true" />
            <span class="mode-tile-title">Custom games</span>
            <span class="mode-tile-sub">Create or join a lobby</span>
          </button>
        </div>
        <div class="menu-secondary">
          <button class="btn btn-sm" data-goto="leaderboard">Leaderboards</button>
          <button class="btn btn-sm" data-goto="settings">Settings</button>
          <div class="menu-auth" id="menu-auth">
            <div class="menu-auth-actions" id="menu-auth-guest">
              <button type="button" class="btn btn-sm" id="menu-login-btn">Log in</button>
              <button type="button" class="btn btn-sm primary" id="menu-signup-btn">Sign up</button>
            </div>
            <div class="menu-auth-actions hidden" id="menu-auth-user">
              <button type="button" class="btn btn-sm" id="menu-logout-btn">Log out</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TRAINING (singleplayer mode picker) -->
    <div class="screen training" data-screen="training">
      <div class="panel wide">
        <h2 class="text-big">Training</h2>
        <div class="cards">
          ${Object.keys(SCENARIOS)
            .map(
              (key) => `
            <div class="card" data-scenario="${key}">
              <div class="card-icon">
                <img src="${SCENARIO_ICONS[key]}" alt="" class="aim4-icon" width="28" height="28" />
              </div>
              <h3 class="card-title">${SCENARIO_META[key].title}</h3>
              <button type="button" class="btn-play" data-play="${key}" aria-label="Play ${SCENARIO_META[key].title}">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
              </button>
            </div>`
            )
            .join('')}
        </div>
        <div class="menu-actions">
          <button class="btn primary" data-goto="menu">Back</button>
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
            ${settingsSections.map((s, i) => settingsTab(s.id, s.label, i === 0)).join('')}
          </nav>
          <div class="settings-bar-actions">
            <button class="btn" data-reset>Reset all</button>
            <button type="button" class="btn primary" id="settings-done-btn">Done</button>
          </div>
        </header>
        <div class="settings-drawer">
          ${settingsSections.map((s, i) => settingsPanel(s.id, s.body, i === 0)).join('')}
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

    <!-- LEADERBOARD -->
    <div class="screen leaderboard" data-screen="leaderboard">
      <div class="panel wide">
        <div class="tabs" id="lb-tabs">
          <button class="tab active" data-lb="elo">Ranked ELO</button>
          ${Object.keys(SCENARIOS)
            .map(
              (k) =>
                `<button class="tab" data-lb="${k}">${SCENARIO_META[k].title}</button>`
            )
            .join('')}
        </div>
        <div id="lb-body" class="lb-body"></div>
        <div class="menu-actions">
          <button class="btn primary" data-goto="menu">Back</button>
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
          <button type="button" class="btn" id="pause-leave-lobby-btn" hidden>Leave to lobby</button>
          <button type="button" class="btn" data-quit>Quit to menu</button>
        </div>
      </div>
    </div>

    <!-- MULTIPLAYER HOME (create / join) -->
    <div class="screen mp" data-screen="mp">
      <div class="panel wide">
        <h2 class="text-big custom-games-title">Custom games</h2>
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
        <div class="menu-actions">
          <button class="btn" id="mp-back-btn">Back</button>
        </div>
      </div>
    </div>

    <!-- MULTIPLAYER LOBBY -->
    <div class="screen mp-lobby" data-screen="mp-lobby">
      <div class="panel wide">
        <h2 class="text-big">Lobby <span id="mp-lobby-code" class="mp-code"></span></h2>
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
      <div class="panel wide">
        <h2 class="text-big" id="res-title">Run Complete</h2>
        <div id="res-stats" class="res-stats"></div>
        <h4>Leaderboard</h4>
        <p class="lb-subtitle">Best score per verified account</p>
        <div id="res-lb" class="lb-body"></div>
        <div class="menu-actions">
          <button class="btn primary" data-restart>Play again</button>
          <button class="btn" data-quit>Menu</button>
        </div>
      </div>
    </div>
    `;
  }

  _cache() {
    this.screens = {};
    this.root.querySelectorAll('[data-screen]').forEach((el) => {
      this.screens[el.dataset.screen] = el;
    });
    this.hud = this.root.querySelector('#hud');
    this.threatsEl = this.root.querySelector('#threats');
    this.mpScoreboard = this.root.querySelector('#mp-scoreboard');
    this.mpChat = this.root.querySelector('#mp-chat');
    this.mpChatLog = this.root.querySelector('#mp-chat-log');
    this.mpChatInput = this.root.querySelector('#mp-chat-input');
    this.mpTabScoreboard = this.root.querySelector('#mp-tab-scoreboard');
    this.mpAimHint = this.root.querySelector('#mp-aim-hint');

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
      if (t.dataset.play) this.play(t.dataset.play);
      else if (t.dataset.goto) {
        if (t.dataset.goto === 'leaderboard') this._renderLeaderboard(this._activeLbTab());
        if (t.dataset.goto === 'settings') this._returnAfterSettings = this.state;
        this.showScreen(t.dataset.goto);
        if (t.dataset.goto === 'mp') this.mp.openBrowser();
        if (t.dataset.goto === 'auth') this._openAuth('login');
      } else if (t.hasAttribute('data-resume')) this.resume();
      else if (t.hasAttribute('data-quit')) this.quit();
      else if (t.hasAttribute('data-restart')) this.play(this.currentScenario);
      else if (t.hasAttribute('data-reset')) {
        this.settings.reset();
        this._populateSettings();
      } else if (t.hasAttribute('data-reset-colors')) {
        this.settings.resetColors();
        this._populateSettings();
      } else if (t.dataset.lb) {
        this.root.querySelectorAll('#lb-tabs .tab').forEach((b) => b.classList.toggle('active', b === t));
        this._renderLeaderboard(t.dataset.lb);
      }
    });

    // Scenario cards: clicking the card body (not the button) also previews
    // which leaderboard is active.
    this.root.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('mouseenter', () => (this.currentScenario = card.dataset.scenario));
    });

    this._bindSettings();
    this._bindSettingsTabs();
    this._bindPauseMenu();
    this._bindConfigShare();
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
      apply(v);
      syncUi(v);
      s.save();
      after?.();
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

  _bindSettings() {
    const s = this.settings;
    const $ = (id) => this.root.querySelector(id);

    const numOnly = (id, apply, { parse = parseFloat, after } = {}) => {
      $(id).addEventListener('change', (e) => {
        const v = parse(e.target.value);
        if (Number.isNaN(v)) return;
        apply(v);
        s.save();
        after?.();
      });
    };

    numOnly('#set-cm360', (v) => (s.data.cm360 = v));
    numOnly('#set-dpi', (v) => (s.data.dpi = v));

    this._bindRange('set-fov', (v) => (s.data.hFov = v));
    numOnly('#set-dur', (v) => (s.data.runDuration = v), { parse: (v) => parseInt(v, 10) });

    $('#set-res').addEventListener('change', (e) => {
      s.data.resolution = e.target.value;
      s.save();
    });
    $('#set-raw').addEventListener('change', (e) => {
      s.data.rawInput = e.target.checked;
      s.save();
    });

    $('#set-xh-color').addEventListener('input', (e) => {
      s.data.crosshair.color = e.target.value;
      s.save();
    });
    this._bindRange('set-xh-gap', (v) => (s.data.crosshair.innerGap = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-xh-len', (v) => (s.data.crosshair.length = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-xh-thick', (v) => (s.data.crosshair.thickness = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-xh-dot', (v) => (s.data.crosshair.dotPercentage = v), { parse: (v) => parseInt(v, 10) });
    $('#set-xh-hitmarker').addEventListener('change', (e) => {
      s.data.crosshair.hitmarker = e.target.checked;
      s.save();
      this.crosshair.drawPreview(e.target.checked);
    });
    $('#set-xh-dyn').addEventListener('change', (e) => {
      s.data.crosshair.dynamicGap = e.target.checked;
      s.save();
    });

    $('#set-vm-hand').addEventListener('change', (e) => {
      s.data.viewmodel.hand = e.target.value === 'left' ? 'left' : 'right';
      s.save();
    });
    this._bindRange('set-vm-fov', (v) => (s.data.viewmodel.fov = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-vm-ox', (v) => (s.data.viewmodel.offsetX = v));
    this._bindRange('set-vm-oy', (v) => (s.data.viewmodel.offsetY = v));
    this._bindRange('set-vm-oz', (v) => (s.data.viewmodel.offsetZ = v));
    $('#set-vm-bob').addEventListener('change', (e) => {
      s.data.viewmodel.bob = e.target.checked;
      s.save();
    });
    $('#set-vm-aimpunch').addEventListener('change', (e) => {
      s.data.weapon.aimpunch = e.target.checked;
      s.save();
    });

    const ensureSprayTune = () => {
      if (!s.data.weapon.sprayTune) s.data.weapon.sprayTune = structuredClone(DEFAULT_SPRAY_TUNE);
      return s.data.weapon.sprayTune;
    };
    const refreshSprayReadout = () => {
      const el = $('#spray-tune-readout');
      if (!el) return;
      const t = getSprayTune(ensureSprayTune());
      el.textContent = [
        `patternScale: ${t.patternScale}`,
        `punchScale: ${t.punchScale}`,
        `punchBaseDeg: ${t.punchBaseDeg}`,
        `punchRampDeg: ${t.punchRampDeg}`,
        `punchRampMaxShots: ${t.punchRampMaxShots}`,
        `punchTauSpray: ${t.punchTauSpray}`,
        `punchTauRecover: ${t.punchTauRecover}`
      ].join('\n');
    };
    this._bindRange('set-spray-pattern', (v) => (ensureSprayTune().patternScale = v), { after: refreshSprayReadout });
    this._bindRange('set-spray-punch-scale', (v) => (ensureSprayTune().punchScale = v), { after: refreshSprayReadout });
    this._bindRange('set-spray-punch-base', (v) => (ensureSprayTune().punchBaseDeg = v), { after: refreshSprayReadout });
    this._bindRange('set-spray-punch-ramp', (v) => (ensureSprayTune().punchRampDeg = v), { after: refreshSprayReadout });
    this._bindRange('set-spray-punch-ramp-max', (v) => (ensureSprayTune().punchRampMaxShots = v), {
      parse: (v) => parseInt(v, 10),
      after: refreshSprayReadout
    });
    this._bindRange('set-spray-tau-spray', (v) => (ensureSprayTune().punchTauSpray = v), { after: refreshSprayReadout });
    this._bindRange('set-spray-tau-recover', (v) => (ensureSprayTune().punchTauRecover = v), { after: refreshSprayReadout });
    $('#btn-spray-tune-copy')?.addEventListener('click', async () => {
      refreshSprayReadout();
      const text = $('#spray-tune-readout')?.textContent;
      if (!text) return;
      try {
        await copyText(text);
        $('#btn-spray-tune-copy').textContent = 'Copied!';
        setTimeout(() => { $('#btn-spray-tune-copy').textContent = 'Copy values for report'; }, 1500);
      } catch {
        /* clipboard blocked — readout is still visible */
      }
    });

    this._bindRange('set-grid-size', (v) => (s.data.gridshot.targetSize = v));
    $('#set-grid-mode').addEventListener('change', (e) => {
      s.data.gridshot.mode = e.target.value;
      s.save();
    });
    this._bindRange('set-grid-track-time', (v) => (s.data.gridshot.trackTime = v));
    $('#set-grid-track-resolve').addEventListener('change', (e) => {
      s.data.gridshot.trackResolve = e.target.value;
      s.save();
    });
    $('#set-grid-float').addEventListener('change', (e) => {
      s.data.gridshot.floatEnabled = e.target.checked;
      s.save();
    });
    this._bindRange('set-grid-float-speed', (v) => (s.data.gridshot.floatSpeedMax = v));
    this._bindRange('set-grid-bounds-y', (v) => (s.data.gridshot.boundsScaleY = v));
    this._bindRange('set-grid-bounds-x', (v) => (s.data.gridshot.boundsScaleX = v));
    $('#set-grid-tl').addEventListener('change', (e) => {
      s.data.gridshot.enableTimeLimit = e.target.checked;
      s.save();
    });
    this._bindRange('set-grid-age', (v) => (s.data.gridshot.maxTargetAge = v), { parse: (v) => parseInt(v, 10) });

    this._bindRange('set-arena-cross', (v) => (s.data.arena.crossDuration = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-arena-peek', (v) => (s.data.arena.peekHold = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-arena-col', (v) => (s.data.arena.columns = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-arena-colr', (v) => (s.data.arena.columnRadius = v));
    this._bindRange('set-arena-ring', (v) => (s.data.arena.ringRadius = v));
    this._bindRange('set-arena-enemy', (v) => (s.data.arena.enemyScale = v));

    $('#set-duels-arena').addEventListener('change', (e) => {
      s.data.duels.arena = parseInt(e.target.value, 10);
      s.save();
    });
    this._bindRange('set-duels-ttk', (v) => (s.data.duels.ttk = v));

    const col = (id, key) =>
      $(id).addEventListener('input', (e) => { s.data.colors[key] = e.target.value; s.save(); });
    col('#set-col-bg', 'bg');
    col('#set-col-floor', 'floor');
    col('#set-col-ebody', 'enemyBody');
    col('#set-col-ehead', 'enemyHead');
    col('#set-col-cover', 'cover');
    col('#set-col-target', 'target');

    $('#set-range-arc').addEventListener('change', (e) => {
      s.data.range.arc = parseInt(e.target.value, 10);
      s.save();
    });
    this._bindRange('set-range-count', (v) => (s.data.range.enemyCount = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-range-rad', (v) => (s.data.range.radius = v), { parse: (v) => parseInt(v, 10) });
    $('#set-range-cover').addEventListener('change', (e) => {
      s.data.range.coverEnabled = e.target.checked;
      s.save();
    });
    this._bindRange('set-range-cover-count', (v) => (s.data.range.coverCount = v), { parse: (v) => parseInt(v, 10) });
    this._bindRange('set-range-cover-dist', (v) => (s.data.range.coverDistance = v));
    this._bindRange('set-range-cover-thick', (v) => (s.data.range.coverThickness = v));
    this._bindRange('set-range-cover-height', (v) => (s.data.range.coverHeight = v));
  }

  _bindPauseMenu() {
    const $ = (id) => this.root.querySelector(id);
    $('#pause-settings-btn')?.addEventListener('click', () => {
      this._returnAfterSettings = 'paused';
      this.showScreen('settings');
    });
    $('#pause-leave-lobby-btn')?.addEventListener('click', () => {
      this.mp?.returnToLobby();
    });
    $('#settings-done-btn')?.addEventListener('click', () => this._closeSettings());
  }

  _closeSettings() {
    const ret = this._returnAfterSettings;
    this._returnAfterSettings = null;
    if (ret) {
      this.showScreen(ret);
      if (ret === 'paused') this._updatePauseMenu();
    } else {
      this.showScreen('menu');
    }
  }

  _updatePauseMenu() {
    const leaveBtn = this.root.querySelector('#pause-leave-lobby-btn');
    if (!leaveBtn) return;
    const inMpMatch = this.mp?.inMatch && !!this.mp?.lobby;
    leaveBtn.hidden = !inMpMatch;
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
    const mmLine = this.root.querySelector('#menu-mm-userline');

    // Matchmaking tile subline reflects sign-in / ELO regardless of auth config.
    if (mmLine) {
      if (this.auth?.isLoggedIn) {
        mmLine.textContent = `${this._accountLabel()} · ${this.auth.elo} ELO`;
      } else {
        mmLine.textContent = this.auth?.isConfigured ? 'Sign in for ranked' : 'Ranked 1v1 duels';
      }
    }

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

    $('#mp-create-btn').addEventListener('click', () => {
      this.mp.create({
        name: name(),
        target: parseInt($('#mp-create-target').value, 10),
        isPublic: !$('#mp-create-private').checked
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
        const goal = l.target > 0 ? `First to ${l.target}` : 'Endless';
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
    $('#mp-lobby-private').checked = lobby.isPublic === false;
    $('#mp-lobby-target').disabled = !isHost;
    $('#mp-lobby-private').disabled = !isHost;

    const inviteUrl = this._mpInviteUrl(lobby.code);
    $('#mp-invite-url').textContent = inviteUrl;

    const readyBtn = $('#mp-ready-btn');
    readyBtn.textContent = me && me.ready ? 'Unready' : 'Ready';
    readyBtn.classList.toggle('primary', !(me && me.ready));

    const startBtn = $('#mp-start-btn');
    const canStart = isHost && lobby.players.length === 2 && lobby.players.every((p) => p.ready || p.id === lobby.hostId);
    startBtn.style.display = isHost ? '' : 'none';
    startBtn.disabled = !canStart;
  }

  beginMpMatch(msg, players) {
    this._mpPlayers = players;
    this._mpTarget = msg.target;
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

  /** Hold-Tab stats overlay during any active run (SP or MP). */
  _canHoldTabOverlay() {
    return this.state === 'playing' && !!this.sceneManager.current
      && !this.mpChat?.classList.contains('typing');
  }

  /** A click on the canvas while unlocked re-acquires pointer lock. */
  _onUnlockedClick() {
    if (this.mpChat?.classList.contains('typing')) return;
    if (this.state === 'playing' || this.state === 'await-start') {
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
    const title = SCENARIO_META[this.currentScenario]?.title ?? 'Run';
    const statRow = (label, val) =>
      `<tr><td class="mp-tab-label">${label}</td><td class="mp-tab-val">${val}</td></tr>`;
    const rows = [
      statRow('Time', `${this.sceneManager.timeRemaining.toFixed(1)}s`),
      statRow('Score', Math.round(sc.score).toLocaleString()),
      statRow('Accuracy', `${Math.round(sc.accuracy * 100)}%`),
      statRow('KPS', sc.kps.toFixed(1)),
      statRow('Hits', `${sc.hits}/${sc.shotsFired}`),
      statRow('Headshot %', `${Math.round(sc.critRatio * 100)}%`),
      statRow('Misses', String(sc.misses))
    ];
    if (sc.kills > 0) rows.push(statRow('Kills', String(sc.kills)));

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

    const goal = this._mpTarget > 0 ? `First to ${this._mpTarget}` : 'Endless';
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
            ${row('Kills', (s) => s.kills ?? 0)}
            ${row('Deaths', (s) => s.deaths ?? 0)}
            ${row('Accuracy', (s) => Math.round((s.accuracy ?? 0) * 100) + '%')}
            ${row('Shots', (s) => s.shots ?? 0)}
            ${row('Hits', (s) => s.hits ?? 0)}
            ${row('Avg TTK', (s) => (s.avgTtk != null ? `${s.avgTtk.toFixed(2)}s` : '—'))}
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
    const mapLabel = this._mpMapId ? getMap(this._mpMapId).label : '';
    const goal = targetVal > 0 ? `First to ${targetVal}` : 'Endless';
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
    const title = msg.aborted ? 'MATCH ABORTED' : won ? 'VICTORY' : 'DEFEAT';
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

  _bindConfigShare() {
    const $ = (id) => this.root.querySelector(id);
    const status = $('#config-status');
    const codeIn = $('#set-config-code');
    const exportBox = $('#config-export-box');
    const exportCode = $('#config-export-code');

    const setStatus = (msg, ok = true) => {
      status.textContent = msg;
      status.classList.toggle('is-error', !ok);
    };

    const doImport = async () => {
      try {
        setStatus('…');
        const settings = await importConfig(codeIn.value);
        this.settings.applyPayload(settings);
        this._populateSettings();
        setStatus('OK');
      } catch (e) {
        setStatus(e.message || 'Failed', false);
      }
    };

    $('#btn-config-import').addEventListener('click', doImport);
    codeIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doImport();
    });
    codeIn.addEventListener('blur', () => {
      if (codeIn.value.trim()) codeIn.value = normalizeCode(codeIn.value);
    });

    $('#btn-config-export').addEventListener('click', async () => {
      try {
        setStatus('…');
        const code = await exportConfig(this.settings.getExportPayload());
        exportCode.textContent = code;
        exportBox.hidden = false;
        codeIn.value = code;
        setStatus('OK');
      } catch (e) {
        setStatus(e.message || 'Failed', false);
      }
    });

    $('#btn-config-copy').addEventListener('click', async () => {
      const code = exportCode.textContent;
      if (!code) return;
      try {
        await copyText(code);
        setStatus('Copied');
      } catch {
        setStatus('Failed', false);
      }
    });
  }

  _populateSettings() {
    const s = this.settings.data;
    const $ = (id) => this.root.querySelector(id);

    $('#set-cm360').value = s.cm360;
    $('#set-dpi').value = s.dpi;
    this._setRange('set-fov', s.hFov);
    $('#set-res').value = s.resolution;
    $('#set-dur').value = s.runDuration;
    $('#set-raw').checked = s.rawInput;

    $('#set-xh-color').value = s.crosshair.color;
    this._setRange('set-xh-gap', s.crosshair.innerGap);
    this._setRange('set-xh-len', s.crosshair.length);
    this._setRange('set-xh-thick', s.crosshair.thickness);
    this._setRange('set-xh-dot', s.crosshair.dotPercentage);
    $('#set-xh-hitmarker').checked = s.crosshair.hitmarker !== false;
    $('#set-xh-dyn').checked = !!s.crosshair.dynamicGap;
    this.crosshair.drawPreview();

    $('#set-vm-hand').value = s.viewmodel?.hand === 'left' ? 'left' : 'right';
    this._setRange('set-vm-fov', s.viewmodel?.fov ?? 68);
    this._setRange('set-vm-ox', s.viewmodel?.offsetX ?? 0.16);
    this._setRange('set-vm-oy', s.viewmodel?.offsetY ?? -0.15);
    this._setRange('set-vm-oz', s.viewmodel?.offsetZ ?? 0.5);
    $('#set-vm-bob').checked = s.viewmodel?.bob !== false;
    $('#set-vm-aimpunch').checked = s.weapon?.aimpunch !== false;

    const st = getSprayTune(s.weapon?.sprayTune);
    this._setRange('set-spray-pattern', st.patternScale);
    this._setRange('set-spray-punch-scale', st.punchScale);
    this._setRange('set-spray-punch-base', st.punchBaseDeg);
    this._setRange('set-spray-punch-ramp', st.punchRampDeg);
    this._setRange('set-spray-punch-ramp-max', st.punchRampMaxShots);
    this._setRange('set-spray-tau-spray', st.punchTauSpray);
    this._setRange('set-spray-tau-recover', st.punchTauRecover);
    const sprayReadout = $('#spray-tune-readout');
    if (sprayReadout) {
      sprayReadout.textContent = [
        `patternScale: ${st.patternScale}`,
        `punchScale: ${st.punchScale}`,
        `punchBaseDeg: ${st.punchBaseDeg}`,
        `punchRampDeg: ${st.punchRampDeg}`,
        `punchRampMaxShots: ${st.punchRampMaxShots}`,
        `punchTauSpray: ${st.punchTauSpray}`,
        `punchTauRecover: ${st.punchTauRecover}`
      ].join('\n');
    }

    this._setRange('set-grid-size', s.gridshot.targetSize);
    $('#set-grid-mode').value = s.gridshot.mode || 'clicking';
    this._setRange('set-grid-track-time', s.gridshot.trackTime ?? 0.4);
    $('#set-grid-track-resolve').value = s.gridshot.trackResolve || 'click';
    $('#set-grid-float').checked = !!s.gridshot.floatEnabled;
    this._setRange('set-grid-float-speed', s.gridshot.floatSpeedMax ?? 2);
    this._setRange('set-grid-bounds-y', s.gridshot.boundsScaleY ?? 1);
    this._setRange('set-grid-bounds-x', s.gridshot.boundsScaleX ?? 1);
    $('#set-grid-tl').checked = s.gridshot.enableTimeLimit;
    this._setRange('set-grid-age', s.gridshot.maxTargetAge);

    this._setRange('set-arena-cross', s.arena.crossDuration);
    this._setRange('set-arena-peek', s.arena.peekHold);
    this._setRange('set-arena-col', s.arena.columns);
    this._setRange('set-arena-colr', s.arena.columnRadius);
    this._setRange('set-arena-ring', s.arena.ringRadius);
    this._setRange('set-arena-enemy', s.arena.enemyScale);

    $('#set-duels-arena').value = String(s.duels.arena);
    this._setRange('set-duels-ttk', s.duels.ttk);

    $('#set-col-bg').value = s.colors.bg;
    $('#set-col-floor').value = s.colors.floor;
    $('#set-col-ebody').value = s.colors.enemyBody;
    $('#set-col-ehead').value = s.colors.enemyHead;
    $('#set-col-cover').value = s.colors.cover;
    $('#set-col-target').value = s.colors.target;

    $('#set-range-arc').value = String(s.range.arc);
    this._setRange('set-range-count', s.range.enemyCount);
    this._setRange('set-range-rad', s.range.radius);
    $('#set-range-cover').checked = !!s.range.coverEnabled;
    this._setRange('set-range-cover-count', s.range.coverCount ?? 2);
    this._setRange('set-range-cover-dist', s.range.coverDistance ?? 4);
    this._setRange('set-range-cover-thick', s.range.coverThickness ?? 1.2);
    this._setRange('set-range-cover-height', s.range.coverHeight ?? 3);
  }

  // -------------------------------------------------------------------------
  // Screen state machine
  // -------------------------------------------------------------------------
  showScreen(name) {
    this.state = name;
    for (const key in this.screens) {
      this.screens[key].classList.toggle('active', key === name);
    }
    const inRun = name === 'playing';
    const sc = this.sceneManager.current;
    const isMp = inRun && sc && sc.isMultiplayer;
    // In multiplayer the live scoreboard replaces the singleplayer stat chips.
    this.hud.classList.toggle('active', inRun && !isMp);
    if (this.mpScoreboard) this.mpScoreboard.classList.toggle('active', !!isMp);
    if (this.mpChat) {
      this.mpChat.classList.toggle('active', !!isMp);
      if (!isMp) this._closeMpChatTyping(false);
    }
    this.crosshair.setVisible(inRun);
    if (name === 'settings') this.crosshair.drawPreview();
    // Hide the system cursor only while actively playing — when paused (Esc),
    // the cursor must reappear so the menu is clickable.
    document.body.classList.toggle('in-run', inRun);
    if (name === 'menu') this.refreshAccountBar();
  }

  play(name) {
    this.currentScenario = name;
    this.sceneManager.load(name);
    // CRIT chip is meaningful for every mode with head-shots (all but Gridshot).
    this.hudCritChip.style.display = name === 'gridshot' ? 'none' : '';
    this.showScreen('playing');
    this.state = 'await-start';
    this.input.requestLock();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.sceneManager.resume();
    this.showScreen('playing');
    this.input.requestLock();
  }

  quit() {
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
    this.showScreen('menu');
  }

  _onLockChange(locked) {
    if (locked) {
      this.engine.audio?.resume();
      this._suppressLockPause = false;
      if (this.state === 'await-start') {
        this.sceneManager.begin();
        this.showScreen('playing');
      }
    } else {
      // Chat input steals pointer lock — keep the match running so remotes keep moving.
      if (this._suppressLockPause) return;
      if (this.state === 'playing') {
        this._closeMpChatTyping(false);
        this._hideMpTabScoreboard();
        this.sceneManager.pause();
        this._updatePauseMenu();
        this.showScreen('paused');
      }
    }
  }

  async _onFinish(results) {
    this.state = 'results';
    this.input.exitLock();
    this.showScreen('results');
    await this._saveAndRenderResults(results);
  }

  // -------------------------------------------------------------------------
  // Per-frame updates (HUD + threat chevrons)
  // -------------------------------------------------------------------------
  frame() {
    const sc = this.sceneManager.current;
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
      this.hudTime.textContent = this.sceneManager.timeRemaining.toFixed(1);
      this.hudScore.textContent = Math.round(sc.score).toLocaleString();
      this.hudAcc.textContent = Math.round(sc.accuracy * 100) + '%';
      this.hudKps.textContent = sc.kps.toFixed(1);
      this.hudHits.textContent = `${sc.hits}/${sc.shotsFired}`;
      this.hudCrit.textContent = Math.round(sc.critRatio * 100) + '%';
    }
    if (this._mpTabBoardHeld) this._renderMpTabScoreboard();
    this._updateAmmo(sc);
    this._updateThreats(sc);
  }

  /** Ammo counter (bottom-right) — only for weapon scenarios. */
  _updateAmmo(sc) {
    if (!this.hudAmmo) return;
    const weapon = this.engine.weapon;
    const show = this.state === 'playing' && sc?.usesWeapon && !!weapon;
    this.hudAmmo.classList.toggle('active', !!show);
    if (!show) return;
    if (weapon.reloading) {
      this.hudAmmo.classList.add('reloading');
      this.hudAmmoMag.textContent = '·';
    } else {
      this.hudAmmo.classList.remove('reloading');
      this.hudAmmoMag.textContent = String(weapon.ammo);
    }
    this.hudAmmoSize.textContent = String(weapon.magSize);
  }

  _updateThreats(sc) {
    if (!sc || this.state !== 'playing' || !sc.isMultiplayer) {
      if (this.threatsEl.childElementCount) this.threatsEl.innerHTML = '';
      return;
    }
    const threats = sc.getThreats();
    const cam = this.engine.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.24;

    // Reuse chevron elements.
    while (this.threatsEl.childElementCount < threats.length) {
      const d = document.createElement('div');
      d.className = 'chevron';
      d.textContent = '▲';
      this.threatsEl.appendChild(d);
    }
    while (this.threatsEl.childElementCount > threats.length) {
      this.threatsEl.lastElementChild.remove();
    }

    threats.forEach((pos, i) => {
      const el = this.threatsEl.children[i];
      _v.copy(pos);
      cam.worldToLocal(_v); // camera space: +x right, +y up, -z forward
      const rel = Math.atan2(_v.x, -_v.z); // 0 = dead ahead, + = right
      // Hide the chevron when the threat is already comfortably on-screen.
      if (Math.abs(rel) < degToRad(22)) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      const sx = cx + Math.sin(rel) * R;
      const sy = cy - Math.cos(rel) * R;
      el.style.left = sx + 'px';
      el.style.top = sy + 'px';
      el.style.transform = `translate(-50%,-50%) rotate(${rel}rad)`;
    });
  }

  // -------------------------------------------------------------------------
  // Leaderboards
  // -------------------------------------------------------------------------
  _activeLbTab() {
    const active = this.root.querySelector('#lb-tabs .tab.active');
    return active ? active.dataset.lb : 'elo';
  }

  _configKeyFor(scenario) {
    return SCENARIOS[scenario].configKeyFor(this.settings);
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
        : (this.auth?.isLoggedIn
          ? 'No scores for these settings yet — finish a run to appear here.'
          : 'No scores yet — sign in and play to appear here.');
      return `<p class="center lb-hint">${hint}</p>`;
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
          <td class="lb-player">${this._esc(r.username)}</td>
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

    if (scenario === 'gridshot') {
      const rows = list
        .map((r, i) => {
          const hl = highlightUserId && r.user_id === highlightUserId ? ' class="hl"' : '';
          return `<tr${hl}>
          <td>${i + 1}</td>
          <td class="lb-player">${this._esc(r.username)}</td>
          <td>${this._formatTimePlayed(r.time_played)}</td>
          <td>${Math.round((r.accuracy || 0) * 100)}%</td>
          <td>${r.kills ?? '—'}</td>
          <td>${Number(r.kpm || 0).toFixed(1)}</td>
        </tr>`;
        })
        .join('');
      return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Time</th><th>Acc</th><th>Kills</th><th>KPM</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    }

    const rows = list
      .map((r, i) => {
        const hl = highlightUserId && r.user_id === highlightUserId ? ' class="hl"' : '';
        const crit = scenario !== 'gridshot'
          ? `<td>${Math.round((r.crit_ratio || 0) * 100)}%</td>`
          : '<td>—</td>';
        const date = r.achieved_at ? new Date(r.achieved_at).toLocaleDateString() : '—';
        return `<tr${hl}>
          <td>${i + 1}</td>
          <td class="lb-player">${this._esc(r.username)}</td>
          <td class="score">${Number(r.score).toLocaleString()}</td>
          <td>${Math.round((r.accuracy || 0) * 100)}%</td>
          ${crit}
          <td>${r.kills ?? '—'}</td>
          <td>${date}</td>
        </tr>`;
      })
      .join('');
    return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Acc</th><th>Crit</th><th>Kills</th><th>Date</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  async _fetchLeaderboard(scenario, configKeyOverride = null) {
    if (scenario === 'elo') {
      const { list, error } = await fetchEloLeaderboardWithMeta(50);
      this._lbCache.elo = list;
      return { list, error, configKey: null };
    }
    const key = configKeyOverride ?? this._configKeyFor(scenario);
    const cacheKey = `${scenario}:${key}`;
    const { list, error } = await fetchLeaderboardWithMeta(scenario, key, 10);
    this._lbCache[cacheKey] = list;
    return { list, error, configKey: key };
  }

  async _renderLeaderboard(scenario) {
    const body = this.root.querySelector('#lb-body');
    const subtitle = this.root.querySelector('#lb-subtitle');
    if (!body) return;
    body.innerHTML = `<p class="center">…</p>`;
    if (subtitle) {
      if (scenario === 'elo') {
        subtitle.textContent = this.auth?.isLoggedIn
          ? `All accounts · signed in as ${this._accountLabel()} (${this.auth.elo} ELO)`
          : 'All accounts · sign in to track your ranked ELO';
      } else {
        const gridshotHint = scenario === 'gridshot'
          ? 'Ranked by time played, then KPM · '
          : 'Best score per verified account · ';
        subtitle.textContent = this.auth?.isLoggedIn
          ? `${gridshotHint}signed in as ${this._accountLabel()}`
          : `${gridshotHint}sign in to submit scores`;
      }
    }
    const { list, error } = await this._fetchLeaderboard(scenario);
    body.innerHTML = this._leaderboardRowsHtml(list, scenario, this.auth?.user?.id, error);
  }

  async _saveAndRenderResults(results) {
    let rank = null;
    let submitNote = '';

    this.root.querySelector('#res-lb').innerHTML =
      `<p class="center lb-hint">${this.auth?.isLoggedIn ? 'Saving score…' : 'Loading leaderboard…'}</p>`;

    if (this.auth?.isLoggedIn) {
      try {
        await this.auth.ensureProfileReady();
      } catch (e) {
        console.warn('[ui] profile ensure failed', e);
      }
      const res = await submitScore(this.auth.user.id, results);
      if (res.ok) {
        console.info('[leaderboard] score saved', results.scenario, results.configKey);
        rank = await fetchUserRank(this.auth.user.id, results.scenario, results.configKey);
      } else {
        submitNote =
          res.reason === 'offline'
            ? ''
            : ` (score not saved: ${res.reason})`;
      }
    } else if (supabaseConfigured()) {
      submitNote = ' · sign in to save to leaderboards';
    }

    this.root.querySelector('#res-title').textContent =
      `${SCENARIO_META[results.scenario].title.toUpperCase()} — ` +
      (rank === 1 ? 'NEW BEST' : rank ? `RANK #${rank}` : 'RUN COMPLETE') +
      submitNote;

    const showCrit = results.scenario !== 'gridshot';
    const stat = (label, val) =>
      `<div class="stat"><span class="stat-value">${val}</span><label>${label}</label></div>`;
    const gridshotStats =
      stat('Time', this._formatTimePlayed(results.timePlayed)) +
      stat('Accuracy', Math.round(results.accuracy * 100) + '%') +
      stat('Kills', results.kills) +
      stat('KPM', results.kpm.toFixed(1));
    const defaultStats =
      stat('Score', results.score.toLocaleString()) +
      stat('Accuracy', Math.round(results.accuracy * 100) + '%') +
      stat('Kills', results.kills) +
      stat('Hits / Shots', `${results.hits}/${results.shots}`) +
      (showCrit ? stat('Crit ratio', Math.round(results.critRatio * 100) + '%') : '') +
      stat('Misses', results.misses);
    this.root.querySelector('#res-stats').innerHTML =
      results.scenario === 'gridshot' ? gridshotStats : defaultStats;

    const { list, error } = await this._fetchLeaderboard(results.scenario, results.configKey);
    this.root.querySelector('#res-lb').innerHTML = this._leaderboardRowsHtml(
      list,
      results.scenario,
      this.auth?.user?.id,
      error
    );
  }
}
