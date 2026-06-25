// ---------------------------------------------------------------------------
// multiplayer/MultiplayerController.js
// Orchestrates the multiplayer flow: owns the NetClient, drives the lobby/match
// lifecycle, and bridges server events into the active MultiplayerDuelScenario
// and the UIOverlay screens. The UI calls into this for user actions (browse /
// create / join / ready / start / leave); this calls back into the UI to swap
// screens, render the lobby browser, and update the live scoreboard.
//
// The browser URL carries the lobby code (?lobby=CODE) so a link can be shared
// and opened to auto-join (when there's space).
// ---------------------------------------------------------------------------

import { NetClient } from './NetClient.js';

export class MultiplayerController {
  constructor({ ui, engine, input, settings, sceneManager, crosshair }) {
    this.ui = ui;
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.sceneManager = sceneManager;
    this.crosshair = crosshair;

    this.net = new NetClient();
    this.lobby = null; // latest lobby view from the server
    this.inMatch = false;
    this.browsing = false;
    this._pendingAutoJoin = null; // { code } to join right after connect

    this._wireNet();
  }

  get myId() {
    return this.net.id;
  }

  _wireNet() {
    const net = this.net;
    net.onLobby = (lobby) => {
      this.lobby = lobby;
      this.browsing = false;
      this._setUrlLobby(lobby.code);
      try {
        this.ui.renderLobby(lobby);
      } catch (e) {
        console.error('[mp] renderLobby failed', e);
      }
      // Entering a lobby from the browser / create / join / auto-join.
      if (this.ui.state === 'mp' || this.ui.state === 'menu') {
        this.ui.showScreen('mp-lobby');
      }
    };
    net.onLobbyList = (lobbies) => {
      if (this.browsing) this.ui.renderLobbyList(lobbies);
    };
    net.onError = (msg) => this.ui.mpStatus(msg, false);
    net.onMatchStart = (msg) => this._startMatch(msg);
    net.onSnapshot = (msg) => this._scenario()?.applySnapshot(msg);
    net.onHit = (msg) => this._scenario()?.applyHit(msg);
    net.onKill = (msg) => {
      this._scenario()?.applyKill(msg);
      this.ui.updateMpScore(msg.scores, this.lobby, msg.mapId);
      if (msg.stats) this.ui.updateMpTabScoreboard(msg.stats);
    };
    net.onRespawn = (msg) => this._scenario()?.applyRespawn(msg);
    net.onChat = (msg) => this.ui.addMpChatMessage(msg);
    net.onMatchEnd = (msg) => this._endMatch(msg);
    net.onClose = () => this._onClose();
  }

  _scenario() {
    const sc = this.sceneManager.current;
    return sc && sc.isMultiplayer ? sc : null;
  }

  /** Ensure a live connection; returns true on success, surfaces errors in the UI. */
  async _ensureConnected() {
    if (this.net.connected) return true;
    try {
      this.ui.mpStatus('Connecting…');
      await this.net.connect();
      this.ui.mpStatus('');
      return true;
    } catch (e) {
      this.ui.mpStatus(e.message || 'Could not connect to the server.', false);
      return false;
    }
  }

  // ---- Lobby browser ------------------------------------------------------
  /** Open the multiplayer home: connect + subscribe to the public lobby list. */
  async openBrowser() {
    this.browsing = true;
    this.ui.renderLobbyList(null); // show "loading" state
    if (!(await this._ensureConnected())) {
      this.browsing = false;
      return;
    }
    this.browsing = true;
    this.net.requestList();
  }

  refreshList() {
    if (this.net.connected) this.net.requestList();
  }

  closeBrowser() {
    this.browsing = false;
    if (this.net.connected && !this.lobby && !this.inMatch) {
      this.net.stopList();
      this.net.disconnect();
    }
  }

  // ---- User actions -------------------------------------------------------
  async create({ name, target, isPublic }) {
    if (!(await this._ensureConnected())) return;
    this.browsing = false;
    this.net.createLobby({ name, target, isPublic });
  }

  async join({ name, code }) {
    if (!(await this._ensureConnected())) return;
    this.browsing = false;
    this.net.joinLobby({ name, code });
  }

  setReady(ready) {
    this.net.setReady(ready);
  }
  setConfig(opts) {
    this.net.setConfig(opts);
  }
  start() {
    this.net.startMatch();
  }

  /** End the active match and return to the pre-match lobby (stay connected). */
  returnToLobby() {
    if (this.inMatch) this.net.returnToLobby();
  }

  leave() {
    if (this.net.connected) this.net.leaveLobby();
    this.net.disconnect();
    this.lobby = null;
    this.inMatch = false;
    this.browsing = false;
    this._setUrlLobby(null);
  }

  /** Called when the user quits a match/lobby back to the main menu. */
  leaveIfActive() {
    if (this.net.connected || this.inMatch) this.leave();
  }

  // ---- URL helpers --------------------------------------------------------
  _setUrlLobby(code) {
    try {
      const url = new URL(window.location.href);
      if (code) url.searchParams.set('lobby', code);
      else url.searchParams.delete('lobby');
      window.history.replaceState({}, '', url);
    } catch {
      /* ignore */
    }
  }

  /** Lobby code present in the URL (?lobby=CODE), or null. */
  urlLobbyCode() {
    try {
      const code = new URL(window.location.href).searchParams.get('lobby');
      return code ? code.trim().toUpperCase().slice(0, 4) : null;
    } catch {
      return null;
    }
  }

  /** Auto-join a lobby from a shared URL on startup. */
  async autoJoinFromUrl(name) {
    const code = this.urlLobbyCode();
    if (!code) return false;
    this.ui.showScreen('mp');
    this.ui.renderLobbyList(null);
    if (!(await this._ensureConnected())) return true;
    this.net.joinLobby({ name, code });
    // If the join fails (full / not found), fall back to the public browser.
    this.browsing = true;
    this.net.requestList();
    return true;
  }

  // ---- Match lifecycle ----------------------------------------------------
  _startMatch(msg) {
    const players = {};
    if (this.lobby) {
      for (const p of this.lobby.players) players[p.id] = { name: p.name, side: p.side };
    }
    this.inMatch = true;
    this.browsing = false;
    this.sceneManager.load('mpduel', {
      net: this.net,
      myId: this.myId,
      mapId: msg.mapId,
      target: msg.target,
      spawns: msg.spawns,
      scores: msg.scores,
      stats: msg.stats,
      players
    });
    this.ui.beginMpMatch(msg, players);
  }

  _endMatch(msg) {
    this.inMatch = false;
    this.input.exitLock();
    this.sceneManager.unload();
    this._resetMpChatUi();

    if (msg.returnToLobby && this.lobby) {
      this.ui.renderLobby(this.lobby);
      this.ui.showScreen('mp-lobby');
      return;
    }
    this.ui.showMpResults(msg, this.lobby, this.myId);
  }

  _resetMpChatUi() {
    this.ui._resetMpChat?.();
    this.ui._hideMpTabScoreboard?.();
  }

  _onClose() {
    if (this.inMatch || (typeof this.ui.state === 'string' && this.ui.state.startsWith('mp'))) {
      this.inMatch = false;
      this.lobby = null;
      this.browsing = false;
      this.ui.mpDisconnected();
    }
  }
}
