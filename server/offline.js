// ---------------------------------------------------------------------------
// server/offline.js
// The desktop app's server keeps working when the online aim4 cannot be reached.
//
// With AIM4_UPSTREAM set, this server passes requests on to the online aim4
// (server/upstream.js). This file is what happens when it can't:
//
//   - Online or not. A request that cannot reach the upstream marks it down, and
//     a light check (the public update feed) runs every PROBE_MS until it
//     answers again. While down, every route is answered here.
//   - The last login. Each /api/me the upstream answers for a signed-in account
//     is kept on disk. While down, a request whose token names that account
//     (its `sub`, read without the network) is that account: same name, plan
//     and limits, with `offline` set so the page can say so. The token's own
//     expiry is not held against it, since refreshing one needs the network.
//     This server listens on 127.0.0.1 only: it is one person's PC.
//   - Demos. While down, the library is what is on this PC. A demo uploaded
//     meanwhile is kept twice: parsed into the local library at once, and its
//     raw upload queued. When the upstream answers again, the queue is sent
//     there with the account's next token, oldest first, so the demos added
//     while offline end up in the cloud. Nothing else on disk is sent.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OFFLINE_DIR = path.resolve(process.env.AIM4_OFFLINE_DIR || path.join(HERE, 'data', 'offline'));
const SESSION_FILE = path.join(OFFLINE_DIR, 'session.json');
const QUEUE_DIR = path.join(OFFLINE_DIR, 'queue');
const LOG_FILE = path.join(OFFLINE_DIR, 'synced.json');

/** How often an unreachable upstream is tried again. */
const PROBE_MS = Number(process.env.AIM4_OFFLINE_PROBE_MS || 10_000);
/** A connection to the upstream that takes longer than this counts as down. */
export const CONNECT_TIMEOUT_MS = Number(process.env.AIM4_UPSTREAM_TIMEOUT_MS || 6_000);
/** Sends of one queued demo before it is set aside as failed. */
const MAX_ATTEMPTS = 3;

const upstream = () => String(process.env.AIM4_UPSTREAM || '').trim().replace(/\/$/, '');

// ---- online or not --------------------------------------------------------------

let online = true;
let since = 0;
let probe = null;

export const isOnline = () => online || !upstream();

/** An error that means the upstream is not there (as opposed to answering with an error). */
export function isNetworkError(err) {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|socket hang up|timed out/i.test(`${err?.code || ''} ${err?.message || ''}`);
}

export function markOffline(reason = '') {
  if (!upstream()) return;
  if (online) {
    online = false;
    since = Date.now();
    log(`offline: ${reason}`);
  }
  if (!probe) {
    probe = setInterval(() => void check(), PROBE_MS);
    probe.unref?.();
  }
}

export function markOnline() {
  if (online) return;
  online = true;
  log(`online again after ${Math.round((Date.now() - since) / 1000)} s`);
  if (probe) clearInterval(probe);
  probe = null;
  void syncQueue();
}

/** One GET to the upstream, resolved with its status, or rejected when it cannot be reached. */
function ping(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, `${upstream()}/`);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, { headers, timeout: CONNECT_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c.length < 1e6 ? c : ''));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function check() {
  try {
    await ping('/api/recorder/latest');
    markOnline();
  } catch {
    /* still down */
  }
}

// ---- the last login ---------------------------------------------------------------

/** The newest token any request carried, per account (memory only). */
const tokens = new Map();

/** The `sub` of a JWT, read without verifying it (that needs the network). */
export function subOf(token) {
  try {
    const part = String(token || '').split('.')[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.sub === 'string' ? json.sub : '';
  } catch {
    return '';
  }
}

export const bearerOf = (req) => /^Bearer\s+(.+)$/i.exec(String(req?.headers?.authorization || '').trim())?.[1]?.trim() || '';

/** Remember the token a request carried, so a reconnect can send the queue with it. */
export function noteToken(req) {
  const token = bearerOf(req);
  const sub = subOf(token);
  if (sub) tokens.set(sub, token);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Keep the upstream's /api/me answer for a signed-in account. */
export function rememberMe(me) {
  const id = me?.account?.signedIn && me.account.id;
  if (!id) return;
  writeJson(SESSION_FILE, { id: String(id), savedAt: new Date().toISOString(), me });
}

/** The kept /api/me, or null. */
export function rememberedMe() {
  const s = readJson(SESSION_FILE, null);
  return s?.id && s.me ? s : null;
}

/** The request's caller as this server's routes expect one (identity.js whoami), from an /api/me answer. */
export function userFromMe(me) {
  const a = me?.account || {};
  if (!a.signedIn || !a.id) return null;
  return Object.freeze({
    id: String(a.id),
    username: String(a.username || ''),
    signedIn: true,
    admin: Boolean(a.admin),
    email: String(a.email || ''),
    provider: String(a.provider || ''),
    providers: [a.linked?.google && 'google', a.linked?.discord && 'discord', a.linked?.x && 'x'].filter(Boolean),
    createdAt: String(a.createdAt || ''),
    steamId: String(a.linked?.steamId || ''),
    uploadAnchored: Boolean(a.linked?.google || a.linked?.steam),
    entitlements: me.entitlements,
    impersonating: null
  });
}

/**
 * The caller while offline: the remembered account when the request's token
 * names it, else nobody.
 */
export function offlineUser(req) {
  const kept = rememberedMe();
  if (!kept) return null;
  const sub = subOf(bearerOf(req));
  return sub && sub === kept.id ? userFromMe(kept.me) : null;
}

/** /api/me while offline: the remembered answer, marked. */
export function offlineMe(req) {
  const kept = rememberedMe();
  const sub = subOf(bearerOf(req));
  if (!kept || !sub || sub !== kept.id) return null;
  return { ...kept.me, offline: { since: new Date(since || Date.now()).toISOString(), savedAt: kept.savedAt, pending: queued().length } };
}

// ---- demos added while offline ---------------------------------------------------------

/** Queued uploads, oldest first. */
export function queued() {
  if (!fs.existsSync(QUEUE_DIR)) return [];
  return fs
    .readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(QUEUE_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
}

/**
 * Keep an offline upload's raw body, and hand back a request that reads it, for
 * the local upload route to parse into the library as usual.
 */
export async function queueUpload(req, user) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(QUEUE_DIR, `${id}.bin`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
  const size = fs.statSync(file).size;
  const item = {
    id,
    file: path.basename(file),
    user: user.id,
    filename: String(req.headers['x-aim4-filename'] || 'match.dem'),
    visibility: String(req.headers['x-aim4-visibility'] || 'private'),
    contentType: String(req.headers['content-type'] || 'application/octet-stream'),
    sizeBytes: size,
    addedAt: new Date().toISOString(),
    attempts: 0,
    error: ''
  };
  writeJson(path.join(QUEUE_DIR, `${id}.json`), item);
  log(`queued ${item.filename} (${size} bytes) for ${user.id}`);
  const copy = fs.createReadStream(file);
  return Object.assign(copy, {
    headers: { ...req.headers, 'content-length': String(size) },
    method: req.method,
    url: req.url,
    socket: req.socket,
    connection: req.socket
  });
}

let syncing = false;

/** Send one queued upload to the upstream. Resolves with its HTTP status. */
function send(item, token) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/replays/demos', `${upstream()}/`);
    const client = target.protocol === 'https:' ? https : http;
    const body = path.join(QUEUE_DIR, item.file);
    const req = client.request(
      target,
      {
        method: 'POST',
        timeout: CONNECT_TIMEOUT_MS * 5,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': item.contentType,
          'Content-Length': String(fs.statSync(body).size),
          'X-Aim4-Filename': item.filename,
          'X-Aim4-Visibility': item.visibility,
          origin: new URL(upstream()).origin
        }
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    fs.createReadStream(body).pipe(req);
  });
}

/**
 * Send the queue to the upstream, oldest first, each with its account's newest
 * token. Stops at the first sign the upstream is gone or the token is stale;
 * the next token or reconnect starts it again.
 */
export async function syncQueue() {
  if (syncing || !upstream() || !online) return;
  syncing = true;
  try {
    for (const item of queued()) {
      if (item.error && item.attempts >= MAX_ATTEMPTS) continue;
      const token = tokens.get(item.user);
      if (!token) continue;
      let answer;
      try {
        answer = await send(item, token);
      } catch (err) {
        if (isNetworkError(err)) {
          markOffline(err.message);
          return;
        }
        answer = { status: 0, text: err.message };
      }
      // A stale token: wait for the page's next one.
      if (answer.status === 401) return;
      const meta = path.join(QUEUE_DIR, `${item.id}.json`);
      if (answer.status >= 200 && answer.status < 300) {
        await rm(path.join(QUEUE_DIR, item.file), { force: true });
        await rm(meta, { force: true });
        const done = readJson(LOG_FILE, []);
        done.push({ ...item, syncedAt: new Date().toISOString(), answer: answer.text.slice(0, 300) });
        writeJson(LOG_FILE, done.slice(-200));
        log(`sent ${item.filename} to ${upstream()}`);
      } else {
        let error = answer.text;
        try {
          error = JSON.parse(answer.text).error || error;
        } catch {
          /* plain text */
        }
        writeJson(meta, { ...item, attempts: item.attempts + 1, error: `${answer.status}: ${String(error).slice(0, 300)}` });
        log(`could not send ${item.filename}: ${answer.status} ${String(error).slice(0, 200)}`);
      }
    }
  } finally {
    syncing = false;
  }
}

/** GET /api/offline/status: for the page's banner. */
export function offlineStatus(req) {
  const sub = subOf(bearerOf(req));
  const mine = queued().filter((q) => !sub || q.user === sub);
  return {
    upstream: upstream(),
    online: isOnline(),
    since: online ? null : new Date(since).toISOString(),
    signedInAs: !online ? rememberedMe()?.me?.account?.username || null : null,
    pending: mine.filter((q) => !(q.error && q.attempts >= MAX_ATTEMPTS)).map((q) => ({ filename: q.filename, addedAt: q.addedAt, error: q.error || '' })),
    failed: mine.filter((q) => q.error && q.attempts >= MAX_ATTEMPTS).map((q) => ({ filename: q.filename, error: q.error })),
    sent: readJson(LOG_FILE, []).filter((q) => !sub || q.user === sub).slice(-10).map((q) => ({ filename: q.filename, syncedAt: q.syncedAt }))
  };
}

function log(line) {
  try {
    fs.mkdirSync(OFFLINE_DIR, { recursive: true });
    fs.appendFileSync(path.join(OFFLINE_DIR, 'offline.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging is best-effort */
  }
}
