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
import { TICKZ_EXT, decodeTickz, decodeTickzStride, encodeTickz } from './tickCodec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.AIM4_REPLAY_DIR || path.join(__dirname, '..', 'data', 'replays');

/** Shared library storage cap for the whole server (all visitors share one pool). */
export const MAX_BYTES = Number(process.env.AIM4_REPLAY_MAX_BYTES || 20 * 1024 ** 3); // 20 GB

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
 * Check an upload against the quota before a byte is written. `incoming` is
 * the declared Content-Length; the writer enforces it again while streaming
 * so a lying header cannot overrun the limit.
 */
export async function checkQuota(user, incoming = 0) {
  const u = await usage(user);
  if (incoming > 0 && u.bytes + incoming > MAX_BYTES) {
    const gb = (MAX_BYTES / 1024 ** 3).toFixed(0);
    return {
      ok: false,
      error: `Not enough shared storage. The server holds ${gb} GB total.`,
      usage: u
    };
  }
  return { ok: true, usage: u };
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
    fs.mkdirSync(ROOT, { recursive: true });
    const target = path.join(ROOT, `.${prefix}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    const out = fs.createWriteStream(target);
    let written = 0;
    let failed = null;

    const abort = (err) => {
      if (failed) return;
      failed = err;
      req.destroy();
      out.destroy();
      fs.promises.rm(target, { force: true }).catch(() => {});
      reject(err);
    };

    req.on('data', (chunk) => {
      written += chunk.length;
      if (written > allowedBytes) abort(new Error('Upload exceeds the available space.'));
    });
    req.on('error', abort);
    out.on('error', abort);
    out.on('finish', () => {
      if (!failed) resolve({ path: target, sizeBytes: written });
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

/** Remove a demo and every round parsed from it. */
export async function deleteDemo(user, id) {
  const demoId = sanitizeId(id);
  const record = await readRecord(user, demoId);
  await fsp.rm(demoPath(user, demoId), { force: true });
  await fsp.rm(recordPath(user, demoId), { force: true });
  const dir = roundsDir(user);
  for (const f of await listFiles(dir)) {
    if (f.includes(`~${demoId}.`)) await fsp.rm(path.join(dir, f), { force: true });
  }
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
  return record;
}

/** Drop the .dem once parsing succeeded, keeping the rounds. */
export async function discardSourceFile(user, id) {
  await fsp.rm(demoPath(user, sanitizeId(id)), { force: true });
}
