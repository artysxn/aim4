// ---------------------------------------------------------------------------
// replays/demoStore.js
// On-disk library for uploaded demos and the rounds parsed out of them.
//
//   server/data/replays/<user>/demos/<demoId>.dem     the upload, kept as-is
//   server/data/replays/<user>/demos/<demoId>.json    demo record + round list
//   server/data/replays/<user>/rounds/<name>.json     round meta + events
//   server/data/replays/<user>/rounds/<name>.bin      tick buffer (tickFormat)
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
import { fileURLToPath } from 'node:url';
import { collectRounds, sortRounds } from '../../src/replays/shared/roundFilter.js';
import { readHeader, sliceStride } from '../../src/replays/shared/tickFormat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.AIM4_REPLAY_DIR || path.join(__dirname, '..', 'data', 'replays');

/** Shared library caps for the whole server (all visitors share one pool). */
export const MAX_DEMOS = Number(process.env.AIM4_REPLAY_MAX_DEMOS || 50);
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

const userDir = (user) => path.join(ROOT, userKey(user));
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

async function listFiles(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

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

  const dir = roundsDir(user);
  for (const r of record.rounds || []) {
    if (!r?.file) continue;
    const p = path.join(dir, `${sanitizeStem(r.file)}.json`);
    try {
      const meta = JSON.parse(await fsp.readFile(p, 'utf8'));
      if (meta.team1) meta.team1 = { ...meta.team1, name: n1 };
      if (meta.team2) meta.team2 = { ...meta.team2, name: n2 };
      await fsp.writeFile(p, JSON.stringify(meta));
    } catch {
      /* round file missing; skip */
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
  const dir = roundsDir(user);
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
    await fsp.writeFile(path.join(dir, base), Buffer.from(data));
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
    maxDemos: MAX_DEMOS,
    bytes,
    maxBytes: MAX_BYTES,
    demoBytes,
    roundBytes,
    demosLeft: Math.max(0, MAX_DEMOS - records.length),
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
  if (u.demos >= MAX_DEMOS) {
    return {
      ok: false,
      error: `Shared library is full (${MAX_DEMOS} demos). Delete one to upload more.`,
      usage: u
    };
  }
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
 * Stream an upload to disk, aborting if it exceeds what the quota allows.
 * Returns the byte count written.
 */
export function saveUpload(user, id, req, allowedBytes) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(demosDir(user), { recursive: true });
    const target = demoPath(user, id);
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
      if (!failed) resolve(written);
    });
    req.pipe(out);
  });
}

/**
 * Stream a request body to a temp file under the replay root (used for
 * .aim4replay import before the package is decoded into round files).
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
 * Persist one parsed round: meta+events as JSON, ticks as a binary sidecar.
 * The pair share a stem so the collector can move from a name to both files
 * without an index.
 */
export async function writeRound(user, demoId, round, extra = {}) {
  await ensureDirs(user);
  const stem = roundStem(round.id, demoId);
  const dir = roundsDir(user);
  const { ticks, ...meta } = round;
  await fsp.writeFile(
    path.join(dir, `${stem}.json`),
    JSON.stringify({ ...meta, ...extra, demoId }, null, 0)
  );
  await fsp.writeFile(path.join(dir, `${stem}.bin`), Buffer.from(ticks));
  return stem;
}

/** Names only. This is what makes filtering cheap. */
export async function listRoundNames(user) {
  const files = await listFiles(roundsDir(user));
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
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
  try {
    return JSON.parse(await fsp.readFile(path.join(roundsDir(user), `${stem}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sanitizeStem(file) {
  const s = String(file || '').replace(/\.[a-z0-9]+$/i, '');
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
  const p = path.join(roundsDir(user), `${stem}.bin`);
  let buf;
  try {
    buf = await fsp.readFile(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const step = Math.max(1, Math.min(1000, Number(stride) || 1));
  if (step === 1) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const header = readHeader(buf);
  return sliceStride(buf, step, header);
}

// ---- Notes ------------------------------------------------------------------

export const NOTE_MAX = 800;

/**
 * A round's note lives in the round's own JSON, not in a side table. It is
 * read on every round load already, it travels with the round when a demo is
 * deleted, and it is a property of the round rather than of whoever wrote it —
 * everyone who can open the round sees the same note.
 */
export async function writeRoundNote(user, file, note) {
  const stem = sanitizeStem(file);
  const p = path.join(roundsDir(user), `${stem}.json`);
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const text = String(note ?? '').slice(0, NOTE_MAX).trim();
  if (text) {
    meta.note = text;
    meta.noteUpdatedAt = Date.now();
  } else {
    delete meta.note;
    delete meta.noteUpdatedAt;
  }
  await fsp.writeFile(p, JSON.stringify(meta));
  await setNotedRound(user, stem, Boolean(text));
  return { note: text, noteUpdatedAt: meta.noteUpdatedAt || null };
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
      const raw = await fsp.readFile(path.join(roundsDir(user), `${stem}.json`), 'utf8');
      if (!/"note"\s*:/.test(raw)) continue;
      const meta = JSON.parse(raw);
      if (meta.note) noted.push(stem);
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
