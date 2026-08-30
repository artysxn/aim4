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
import { handleRecorderRequest } from './recorder/routes.js';
import { handleSampleDemoRequest } from './replays/sampleDemos.js';
import { handleTeamRequest } from './replays/teamRoutes.js';
import { handleAdminRequest } from './admin/routes.js';
import { handleSimRequest } from './sim/routes.js';
import { handleAccountRequest } from './account/routes.js';
import { handleSupportRequest } from './support/routes.js';
import { handlePitchRequest } from './pitchRoutes.js';
import { handleBillingRequest } from './billing/routes.js';
import { handleFaceitWebhookRequest } from './ingest/faceit/webhookRoutes.js';
import { handleCs3dRequest } from './cs3d/routes.js';
import { checkCaseSensitivity, sweepStaleUploads } from './replays/demoStore.js';
import { parseQueueBusy, resumeInterruptedParses, sweepBatchFiles } from './replays/jobs.js';
import { setParserBusyProbe } from './sim/jobs.js';
import { printHostBanner, fetchPublicIp } from './network.js';
import { seedAdmins } from './entitlements/service.js';
import { startGeoUpdater } from './account/geo.js';
import { backfillEffectiveEntitlements } from './entitlements/load.js';
import { startSweep } from './entitlements/sweep.js';
import { startVrsSync } from './replays/vrsSync.js';
import { warmCloakBrowserCache } from './ingest/hltv/cloakBrowser.js';
import { loadConfig as loadIngestConfig } from './ingest/hltv/config.js';
import { startSupervisor as startIngestSupervisor } from './ingest/hltv/service.js';
import { recordRequest } from './perf.js';

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

  // Timed on 'close' rather than 'finish': a client that disconnects mid-stream
  // still cost the server the work, and a route that only ever gets abandoned
  // is exactly the one worth seeing in the panel.
  const startedNs = process.hrtime.bigint();
  res.once('close', () => {
    recordRequest(
      req.method || 'GET',
      url.pathname,
      Number(process.hrtime.bigint() - startedNs) / 1e6,
      res.statusCode || 0
    );
  });

  try {
    // Replays own their transport: a .dem upload streams to disk and a tick
    // buffer comes back as binary, so this runs ahead of the JSON body reader
    // and its 64 KB cap. It must also run ahead of the generic OPTIONS reply
    // below, which allows neither Authorization nor the upload's own headers —
    // answering a replay preflight there makes the browser refuse the upload.
    if (url.pathname.startsWith('/api/sampledemos') && (await handleSampleDemoRequest(req, res, url))) {
      return;
    }

    if (url.pathname.startsWith('/api/replays') && (await handleReplayRequest(req, res, url))) {
      return;
    }

    // The desktop recorder's download and update feed. Ahead of the JSON body
    // reader for the same reason replays are: publishing a build streams an
    // executable through, and serving one sends binary back.
    if (url.pathname.startsWith('/api/recorder') && (await handleRecorderRequest(req, res, url))) {
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

    // Sim, for the same reason as admin, plus one of its own: the generic
    // OPTIONS reply below would confirm the prefix exists to any origin, and
    // this surface is meant to be invisible to everyone but one account.
    if (url.pathname.startsWith('/api/sim') && (await handleSimRequest(req, res, url))) {
      return;
    }

    // Billing runs before the JSON reader below: webhook signatures are
    // computed over the exact bytes a provider sent, so the raw body has to
    // survive, and MAX_BODY / JSON.parse would consume it.
    if (url.pathname.startsWith('/api/billing') && (await handleBillingRequest(req, res, url))) {
      return;
    }

    // Same raw-body reasoning as billing, plus one of its own: FACEIT retries
    // any non-2xx, so this must answer fast and must not sit behind the JSON
    // reader's 64 KB cap and parse.
    if (
      url.pathname.startsWith('/api/ingest/faceit') &&
      (await handleFaceitWebhookRequest(req, res, url))
    ) {
      return;
    }

    if (await handleAccountRequest(req, res, url)) {
      return;
    }

    // Tickets from /contact and the notification feed. Reads its own JSON
    // bodies like account does, so it runs ahead of the generic reader too.
    if (await handleSupportRequest(req, res, url)) {
      return;
    }

    // The pitch deck's live wording. Public, read-only, and cacheable, which is
    // none of the things the generic no-store JSON reply below is.
    if (await handlePitchRequest(req, res, url)) {
      return;
    }

    // 3D map packs: static, public, long-cached binaries with their own CORS.
    if (url.pathname.startsWith('/api/cs3d/') && (await handleCs3dRequest(req, res, url))) {
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
// Sim work yields to demo parsing (SIM-PLAN 9.2b). The probe is injected here
// rather than imported inside the sim runner so the two queues stay unaware of
// each other's internals, and so a test can drive it.
setParserBusyProbe(parseQueueBusy);
// Admins are a table, not an env list. AIM4_ADMIN_USER_IDS only bootstraps it,
// so a fresh project has someone who can reach the panel. Never awaited and
// never fatal: no admins configured is a normal state for a local run.
seedAdmins().catch(() => {});
// Profiles that predate entitlements still have empty effective_capabilities;
// RLS reads that column, so fill it once after boot.
backfillEffectiveEntitlements().then((r) => {
  if (r?.updated) console.log(`[entitlements] backfilled effective_* for ${r.updated} profiles`);
}).catch(() => {});
// Keeps the GeoIP country database at AIM4_GEOIP_DB downloaded and fresh, so
// sharing detection needs no host-side cron and survives redeploys. First
// check is deferred past the boot scramble; no-op when the env var is unset.
startGeoUpdater();
// Converts or expires trials, lapses ended subscriptions, sends the 48 hour
// warning, and tidies quota counters. Entitlement resolution is time-aware on
// its own, so a sweep that has not run is a reporting gap, not an access one.
startSweep();
// Valve regional standings: bundled snapshot at boot, then a daily GitHub
// scan copies a newer live/<year> table when one is published.
startVrsSync();
// Demo ingest starts Off on every API boot. Ledger/cursor keep progress so an
// admin turning On resumes the walk. While On, the supervisor restarts a
// crashed child with backoff; it does not auto-enable after a deploy.
startIngestSupervisor();
// Prefetch CloakBrowser into the state volume so Hard Restart / On does not
// race a 214 MB extract (spawn ETXTBSY) while Chromium is still being written.
//
// DEFERRED, not at boot. Every deploy cold-starts the container with empty
// listing and stats caches, so the first minute is already the most expensive
// of the process's life; unpacking 214 MB of Chromium in the middle of it was
// part of why a fresh deploy answered "API may be down". Ingest starts Off on
// every boot, so nothing needs this binary for at least as long as it takes
// an admin to reach the panel -- and Hard Restart / On still awaits its own
// warm, exactly as before. The delay only moves the prefetch out of the
// window where real requests are fighting for the box.
setTimeout(() => warmCloakBrowserCache(loadIngestConfig()).catch(() => {}), 90 * 1000);
// Load the aggregate-store SNAPSHOT shortly after boot — a load, never a
// build (see the essay below before touching this). With the file present the
// first Database visitor after a deploy is warm instead of eating the one
// remaining 503-and-fallback window; without one, this does nothing and the
// first visitor kicks the background build exactly as before.
setTimeout(async () => {
  try {
    const { listDemos, userDir } = await import('./replays/demoStore.js');
    const { SHARED_LIBRARY } = await import('./replays/auth.js');
    const { warmHotStoreFromSnapshot } = await import('./replays/statsHotService.js');
    const records = (await listDemos(SHARED_LIBRARY)).filter(
      (r) => (r.status || 'ready') === 'ready'
    );
    await warmHotStoreFromSnapshot({ userDir }, SHARED_LIBRARY, records);
  } catch (err) {
    console.warn('[stats] boot snapshot load skipped:', err?.message || err);
  }
}, 5 * 1000);
// Wire the aim rescan to the shared library. Wiring only: nothing starts here.
// It is begun either from the admin tools or by a reader opening Performance,
// and it never builds anything at boot for the reason set out immediately below.
setTimeout(async () => {
  try {
    const { listDemos, readRoundMeta, readRoundTicks, userDir } = await import(
      './replays/demoStore.js'
    );
    const { SHARED_LIBRARY } = await import('./replays/auth.js');
    const { getZones } = await import('./zonesStore.js');
    const { initAimScan, ensureAimScanLedger } = await import('./replays/aimScan.js');
    await initAimScan({
      io: { userDir, readRoundMeta, readRoundTicks, getZones },
      user: SHARED_LIBRARY,
      listRecords: () => listDemos(SHARED_LIBRARY)
    });
    // One small JSON file, so the first reader is answered from memory.
    await ensureAimScanLedger();
  } catch (err) {
    console.warn('[aim] rescan wiring skipped:', err?.message || err);
  }
}, 6 * 1000);
// NO boot-time warm of the aggregate store. There was one here; it made things
// worse, not better, and the way it failed is worth keeping written down.
//
// Building the store reads every stats index in the library. At ~4,900 demos
// that is hundreds of MB of JSON parsed against a 1 GB heap, so it does not
// finish in seconds — it grinds. getHotStore() dedupes concurrent builds by
// handing every caller the SAME in-flight promise, which is correct and is
// exactly what turned a slow build into a dead endpoint: the warm started at
// boot, and every /aggregate request after it waited on that one promise. The
// Database sat on "Loading database…" for as long as the build took, on every
// single deploy.
//
// The request path no longer waits on a build at all — it passes requireWarm,
// gets null while the store is cold, and answers 503 so the browser can take
// the paged path. That removes the hang but not the cost: the build is still
// CPU the box does not have to spare during the first minute of a deploy, and
// it would be competing with the paged fallback it just sent everyone to. So
// it stays visitor-triggered, starting after the boot scramble rather than in
// the middle of it. Warming is worth revisiting once the build itself is cheap
// (reading the columnar sidecars instead of whole indexes); until then it is a
// liability.

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
