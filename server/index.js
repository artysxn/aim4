// ---------------------------------------------------------------------------
// index.js — AIM4 backend
//   REST  /api/configs     → settings share codes
//   WS    /ws              → multiplayer duels (128 tick)
//   GET   /*               → static client (when AIM4_SERVE_STATIC=1)
//
// Dev:  npm run server     (API + WS on 127.0.0.1, use Vite for the client)
// Host: npm run host        (serves dist/ + API + WS on 0.0.0.0 for LAN/online)
// ---------------------------------------------------------------------------

import http from 'http';
import { WebSocketServer } from 'ws';
import { saveConfig, getConfig } from './store.js';
import { isValidCodeFormat, normalizeCode } from './configCodes.js';
import { MultiplayerServer } from './lobby.js';
import { tryServeStatic, distExists } from './static.js';
import { printHostBanner, fetchPublicIp } from './network.js';

// PORT (no prefix) is the convention most PaaS inject (Fly.io, Render, etc.);
// AIM4_API_PORT still wins so existing local/host scripts are unaffected.
const PORT = Number(process.env.AIM4_API_PORT || process.env.PORT || 3784);
const HOST = process.env.AIM4_HOST || '127.0.0.1';
const SERVE_STATIC =
  process.env.AIM4_SERVE_STATIC === '1' || process.env.AIM4_SERVE_STATIC === 'true';
const MAX_BODY = 64 * 1024;

// Public host (e.g. "203.0.113.5:3784") shared with clients so the host can
// build an invite link that works for friends over the internet. Filled in
// asynchronously at startup when serving statically (host mode).
let publicHost = null;

// Basic, low-risk hardening applied to every HTTP response. Intentionally no
// CSP here — a strict policy can break Three.js / WebSocket without care.
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'POST' && url.pathname === '/api/configs') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        send(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const { code, created } = saveConfig(body.settings);
      send(res, 201, { code, created });
      return;
    }

    const match = url.pathname.match(/^\/api\/configs\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const code = normalizeCode(decodeURIComponent(match[1]));
      if (!isValidCodeFormat(code)) {
        send(res, 400, { error: 'Invalid code format' });
        return;
      }
      const settings = getConfig(code);
      if (!settings) {
        send(res, 404, { error: 'Code not found' });
        return;
      }
      send(res, 200, { code, settings });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/mp/status') {
      send(res, 200, {
        ok: true,
        ws: '/ws',
        publicHost,
        region: process.env.FLY_REGION || null
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true, region: process.env.FLY_REGION || null });
      return;
    }

    if (SERVE_STATIC && !url.pathname.startsWith('/api') && tryServeStatic(req, res, url)) {
      return;
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || 'Server error' });
  }
});

const mp = new MultiplayerServer();
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => mp.addConnection(ws));

if (SERVE_STATIC && !distExists()) {
  console.error('');
  console.error('ERROR: dist/ not found. Run "npm run build" first, or use start-host.bat');
  console.error('');
  process.exit(1);
}

server.listen(PORT, HOST, async () => {
  if (SERVE_STATIC) {
    // Resolve the public IP first so the banner and /api/mp/status agree.
    const ip = await fetchPublicIp();
    if (ip) publicHost = `${ip}:${PORT}`;
    await printHostBanner(PORT, ip);
  } else {
    console.log(`AIM4 config API on http://${HOST}:${PORT}`);
    console.log(`AIM4 multiplayer (128 tick) on ws://${HOST}:${PORT}/ws`);
    console.log('(Run "npm run host" or start-host.bat to serve the game for others.)');
  }
});
