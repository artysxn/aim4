// ---------------------------------------------------------------------------
// index.js — AIM4 backend
//   REST  /api/configs     → settings share codes
//   WS    /ws              → multiplayer duels (128 tick)
//   GET   /*               → static client (when AIM4_SERVE_STATIC=1)
//
// Dev:  npm run server     (API + WS on 127.0.0.1, use Vite for the client)
// Host: npm run host        (serves dist/ + API + WS on 0.0.0.0 for LAN/online)
// ---------------------------------------------------------------------------

// First, so every module below sees SUPABASE_* and friends from .env.
import './env.js';
import http from 'http';
import { WebSocketServer } from 'ws';
import { saveConfig, getConfig } from './store.js';
import { getBaselines, saveBaselines } from './baselinesStore.js';
import { isValidCodeFormat, normalizeCode } from './configCodes.js';
import { MultiplayerServer } from './lobby.js';
import { FootballServer } from './football.js';
import { tryServeStatic, distExists } from './static.js';
import { handleReplayRequest } from './replays/routes.js';
import { handleTeamRequest } from './replays/teamRoutes.js';
import { handleAdminRequest } from './admin/routes.js';
import { handleAccountRequest } from './account/routes.js';
import { handleBillingRequest } from './billing/routes.js';
import { checkCaseSensitivity, sweepStaleUploads } from './replays/demoStore.js';
import { resumeInterruptedParses, sweepBatchFiles } from './replays/jobs.js';
import { printHostBanner, fetchPublicIp } from './network.js';
import { seedAdmins } from './entitlements/service.js';
import { backfillEffectiveEntitlements } from './entitlements/load.js';
import { startSweep } from './entitlements/sweep.js';

// PORT (no prefix) is the convention most hosts inject; AIM4_API_PORT still
// wins so existing local/host scripts are unaffected.
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

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    // Replays own their transport: a .dem upload streams to disk and a tick
    // buffer comes back as binary, so this runs ahead of the JSON body reader
    // and its 64 KB cap. It must also run ahead of the generic OPTIONS reply
    // below, which allows neither Authorization nor the upload's own headers —
    // answering a replay preflight there makes the browser refuse the upload.
    if (url.pathname.startsWith('/api/replays') && (await handleReplayRequest(req, res, url))) {
      return;
    }

    // Same reasoning as replays: teams answer their own preflight, because the
    // generic OPTIONS reply below does not allow the Authorization header.
    if (url.pathname.startsWith('/api/teams') && (await handleTeamRequest(req, res, url))) {
      return;
    }

    // Admin owns its own CORS and cache headers: the generic send() below
    // answers with Access-Control-Allow-Origin: *, which is right for a public
    // demo library and wrong for an endpoint that can grant subscriptions.
    if (url.pathname.startsWith('/api/admin') && (await handleAdminRequest(req, res, url))) {
      return;
    }

    // Billing runs before the JSON reader below: webhook signatures are
    // computed over the exact bytes a provider sent, so the raw body has to
    // survive, and MAX_BODY / JSON.parse would consume it.
    if (url.pathname.startsWith('/api/billing') && (await handleBillingRequest(req, res, url))) {
      return;
    }

    if (await handleAccountRequest(req, res, url)) {
      return;
    }

    if (req.method === 'OPTIONS') {
      send(res, 204, {});
      return;
    }

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

    // Aim4 rating baselines — read by the game, written by /tools/editvalues.
    if (req.method === 'GET' && url.pathname === '/api/baselines') {
      send(res, 200, { baselines: getBaselines() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/baselines') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        send(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      try {
        const saved = saveBaselines(body.baselines ?? body);
        send(res, 200, { ok: true, baselines: saved });
      } catch (err) {
        send(res, 400, { error: err.message || 'Invalid baselines payload' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/mp/status') {
      send(res, 200, {
        ok: true,
        ws: '/ws',
        publicHost,
        region: process.env.AIM4_REGION || null,
        machineId: process.env.AIM4_INSTANCE_ID || null
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, {
        ok: true,
        region: process.env.AIM4_REGION || null,
        machineId: process.env.AIM4_INSTANCE_ID || null
      });
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
const football = new FootballServer();
const wss = new WebSocketServer({ noServer: true });
const footballWss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => mp.addConnection(ws));
footballWss.on('connection', (ws) => football.addConnection(ws));

// Route WS upgrades by path: /ws → duels, /football → the easter-egg pitch.
server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    /* fall through to destroy */
  }
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/football') {
    footballWss.handleUpgrade(req, socket, head, (ws) => footballWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

if (SERVE_STATIC && !distExists()) {
  console.error('');
  console.error('ERROR: dist/ not found. Run "npm run build" first, or use npm run host');
  console.error('');
  process.exit(1);
}

// A demo upload is hundreds of megabytes and can legitimately spend many
// minutes on the wire. Node's default 5 minute requestTimeout would destroy
// the socket mid-transfer, which a browser reports as a generic network error
// rather than as a timeout. headersTimeout stays short: only the body is slow.
server.requestTimeout = Number(process.env.AIM4_REQUEST_TIMEOUT_MS || 30 * 60 * 1000);
server.headersTimeout = 65_000;

// Round names are the replay database's keys and they are case-sensitive.
checkCaseSensitivity();

// An upload interrupted by a restart leaves a temp file with nothing tracking
// it. Best-effort, and never a reason to fail startup.
sweepStaleUploads().catch(() => {});
// The parse queue is in memory, so a demo left mid-parse by a restart has
// nothing working on it. Its .dem is still on the volume, so requeue rather
// than making someone re-upload hundreds of megabytes. Not awaited: several
// interrupted parses must not hold the port closed.
resumeInterruptedParses().catch(() => {});
sweepBatchFiles().catch(() => {});
// Admins are a table, not an env list. AIM4_ADMIN_USER_IDS only bootstraps it,
// so a fresh project has someone who can reach the panel. Never awaited and
// never fatal: no admins configured is a normal state for a local run.
seedAdmins().catch(() => {});
// Profiles that predate entitlements still have empty effective_capabilities;
// RLS reads that column, so fill it once after boot.
backfillEffectiveEntitlements().then((r) => {
  if (r?.updated) console.log(`[entitlements] backfilled effective_* for ${r.updated} profiles`);
}).catch(() => {});
// Converts or expires trials, lapses ended subscriptions, sends the 48 hour
// warning, and tidies quota counters. Entitlement resolution is time-aware on
// its own, so a sweep that has not run is a reporting gap, not an access one.
startSweep();

server.listen(PORT, HOST, async () => {
  if (SERVE_STATIC) {
    // Resolve the public IP first so the banner and /api/mp/status agree.
    const ip = await fetchPublicIp();
    if (ip) publicHost = `${ip}:${PORT}`;
    await printHostBanner(PORT, ip);
  } else {
    console.log(`AIM4 config API on http://${HOST}:${PORT}`);
    console.log(`AIM4 multiplayer (128 tick) on ws://${HOST}:${PORT}/ws`);
    console.log('(Run "npm run host" to serve the game for others.)');
  }
});
