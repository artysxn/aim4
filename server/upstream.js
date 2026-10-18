// ---------------------------------------------------------------------------
// server/upstream.js
// Data from the online aim4 instead of this machine's.
//
// With AIM4_UPSTREAM set (https://aim4.io), this server keeps serving the
// client it was built with and passes every /api request on to that server,
// untouched: the demo library, the stats, the database, documents, accounts.
// The browser's own Authorization header goes with it, and the online server
// checks it against the same Supabase project, so the person signed in here is
// the same person there, with the same plan and the same data.
//
// What stays on this machine is what only this machine can do: aim4 eye (the
// relay to the model on this PC), the 3D asset packs read from disk, and the
// desktop app's update feed, so a local build is never replaced by the
// published one.
//
// Bytes are piped both ways as they come, so uploads, tick buffers and
// streamed answers pass through without being held in memory.
//
// With AIM4_UPSTREAM_SITE=1 (the desktop app's own server) the pages come from
// the online aim4 too, so the window always shows the current site; this
// server's own build is what it shows when the online aim4 is out of reach.
// When it is out of reach, nothing goes there (server/offline.js decides), and
// a read that fails to connect is answered here instead.
// ---------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { CONNECT_TIMEOUT_MS, isNetworkError, isOnline, markOffline, noteToken, rememberMe, syncQueue } from './offline.js';

export const UPSTREAM = String(process.env.AIM4_UPSTREAM || '').trim().replace(/\/$/, '');

/** Routes that are answered here even with an upstream set. */
const LOCAL_ONLY = ['/api/eye/', '/api/cs3d/', '/api/recorder', '/api/offline/'];
/** The pages as well as the data (the desktop app's own server). */
const SITE_UPSTREAM = process.env.AIM4_UPSTREAM_SITE === '1';

/** Request headers that describe this hop, not the request. */
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'origin', 'referer']);

/** True when this request should be answered by the online server. */
export function goesUpstream(pathname) {
  if (!UPSTREAM || !isOnline()) return false;
  if (!pathname.startsWith('/api/')) return SITE_UPSTREAM;
  return !LOCAL_ONLY.some((p) => pathname.startsWith(p));
}

/** What proxyUpstream resolves with when it could not connect and the request can be answered here. */
export const ANSWER_HERE = 'answer-here';

/**
 * Pass one request to the online server and its answer back. Resolves with
 * ANSWER_HERE when the online server could not be reached and the request has
 * no body (a page, a read), so the caller answers it from this machine.
 */
export function proxyUpstream(req, res, url) {
  noteToken(req);
  const target = new URL(url.pathname + url.search, `${UPSTREAM}/`);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k)) headers[k] = v;
  headers.host = target.host;
  // The online server sees this as a call from its own site.
  headers.origin = new URL(UPSTREAM).origin;
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    /** A socket to the upstream is open (only the connection is timed: a slow answer is not offline). */
    let connected = false;
    const up = client.request(target, { method: req.method, headers }, (answer) => {
      connected = true;
      res.writeHead(answer.statusCode || 502, answer.headers);
      // Each signed-in /api/me is the login this PC falls back to offline.
      if (url.pathname === '/api/me' && req.method === 'GET' && answer.statusCode === 200) {
        const chunks = [];
        answer.on('data', (c) => chunks.push(c));
        answer.on('end', () => {
          try {
            const raw = Buffer.concat(chunks);
            const enc = String(answer.headers['content-encoding'] || '');
            const body = enc.includes('br') ? zlib.brotliDecompressSync(raw) : enc.includes('gzip') ? zlib.gunzipSync(raw) : enc.includes('deflate') ? zlib.inflateSync(raw) : raw;
            rememberMe(JSON.parse(body.toString('utf8')));
          } catch {
            /* not JSON (an error page): nothing to keep */
          }
        });
      }
      answer.pipe(res);
      answer.on('end', () => {
        // A signed-in request that got through: demos added while offline can go now.
        if (headers.authorization) void syncQueue();
        resolve();
      });
      answer.on('error', resolve);
    });
    const timer = setTimeout(() => {
      if (!connected) up.destroy(new Error('timed out'));
    }, CONNECT_TIMEOUT_MS);
    up.on('socket', (socket) => {
      const open = () => {
        connected = true;
        clearTimeout(timer);
      };
      // A kept-alive socket is open already; a new one says so when it is (after TLS, for https).
      if (!socket.connecting && !socket.pending) open();
      else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', open);
    });
    up.on('close', () => clearTimeout(timer));
    up.on('error', (err) => {
      if (!connected && isNetworkError(err)) {
        markOffline(err.code || err.message);
        if (!res.headersSent && (req.method === 'GET' || req.method === 'HEAD')) return resolve(ANSWER_HERE);
      }
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `The online aim4 (${UPSTREAM}) could not be reached: ${err.message}. You are offline now; try again to use the demos on this PC.` }));
      resolve();
    });
    req.pipe(up);
  });
}
