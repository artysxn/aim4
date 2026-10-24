// ---------------------------------------------------------------------------
// server/similar/routes.js
// /api/similar: the Similar Rounds scan, answered by the desktop app's own
// server only.
//
// AIM4_DESKTOP=1 is set by the two servers the app starts (run-pack.js, and
// run-account.js for a checkout). Anywhere else, aim4.io included, the route
// says the feature lives in the desktop app, so a browser never runs a scan
// on the site's server.
//
//   GET  /api/similar/status   { available, threads, cache }
//   POST /api/similar/scan     NDJSON, one event a line (see scan.js):
//                              phase / start / progress / done, or error
// ---------------------------------------------------------------------------

import { cacheStats, runScan, threadCount } from './scan.js';

export function similarEnabled() {
  return process.env.AIM4_DESKTOP === '1';
}

const FILE_RE = /^[A-Za-z0-9_~-]+$/;
const TEAM_RE = /^[A-Za-z0-9]{3}$/;
const MODES = new Set(['round', 'drawing', 'both']);
const MAX_STROKES = 24;
const MAX_POINTS = 400;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Send JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** The request, checked and reduced to what the scan reads. */
export function parseAsk(body) {
  const file = String(body?.file || '');
  if (!FILE_RE.test(file)) throw Object.assign(new Error('Name the round to compare.'), { status: 400 });
  const tick = Number(body?.tick);
  if (!Number.isFinite(tick)) throw Object.assign(new Error('Send the moment as a tick.'), { status: 400 });
  const strokes = [];
  for (const s of Array.isArray(body?.strokes) ? body.strokes.slice(0, MAX_STROKES) : []) {
    const pts = [];
    for (const p of Array.isArray(s?.pts) ? s.pts.slice(0, MAX_POINTS) : []) {
      const x = Number(p?.[0]);
      const y = Number(p?.[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    }
    if (pts.length) strokes.push({ side: s?.side === 'T' || s?.side === 'CT' ? s.side : '', pts });
  }
  const team = String(body?.team || '');
  return {
    file,
    tick,
    side: body?.side === 'CT' ? 'CT' : 'T',
    both: body?.both === true,
    mode: MODES.has(body?.mode) ? body.mode : 'round',
    strokes,
    team: TEAM_RE.test(team) ? team : ''
  };
}

/** This server, as the scan reaches it: the address the request came in on. */
function selfBase(req) {
  let addr = String(req.socket?.localAddress || '127.0.0.1');
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::' || addr === '0.0.0.0') addr = '127.0.0.1';
  const host = addr.includes(':') ? `[${addr}]` : addr;
  return `http://${host}:${req.socket?.localPort || 80}`;
}

/** The caller's own sign-in (and an admin's "view as"), passed through. */
function forwardHeaders(req) {
  const out = {};
  for (const k of ['authorization', 'x-aim4-impersonate']) {
    if (req.headers[k]) out[k] = String(req.headers[k]);
  }
  return out;
}

export async function handleSimilarRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/similar/')) return false;
  if (!similarEnabled()) {
    json(res, 404, { error: 'Similar Rounds runs in the aim4 desktop app. Update the app to use it.' });
    return true;
  }

  if (req.method === 'GET' && p === '/api/similar/status') {
    json(res, 200, { available: true, threads: threadCount(), cache: cacheStats() });
    return true;
  }

  if (req.method === 'POST' && p === '/api/similar/scan') {
    let ask;
    try {
      ask = parseAsk(await readBody(req));
    } catch (err) {
      json(res, err.status || 400, { error: err.message });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    });
    const controller = new AbortController();
    // The window closed the request (Stop, or the viewer went away).
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const emit = (event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      await runScan({
        api: { base: selfBase(req), headers: forwardHeaders(req) },
        ask,
        emit,
        signal: controller.signal
      });
    } catch (err) {
      if (!controller.signal.aborted) emit({ type: 'error', error: err?.message || 'The scan failed.' });
    }
    if (!res.writableEnded) res.end();
    return true;
  }

  json(res, 404, { error: 'Not found.' });
  return true;
}
