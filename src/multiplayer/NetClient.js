// ---------------------------------------------------------------------------
// multiplayer/NetClient.js
// Thin WebSocket client for the multiplayer duel server. Owns the socket and a
// set of callback hooks the UI / scenario subscribe to. Knows nothing about
// THREE or the DOM — it just sends typed messages and surfaces typed events.
// ---------------------------------------------------------------------------

import { C2S, S2C } from './protocol.js';

function resolveApiUrl() {
  const raw = import.meta.env.VITE_API_URL;
  if (!raw) return null;
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

/** Host the client should talk to. Precedence: ?server= → session → VITE_API_URL → same origin. */
function mpServerHost() {
  const strip = (s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const apiUrl = resolveApiUrl();
  try {
    const fromUrl = new URLSearchParams(location.search).get('server');
    if (fromUrl) {
      sessionStorage.setItem('mp-server', fromUrl);
      return strip(fromUrl);
    }
    // Production builds bake in VITE_API_URL — ignore a stale session override
    // left over from LAN/host testing or an old Fly region.
    if (apiUrl) {
      sessionStorage.removeItem('mp-server');
      return new URL(apiUrl).host;
    }
    const saved = sessionStorage.getItem('mp-server');
    if (saved) return strip(saved);
  } catch {
    /* ignore */
  }
  if (apiUrl) return new URL(apiUrl).host;
  return location.host;
}

function serverLabel() {
  const apiUrl = resolveApiUrl();
  if (apiUrl) return new URL(apiUrl).host;
  return mpServerHost();
}

function httpOrigin() {
  const apiUrl = resolveApiUrl();
  if (apiUrl) return new URL(apiUrl).origin;
  return `${location.protocol}//${mpServerHost()}`;
}

function wsUrl() {
  const apiUrl = resolveApiUrl();
  if (apiUrl) {
    const u = new URL(apiUrl);
    const proto = u.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${u.host}/ws`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${mpServerHost()}/ws`;
}

export class NetClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.serverPublicHost = null;
    this.serverRegion = null;

    this.pingMs = 0;
    this.lossPct = 0;

    this._pingSeq = 0;
    this._pendingPings = new Map();
    this._pingSent = 0;
    this._pingAcked = 0;
    this._pingTimer = null;

    // Event hooks (assign functions): each receives the message object.
    this.onWelcome = null;
    this.onLobby = null;
    this.onError = null;
    this.onMatchStart = null;
    this.onSnapshot = null;
    this.onHit = null;
    this.onKill = null;
    this.onRespawn = null;
    this.onChat = null;
    this.onMatchEnd = null;
    this.onClose = null;
    this.onLobbyList = null;
    this.onNetStats = null;
    this.onQueueStatus = null;
    this.onShotFired = null;
  }

  async _checkServer(timeoutMs = 5000) {
    const origin = httpOrigin();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${origin}/api/mp/status`, { signal: ctrl.signal });
      if (!res.ok) throw new Error('bad status');
      try {
        const body = await res.json();
        this.serverPublicHost = body && body.publicHost ? body.publicHost : null;
        this.serverRegion = body && body.region ? body.region : null;
      } catch {
        this.serverPublicHost = null;
        this.serverRegion = null;
      }
    } catch {
      throw new Error(`Server unreachable (${serverLabel()})`);
    } finally {
      clearTimeout(timer);
    }
  }

  connect({ timeoutMs = 12000 } = {}) {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this._connecting) return this._connecting;

    this._connecting = this._openSocket(timeoutMs).finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _openSocket(timeoutMs) {
    await this._checkServer(Math.min(timeoutMs, 6000));

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      let ws;
      try {
        ws = new WebSocket(wsUrl());
      } catch (e) {
        finish(reject, e instanceof Error ? e : new Error('Bad WebSocket URL'));
        return;
      }
      this.ws = ws;

      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        finish(reject, new Error('Connection timed out'));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        this.connected = true;
        this._startPingLoop();
        finish(resolve);
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev));
      ws.addEventListener('close', () => {
        this.connected = false;
        this._stopPingLoop();
        finish(reject, new Error('Connection closed'));
        this.onClose?.();
      });
      ws.addEventListener('error', () => {
        finish(reject, new Error('Connection failed'));
      });
    });
  }

  disconnect() {
    this._stopPingLoop();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connected = false;
    this._connecting = null;
    this.pingMs = 0;
    this.lossPct = 0;
    this.serverRegion = null;
    this._pendingPings.clear();
  }

  _startPingLoop() {
    this._stopPingLoop();
    this._pingSent = 0;
    this._pingAcked = 0;
    this._pendingPings.clear();
    this._sendPing();
    this._pingTimer = setInterval(() => this._sendPing(), 500);
  }

  _stopPingLoop() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _sendPing() {
    if (!this.connected) return;
    const id = ++this._pingSeq;
    this._pendingPings.set(id, Date.now());
    this._pingSent++;
    this._send({ t: C2S.PING, id, ct: performance.now() });
    this._updateLoss();
  }

  _onPong(msg) {
    const sentAt = this._pendingPings.get(msg.id);
    if (sentAt == null) return;
    this._pendingPings.delete(msg.id);
    this._pingAcked++;
    const rtt = Date.now() - sentAt;
    this.pingMs = this.pingMs ? Math.round(this.pingMs * 0.65 + rtt * 0.35) : rtt;
    this._updateLoss();
    this.onNetStats?.({ pingMs: this.pingMs, lossPct: this.lossPct });
  }

  _updateLoss() {
    const pending = this._pendingPings.size;
    const window = Math.max(1, this._pingSent);
    const acked = Math.max(0, this._pingAcked);
    const lost = Math.max(0, window - acked - pending);
    this.lossPct = Math.round((lost / window) * 100);
    if (this._pingSent > 40) {
      this._pingSent = Math.round(this._pingSent * 0.5);
      this._pingAcked = Math.round(this._pingAcked * 0.5);
    }
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.t) {
      case S2C.WELCOME:
        this.id = msg.id;
        this.onWelcome?.(msg);
        break;
      case S2C.LOBBY:
        this.onLobby?.(msg.lobby);
        break;
      case S2C.ERROR:
        this.onError?.(msg.msg);
        break;
      case S2C.MATCH_START:
        this.onMatchStart?.(msg);
        break;
      case S2C.SNAPSHOT:
        this.onSnapshot?.(msg);
        break;
      case S2C.HIT:
        this.onHit?.(msg);
        break;
      case S2C.KILL:
        this.onKill?.(msg);
        break;
      case S2C.RESPAWN:
        this.onRespawn?.(msg);
        break;
      case S2C.CHAT:
        this.onChat?.(msg);
        break;
      case S2C.MATCH_END:
        this.onMatchEnd?.(msg);
        break;
      case S2C.LOBBY_LIST:
        this.onLobbyList?.(msg.lobbies || []);
        break;
      case S2C.QUEUE_STATUS:
        this.onQueueStatus?.(msg);
        break;
      case S2C.SHOT_FIRED:
        this.onShotFired?.(msg);
        break;
      case S2C.PONG:
        this._onPong(msg);
        break;
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ---- Commands -----------------------------------------------------------
  createLobby({ name, target, isPublic, weapon }) {
    this._send({ t: C2S.CREATE, name, target, isPublic, weapon });
  }
  requestList() {
    this._send({ t: C2S.LIST });
  }
  stopList() {
    this._send({ t: C2S.UNLIST });
  }
  joinLobby({ code, name }) {
    this._send({ t: C2S.JOIN, code, name });
  }
  leaveLobby() {
    this._send({ t: C2S.LEAVE });
  }
  returnToLobby() {
    this._send({ t: C2S.RETURN_LOBBY });
  }
  setReady(ready) {
    this._send({ t: C2S.READY, ready });
  }
  setConfig({ target, isPublic, weapon }) {
    this._send({ t: C2S.CONFIG, target, isPublic, weapon });
  }
  startMatch() {
    this._send({ t: C2S.START });
  }
  sendState(s) {
    this._send({ t: C2S.STATE, ...s });
  }
  sendShot(o, d, claim, accuracy, end = null) {
    const msg = {
      t: C2S.SHOOT,
      ox: o.x, oy: o.y, oz: o.z,
      dx: d.x, dy: d.y, dz: d.z,
      rtt: this.pingMs || undefined,
      victimId: claim?.victimId,
      zone: claim?.zone
    };
    if (end) {
      msg.ex = end.x;
      msg.ey = end.y;
      msg.ez = end.z;
    }
    if (accuracy) {
      msg.aimDx = accuracy.aimDx;
      msg.aimDy = accuracy.aimDy;
      msg.aimDz = accuracy.aimDz;
      msg.onGround = accuracy.onGround;
      msg.speedHoriz = accuracy.speedHoriz;
      msg.spreadSeed = accuracy.seed;
    }
    this._send(msg);
  }
  sendChat(text) {
    this._send({ t: C2S.CHAT, text });
  }
  queueMatch({ name, userId, elo }) {
    this._send({ t: C2S.QUEUE, name, userId, elo });
  }
  dequeueMatch() {
    this._send({ t: C2S.DEQUEUE });
  }
}
