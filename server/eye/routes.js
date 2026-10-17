// ---------------------------------------------------------------------------
// server/eye/routes.js — /api/eye/*
//
//   POST   /api/eye/link            link the desktop app this page runs in
//   GET    /api/eye/devices         this account's linked apps, online or not
//   DELETE /api/eye/devices/:id     unlink one (its live connection drops)
//   GET    /api/eye/status          is aim4 eye running for me, and doing what
//   POST   /api/eye/chat            one chat completion, streamed back (SSE)
//   POST   /api/eye/command         tell my app to download/load/unload a model
//
// And the app's own socket, upgraded in server/index.js:
//   GET    /eye/agent               Authorization: Bearer <device token>
//
// Everything here is signed-in only, and an account only ever reaches its
// own apps: the relay is keyed by account.
// ---------------------------------------------------------------------------

import { whoami } from '../replays/identity.js';
import { linkDevice, listDevices, revokeDevice } from './eyeStore.js';
import { MAX_CHAT_BYTES, eyeRelay } from './relay.js';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('Request body too large.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON body.');
    err.status = 400;
    throw err;
  }
}

/**
 * @param {import('./relay.js').EyeRelay} [relay]  injectable for tests
 * @returns {Promise<boolean>} true when the request was an eye route
 */
export async function handleEyeRequest(req, res, url, relay = eyeRelay) {
  const p = url.pathname;
  if (!p.startsWith('/api/eye/')) return false;
  try {
    const me = await whoami(req);
    if (!me.signedIn) {
      json(res, 401, { error: 'Sign in to use aim4 eye.' });
      return true;
    }
    // A "view as" session must not drive someone else's computer.
    if (me.impersonating) {
      json(res, 403, { error: 'Not while viewing as another user.' });
      return true;
    }

    if (req.method === 'POST' && p === '/api/eye/link') {
      const body = await readJson(req, 4096);
      const { device, token } = await linkDevice(me.id, body.name);
      json(res, 200, { device, token });
      return true;
    }

    if (req.method === 'GET' && p === '/api/eye/devices') {
      const live = new Map(relay.status(me.id).devices.map((d) => [d.id, d]));
      const devices = (await listDevices(me.id)).map((d) => ({ ...d, online: live.has(d.id), live: live.get(d.id) || null }));
      json(res, 200, { devices });
      return true;
    }

    const del = p.match(/^\/api\/eye\/devices\/([a-f0-9]{12})$/);
    if (req.method === 'DELETE' && del) {
      const removed = await revokeDevice(me.id, del[1]);
      if (removed) relay.disconnect(me.id, del[1]);
      json(res, removed ? 200 : 404, { removed });
      return true;
    }

    if (req.method === 'GET' && p === '/api/eye/status') {
      json(res, 200, relay.status(me.id));
      return true;
    }

    if (req.method === 'POST' && p === '/api/eye/command') {
      const body = await readJson(req, 4096);
      const sent = relay.command(me.id, String(body.command || ''), body.args || {}, String(body.deviceId || ''));
      json(res, sent ? 200 : 409, sent ? { sent: true } : { error: 'aim4 eye is not running, or that is not a command it knows.' });
      return true;
    }

    if (req.method === 'POST' && p === '/api/eye/chat') {
      const body = await readJson(req, MAX_CHAT_BYTES);
      if (!Array.isArray(body.messages) || !body.messages.length) {
        json(res, 400, { error: 'A chat needs messages.' });
        return true;
      }
      streamChat(req, res, me.id, body, relay);
      return true;
    }

    json(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    json(res, err.status || 500, { error: err.message || 'Server error' });
    return true;
  }
}

/** The app's answer, out to the page as server-sent events, OpenAI style. */
function streamChat(req, res, userId, body, relay) {
  let open = true;
  const write = (text) => {
    if (open) res.write(text);
  };
  const end = () => {
    if (!open) return;
    open = false;
    res.end();
  };
  const chat = relay.startChat(
    userId,
    body,
    {
      onChunk: (data) => write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`),
      onDone: () => {
        write('data: [DONE]\n\n');
        end();
      },
      onError: (message) => {
        write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        end();
      }
    },
    String(body.deviceId || '')
  );
  if (!chat) {
    json(res, 409, { error: 'aim4 eye is not running. Open the aim4 desktop app on your computer.' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Proxies must not hold the stream back until it is complete.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  // The page closing the request is the only "stop" a reader can give.
  res.on('close', () => {
    if (open) {
      open = false;
      chat.cancel();
    }
  });
}
