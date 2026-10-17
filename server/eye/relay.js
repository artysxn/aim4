// ---------------------------------------------------------------------------
// server/eye/relay.js
// The meeting point between a user's aim4 eye (the desktop app, where the
// model runs) and wherever they are chatting from (the site in a browser, or
// the same site inside the desktop window).
//
// The app dials OUT to aim4.io and keeps one WebSocket open, so nothing on the
// user's machine has to accept a connection: no ports, no firewall, no
// browser rules about websites reaching into the local network. A chat request
// arrives here over HTTP, goes down that socket to the app, and the app's
// streamed answer comes back up it and out to the page as server-sent events.
//
// The server only carries text. It never runs the model and never looks inside
// a conversation beyond checking it is the shape a chat request has.
//
// App -> server
//   { type: 'hello', version, platform, hardware }        once, after connecting
//   { type: 'status', state, model, progress, message }   whenever it changes
//   { type: 'chunk', id, data }                            one streamed delta
//   { type: 'done', id }                                   the answer is complete
//   { type: 'error', id, message }                         the answer failed
//
// Server -> app
//   { type: 'chat', id, body }       an OpenAI-style chat completion request
//   { type: 'cancel', id }           the page went away; stop generating
//   { type: 'command', command, args }  e.g. use-model, unload
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { deviceForToken, touchDevice } from './eyeStore.js';

/** A chat request's own fields; anything else in the body is dropped. */
const CHAT_FIELDS = ['messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'max_tokens', 'stop', 'chat_template_kwargs'];
export const MAX_CHAT_BYTES = 768 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 25_000;
/** An answer that has said nothing for this long is treated as lost. */
const IDLE_TIMEOUT_MS = 5 * 60_000;
const STATES = new Set(['starting', 'idle', 'downloading', 'loading', 'ready', 'busy', 'error']);
const COMMANDS = new Set(['use-model', 'unload', 'cancel-download']);

const tokenOf = (req, url) => {
  const auth = String(req.headers?.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return url?.searchParams?.get('token') || '';
};

export class EyeRelay {
  constructor() {
    /** userId -> Map(deviceId -> agent) */
    this.agents = new Map();
    /** request id -> { agent, onChunk, onDone, onError, timer } */
    this.pending = new Map();
  }

  /**
   * Authenticate an app's upgrade request and keep the socket.
   * @param {import('ws').WebSocketServer} wss
   */
  async handleUpgrade(wss, req, socket, head) {
    let url = null;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      /* no token then */
    }
    const device = await deviceForToken(tokenOf(req, url)).catch(() => null);
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, device));
  }

  /** Keep one connected app. A second connection from the same device replaces the first. */
  attach(ws, device) {
    const userId = device.userId;
    if (!this.agents.has(userId)) this.agents.set(userId, new Map());
    const mine = this.agents.get(userId);
    mine.get(device.id)?.ws.close(4000, 'replaced');
    const agent = {
      ws,
      device: { id: device.id, name: device.name },
      userId,
      connectedAt: Date.now(),
      hello: null,
      state: { state: 'starting', model: '', progress: null, message: '' },
      alive: true
    };
    mine.set(device.id, agent);
    void touchDevice(device.id).catch(() => {});

    ws.on('pong', () => {
      agent.alive = true;
    });
    const beat = setInterval(() => {
      if (!agent.alive) {
        ws.terminate();
        return;
      }
      agent.alive = false;
      try {
        ws.ping();
      } catch {
        /* closing anyway */
      }
    }, HEARTBEAT_MS);

    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > MAX_MESSAGE_BYTES) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      this.onAgentMessage(agent, msg);
    });
    ws.on('close', () => {
      clearInterval(beat);
      if (mine.get(device.id) === agent) mine.delete(device.id);
      if (!mine.size) this.agents.delete(userId);
      for (const [id, p] of this.pending) {
        if (p.agent === agent) this.finish(id, 'error', 'aim4 eye disconnected.');
      }
    });
  }

  onAgentMessage(agent, msg) {
    switch (msg?.type) {
      case 'hello':
        agent.hello = {
          version: String(msg.version || '').slice(0, 32),
          platform: String(msg.platform || '').slice(0, 32),
          hardware: msg.hardware && typeof msg.hardware === 'object' ? JSON.parse(JSON.stringify(msg.hardware)) : null
        };
        return;
      case 'status':
        agent.state = {
          state: STATES.has(msg.state) ? msg.state : 'idle',
          model: String(msg.model || '').slice(0, 80),
          progress: Number.isFinite(msg.progress) ? Math.max(0, Math.min(1, msg.progress)) : null,
          message: String(msg.message || '').slice(0, 300)
        };
        return;
      case 'chunk': {
        const p = this.pending.get(msg.id);
        if (!p || p.agent !== agent) return;
        this.bump(msg.id);
        p.onChunk(msg.data);
        return;
      }
      case 'done':
        if (this.pending.get(msg.id)?.agent === agent) this.finish(msg.id, 'done');
        return;
      case 'error':
        if (this.pending.get(msg.id)?.agent === agent) this.finish(msg.id, 'error', String(msg.message || 'aim4 eye failed.'));
        return;
      default:
    }
  }

  /** What a page shows: is aim4 eye running for this account, and doing what. */
  status(userId) {
    const devices = [...(this.agents.get(String(userId))?.values() || [])].map((a) => ({
      id: a.device.id,
      name: a.device.name,
      connectedAt: a.connectedAt,
      version: a.hello?.version || '',
      platform: a.hello?.platform || '',
      hardware: a.hello?.hardware || null,
      ...a.state
    }));
    return { online: devices.length > 0, ready: devices.some((d) => d.state === 'ready'), devices };
  }

  /** The app to send work to: a ready one, the newest first. */
  pickAgent(userId, deviceId = '') {
    const list = [...(this.agents.get(String(userId))?.values() || [])];
    if (deviceId) return list.find((a) => a.device.id === deviceId) || null;
    const ready = list.filter((a) => a.state.state === 'ready');
    const pool = ready.length ? ready : list;
    return pool.sort((a, b) => b.connectedAt - a.connectedAt)[0] || null;
  }

  /**
   * Send one chat request to the user's app.
   * @returns {{ id: string, cancel: () => void } | null}  null when no app is connected
   */
  startChat(userId, body, { onChunk, onDone, onError }, deviceId = '') {
    const agent = this.pickAgent(userId, deviceId);
    if (!agent) return null;
    const id = crypto.randomBytes(8).toString('hex');
    const clean = {};
    for (const k of CHAT_FIELDS) if (body?.[k] !== undefined) clean[k] = body[k];
    clean.stream = true;
    this.pending.set(id, { agent, onChunk, onDone, onError, timer: null });
    this.bump(id);
    agent.ws.send(JSON.stringify({ type: 'chat', id, body: clean }));
    return {
      id,
      cancel: () => {
        if (!this.pending.has(id)) return;
        try {
          agent.ws.send(JSON.stringify({ type: 'cancel', id }));
        } catch {
          /* gone already */
        }
        this.finish(id, 'cancelled');
      }
    };
  }

  /** Pass a control command (download a model, unload it) to the user's app. */
  command(userId, command, args = {}, deviceId = '') {
    if (!COMMANDS.has(command)) return false;
    const agent = this.pickAgent(userId, deviceId);
    if (!agent) return false;
    agent.ws.send(JSON.stringify({ type: 'command', command, args: JSON.parse(JSON.stringify(args || {})) }));
    return true;
  }

  /** Drop a device's live connection (it was revoked). */
  disconnect(userId, deviceId) {
    this.agents.get(String(userId))?.get(deviceId)?.ws.close(4001, 'revoked');
  }

  bump(id) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.finish(id, 'error', 'aim4 eye stopped answering.'), IDLE_TIMEOUT_MS);
  }

  finish(id, how, message = '') {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (how === 'done') p.onDone();
    else if (how === 'error') p.onError(message);
  }
}

export const eyeRelay = new EyeRelay();
