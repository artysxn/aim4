// ---------------------------------------------------------------------------
// server/support/routes.js
// /api/support/* (tickets, from the /contact page) and /api/notifications.
//
// Ticket creation is public on purpose: "I cannot sign in" is the most
// important ticket there is, and requiring an account to say so would file it
// under silence. Everything else needs a session; the admin half lives in
// server/admin/routes.js with the rest of the admin surface.
// ---------------------------------------------------------------------------

import { whoami } from '../replays/identity.js';
import {
  createTicket,
  listNotificationsFor,
  listTicketsFor,
  markNotificationsRead,
  replyToTicket
} from './store.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

/** Anonymous tickets per IP per hour. Enough for a real person, not a hose. */
const MAX_TICKETS_PER_WINDOW = 5;
const WINDOW_MS = 60 * 60 * 1000;
const recent = new Map();

function throttled(ip) {
  const nowMs = Date.now();
  const list = (recent.get(ip) || []).filter((t) => nowMs - t < WINDOW_MS);
  recent.set(ip, list);
  if (recent.size > 5000) {
    for (const [k, v] of recent) {
      if (!v.some((t) => nowMs - t < WINDOW_MS)) recent.delete(k);
    }
  }
  return list.length >= MAX_TICKETS_PER_WINDOW;
}

function record(ip) {
  const list = recent.get(ip) || [];
  list.push(Date.now());
  recent.set(ip, list);
}

export function resetSupportThrottle() {
  recent.clear();
}

function clientIp(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.socket?.remoteAddress || '';
}

/**
 * @returns {Promise<boolean>} true when this request was a support route.
 */
export async function handleSupportRequest(req, res, url) {
  const p = url.pathname;
  const owned = p.startsWith('/api/support') || p.startsWith('/api/notifications');
  if (!owned) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  const me = await whoami(req);

  try {
    // ---- tickets ------------------------------------------------------------
    if (req.method === 'POST' && p === '/api/support/tickets') {
      const ip = clientIp(req);
      if (throttled(`ip:${ip}`)) {
        json(res, 429, { error: 'Too many tickets from this address. Try again later.' });
        return true;
      }
      const body = await readJson(req);
      const result = await createTicket({
        subject: body.subject,
        body: body.body,
        email: me.signedIn ? '' : body.email,
        userId: me.signedIn ? me.id : '',
        username: me.signedIn ? me.username : ''
      });
      if (result.error) {
        json(res, 400, { error: result.error });
        return true;
      }
      record(`ip:${ip}`);
      json(res, 201, { ticket: result.ticket });
      return true;
    }

    if (req.method === 'GET' && p === '/api/support/tickets') {
      if (!me.signedIn) {
        json(res, 200, { tickets: [] });
        return true;
      }
      json(res, 200, { tickets: await listTicketsFor(me.id) });
      return true;
    }

    const reply = p.match(/^\/api\/support\/tickets\/([A-Za-z0-9_-]+)\/reply$/);
    if (req.method === 'POST' && reply) {
      if (!me.signedIn) {
        json(res, 401, { error: 'Sign in first.' });
        return true;
      }
      const body = await readJson(req);
      const result = await replyToTicket(reply[1], {
        text: body.text,
        asAdmin: false,
        by: me.username,
        userId: me.id
      });
      if (result.error) {
        json(res, 400, { error: result.error });
        return true;
      }
      json(res, 200, { ticket: result.ticket });
      return true;
    }

    // ---- notifications ------------------------------------------------------
    if (req.method === 'GET' && p === '/api/notifications') {
      json(res, 200, { notifications: await listNotificationsFor(me) });
      return true;
    }

    if (req.method === 'POST' && p === '/api/notifications/read') {
      if (!me.signedIn) {
        json(res, 401, { error: 'Sign in first.' });
        return true;
      }
      const body = await readJson(req);
      json(res, 200, await markNotificationsRead(me, body.ids));
      return true;
    }

    json(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    json(res, 400, { error: err.message || 'Bad request' });
    return true;
  }
}
