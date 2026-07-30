// ---------------------------------------------------------------------------
// replays/demoStore.js
// On-disk library for uploaded demos and the rounds parsed out of them.
//
//   server/data/replays/<user>/demos/<demoId>.dem       the upload, deleted after parse
//   server/data/replays/<user>/demos/<demoId>.json      demo record + round list
//   server/data/replays/<user>/rounds/<name>.json.zst   round meta + events
//   server/data/replays/<user>/rounds/<name>.tickz      tick buffer, compressed
//   server/data/replays/<user>/rounds/<name>.c100.bin   stride-100 coarse pass
//
// The last three are the compact form. Their plain ancestors (<name>.json and
// <name>.bin) are still read when present, so a library that has not been
// through scripts/compact-replays.mjs keeps working unchanged. Everything above
// readRoundTicks / readRoundMeta sees the same data either way: the codec stops
// here and the viewer receives byte-identical tickFormat buffers.
//
// <name> is the round id, optionally suffixed "~<demoId>" when two demos
// produce the same round name. Filtering never opens a round file: the
// collector reads the rounds directory and matches on names alone.
//
// REQUIRES A CASE-SENSITIVE FILESYSTEM. Round ids use upper case, lower case
// and digits, so "HBq" and "hbQ" are two different rounds. On ext4/xfs they
// are two different files, which is correct. On Windows or default macOS they
// collide and one round silently overwrites the other. checkCaseSensitivity()
// below turns that into a startup warning rather than quiet data loss.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { collectRounds, sortRounds } from '../../src/replays/shared/roundFilter.js';
import { readHeader, sliceStride } from '../../src/replays/shared/tickFormat.js';
import { encodePacked } from '../../src/replays/shared/tickPacked.js';
import { TICKZ_EXT, decodeTickz, decodeTickzStride, encodeTickz } from './tickCodec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.AIM4_REPLAY_DIR || path.join(__dirname, '..', 'data', 'replays');

/** Shared library storage cap for the whole server (all visitors share one pool). */
export const MAX_BYTES = Number(process.env.AIM4_REPLAY_MAX_BYTES || 20 * 1024 ** 3); // 20 GB

/**
 * Largest single upload, archive or bare demo. An archive may hold as many
 * demos as it likes within this.
 *
 * Separate from MAX_BYTES on purpose. The library cap answers "is there room to
 * keep this", which the quota check already does. This answers "is one request
 * allowed to be this big", which is a different question: the archive lands on
 * disk whole before anything is extracted, so peak disk is the archive plus
 * everything that comes out of it, and a single request that large also has to
 * stay inside AIM4_REQUEST_TIMEOUT_MS to arrive at all.
 */
export const MAX_UPLOAD_BYTES = Number(
  process.env.AIM4_MAX_UPLOAD_BYTES || 5 * 1024 ** 3
); // 5 GB

/**
 * Sanitize a library folder name under ROOT. The public library uses a fixed
 * key from auth.js (default "local"); this just keeps paths safe.
 */
export function userKey(raw) {
  const s = String(raw || '').trim();
  const safe = s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return safe || 'local';
}

export const userDir = (user) => path.join(ROOT, userKey(user));
const demosDir = (user) => path.join(userDir(user), 'demos');
const roundsDir = (user) => path.join(userDir(user), 'rounds');
export const uploadsDir = (user) => path.join(userDir(user), 'uploads');

/**
 * Every library folder under ROOT.
 *
 * Normally one (the shared library from auth.js), but AIM4_REPLAY_LIBRARY can
 * point at a former per-account folder, and the boot-time parse resume has to
 * cover whatever is actually on the volume rather than assume.
 */
export async function listLibraryUsers() {
  try {
    const entries = await fsp.readdir(ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name !== 'zones').map((e) => e.name);
  } catch {
    return [];
  }
}

/** True when the uploaded .dem is still on disk, i.e. a parse can be retried. */
export async function hasSourceFile(user, id) {
  try {
    await fsp.access(demoPath(user, sanitizeId(id)));
    return true;
  } catch {
    return false;
  }
}

export function newDemoId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Probe whether the storage volume distinguishes case, and warn if it does
 * not. Round names are the database key and they are case-sensitive, so a
 * case-folding volume merges distinct rounds into one file. That failure is
 * invisible at write time and only shows up as missing rounds much later,
 * which is exactly the kind of thing worth a loud line at startup.
 *
 * @returns {boolean} true when the filesystem is case-sensitive
 */
export function checkCaseSensitivity(dir = ROOT) {
  const probe = path.join(dir, '.CaseProbe');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '');
    const folded = fs.existsSync(path.join(dir, '.caseprobe'));
    fs.rmSync(probe, { force: true });
    if (folded) {
      console.warn(
        '[replays] WARNING: the replay directory is on a case-insensitive ' +
          'filesystem. Round ids differ by case ("HBq" and "hbQ" are different ' +
          'rounds), so rounds will silently overwrite each other. Use a ' +
          'case-sensitive volume (ext4/xfs) for AIM4_REPLAY_DIR.'
      );
    }
    return !folded;
  } catch {
    // Never let a diagnostic stop the server from booting.
    return true;
  }
}

/**
 * Delete upload temp files left behind by a restart.
 *
 * An upload in flight when the process dies leaves its .tmp on the volume with
 * nothing tracking it, and at 5 GB a couple of those are a meaningful chunk of
 * the disk. Anything still around from before this process started cannot
 * belong to it, so age is a safe test.
 *
 * @returns {Promise<number>} bytes reclaimed
 */
export async function sweepStaleUploads(maxAgeMs = 60 * 60 * 1000) {
  let freed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const f of await listFiles(ROOT)) {
    if (!/^\.(upload|import)-[a-f0-9]+\.tmp$/.test(f)) continue;
    const p = path.join(ROOT, f);
    try {
      const st = await fsp.stat(p);
      if (st.mtimeMs > cutoff) continue;
      await fsp.rm(p, { force: true });
      freed += st.size;
    } catch {
      /* raced with something else; nothing to do */
    }
  }
  if (freed) {
    const mb = freed / 1024 ** 2;
    console.warn(
      `[replays] removed abandoned upload temp files, freed ${mb >= 1 ? `${mb.toFixed(0)} MB` : `${freed} bytes`}`
    );
  }
  return freed;
}

async function ensureDirs(user) {
  await fsp.mkdir(demosDir(user), { recursive: true });
  await fsp.mkdir(roundsDir(user), { recursive: true });
}

/**
 * Create the library folders before something writes into them directly.
 *
 * Ingest streams extracted demos to demoFilePath() before any record exists,
 * so it cannot rely on writeRecord having made the directory first.
 */
export const ensureLibraryDirs = ensureDirs;

async function listFiles(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ---- round file naming ------------------------------------------------------

/** Round meta, compact form first. Reads try these in order. */
const META_EXTS = ['.json.zst', '.json'];
/** Suffix for the precomputed coarse pass. */
const COARSE_EXT = '.c100.bin';
/**
 * The stride the timeline's first pass asks for (COARSE_STRIDE in
 * src/replays/tickStore.js). Precomputing exactly this one is what keeps the
 * coarse pass cheap once the full buffer is compressed.
 */
const COARSE_STRIDE = 100;

async function readIfPresent(file) {
  try {
    return await fsp.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const asArrayBuffer = (buf) =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

async function dirBytes(dir) {
  let total = 0;
  for (const f of await listFiles(dir)) {
    try {
      total += (await fsp.stat(path.join(dir, f))).size;
    } catch {
      /* raced with a delete */
    }
  }
  return total;
}

// ---- Demo records -----------------------------------------------------------

const demoPath = (user, id) => path.join(demosDir(user), `${sanitizeId(id)}.dem`);
const recordPath = (user, id) => path.join(demosDir(user), `${sanitizeId(id)}.json`);

function sanitizeId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) throw new Error('Invalid id');
  return s;
}

export async function readRecord(user, id) {
  try {
    return JSON.parse(await fsp.readFile(recordPath(user, id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeRecord(user, record) {
  await ensureDirs(user);
  await fsp.writeFile(recordPath(user, record.id), JSON.stringify(record, null, 2));
  return record;
}

/**
 * Update display names for both teams on a demo and its round JSON files.
 * Short ids (and therefore round filenames) stay the same.
 */
export async function renameDemoTeams(user, id, team1Name, team2Name) {
  const demoId = sanitizeId(id);
  const record = await readRecord(user, demoId);
  if (!record) return null;

  const n1 = String(team1Name || '').trim().slice(0, 48) || record.team1?.name || 'Team 1';
  const n2 = String(team2Name || '').trim().slice(0, 48) || record.team2?.name || 'Team 2';
  record.team1 = { ...(record.team1 || {}), name: n1, id: record.team1?.id };
  record.team2 = { ...(record.team2 || {}), name: n2, id: record.team2?.id };

  for (const r of record.rounds || []) {
    if (!r?.file) continue;
    try {
      const meta = await readRoundMeta(user, r.file);
      if (!meta) continue;
      if (meta.team1) meta.team1 = { ...meta.team1, name: n1 };
      if (meta.team2) meta.team2 = { ...meta.team2, name: n2 };
      await writeRoundMeta(user, sanitizeStem(r.file), meta);
    } catch {
      /* round file missing or unreadable; skip */
    }
  }

  await writeRecord(user, record);
  return record;
}

/**
 * Persist a fully materialized demo (manifest + round files) without
 * re-deriving round ids. Used by server ingest and by import of local packages.
 *
 * @param {string} user
 * @param {object} record
 * @param {Map<string, Uint8Array>|Iterable<[string, Uint8Array]>} files
 */
export async function writeMaterialized(user, record, files) {
  await ensureDirs(user);
  const demoId = sanitizeId(record.id);
  for (const [name, data] of files) {
    const n = String(name).replace(/\\/g, '/');
    if (n === 'manifest.json') continue;
    if (!n.startsWith('rounds/') || n.includes('..')) {
      throw new Error(`Unexpected package entry: ${name}`);
    }
    const base = path.basename(n);
    if (!base.endsWith(`~${demoId}.json`) && !base.endsWith(`~${demoId}.bin`)) {
      throw new Error(`Round file does not match demo id: ${base}`);
    }
    // Packages carry the plain v1 pair, which is the format the local parse
    // tool writes. Store them the same way a server-side parse would, so an
    // imported demo is not the one thing in the library still uncompressed.
    const stem = base.split('.')[0];
    const buf = Buffer.from(data);
    if (base.endsWith('.json')) {
      await writeRoundMeta(user, stem, JSON.parse(buf.toString('utf8')));
    } else {
      await writeRoundTicks(user, stem, buf);
    }
  }
  await writeRecord(user, { ...record, id: demoId });
  return record;
}

export async function listDemos(user) {
  const files = await listFiles(demosDir(user));
  const records = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(await fsp.readFile(path.join(demosDir(user), f), 'utf8')));
    } catch {
      /* skip a corrupt record rather than fail the whole listing */
    }
  }
  return records.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
}

export async function usage(user) {
  const [demoBytes, roundBytes, records] = await Promise.all([
    dirBytes(demosDir(user)),
    dirBytes(roundsDir(user)),
    listDemos(user)
  ]);
  const bytes = demoBytes + roundBytes;
  return {
    demos: records.length,
    bytes,
    maxBytes: MAX_BYTES,
    demoBytes,
    roundBytes,
    bytesLeft: Math.max(0, MAX_BYTES - bytes)
  };
}

/**
 * Check an upload against the per-upload cap and the library quota before a
 * byte is written. `incoming` is the declared Content-Length; the writer
 * enforces both again while streaming, so a lying or absent header cannot
 * overrun either limit.
 *
 * `allowed` is what the caller must cap the stream at: the smaller of what is
 * left in the library and what one upload may be.
 */
export async function checkQuota(user, incoming = 0) {
  const u = await usage(user);
  const gb = (n) => (n / 1024 ** 3).toFixed(n >= 1024 ** 3 ? 0 : 1);

  if (incoming > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `That upload is ${gb(incoming)} GB. One upload can be up to ${gb(MAX_UPLOAD_BYTES)} GB, however many demos it holds.`,
      usage: u
    };
  }
  if (incoming > 0 && u.bytes + incoming > MAX_BYTES) {
    return {
      ok: false,
      error: `Not enough shared storage. The server holds ${gb(MAX_BYTES)} GB total.`,
      usage: u
    };
  }
  return { ok: true, usage: u, allowed: Math.min(u.bytesLeft, MAX_UPLOAD_BYTES) };
}

/**
 * Stream a request body to a temp file under the replay root.
 *
 * Every upload lands here first, demo and .aim4replay package alike. Where a
 * demo finally goes is not known until it has been unpacked (a .zip yields
 * several, each needing its own id), so writing straight to a demo path would
 * only have to be undone.
 */
export function saveTempUpload(req, allowedBytes, prefix = 'import') {
  return new Promise((resolve, reject) => {
    // The auth and quota checks ahead of this call are async, so the client can
    // disconnect before we ever attach. Once that has happened 'end', 'error'
    // and 'close' have all fired already and none of them will fire again:
    // piping would wait forever, pinning the handler and orphaning the file it
    // had just created. Checked up front so no file is created at all.
    if (req.destroyed && !req.readableEnded) {
      reject(new Error('Upload was interrupted before it finished.'));
      return;
    }

    fs.mkdirSync(ROOT, { recursive: true });
    const target = path.join(ROOT, `.${prefix}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    const out = fs.createWriteStream(target);
    let written = 0;
    let failed = null;

    const abort = (err) => {
      if (failed) return;
      failed = err;
      req.destroy();

      // Unlink only after the stream has finished tearing down. Deleting while
      // a write is still in flight loses the race: the pending write recreates
      // the file a moment later and it is then orphaned for good, which at
      // these sizes means a multi-gigabyte file nobody will ever look for.
      const discard = () => {
        fs.promises
          .rm(target, { force: true })
          .catch(() => {})
          .finally(() => reject(err));
      };
      if (out.closed) discard();
      else {
        out.once('close', discard);
        out.destroy();
      }
    };

    req.on('data', (chunk) => {
      written += chunk.length;
      if (written > allowedBytes) {
        // Which ceiling was hit changes what the user should do about it, so
        // say. Being cut off at exactly the per-upload cap means split the
        // archive; running out of quota means delete something first.
        const gb = (n) => (n / 1024 ** 3).toFixed(0);
        abort(
          new Error(
            allowedBytes >= MAX_UPLOAD_BYTES
              ? `One upload can be up to ${gb(MAX_UPLOAD_BYTES)} GB, however many demos it holds.`
              : `Not enough shared storage left for that upload.`
          )
        );
      }
    });
    req.on('error', abort);
    out.on('error', abort);
    out.on('finish', () => {
      if (!failed) resolve({ path: target, sizeBytes: written });
    });

    // A client that goes away mid-body emits neither 'end' nor 'error', so
    // without this the promise never settles: the route awaits forever, the
    // handler is pinned, and the partial file is orphaned with nothing left
    // holding a reference to it. Over a multi-gigabyte upload on a domestic
    // connection this is not an edge case.
    let ended = false;
    req.on('end', () => {
      ended = true;
    });
    req.on('close', () => {
      if (!ended) abort(new Error('Upload was interrupted before it finished.'));
    });

    req.pipe(out);
  });
}

export function demoFilePath(user, id) {
  return demoPath(user, id);
}

// ---- Rounds -----------------------------------------------------------------

function roundStem(roundId, demoId) {
  return `${roundId}~${sanitizeId(demoId)}`;
}

/**
 * Write a round's meta+events, compressed. Any plaintext twin left over from
 * before compaction is removed, so a read can never pick up the stale copy.
 */
async function writeRoundMeta(user, stem, meta) {
  const dir = roundsDir(user);
  await fsp.writeFile(
    path.join(dir, `${stem}.json.zst`),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(meta)))
  );
  await fsp.rm(path.join(dir, `${stem}.json`), { force: true });
}

/**
 * Write a round's tick buffer in compact form: the compressed full-detail file
 * plus the precomputed coarse pass. Takes a tickFormat v1 buffer, which is the
 * only shape anything upstream produces.
 */
async function writeRoundTicks(user, stem, ticks) {
  const dir = roundsDir(user);
  const raw = Buffer.isBuffer(ticks) ? ticks : Buffer.from(ticks);
  await fsp.writeFile(path.join(dir, `${stem}${TICKZ_EXT}`), encodeTickz(raw));
  await fsp.writeFile(
    path.join(dir, `${stem}${COARSE_EXT}`),
    Buffer.from(sliceStride(raw, COARSE_STRIDE))
  );
  await fsp.rm(path.join(dir, `${stem}.bin`), { force: true });
}

/**
 * Persist one parsed round: meta+events as compressed JSON, ticks as a
 * compressed sidecar plus its coarse pass. All share a stem so the collector
 * can move from a name to every file without an index.
 */
export async function writeRound(user, demoId, round, extra = {}) {
  await ensureDirs(user);
  const stem = roundStem(round.id, demoId);
  const { ticks, ...meta } = round;
  await writeRoundMeta(user, stem, { ...meta, ...extra, demoId });
  await writeRoundTicks(user, stem, Buffer.from(ticks));
  return stem;
}

/** Names only. This is what makes filtering cheap. */
export async function listRoundNames(user) {
  const files = await listFiles(roundsDir(user));
  const stems = new Set();
  for (const f of files) {
    // Meta is the round's existence: a stem with only a tick file is a partial
    // write, and the collector has nothing to filter it on anyway.
    if (f.endsWith('.json') || f.endsWith('.json.zst')) stems.add(f.split('.')[0]);
  }
  return [...stems];
}

/**
 * The collector: filter a whole library by name, fast, then hand back just
 * the matches for the client to load lazily.
 */
export async function findRounds(user, query = {}, opts = {}) {
  const names = await listRoundNames(user);
  return sortRounds(collectRounds(names, query, opts));
}

export async function readRoundMeta(user, file) {
  const stem = sanitizeStem(file);
  const dir = roundsDir(user);
  for (const ext of META_EXTS) {
    const raw = await readIfPresent(path.join(dir, `${stem}${ext}`));
    if (!raw) continue;
    return JSON.parse(ext.endsWith('.zst') ? zlib.zstdDecompressSync(raw) : raw.toString('utf8'));
  }
  return null;
}

/**
 * Reduce any round file name to its stem.
 *
 * Everything from the first dot goes, not just the last extension: round ids
 * are drawn from `[A-Za-z0-9_~-]` and never contain a dot, so the first one is
 * always the start of the suffix. Stripping a single extension would leave
 * "<stem>.json" behind for "<stem>.json.zst" and fail the check below.
 */
function sanitizeStem(file) {
  const s = String(file || '').split('.')[0];
  if (!/^[A-Za-z0-9_~-]+$/.test(s)) throw new Error('Invalid round name');
  return s;
}

/**
 * Read a round's ticks, optionally thinned.
 *
 * stride 100 is the timeline's first pass: it returns every 100th tick as a
 * self-describing buffer roughly one percent of the size, which is why a
 * whole match can be scrubbed before any round has finished loading in full.
 */
export async function readRoundTicks(user, file, stride = 1) {
  const stem = sanitizeStem(file);
  const dir = roundsDir(user);
  const step = Math.max(1, Math.min(1000, Number(stride) || 1));

  // The coarse pass is precomputed, so the common first paint never touches
  // the compressed file at all.
  if (step === COARSE_STRIDE) {
    const coarse = await readIfPresent(path.join(dir, `${stem}${COARSE_EXT}`));
    if (coarse) return asArrayBuffer(coarse);
  }

  const tickz = await readIfPresent(path.join(dir, `${stem}${TICKZ_EXT}`));
  if (tickz) return step === 1 ? decodeTickz(tickz) : decodeTickzStride(tickz, step);

  // Not compacted yet: the original fixed-width file, read exactly as before.
  const buf = await readIfPresent(path.join(dir, `${stem}.bin`));
  if (!buf) return null;
  if (step === 1) return asArrayBuffer(buf);
  return sliceStride(buf, step, readHeader(buf));
}

// ---- the viewer's wire body --------------------------------------------------

/**
 * Full-detail rounds, compressed once and kept.
 *
 * A round is ~1 MB of fixed-width rows. Gzipping those per request cost ~10 ms
 * of CPU to produce ~261 KB, which is 3.5x LARGER than the .tickz the bytes were
 * just decoded from — the row layout simply does not compress well without the
 * columnar transform. Applying that transform and gzipping the result gets the
 * same round down to ~75 KB, and the browser inflates it in the network layer
 * for free, so the only client-side work left is the varint unpack (~2 ms).
 *
 * Round files are immutable — the name encodes the content — so a body can be
 * cached for as long as there is room for it, and only a delete has to evict.
 */
const WIRE_CACHE_BYTES = Number(process.env.AIM4_TICK_WIRE_CACHE_BYTES || 48 * 1024 * 1024);
/** @type {Map<string, Buffer>} insertion-ordered, so the oldest key is the LRU victim */
const wireCache = new Map();
let wireCacheBytes = 0;

function wireCacheGet(key) {
  const hit = wireCache.get(key);
  if (!hit) return null;
  // Re-insert so recently used bodies survive eviction.
  wireCache.delete(key);
  wireCache.set(key, hit);
  return hit;
}

function wireCachePut(key, buf) {
  if (buf.length > WIRE_CACHE_BYTES) return;
  wireCache.set(key, buf);
  wireCacheBytes += buf.length;
  for (const [k, v] of wireCache) {
    if (wireCacheBytes <= WIRE_CACHE_BYTES) break;
    if (k === key) continue;
    wireCache.delete(k);
    wireCacheBytes -= v.length;
  }
}

/** Drop cached bodies for one demo's rounds (only a delete can invalidate). */
function forgetWireCache(demoId) {
  const suffix = `~${demoId}`;
  for (const [k, v] of wireCache) {
    if (!k.includes(suffix)) continue;
    wireCache.delete(k);
    wireCacheBytes -= v.length;
  }
}

/**
 * A round's full-detail ticks as a gzipped columnar body, ready to write to the
 * socket with `Content-Encoding: gzip`.
 *
 * @returns {Promise<Buffer|null>} null when the round has no tick file
 */
export async function readRoundTicksPacked(user, file) {
  const stem = sanitizeStem(file);
  const key = `${user}/${stem}`;
  const cached = wireCacheGet(key);
  if (cached) return cached;

  const raw = await readRoundTicks(user, stem, 1);
  if (!raw) return null;
  const bytes = Buffer.from(raw);
  const body = encodePacked(bytes, readHeader(bytes).tickCount);
  // Level 6: level 9 doubled the CPU for under 1% off the wire (measured).
  const out = zlib.gzipSync(Buffer.from(body.buffer, body.byteOffset, body.byteLength), {
    level: 6
  });
  wireCachePut(key, out);
  return out;
}

// ---- Notes ------------------------------------------------------------------

export const NOTE_MAX = 800;
export const NOTES_MAX_PER_ROUND = 40;

/**
 * Normalize meta.notes (and legacy meta.note) into a sorted list of
 * { id, tick, text, updatedAt }.
 */
export function normalizeRoundNotes(meta) {
  if (!meta || typeof meta !== 'object') return [];
  const out = [];
  if (Array.isArray(meta.notes)) {
    for (const raw of meta.notes) {
      if (!raw || typeof raw !== 'object') continue;
      const text = String(raw.text ?? '').slice(0, NOTE_MAX).trim();
      if (!text) continue;
      const tick = Number(raw.tick);
      // `kind` separates what the coach wrote from what a person wrote, and
      // `mark` is the reader's verdict on a coach note. Both round-trip so a
      // reviewed note stays reviewed.
      out.push({
        id: String(raw.id || '').slice(0, 32) || `n${out.length}`,
        tick: Number.isFinite(tick) ? Math.max(0, Math.round(tick)) : 0,
        text,
        kind: raw.kind === 'coach' ? 'coach' : 'user',
        mark: raw.mark === 'ok' || raw.mark === 'x' ? raw.mark : '',
        updatedAt: Number(raw.updatedAt) || 0
      });
    }
  } else if (meta.note) {
    // Pre-timestamped single note → one entry at freezetime end when known.
    const tick = Number(meta.freezeEndTick);
    out.push({
      id: 'legacy',
      tick: Number.isFinite(tick) ? tick : 0,
      text: String(meta.note).slice(0, NOTE_MAX).trim(),
      updatedAt: Number(meta.noteUpdatedAt) || 0
    });
  }
  out.sort((a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  return out.slice(0, NOTES_MAX_PER_ROUND);
}

function roundHasNotes(meta) {
  return normalizeRoundNotes(meta).length > 0;
}

/**
 * Replace the round's notes list. Notes belong to the round (shared), live in
 * the round JSON, and are indexed in notes.json for library badges.
 *
 * Accepts either `{ notes: [...] }` or legacy `{ note: "text" }`.
 */
export async function writeRoundNotes(user, file, payload) {
  const stem = sanitizeStem(file);
  const meta = await readRoundMeta(user, stem);
  if (!meta) return null;

  let notes;
  if (payload && Array.isArray(payload.notes)) {
    notes = normalizeRoundNotes({ notes: payload.notes });
  } else if (payload && (payload.note !== undefined || typeof payload === 'string')) {
    // Legacy single-string save.
    const text = String(payload.note ?? payload ?? '')
      .slice(0, NOTE_MAX)
      .trim();
    notes = text
      ? normalizeRoundNotes({
          notes: [
            {
              id: 'legacy',
              tick: Number(meta.freezeEndTick) || 0,
              text,
              updatedAt: Date.now()
            }
          ]
        })
      : [];
  } else {
    notes = [];
  }

  if (notes.length) {
    meta.notes = notes;
  } else {
    delete meta.notes;
  }
  delete meta.note;
  delete meta.noteUpdatedAt;

  await writeRoundMeta(user, stem, meta);
  await setNotedRound(user, stem, notes.length > 0);
  return { notes };
}

/** @deprecated use writeRoundNotes — kept for any stray callers */
export async function writeRoundNote(user, file, note) {
  return writeRoundNotes(user, file, { note });
}

/** Fast set of round stems that currently have a note (library-wide index). */
const notesIndexPath = (user) => path.join(userDir(user), 'notes.json');

export async function listNotedRounds(user) {
  try {
    const raw = JSON.parse(await fsp.readFile(notesIndexPath(user), 'utf8'));
    if (Array.isArray(raw)) return raw;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return rebuildNotesIndex(user);
}

async function rebuildNotesIndex(user) {
  const names = await listRoundNames(user);
  const noted = [];
  for (const stem of names) {
    try {
      // The cheap regex prefilter this used to run cannot survive compression:
      // a compressed round has no readable "notes" substring, so every round
      // has to be decoded. This runs once, only when the index is missing.
      const meta = await readRoundMeta(user, stem);
      if (meta && roundHasNotes(meta)) noted.push(stem);
    } catch {
      /* skip corrupt */
    }
  }
  await fsp.writeFile(notesIndexPath(user), JSON.stringify(noted));
  return noted;
}

async function setNotedRound(user, stem, hasNote) {
  let list = [];
  try {
    list = await listNotedRounds(user);
  } catch {
    list = [];
  }
  const has = list.includes(stem);
  if (hasNote === has) return;
  const next = hasNote ? [...list, stem] : list.filter((f) => f !== stem);
  await fsp.writeFile(notesIndexPath(user), JSON.stringify(next));
}

// ---- Playlists --------------------------------------------------------------

export const MAX_PLAYLISTS = 100;
export const MAX_PLAYLIST_ROUNDS = 400;

const playlistsPath = (user) => path.join(userDir(user), 'playlists.json');

/**
 * Playlists hold round *names*, nothing else. A name is the whole key — the
 * client turns a list of them back into round summaries with one collector
 * call, so a playlist can never go stale against a renamed team and rounds
 * that have since been deleted simply drop out.
 */
export async function readPlaylists(user) {
  try {
    const raw = JSON.parse(await fsp.readFile(playlistsPath(user), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return [];
  }
}

async function savePlaylists(user, list) {
  await fsp.mkdir(userDir(user), { recursive: true });
  await fsp.writeFile(playlistsPath(user), JSON.stringify(list, null, 2));
  return list;
}

function cleanPlaylistName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function cleanRoundNames(rounds) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rounds) ? rounds : []) {
    const s = String(r || '').replace(/\.[a-z0-9]+$/i, '');
    if (!/^[A-Za-z0-9_~-]+$/.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_PLAYLIST_ROUNDS) break;
  }
  return out;
}

/** Create or update one playlist. Returns the whole list. */
export async function upsertPlaylist(user, patch = {}) {
  const list = await readPlaylists(user);
  const id = String(patch.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const existing = id ? list.find((p) => p.id === id) : null;

  if (!existing && list.length >= MAX_PLAYLISTS) {
    const err = new Error(`You can keep ${MAX_PLAYLISTS} playlists. Delete one first.`);
    err.status = 409;
    throw err;
  }

  const name = cleanPlaylistName(patch.name) || existing?.name || 'Untitled playlist';
  const rounds = patch.rounds === undefined ? existing?.rounds || [] : cleanRoundNames(patch.rounds);

  if (existing) {
    existing.name = name;
    existing.rounds = rounds;
    existing.updatedAt = Date.now();
  } else {
    list.push({
      id: crypto.randomBytes(6).toString('hex'),
      name,
      rounds,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return savePlaylists(user, list);
}

export async function removePlaylist(user, id) {
  const key = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const list = await readPlaylists(user);
  const next = list.filter((p) => p.id !== key);
  if (next.length === list.length) return null;
  return savePlaylists(user, next);
}

/** Remove a demo and every round parsed from it. Always cleans up on disk. */
export async function deleteDemo(user, id) {
  const demoId = sanitizeId(id);
  if (!demoId) return null;
  const record = await readRecord(user, demoId);
  await fsp.rm(demoPath(user, demoId), { force: true });
  await fsp.rm(recordPath(user, demoId), { force: true });
  const dir = roundsDir(user);
  for (const f of await listFiles(dir)) {
    if (f.includes(`~${demoId}.`)) await fsp.rm(path.join(dir, f), { force: true });
  }
  forgetWireCache(demoId);
  // Playlists would otherwise keep counting rounds that no longer exist.
  const lists = await readPlaylists(user);
  let touched = false;
  for (const pl of lists) {
    const kept = (pl.rounds || []).filter((r) => !r.endsWith(`~${demoId}`));
    if (kept.length !== (pl.rounds || []).length) {
      pl.rounds = kept;
      touched = true;
    }
  }
  if (touched) await savePlaylists(user, lists);
  // Drop note-index entries for rounds that went with the demo.
  try {
    const noted = await listNotedRounds(user);
    const kept = noted.filter((f) => !f.endsWith(`~${demoId}`));
    if (kept.length !== noted.length) {
      await fsp.writeFile(notesIndexPath(user), JSON.stringify(kept));
    }
  } catch {
    /* index is best-effort */
  }
  // Still report success when only an in-memory failed job remained (no record).
  return record || { id: demoId };
}

/** Drop the .dem once parsing succeeded, keeping the rounds. */
export async function discardSourceFile(user, id) {
  await fsp.rm(demoPath(user, sanitizeId(id)), { force: true });
}
