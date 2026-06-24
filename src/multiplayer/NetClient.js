// ---------------------------------------------------------------------------
// multiplayer/NetClient.js
// Thin WebSocket client for the multiplayer duel server. Owns the socket and a
// set of callback hooks the UI / scenario subscribe to. Knows nothing about
// THREE or the DOM — it just sends typed messages and surfaces typed events.
// ---------------------------------------------------------------------------

import { C2S, S2C } from './protocol.js';

/**
 * Host the client should talk to. Precedence:
 *   1. ?server= URL override (also remembered for the session)
 *   2. saved session override
 *   3. VITE_API_URL baked in at build time — for split deploys where the client
 *      (e.g. Vercel) and backend (e.g. Fly.io) live on different origins
 *   4. same origin — LAN / host-mode where the backend also serves the client
 */
function mpServerHost() {
  const strip = (s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '');
  try {
    const fromUrl = new URLSearchParams(location.search).get('server');
    if (fromUrl) {
      sessionStorage.setItem('mp-server', fromUrl);
      return strip(fromUrl);
    }
    const saved = sessionStorage.getItem('mp-server');
    if (saved) return strip(saved);
  } catch {
    /* ignore */
  }
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) return strip(apiUrl);
  return location.host;
}

function httpOrigin() {
  return `${location.protocol}//${mpServerHost()}`;
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${mpServerHost()}/ws`;
}

function serverUnreachableMessage() {
  const host = location.hostname;
  const onLocalhost = host === 'localhost' || host === '127.0.0.1';
  if (onLocalhost) {
    return (
      'Cannot reach the multiplayer server on this PC. ' +
      'If you are joining a friend, open their full invite link (not localhost). ' +
      'If you are hosting, run start-host.bat or npm run server.'
    );
  }
  return (
    'Cannot reach the multiplayer server at this address. ' +
    'Ask the host for their invite link and make sure they have start-host.bat running.'
  );
}

export class NetClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.serverPublicHost = null; // "ip:port" reported by the host server, if any

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
      } catch {
        this.serverPublicHost = null;
      }
    } catch {
      throw new Error(serverUnreachableMessage());
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
        finish(reject, new Error('Timed out connecting to the server.'));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        this.connected = true;
        finish(resolve);
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev));
      ws.addEventListener('close', () => {
        this.connected = false;
        finish(reject, new Error('Could not reach the server (connection closed).'));
        this.onClose?.();
      });
      ws.addEventListener('error', () => {
        finish(reject, new Error('Could not reach the multiplayer server.'));
      });
    });
  }

  disconnect() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connected = false;
    this._connecting = null;
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
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ---- Commands -----------------------------------------------------------
  createLobby({ name, target, isPublic }) {
    this._send({ t: C2S.CREATE, name, target, isPublic });
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
  setReady(ready) {
    this._send({ t: C2S.READY, ready });
  }
  setConfig({ target, isPublic }) {
    this._send({ t: C2S.CONFIG, target, isPublic });
  }
  startMatch() {
    this._send({ t: C2S.START });
  }
  sendState(s) {
    this._send({ t: C2S.STATE, ...s });
  }
  sendShot(o, d) {
    this._send({ t: C2S.SHOOT, ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z });
  }
  sendChat(text) {
    this._send({ t: C2S.CHAT, text });
  }
}
