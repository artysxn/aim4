// ---------------------------------------------------------------------------
// replays/praccImport.js
// PRACC demos into the library, fetched by this server rather than carried by
// the browser.
//
// The DEMOS tab on pracc.com/team/server lists a month of matches, and each row
// holds a link PRACC already signed for the signed-in team. Those links are
// plain S3 presigned GETs: SigV4 over the host header only, one hour long, no
// cookie and no client address in the signature. So the browser hands over the
// link and nothing else. No PRACC session ever reaches this box, and a 300 MB
// file does not have to fit through anybody's uplink.
//
// What arrives is someone's URL, which makes this the one place the server
// fetches from an address a client chose. Hence checkSourceUrl (host AND bucket,
// see DEFAULT_SOURCES), guardedLookup (the address the socket really connects
// to), and a re-check of every redirect hop.
//
// Two queues, because the two jobs run on different clocks. The links die after
// an hour and a Hetzner to Hetzner download takes seconds, while parsing takes
// minutes per demo and only so many fit on the box at once. Paced by the parser,
// a first click on a month of demos would still be working through its list when
// the links expired. So downloads run ahead and hold the compressed file on the
// volume, up to maxPendingBytes, and the ingest side feeds startIngest only as
// the parse queue empties. From startIngest on this is an ordinary upload: same
// gates, same unpack, same parse, same deletion of the archive and the .dem.
//
// Queue state lives in memory, like the parse queue it feeds. A restart loses
// the queue, sweepStaleUploads takes the leftover temp files, and the next click
// on the button re-sends whatever is not in the library yet.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import dns from 'node:dns';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { classifyUpload } from './archive.js';
import { ROOT, checkQuota, listDemos, readRecord } from './demoStore.js';
import { batchStatus, parseQueueDepth, releaseUploads, startIngest } from './jobs.js';
import { createLanes } from './parseLanes.js';
import { sniffMagic } from '../ingest/hltv/classify.js';
import { looksLikeChallenge } from '../ingest/hltv/fetcher.js';

/**
 * Where PRACC keeps its demos, read off real download links: "host/path prefix".
 *
 * The prefix is not decoration. fsn1.your-objectstorage.com is Hetzner's shared
 * endpoint with the bucket in the path, so the bare hostname would let this
 * route fetch out of every Hetzner customer's bucket. PRACC moved from R2 to
 * Hetzner during 2026 and may move again, which is what AIM4_PRACC_DEMO_SOURCES
 * is for; a refusal names the host it turned down so the fix is obvious.
 */
const DEFAULT_SOURCES = [
  'fsn1.your-objectstorage.com/pracc-demos/',
  '23919397ed7c4cdd2bf49a1aacd4db9a.r2.cloudflarestorage.com/scrim-demos/'
];

const MAX_PER_REQUEST = 100;
const MAX_ACTIVE_PER_UPLOADER = 200;
const MAX_REDIRECTS = 5;
/** Enough for the magic bytes, including a tar's marker at offset 257. */
const SNIFF_BYTES = 512;
/** Nothing on the wire for this long and the download is dead. */
const IDLE_MS = 60 * 1000;
const DOWNLOAD_DEADLINE_MS = 30 * 60 * 1000;
/** A batch that never settles must not hold its source as "in progress" for good. */
const WATCH_LIMIT_MS = 6 * 60 * 60 * 1000;
/** Finished requests stay readable for a client that polls late. */
const REQUEST_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * A scrim on a map the viewer does not cover fails the same way every time, and
 * finding that out costs a download and a bz2 unpack per click. Not forever, since
 * maps get added, and a week is long against a list that only spans a month.
 */
const UNSUPPORTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** "unknown" is the parser failing to read a map at all, which is not this. */
const UNSUPPORTED_MAP = /^Unsupported map "(?!unknown")/;

const maxBytes = () => Number(process.env.AIM4_PRACC_MAX_BYTES || 2 * 1024 ** 3);
const maxPendingBytes = () => Number(process.env.AIM4_PRACC_MAX_PENDING_BYTES || 20 * 1024 ** 3);

/** Why a demo did not make it, in a form the button can act on. */
export class PraccImportError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'PraccImportError';
    this.reason = reason;
  }
}

const refuse = (reason, message) => {
  throw new PraccImportError(reason, message);
};

// ---------------------------------------------------------------------------
// Which addresses this will fetch.
// ---------------------------------------------------------------------------

/** @returns {{host: string, prefix: string}[]} */
export function demoSources() {
  const extra = String(process.env.AIM4_PRACC_DEMO_SOURCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_SOURCES, ...extra].map((entry) => {
    const slash = entry.indexOf('/');
    return slash < 0
      ? { host: entry.toLowerCase(), prefix: '/' }
      : { host: entry.slice(0, slash).toLowerCase(), prefix: entry.slice(slash) };
  });
}

/**
 * Is this a link to a PRACC demo? Throws PraccImportError when it is not.
 * Runs on the first URL and on every redirect target, before any connection.
 *
 * @param {string|URL} raw
 * @returns {URL}
 */
export function checkSourceUrl(raw, sources = demoSources()) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    refuse('bad_url', 'That is not a valid link.');
  }
  if (url.protocol !== 'https:') refuse('bad_url', 'Demo links have to be https.');
  if (url.username || url.password) refuse('bad_url', 'Demo links cannot carry a login.');
  if (url.port && url.port !== '443') refuse('bad_url', 'Demo links cannot name a port.');
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    refuse('bad_url', 'Demo links cannot point at an IP address.');
  }
  // new URL() has already resolved plain and %2e dot segments. An encoded slash
  // survives it, and is the one way left to spell a path that leaves the prefix.
  if (/%2f|%5c|%00/i.test(url.pathname)) refuse('bad_url', 'That link has an encoded path in it.');
  const known = sources.some((s) => s.host === url.hostname && url.pathname.startsWith(s.prefix));
  if (!known) {
    // Host and first folder: that is what a new AIM4_PRACC_DEMO_SOURCES entry needs.
    const where = `${url.hostname}/${url.pathname.split('/')[1] || ''}`.replace(/\/$/, '');
    refuse('host_not_allowed', `aim4 does not fetch demos from ${where}.`);
  }
  return url;
}

const NOT_PUBLIC = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  NOT_PUBLIC.addSubnet(ip, bits, 'ipv4');
}
for (const [ip, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
]) {
  NOT_PUBLIC.addSubnet(ip, bits, 'ipv6');
}

/** Loopback, private, link-local (cloud metadata lives there), and the rest. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  return !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * dns.lookup, refusing a name that resolves anywhere but the public internet.
 *
 * Done as the socket's own lookup rather than as a check ahead of the request:
 * a check beforehand resolves the name once and the connection resolves it again,
 * and a name that answers differently the second time walks straight past it.
 */
export function guardedLookup(hostname, options, callback, resolve = dns.lookup) {
  resolve(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad || !addresses.length) {
      const refused = new Error(`${hostname} does not resolve to a public address.`);
      refused.code = 'EPRACCADDRESS';
      return callback(refused);
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function guardedRequest(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: guardedLookup,
        signal,
        // Only ever these. The link is its own credential, so there is nothing
        // of anybody's to forward and no reason to go looking for any.
        headers: { 'User-Agent': 'aim4-demo-import', Accept: '*/*', 'Accept-Encoding': 'identity' }
      },
      resolve
    );
    // The socket's idle timeout, so it covers a stalled body as well as a server
    // that never answers.
    req.setTimeout(IDLE_MS, () => req.destroy(new Error('No data from the demo host for a minute.')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// The download.
// ---------------------------------------------------------------------------

/** The first of the body, for naming a refusal. Never more than a small read. */
async function bodySample(res, limit = 4096) {
  let text = '';
  try {
    for await (const chunk of res) {
      text += chunk.toString('utf8');
      if (text.length >= limit) break;
    }
  } catch {
    /* the status code already says enough */
  }
  res.destroy();
  return text;
}

async function refusalFor(res) {
  const status = res.statusCode;
  const body = await bodySample(res);
  if (looksLikeChallenge(body)) {
    return new PraccImportError('blocked', 'The demo host answered with a bot check, so aim4 could not fetch this demo.');
  }
  if (status === 401 || status === 403) {
    return new PraccImportError('link_expired', 'PRACC\'s link was refused. It has probably expired.');
  }
  if (status === 404) return new PraccImportError('missing', 'PRACC no longer has this demo.');
  return new PraccImportError('source_unavailable', `The demo host answered HTTP ${status}.`);
}

function inspectHead(buf) {
  const magic = sniffMagic(buf);
  if (magic.kind === 'html') {
    throw looksLikeChallenge(buf.toString('utf8'))
      ? new PraccImportError('blocked', 'The demo host answered with a bot check, so aim4 could not fetch this demo.')
      : new PraccImportError('not_a_demo', 'The demo host answered with a web page instead of a file.');
  }
  if (magic.kind === 'unknown') throw new PraccImportError('not_a_demo', 'That file is not a demo or an archive.');
  return magic;
}

/**
 * Stream a checked link to `dest`, following redirects that also check out.
 * The file is judged by its first bytes and the cap holds while it streams, so a
 * wrong answer or an oversized one stops there. `dest` is gone after any failure.
 *
 * @returns {Promise<{bytes: number, magic: {kind: string, ext: string}, url: URL}>}
 */
export async function downloadSource(link, dest, { limit, onProgress, signal, sources } = {}) {
  let url = checkSourceUrl(link, sources);
  let res;
  for (let hop = 0; ; hop++) {
    try {
      res = await deps.request(url, { signal });
    } catch (err) {
      if (err?.code === 'EPRACCADDRESS') throw new PraccImportError('bad_url', err.message);
      throw new PraccImportError('source_unavailable', `Could not reach the demo host: ${err?.message || err}`);
    }
    const location = res.headers.location;
    if (!(res.statusCode >= 300 && res.statusCode < 400 && location)) break;
    res.resume();
    if (hop >= MAX_REDIRECTS) refuse('bad_url', 'Too many redirects from the demo host.');
    let next;
    try {
      next = new URL(location, url);
    } catch {
      refuse('bad_url', 'The demo host redirected to an invalid link.');
    }
    url = checkSourceUrl(next, sources);
  }
  if (res.statusCode !== 200) throw await refusalFor(res);

  const declared = Number(res.headers['content-length']) || 0;
  if (declared > limit) {
    res.destroy();
    refuse('too_large', `That demo is ${Math.ceil(declared / 1024 ** 2)} MB, over the limit of ${Math.floor(limit / 1024 ** 2)} MB.`);
  }

  let received = 0;
  let magic = null;
  let head = [];
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > limit) {
        cb(new PraccImportError('too_large', `That demo is over the limit of ${Math.floor(limit / 1024 ** 2)} MB.`));
        return;
      }
      try {
        if (!magic) {
          head.push(chunk);
          const sofar = Buffer.concat(head);
          if (sofar.length >= SNIFF_BYTES) {
            magic = inspectHead(sofar);
            head = null;
          }
        }
      } catch (err) {
        cb(err);
        return;
      }
      onProgress?.({ received, total: declared });
      cb(null, chunk);
    },
    flush(cb) {
      try {
        if (!magic) magic = inspectHead(Buffer.concat(head));
        if (declared && received !== declared) {
          refuse('source_unavailable', 'The download ended before the whole file arrived.');
        }
        cb();
      } catch (err) {
        cb(err);
      }
    }
  });

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  try {
    await pipeline(res, meter, out);
  } catch (err) {
    // Unlink after the stream has closed: deleting under a write still in flight
    // loses the race and the file comes back orphaned (see saveTempUpload).
    if (!out.closed) await once(out, 'close').catch(() => {});
    await fsp.rm(dest, { force: true }).catch(() => {});
    if (err instanceof PraccImportError) throw err;
    throw new PraccImportError('source_unavailable', `The download failed: ${err?.message || err}`);
  }
  return { bytes: received, magic, url };
}

// ---------------------------------------------------------------------------
// Naming and remembering.
// ---------------------------------------------------------------------------

function lastSegment(url) {
  const raw = path.posix.basename(url.pathname);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * What identifies this demo across clicks. Taken from the link, not from what
 * the client calls it: the signed path is what actually gets downloaded. PRACC
 * names the file after a long random id, the same for both teams in the scrim.
 */
export function sourceKey(url) {
  const base = lastSegment(url).replace(/\.(dem(\.\w+)?|\w+)$/i, '');
  if (/^[A-Za-z0-9_-]{12,}$/.test(base)) return base;
  return crypto.createHash('sha256').update(`${url.hostname}${url.pathname}`).digest('hex').slice(0, 32);
}

const SAME_KIND = { 'tar.gz': 'gz', 'tar.zst': 'zst' };

/**
 * The name startIngest classifies by. The bytes decide the type and the link
 * only supplies the stem, because a storage key says whatever it likes.
 */
export function importFilename(url, magic) {
  const base =
    lastSegment(url)
      .replace(/[^\w.-]/g, '_')
      .slice(-120) || 'pracc';
  const kind = classifyUpload(base);
  if (kind && (SAME_KIND[kind] || kind) === magic.kind) return base;
  return `${base}${magic.ext}`;
}

const ledgerFile = () => path.join(ROOT, '.pracc-imports.json');

async function loadLedger() {
  if (state.ledger) return state.ledger;
  try {
    state.ledger = JSON.parse(await fsp.readFile(ledgerFile(), 'utf8'));
  } catch {
    state.ledger = {};
  }
  return state.ledger;
}

let ledgerChain = Promise.resolve();
let ledgerSeq = 0;

/** Serialized, for the reason gdrive/queue.js gives: two renames of one tmp lose. */
function saveLedger() {
  const doc = state.ledger;
  ledgerChain = ledgerChain
    .then(async () => {
      const tmp = `${ledgerFile()}.tmp-${ledgerSeq++}`;
      await fsp.mkdir(ROOT, { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(doc));
      await fsp.rename(tmp, ledgerFile());
    })
    .catch((err) => console.warn('[pracc] ledger write failed:', err?.message || err));
  return ledgerChain;
}

/**
 * Is this demo in the library already? Remembered imports are checked against
 * the records, so a demo somebody has since deleted can come back. The file name
 * catches a copy that was unpacked with 7-Zip and uploaded by hand, which is how
 * these reached the library before this route existed. A copy under any other
 * name is left to the identity check that runs after the parse.
 */
async function knownCopy(user, key, records) {
  const ledger = await loadLedger();
  const hit = ledger[key];
  if (hit?.demoIds?.length) {
    for (const id of hit.demoIds) {
      const record = await deps.readRecord(user, id).catch(() => null);
      if (record && record.status !== 'error') return id;
    }
    delete ledger[key];
    await saveLedger();
  }
  const list = records || (await deps.listDemos(user));
  const want = `${key}.dem`.toLowerCase();
  const named = list.find(
    (r) => String(r.filename || '').toLowerCase() === want && r.status !== 'error'
  );
  return named ? named.id : null;
}

// ---------------------------------------------------------------------------
// The queues.
// ---------------------------------------------------------------------------

const defaultDeps = {
  request: guardedRequest,
  startIngest,
  batchStatus,
  parseQueueDepth,
  releaseUploads,
  checkQuota,
  listDemos,
  readRecord,
  pollMs: 1000
};
let deps = { ...defaultDeps };

function freshState() {
  return {
    /** Items waiting to download, one lane per uploader. */
    downloads: createLanes(),
    /** Items on disk, waiting for the parse queue to have room. */
    ready: [],
    /** sourceKey -> the item working on it, from queued until it settles. */
    active: new Map(),
    /** request id -> what one click asked for. */
    requests: new Map(),
    pendingBytes: 0,
    downloading: false,
    ingesting: false,
    ledger: null
  };
}
let state = freshState();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(['done', 'duplicate', 'failed', 'refused']);

function settle(item, patch) {
  Object.assign(item, patch);
  item.url = null;
  item.gate = null;
  item.finishedAt = Date.now();
  if (state.active.get(item.key) === item) state.active.delete(item.key);
  if (item.state === 'failed') {
    console.warn(`[pracc] ${item.key}: ${item.reason} (${item.error})`);
  }
}

function failItem(item, err) {
  settle(item, {
    state: 'failed',
    reason: err?.reason || 'failed',
    error: err?.message || String(err)
  });
}

function giveBack(item) {
  deps.releaseUploads(item.owner?.uploaderId, item.reserved || 0);
  item.reserved = 0;
  item.releaseQuota?.();
  item.releaseQuota = null;
}

async function downloadItem(item) {
  while (state.pendingBytes >= maxPendingBytes()) await sleep(deps.pollMs);

  // Something earlier in the queue may have landed this very demo by now.
  const existing = await knownCopy(item.user, item.key).catch(() => null);
  if (existing) {
    settle(item, { state: 'duplicate', demoIds: [existing] });
    return;
  }

  const gated = await item.gate();
  if (gated.refusal) {
    settle(item, {
      state: 'failed',
      reason: gated.refusal.body?.reason || 'limit',
      // A plan refusal keeps its words in `message`; `error` is its machine code.
      error: gated.refusal.body?.message || gated.refusal.body?.error || 'aim4 would not take this demo.'
    });
    return;
  }
  item.reserved = gated.reserved;
  item.releaseQuota = gated.gate?.release || null;

  const tmp = path.join(ROOT, `.pracc-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    item.state = 'downloading';
    const limit = Math.min(
      maxBytes(),
      gated.gate.allowed,
      Math.max(0, gated.gate.usage.bytesLeft - state.pendingBytes)
    );
    const abort = AbortSignal.timeout(DOWNLOAD_DEADLINE_MS);
    const got = await downloadSource(item.url, tmp, {
      limit,
      signal: abort,
      onProgress: ({ received, total }) => {
        item.received = received;
        item.total = total;
      }
    });
    item.url = null;
    item.tmp = tmp;
    item.sizeBytes = got.bytes;
    item.received = got.bytes;
    item.total = got.bytes;
    item.filename = importFilename(got.url, got.magic);
    item.state = 'waiting';
    state.pendingBytes += got.bytes;
    state.ready.push(item);
    void pumpIngest();
  } catch (err) {
    giveBack(item);
    await fsp.rm(tmp, { force: true }).catch(() => {});
    failItem(item, err);
  }
}

async function pumpDownloads() {
  if (state.downloading) return;
  state.downloading = true;
  const run = state;
  try {
    for (;;) {
      const item = run.downloads.next();
      if (!item) return;
      try {
        await downloadItem(item);
      } catch (err) {
        console.error('[pracc] download step failed:', err);
        failItem(item, err);
      }
    }
  } finally {
    run.downloading = false;
  }
}

async function ingestItem(item) {
  // At the moment of ingest rather than from the download: that may be an hour
  // old by now. Other held archives are on the volume without being in usage.
  const quota = await deps.checkQuota(item.user, 0);
  const batch = deps.startIngest({
    user: item.user,
    filename: item.filename,
    source: item.tmp,
    sizeBytes: item.sizeBytes,
    allowedBytes: Math.max(0, quota.usage.bytesLeft - state.pendingBytes),
    owner: item.owner,
    reserved: item.reserved,
    releaseQuota: item.releaseQuota
  });
  // startIngest owns the source and both reservations from here.
  item.tmp = null;
  item.reserved = 0;
  item.releaseQuota = null;
  state.pendingBytes -= item.sizeBytes;
  item.batch = batch;
  item.state = 'unpacking';

  // Until the unpack is over its parse is not queued, and the depth check in
  // pumpIngest would wave the next one through on top of it.
  while (batch.stage === 'unpacking') await sleep(deps.pollMs);
  item.state = 'parsing';
  void watchBatch(item, batch);
}

async function pumpIngest() {
  if (state.ingesting) return;
  state.ingesting = true;
  const run = state;
  try {
    while (run.ready.length) {
      while (deps.parseQueueDepth() > 0) await sleep(deps.pollMs);
      const item = run.ready.shift();
      try {
        await ingestItem(item);
      } catch (err) {
        console.error('[pracc] ingest step failed:', err);
        giveBack(item);
        if (item.tmp) {
          await fsp.rm(item.tmp, { force: true }).catch(() => {});
          run.pendingBytes -= item.sizeBytes;
        }
        failItem(item, err);
      }
    }
  } finally {
    run.ingesting = false;
  }
}

/** Batches finish on their own; this waits to write down how it went. */
async function watchBatch(item, batch) {
  const since = Date.now();
  while (!batch.finishedAt) {
    if (Date.now() - since > WATCH_LIMIT_MS) {
      failItem(item, new PraccImportError('stalled', 'Parsing did not finish.'));
      return;
    }
    await sleep(deps.pollMs);
  }
  const status = deps.batchStatus(batch);
  const files = status?.files || [];
  const stored = files.filter((f) => !f.failed).map((f) => f.demoId);
  const copies = files.filter((f) => f.failed && f.duplicate);
  const ledger = await loadLedger();

  if (stored.length) {
    ledger[item.key] = { demoIds: stored, at: Date.now() };
    await saveLedger();
    settle(item, { state: 'done', demoIds: stored });
  } else if (copies.length && copies.length === files.length) {
    const ids = copies.map((f) => f.duplicateOf).filter(Boolean);
    ledger[item.key] = { demoIds: ids, at: Date.now() };
    await saveLedger();
    settle(item, { state: 'duplicate', demoIds: ids });
  } else {
    const error = status?.error || files.find((f) => f.error)?.error || 'Parsing failed.';
    const unsupported = UNSUPPORTED_MAP.test(error);
    if (unsupported) {
      ledger[item.key] = { unsupported: error, at: Date.now() };
      await saveLedger();
    }
    failItem(item, new PraccImportError(unsupported ? 'unsupported_map' : 'parse_failed', error));
  }
  console.log(`[pracc] ${item.filename}: ${item.state}`);
}

// ---------------------------------------------------------------------------
// The surface routes.js calls.
// ---------------------------------------------------------------------------

function itemView(entry) {
  const { item, uid, label } = entry;
  const out = { uid, label, state: item.state };
  if (item.reason) out.reason = item.reason;
  if (item.error) out.error = item.error;
  if (item.demoIds?.length) out.demoIds = item.demoIds;
  if (item.state === 'downloading') {
    out.received = item.received || 0;
    out.total = item.total || 0;
  }
  if (item.batch && !TERMINAL.has(item.state)) {
    const file = deps.batchStatus(item.batch)?.files?.[0];
    if (file) {
      out.round = file.round || 0;
      out.rounds = file.total || 0;
    }
  }
  return out;
}

function requestView(request) {
  const demos = request.entries.map(itemView);
  return {
    id: request.id,
    done: demos.every((d) => TERMINAL.has(d.state)),
    demos
  };
}

/** One poll's worth of status. Holds no link, so the id is all it takes to read it. */
export function praccRequestStatus(id) {
  const request = state.requests.get(String(id || ''));
  return request ? requestView(request) : null;
}

function sweepRequests() {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [id, request] of state.requests) {
    if (request.createdAt > cutoff) continue;
    if (request.entries.every(({ item }) => TERMINAL.has(item.state))) state.requests.delete(id);
  }
}

const cleanLabel = (raw) =>
  String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 120);

/**
 * Take one click's worth of demos.
 *
 * Bad entries are refused one by one rather than failing the whole request, the
 * same way a stored package id skips one file and not the rest of a drop. A
 * request where nothing could be taken answers 400.
 *
 * @param {object} opts
 * @param {string} opts.user      the library
 * @param {Array<{uid?: string, url: string, label?: string}>} opts.demos
 * @param {object} opts.owner     uploaderId, uploaderName, visibility, account
 * @param {() => Promise<object>} opts.gate  gateUpload with reserve:true, per demo
 * @returns {Promise<{status: number, body: object}>}
 */
export async function queuePraccImports({ user, demos, owner, gate }) {
  if (!Array.isArray(demos) || !demos.length) {
    return { status: 400, body: { error: 'That request has no demos in it.' } };
  }
  if (demos.length > MAX_PER_REQUEST) {
    return { status: 400, body: { error: `One request can carry up to ${MAX_PER_REQUEST} demos.` } };
  }
  sweepRequests();

  const records = await deps.listDemos(user);
  let activeForUploader = 0;
  for (const item of state.active.values()) {
    if (item.owner?.uploaderId === owner.uploaderId) activeForUploader++;
  }

  const entries = [];
  let queued = 0;
  for (const demo of demos) {
    const uid = String(demo?.uid || '').slice(0, 80);
    const label = cleanLabel(demo?.label);
    let url;
    try {
      url = checkSourceUrl(demo?.url);
    } catch (err) {
      entries.push({
        uid,
        label,
        item: { state: 'refused', reason: err.reason || 'bad_url', error: err.message }
      });
      continue;
    }
    const key = sourceKey(url);

    // Clicking twice, or a teammate clicking in the same minute, joins the work
    // that is already going rather than fetching the file a second time.
    const running = state.active.get(key);
    if (running) {
      entries.push({ uid, label, item: running });
      continue;
    }
    const existing = await knownCopy(user, key, records);
    if (existing) {
      entries.push({ uid, label, item: { state: 'duplicate', demoIds: [existing] } });
      continue;
    }
    const noted = (await loadLedger())[key];
    if (noted?.unsupported && Date.now() - noted.at < UNSUPPORTED_TTL_MS) {
      entries.push({
        uid,
        label,
        item: { state: 'failed', reason: 'unsupported_map', error: noted.unsupported }
      });
      continue;
    }
    if (activeForUploader >= MAX_ACTIVE_PER_UPLOADER) {
      entries.push({
        uid,
        label,
        item: { state: 'refused', reason: 'busy', error: 'Too many demos are waiting already. Try again when these finish.' }
      });
      continue;
    }
    activeForUploader++;

    const item = {
      key,
      user,
      owner,
      gate,
      url: url.href,
      state: 'queued',
      received: 0,
      total: 0,
      createdAt: Date.now()
    };
    state.active.set(key, item);
    state.downloads.push(owner.uploaderId, item);
    entries.push({ uid, label, item });
    queued++;
  }

  const request = { id: crypto.randomBytes(16).toString('hex'), createdAt: Date.now(), entries };
  state.requests.set(request.id, request);
  if (queued) {
    console.log(`[pracc] ${owner.uploaderName || owner.uploaderId} queued ${queued} of ${demos.length} demos`);
    void pumpDownloads();
  }

  const view = requestView(request);
  const allRefused = entries.every(({ item }) => item.state === 'refused');
  return {
    status: allRefused ? 400 : view.done ? 200 : 202,
    body: {
      request: view,
      ...(allRefused ? { error: entries[0].item.error } : {})
    }
  };
}

/** Only for tests: swap the outside world, and start from an empty queue. */
export function _setPraccDeps(over = {}) {
  deps = { ...defaultDeps, ...over };
  state = freshState();
}
