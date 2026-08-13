// ---------------------------------------------------------------------------
// server/sim/routes.js
// /api/sim/* — the hidden simulation surface.
//
// Shaped like server/admin/routes.js on purpose, and for the same three
// reasons: no wildcard CORS (server/index.js answers everything else with
// Access-Control-Allow-Origin: *, which is wrong for a surface that encodes
// strategy ideas), no-store on every response, and a rate limit so an auth bug
// alone is not enough to reach it.
//
// Two differences from admin, both deliberate:
//
//   Every non-200 is 404 with the same body, including the OPTIONS preflight
//   for a caller we would refuse anyway. There is no status code here that
//   distinguishes "wrong path" from "not you".
//
//   Nothing is logged at info level. Sim payloads describe how a team plays,
//   so the log line itself would be the leak (2.3).
// ---------------------------------------------------------------------------

import { simGuard } from './guard.js';
import { listExportableDemos, packageDemo } from './export.js';
import { listMatches, readRoundMeta, readRoundTicks, runMatch, runStatus } from './matches.js';

const NOT_FOUND = { error: 'Not found' };

/** Origins allowed to call the sim API. Never `*`. */
function allowedOrigins() {
  const raw =
    process.env.AIM4_SIM_ORIGINS ||
    process.env.AIM4_ADMIN_ORIGINS ||
    'https://aim4.io,https://www.aim4.io,http://localhost:5173';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function corsHeaders(req) {
  const origin = String(req.headers?.origin || '');
  const headers = {
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
  if (origin && allowedOrigins().has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(res, req, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function notFound(res, req) {
  json(res, req, 404, NOT_FOUND);
  return true;
}

// ---------------------------------------------------------------------------
// Rate limiting. Fixed window, per IP before we know who anyone is and per
// account afterwards.
// ---------------------------------------------------------------------------

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.AIM4_SIM_RATE_LIMIT || 240);
const buckets = new Map();

function rateLimited(key, now = Date.now()) {
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_PER_WINDOW;
}

/** Test seam: the limiter is module state and tests need a clean one. */
export function _resetRateLimit() {
  buckets.clear();
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{whoami?: Function, isSiteAdmin?: Function}} [deps]
 * @returns {Promise<boolean>} true when this request was a sim route.
 */
export async function handleSimRequest(req, res, url, deps = {}) {
  if (!url.pathname.startsWith('/api/sim')) return false;

  const ip = req.socket?.remoteAddress || 'unknown';
  if (rateLimited(`ip:${ip}`)) {
    json(res, req, 429, { error: 'Too many requests.' });
    return true;
  }

  // The preflight is answered for everyone, because refusing it would tell a
  // cross-origin prober that the path exists. It carries no data.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return true;
  }

  const access = await simGuard(req, deps);
  if (!access.allowed) return notFound(res, req);

  if (rateLimited(`sim:${access.me.id}`)) {
    json(res, req, 429, { error: 'Too many requests.' });
    return true;
  }

  try {
    return await route(req, res, url, access.me);
  } catch (err) {
    // Message only, never the payload.
    console.error('[sim]', err?.message || err);
    json(res, req, 500, { error: 'Server error' });
    return true;
  }
}

const MAX_BODY = 64 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendBytes(res, req, bytes, filename, type = 'application/octet-stream') {
  res.writeHead(200, {
    ...corsHeaders(req),
    'Content-Type': type,
    'Content-Length': bytes.byteLength,
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.end(Buffer.from(bytes));
}

async function route(req, res, url, me) {
  const p = url.pathname;
  const q = url.searchParams;

  // The one endpoint P0 needs: the client renders nothing until this says 200.
  if (p === '/api/sim/me' && req.method === 'GET') {
    json(res, req, 200, { ok: true, id: me.id, username: me.username || null });
    return true;
  }

  // ---- dataset export (SIM-PLAN 9.2c: selection, never the corpus) ----------

  if (p === '/api/sim/export/list' && req.method === 'GET') {
    json(res, req, 200, { demos: await listExportableDemos() });
    return true;
  }

  if (p === '/api/sim/export/demo' && req.method === 'GET') {
    const pkg = await packageDemo(q.get('id'));
    if (!pkg) return notFound(res, req);
    sendBytes(res, req, pkg.bytes, pkg.filename);
    return true;
  }

  // ---- scripted matches ------------------------------------------------------

  if (p === '/api/sim/run' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      json(res, req, 400, { error: 'bad body' });
      return true;
    }
    const result = await runMatch(body);
    json(res, req, result.error ? 409 : 200, result);
    return true;
  }

  if (p === '/api/sim/run' && req.method === 'GET') {
    json(res, req, 200, runStatus());
    return true;
  }

  if (p === '/api/sim/matches' && req.method === 'GET') {
    json(res, req, 200, { matches: await listMatches() });
    return true;
  }

  // /api/sim/matches/<id>/round/<n>/{ticks,meta}
  const m = p.match(/^\/api\/sim\/matches\/([^/]+)\/round\/(\d+)\/(ticks|meta)$/);
  if (m && req.method === 'GET') {
    const [, id, round, kind] = m;
    if (kind === 'ticks') {
      const bytes = await readRoundTicks(id, round);
      if (!bytes) return notFound(res, req);
      sendBytes(res, req, bytes, `${id}-r${round}.ticks`);
      return true;
    }
    const meta = await readRoundMeta(id, round);
    if (!meta) return notFound(res, req);
    json(res, req, 200, meta);
    return true;
  }

  return notFound(res, req);
}
