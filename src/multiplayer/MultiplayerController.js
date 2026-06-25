// ---------------------------------------------------------------------------
// multiplayer/MultiplayerController.js
// Orchestrates custom games + ranked matchmaking over NetClient.
// ---------------------------------------------------------------------------

import { NetClient } from './NetClient.js';
import { DEFAULT_ELO } from './elo.js';

export class MultiplayerController {
  constructor({ ui, engine, input, settings, sceneManager, crosshair }) {
    this.ui = ui;
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.sceneManager = sceneManager;
    this.crosshair = crosshair;

    this.net = new NetClient();
    this.lobby = null;
    this.inMatch = false;
    this.inQueue = false;
    this.queueElo = DEFAULT_ELO;
    this.browsing = false;

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
      if (!lobby.isMatchmade) {
        this._setUrlLobby(lobby.code);
        try {
          this.ui.renderLobby(lobby);
        } catch (e) {
          console.error('[mp] renderLobby failed', e);
        }
        if (this.ui.state === 'mp' || this.ui.state === 'menu') {
          this.ui.showScreen('mp-lobby');
        }
      }
    };
    net.onLobbyList = (lobbies) => {
      if (this.browsing) this.ui.renderLobbyList(lobbies);
    };
    net.onError = (msg) => this.ui.mpStatus(msg, false);
    net.onQueueStatus = (msg) => {
      this.inQueue = !!msg.inQueue;
      if (Number.isFinite(msg.elo)) this.queueElo = msg.elo;
      this.ui.onQueueStatus?.(msg);
    };
    net.onMatchStart = (msg) => {
      this._leaveSingleplayerIfActive();
      this._startMatch(msg);
    };
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

  /** Tear down an active singleplayer run when a ranked/custom match starts. */
  _leaveSingleplayerIfActive() {
    const spStates = new Set(['playing', 'paused', 'await-start', 'await-resume', 'results']);
    if (!spStates.has(this.ui.state)) return;
    this.input.exitLock();
    this.sceneManager.unload();
    if (this.ui.state === 'results' || this.ui.state === 'paused') {
      this.ui.state = 'menu';
    }
  }

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

  // ---- Lobby browser (custom games) ---------------------------------------
  async openBrowser() {
    this.browsing = true;
    this.ui.renderLobbyList(null);
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
    if (this.net.connected && !this.lobby && !this.inMatch && !this.inQueue) {
      this.net.stopList();
      this.net.disconnect();
    }
  }

  // ---- Ranked matchmaking -------------------------------------------------
  async enterQueue({ name, userId, elo }) {
    if (!(await this._ensureConnected())) return false;
    this.browsing = false;
    this.net.queueMatch({ name, userId, elo });
    return true;
  }

  leaveQueue() {
    if (this.net.connected) this.net.dequeueMatch();
    this.inQueue = false;
    if (this.net.connected && !this.lobby && !this.inMatch && !this.browsing) {
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

  returnToLobby() {
    if (this.inMatch) this.net.returnToLobby();
  }

  leave() {
    if (this.inQueue) this.leaveQueue();
    if (this.net.connected) this.net.leaveLobby();
    this.net.disconnect();
    this.lobby = null;
    this.inMatch = false;
    this.browsing = false;
    this.inQueue = false;
    this._setUrlLobby(null);
  }

  leaveIfActive() {
    if (this.inMatch || this.lobby) this.leave();
  }

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

  urlLobbyCode() {
    try {
      const code = new URL(window.location.href).searchParams.get('lobby');
      return code ? code.trim().toUpperCase().slice(0, 4) : null;
    } catch {
      return null;
    }
  }

  async autoJoinFromUrl(name) {
    const code = this.urlLobbyCode();
    if (!code) return false;
    this.ui.showScreen('mp');
    this.ui.renderLobbyList(null);
    if (!(await this._ensureConnected())) return true;
    this.net.joinLobby({ name, code });
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
    this.inQueue = false;
    this.browsing = false;
    this.sceneManager.load('mpduel', {
      net: this.net,
      myId: this.myId,
      mapId: msg.mapId,
      target: msg.target,
      spawns: msg.spawns,
      scores: msg.scores,
      stats: msg.stats,
      players,
      isMatchmade: !!msg.isMatchmade
    });
    this.ui.beginMpMatch(msg, players);
  }

  async _endMatch(msg) {
    this.inMatch = false;
    this.input.exitLock();
    this.sceneManager.unload();
    this.ui._resetMpChat?.();
    this.ui._hideMpTabScoreboard?.();

    if (msg.isMatchmade && msg.elo && this.ui.auth?.user?.id) {
      const myElo = msg.elo[this.myId];
      if (myElo?.newElo != null) {
        await this.ui.auth.applyMatchElo(myElo.newElo);
      }
    }

    if (msg.returnToLobby && this.lobby && !this.lobby.isMatchmade) {
      this.ui.renderLobby(this.lobby);
      this.ui.showScreen('mp-lobby');
      return;
    }

    if (this.lobby?.isMatchmade) {
      this.lobby = null;
    }

    this.ui.showMpResults(msg, this.lobby, this.myId);
  }

  _onClose() {
    this.inQueue = false;
    if (this.inMatch || (typeof this.ui.state === 'string' && this.ui.state.startsWith('mp'))) {
      this.inMatch = false;
      this.lobby = null;
      this.browsing = false;
      this.ui.mpDisconnected();
    }
    this.ui.onQueueStatus?.({ inQueue: false, queueSize: 0, elo: this.queueElo });
  }
}
