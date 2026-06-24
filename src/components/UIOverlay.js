// ---------------------------------------------------------------------------
// UIOverlay.js
// All HTML/CSS UI layered over the canvas: main menu, settings, leaderboards,
// in-run HUD, pause + results screens, and the off-screen threat chevrons for
// the Arena. Holds the screen state machine and coordinates pointer-lock with
// the run lifecycle. The core game loop never touches UI state.
//
// States: menu | settings | leaderboard | await-start | playing | paused
//         | await-resume | results
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { degToRad, countsPer360 } from '../utils/MathUtils.js';
import { RESOLUTIONS } from '../core/SettingsManager.js';
import { SCENARIOS } from '../core/SceneManager.js';
import * as Storage from '../utils/Storage.js';
import { exportConfig, importConfig, copyText, normalizeCode } from '../utils/ConfigCodes.js';
import { MultiplayerController } from '../multiplayer/MultiplayerController.js';
import { SCORE_TARGETS } from '../multiplayer/constants.js';
import { getMap } from '../multiplayer/maps.js';

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
  constructor({ engine, input, settings, crosshair, sceneManager }) {
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.crosshair = crosshair;
    this.sceneManager = sceneManager;

    this.root = document.getElementById('ui-root');
    this.state = 'menu';
    this.currentScenario = 'gridshot';
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
    this._populateSettings();
    this.showScreen('menu');

    this.mp = new MultiplayerController({
      ui: this,
      engine: this.engine,
      input: this.input,
      settings: this.settings,
      sceneManager: this.sceneManager,
      crosshair: this.crosshair
    });
    this._bindMultiplayer();
    this._bindMpChat();
    this._bindMpTabScoreboard();

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
        'background:#7a1020;color:#fff;font:13px/1.4 monospace;padding:10px 44px 10px 14px;' +
        'white-space:pre-wrap;word-break:break-word;box-shadow:0 4px 20px rgba(0,0,0,.5);';
      const close = document.createElement('button');
      close.textContent = '✕';
      close.style.cssText =
        'position:absolute;top:8px;right:10px;background:none;border:none;color:#fff;font-size:16px;cursor:pointer;';
      close.onclick = () => el.remove();
      this._errMsg = document.createElement('span');
      el.appendChild(this._errMsg);
      el.appendChild(close);
      this.root.appendChild(el);
    }
    const msg = (err && (err.stack || err.message)) || String(err);
    this._errMsg.textContent = '⚠ Runtime error (game still rendering):\n' + msg;
  }

  _settingsSections(resOptions) {
    return [
      {
        id: 'mouse',
        label: 'Mouse',
        body: `
          ${numField('set-cm360', 'Sensitivity (cm / 360°)', '0.5')}
          ${numField('set-dpi', 'Mouse DPI / CPI', '50')}
          <p class="readout" id="sens-readout"></p>`
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
          <div class="color-row">
            <span>Color</span>
            <input type="color" id="set-xh-color" />
          </div>
          ${rf('set-xh-gap', 'Inner gap', 0, 30, 1)}
          ${rf('set-xh-len', 'Length', 0, 30, 1)}
          ${rf('set-xh-thick', 'Thickness', 1, 8, 1)}
            ${rf('set-xh-dot', 'Center dot (%)', 0, 100, 5)}
            <label class="field-check"><input type="checkbox" id="set-xh-hitmarker" /> Show hitmarker cross on hit</label>`
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
          <button type="button" class="btn btn-block" data-reset-colors>Reset colors</button>
          <p class="readout muted">World colors apply on next run.</p>`
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
          ${rf('set-duels-ttk', 'Time to kill (s)', 0.2, 2.0, 0.1)}
          <p class="readout">WASD move · Shift walk · Ctrl/C crouch · 250 u/s peeks.</p>`
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
          <p class="readout">Paste a code to load settings, or export yours to share.</p>
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

    <!-- MULTIPLAYER LIVE SCOREBOARD -->
    <div id="mp-scoreboard" class="mp-scoreboard"></div>

    <!-- MULTIPLAYER CHAT (Enter / Y to open · Tab to return to game) -->
    <div id="mp-chat" class="mp-chat">
      <div id="mp-chat-log" class="mp-chat-log"></div>
      <input id="mp-chat-input" type="text" class="mp-chat-input" maxlength="120" placeholder="Enter or Y to chat · Hold Tab for stats" spellcheck="false" autocomplete="off" />
    </div>

    <!-- CLICK-TO-AIM PROMPT (multiplayer, when pointer lock is not held) -->
    <div id="mp-aim-hint" class="mp-aim-hint"><span>Click to aim</span></div>

    <!-- HOLD-TAB SCOREBOARD -->
    <div id="mp-tab-scoreboard" class="mp-tab-scoreboard"></div>

    <!-- MAIN MENU -->
    <div class="screen menu" data-screen="menu">
      <div class="panel wide">
        <h1 class="logo text-big">AIM4<span>.io</span></h1>
        <p class="subtitle">Three.js · Pointer Lock · cm/360 true sensitivity</p>
        <div class="cards">
          ${Object.keys(SCENARIOS)
            .map(
              (key) => `
            <div class="card" data-scenario="${key}">
              <div class="card-icon ${key}"></div>
              <h3 class="card-title">${SCENARIO_META[key].title}</h3>
              <button type="button" class="btn-play" data-play="${key}" aria-label="Play ${SCENARIO_META[key].title}">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
              </button>
            </div>`
            )
            .join('')}
        </div>
        <div class="menu-actions">
          <button class="btn primary" data-goto="mp">⚔ Multiplayer</button>
          <button class="btn" data-goto="settings">⚙ Settings</button>
          <button class="btn" data-goto="leaderboard">🏆 Leaderboards</button>
        </div>
        <p class="hint">Singleplayer above · <b>Multiplayer</b> for online 1v1 duels · <b>WASD</b> + <b>Shift</b> + <b>Ctrl</b> + <b>Space</b> · <b>Esc</b> to pause</p>
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
            <button class="btn primary" data-goto="menu">Done</button>
          </div>
        </header>
        <div class="settings-drawer">
          ${settingsSections.map((s, i) => settingsPanel(s.id, s.body, i === 0)).join('')}
        </div>
      </div>
    </div>

    <!-- LEADERBOARD -->
    <div class="screen leaderboard" data-screen="leaderboard">
      <div class="panel wide">
        <h2 class="text-big">Leaderboards</h2>
        <p class="muted">Top 10 for your <b>current settings</b> of each scenario.</p>
        <div class="tabs" id="lb-tabs">
          ${Object.keys(SCENARIOS)
            .map(
              (k, i) =>
                `<button class="tab ${i === 0 ? 'active' : ''}" data-lb="${k}">${SCENARIO_META[k].title}</button>`
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
      <div class="panel">
        <h2 class="text-big pause-title">Paused</h2>
        <p class="muted">Your run is frozen. Resume to re-lock the mouse.</p>
        <div class="menu-actions">
          <button class="btn primary" data-resume>Resume</button>
          <button class="btn" data-quit>Quit to menu</button>
        </div>
      </div>
    </div>

    <!-- MULTIPLAYER HOME (create / join) -->
    <div class="screen mp" data-screen="mp">
      <div class="panel wide">
        <h2 class="text-big">Multiplayer</h2>
        <p class="muted">Online 1v1 duels · arenas rotate each round · server runs at <b>128 tick</b>.</p>
        <p class="readout muted">To host for friends: run <b>start-host.bat</b>, then share the invite link from your lobby (not just the code).</p>
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
            <p class="muted mp-map-note">Map is chosen randomly each round.</p>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Win condition</span></div>
              <select id="mp-create-target">${this._targetOptions()}</select>
            </div>
            <label class="field-check"><input type="checkbox" id="mp-create-private" /> Private lobby (join by code/link only)</label>
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
          <p class="readout"><b>Invite link</b> — friends must open this exact URL (not localhost on their PC):</p>
          <code class="config-export-code" id="mp-invite-url"></code>
          <button type="button" class="btn btn-block" id="mp-invite-copy">Copy invite link</button>
        </div>
        <div class="mp-cols">
          <div class="mp-col">
            <p class="muted mp-map-note">Map cycles randomly — first arena picked when the match starts.</p>
            <div class="field field-plain">
              <div class="field-top"><span class="field-label">Win condition</span></div>
              <select id="mp-lobby-target">${this._targetOptions()}</select>
            </div>
            <label class="field-check"><input type="checkbox" id="mp-lobby-private" /> Private lobby</label>
            <p class="readout muted" id="mp-host-note"></p>
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
        this.showScreen(t.dataset.goto);
        if (t.dataset.goto === 'mp') this.mp.openBrowser();
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

    numOnly('#set-cm360', (v) => (s.data.cm360 = v), { after: () => this._updateSensReadout() });
    numOnly('#set-dpi', (v) => (s.data.dpi = v), { after: () => this._updateSensReadout() });

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

  // -------------------------------------------------------------------------
  // Multiplayer
  // -------------------------------------------------------------------------
  _targetOptions() {
    return SCORE_TARGETS.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
  }

  _defaultName() {
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
      if (code.length !== 4) return this.mpStatus('Enter the 4-character lobby code.', false);
      this.mp.join({ name: name(), code });
    });

    $('#mp-invite-copy')?.addEventListener('click', () => {
      const url = $('#mp-invite-url')?.textContent;
      if (!url) return;
      navigator.clipboard?.writeText(url).then(
        () => this.mpStatus('Invite link copied.', true),
        () => this.mpStatus('Could not copy — select the link and copy manually.', false)
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
      if (this.mp.lobby) this.showScreen('mp-lobby');
      else this.showScreen('mp');
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

  /** Render the public lobby browser list. `lobbies === null` = loading. */
  renderLobbyList(lobbies) {
    const el = this.root.querySelector('#mp-lobby-list');
    if (!el) return;
    if (lobbies === null) {
      el.innerHTML = '<div class="mp-lobby-empty">Loading lobbies…</div>';
      return;
    }
    if (!lobbies.length) {
      el.innerHTML = '<div class="mp-lobby-empty">No public lobbies right now. Create one below.</div>';
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
        const youName = p.id === this.mp.myId ? `${p.name} <span class="muted">(you)</span>` : p.name;
        return `<div class="mp-player"><span class="mp-side">${p.side || '–'}</span><span class="mp-name">${youName}</span>${tags.join('')}</div>`;
      })
      .join('') + (lobby.players.length < 2 ? '<div class="mp-player waiting">Waiting for an opponent…</div>' : '');

    $('#mp-lobby-target').value = String(lobby.target);
    $('#mp-lobby-private').checked = lobby.isPublic === false;
    $('#mp-lobby-target').disabled = !isHost;
    $('#mp-lobby-private').disabled = !isHost;

    const inviteUrl = this._mpInviteUrl(lobby.code);
    $('#mp-invite-url').textContent = inviteUrl;
    $('#mp-host-note').innerHTML = isHost
      ? 'You are host — pick win condition and privacy. Maps rotate each round. Copy the invite link above for friends.'
      : 'Only the host can change settings. Maps rotate each round.';

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
    this.updateMpScore(msg.scores, this.mp.lobby, msg.mapId);
    this.hudCritChip.style.display = 'none';
    this.showScreen('playing'); // sets state = 'playing'
    // Start the simulation immediately so state is sent and opponents update
    // even before pointer lock is granted (e.g. the tab isn't focused yet).
    this.sceneManager.begin();
    this.input.requestLock(); // best-effort; clicking the canvas will lock too
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

  /** A click on the canvas while unlocked re-acquires pointer lock. */
  _onUnlockedClick() {
    if (this.mpChat?.classList.contains('typing')) return;
    if (this.state === 'playing' || this.state === 'await-start' || this.state === 'await-resume') {
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

  updateMpTabScoreboard(stats) {
    this._mpTabStats = stats || {};
    if (this._mpTabBoardHeld) this._renderMpTabScoreboard();
  }

  _renderMpTabScoreboard() {
    if (!this.mpTabScoreboard) return;
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
        const you = p.id === this.mp.myId ? ' <span class="muted">(you)</span>' : '';
        return `<th class="mp-tab-name${me}">${this._esc(p.name)}${you}</th>`;
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
    this.mpTabScoreboard.innerHTML = `
      <div class="mp-tab-board">
        <div class="mp-tab-board-head">
          <span class="mp-tab-board-title">Match Stats</span>
          <span class="mp-tab-board-goal">${goal}</span>
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
      </div>`;
  }

  _bindMpTabScoreboard() {
    const hide = () => this._hideMpTabScoreboard();
    const show = () => {
      if (!this._isMpPlaying()) return;
      if (this.mpChat?.classList.contains('typing')) return;
      this._mpTabBoardHeld = true;
      this._renderMpTabScoreboard();
      this.mpTabScoreboard?.classList.add('visible');
    };

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab' || e.repeat) return;
      if (!this._isMpPlaying()) return;
      if (this.mpChat?.classList.contains('typing')) return;
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
    this.mpScoreboard.innerHTML = `<div class="mp-sb-goal">${goalLine}</div>${rows}`;
  }

  showMpResults(msg, lobby, myId) {
    this.state = 'mp-results';
    this._resetMpChat();
    this._hideMpTabScoreboard();
    this.input.exitLock();
    const won = msg.winnerId === myId;
    const title = msg.aborted ? 'Match Aborted' : won ? '🏆 Victory' : 'Defeat';
    this.root.querySelector('#mp-res-title').textContent = title;
    const players = (lobby && lobby.players) || [];
    const stat = (label, val) => `<div class="stat"><span class="text-big">${val}</span><label>${label}</label></div>`;
    this.root.querySelector('#mp-res-score').innerHTML = players
      .map((p) => stat(p.id === myId ? `${p.name} (you)` : p.name, (msg.scores && msg.scores[p.id]) || 0))
      .join('');
    this.showScreen('mp-results');
  }

  mpDisconnected() {
    this.state = 'menu';
    this._resetMpChat();
    this._hideMpTabScoreboard();
    this.input.exitLock();
    this.sceneManager.unload();
    this.mpStatus('Disconnected from server.', false);
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
        setStatus('Importing…');
        const settings = await importConfig(codeIn.value);
        this.settings.applyPayload(settings);
        this._populateSettings();
        setStatus('Settings imported.');
      } catch (e) {
        setStatus(e.message || 'Import failed.', false);
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
        setStatus('Generating code…');
        const code = await exportConfig(this.settings.getExportPayload());
        exportCode.textContent = code;
        exportBox.hidden = false;
        codeIn.value = code;
        setStatus('Code ready — copy or share it.');
      } catch (e) {
        setStatus(e.message || 'Export failed. Is the config server running?', false);
      }
    });

    $('#btn-config-copy').addEventListener('click', async () => {
      const code = exportCode.textContent;
      if (!code) return;
      try {
        await copyText(code);
        setStatus('Copied to clipboard.');
      } catch {
        setStatus('Could not copy — select the code manually.', false);
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

    this._updateSensReadout();
  }

  _updateSensReadout() {
    const s = this.settings.data;
    const counts = countsPer360(s.cm360, s.dpi);
    this.root.querySelector('#sens-readout').innerHTML =
      `≈ <b>${Math.round(counts).toLocaleString()}</b> counts / 360° · ` +
      `<b>${(this.settings.radiansPerCount * 1000).toFixed(4)}</b> mrad / count`;
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
    // Hide the system cursor only while actively playing — when paused (Esc),
    // the cursor must reappear so the menu is clickable.
    document.body.classList.toggle('in-run', inRun);
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
    this.state = 'await-resume';
    this.input.requestLock();
  }

  quit() {
    this.state = 'menu';
    this._resetMpChat();
    this._hideMpTabScoreboard();
    this.input.exitLock();
    this.mp?.leaveIfActive();
    this.sceneManager.unload();
    this.showScreen('menu');
  }

  _onLockChange(locked) {
    if (locked) {
      this._suppressLockPause = false;
      if (this.state === 'await-start') {
        this.sceneManager.begin();
        this.showScreen('playing');
      } else if (this.state === 'await-resume') {
        this.sceneManager.resume();
        this.showScreen('playing');
      }
    } else {
      // Chat input steals pointer lock — keep the match running so remotes keep moving.
      if (this._suppressLockPause) return;
      // In multiplayer, losing the lock (clicking out, alt-tab) must NOT pause:
      // the match is server-driven and opponents keep moving. frame() shows a
      // "click to aim" prompt; clicking the canvas re-locks.
      if (this.state === 'playing' && this.sceneManager.current?.isMultiplayer) return;
      // Singleplayer: lost the lock mid-run (Esc) -> pause.
      if (this.state === 'playing') {
        this.sceneManager.pause();
        this.showScreen('paused');
      }
    }
  }

  _onFinish(results) {
    this.state = 'results';
    this.input.exitLock();
    this._saveAndRenderResults(results);
    this.showScreen('results');
  }

  // -------------------------------------------------------------------------
  // Per-frame updates (HUD + threat chevrons)
  // -------------------------------------------------------------------------
  frame() {
    const sc = this.sceneManager.current;
    // Multiplayer keeps running without pointer lock; prompt the user to click
    // back in to aim whenever we're playing but don't hold the lock. A short
    // grace period avoids a flash while a normal (focused) lock is resolving.
    if (this._isMpPlaying() && !this.input.locked && !this.mpChat?.classList.contains('typing')) {
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
    this._updateThreats(sc);
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
    return active ? active.dataset.lb : 'gridshot';
  }

  _configKeyFor(scenario) {
    return SCENARIOS[scenario].configKeyFor(this.settings);
  }

  _leaderboardRows(scenario, highlightDate = null) {
    const key = this._configKeyFor(scenario);
    const list = Storage.getLeaderboard(scenario, key).slice(0, 10);
    if (!list.length) {
      return `<p class="muted center">No scores yet for these settings. Be the first.</p>`;
    }
    const rows = list
      .map((r, i) => {
        const hl = highlightDate && r.date === highlightDate ? ' class="hl"' : '';
        const crit = scenario !== 'gridshot' ? `<td>${Math.round((r.critRatio || 0) * 100)}%</td>` : '<td>—</td>';
        return `<tr${hl}>
          <td>${i + 1}</td>
          <td class="score">${r.score.toLocaleString()}</td>
          <td>${Math.round(r.accuracy * 100)}%</td>
          ${crit}
          <td>${r.kills}</td>
          <td>${new Date(r.date).toLocaleDateString()}</td>
        </tr>`;
      })
      .join('');
    return `<table class="lb-table">
      <thead><tr><th>#</th><th>Score</th><th>Acc</th><th>Crit</th><th>Kills</th><th>Date</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  _renderLeaderboard(scenario) {
    this.root.querySelector('#lb-body').innerHTML = this._leaderboardRows(scenario);
  }

  _saveAndRenderResults(results) {
    const record = {
      score: results.score,
      accuracy: results.accuracy,
      critRatio: results.critRatio,
      kills: results.kills,
      hits: results.hits,
      shots: results.shots,
      date: Date.now()
    };
    const rank = Storage.addLeaderboardRecord(results.scenario, results.configKey, record);

    this.root.querySelector('#res-title').textContent =
      `${SCENARIO_META[results.scenario].title} · ` + (rank === 1 ? '🥇 New Best!' : rank ? `Rank #${rank}` : 'Run Complete');

    const showCrit = results.scenario !== 'gridshot';
    const stat = (label, val) => `<div class="stat"><span class="text-big">${val}</span><label>${label}</label></div>`;
    this.root.querySelector('#res-stats').innerHTML =
      stat('Score', results.score.toLocaleString()) +
      stat('Accuracy', Math.round(results.accuracy * 100) + '%') +
      stat('Kills', results.kills) +
      stat('Hits / Shots', `${results.hits}/${results.shots}`) +
      (showCrit ? stat('Crit ratio', Math.round(results.critRatio * 100) + '%') : '') +
      stat('Misses', results.misses);

    this.root.querySelector('#res-lb').innerHTML = this._leaderboardRows(results.scenario, record.date);
  }
}
