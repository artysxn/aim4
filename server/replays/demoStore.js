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
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Request-path decompression goes to the threadpool, never the main loop. */
const zstdDecompress = promisify(zlib.zstdDecompress);
import { collectRounds, sortRounds } from '../../src/replays/shared/roundFilter.js';
import { readHeader, sliceStride } from '../../src/replays/shared/tickFormat.js';
import { encodePacked } from '../../src/replays/shared/tickPacked.js';
import {
  TICKZ_EXT,
  decodeTickzAsync,
  decodeTickzStrideAsync,
  encodeTickz
} from './tickCodec.js';
import {
  assertNotReservedKey,
  assertReal,
  isReservedLibraryKey
} from '../../shared/sim/firewall.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.AIM4_REPLAY_DIR || path.join(__dirname, '..', 'data', 'replays');

/** Shared library storage cap for the whole server (all visitors share one pool). */
export const MAX_BYTES = Number(process.env.AIM4_REPLAY_MAX_BYTES || 100 * 1024 ** 3); // 100 GB

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
  const key = safe || 'local';
  // The firewall (12.1). `sim/` sits under ROOT beside the libraries, so
  // without this every reader in this module — and therefore every extractor,
  // trainer, and the stats index — is one library key away from ingesting
  // simulated rounds. Refuse rather than fall back to the default library: a
  // silent redirect turns "read the sim tree" into "train on real demos
  // instead", which is a different wrong answer, not a refusal.
  assertNotReservedKey(key, 'demoStore');
  return key;
}

export const userDir = (user) => path.join(ROOT, userKey(user));
const demosDir = (user) => path.join(userDir(user), 'demos');
const roundsDir = (user) => path.join(userDir(user), 'rounds');
export const uploadsDir = (user) => path.join(userDir(user), 'uploads');
/**
 * Attached voice comms. Defined here with the other library folders rather
 * than in commsStore, so the storage meter can size it without importing that
 * module and forming a cycle: commsStore already depends on this one for
 * userDir().
 */
export const commsDir = (user) => path.join(userDir(user), 'comms');

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
    // `zones` was already excluded here by hand; `sim` joins it, from the one
    // list in firewall.js. Boot-time parse resume walks whatever is actually
    // on the volume, so this is the walker that would otherwise discover the
    // sim tree the moment the first match is written (12.1).
    return entries
      .filter((e) => e.isDirectory() && !isReservedLibraryKey(e.name))
      .map((e) => e.name);
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

/** Open file descriptors per batch. Enough to saturate a disk, not enough to exhaust one. */
const READ_CONCURRENCY = 32;

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

/**
 * Total bytes in one directory.
 *
 * The rounds directory holds roughly 25 files per demo, so a few hundred demos
 * put five figures of entries in here. Statting them one await at a time made
 * the storage meter, which rides along on every library listing, the slowest
 * thing in the request.
 */
async function dirBytes(dir) {
  const files = await listFiles(dir);
  let total = 0;
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    const sizes = await Promise.all(
      files.slice(i, i + READ_CONCURRENCY).map(async (f) => {
        try {
          return (await fsp.stat(path.join(dir, f))).size;
        } catch {
          return 0; /* raced with a delete */
        }
      })
    );
    for (const size of sizes) total += size;
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
  // Every record write funnels through here, so this one line is what keeps the
  // listing cache honest: uploads, renames, visibility changes and parse-status
  // updates all land on disk via writeRecord.
  invalidateDemoList(user);
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
 * Change who may browse a demo (public / unlisted / private).
 * Round files are unchanged; only the demo record's visibility field moves.
 */
export async function setDemoVisibility(user, id, visibility) {
  const demoId = sanitizeId(id);
  const record = await readRecord(user, demoId);
  if (!record) return null;
  const next = String(visibility || '').toLowerCase();
  if (!['public', 'unlisted', 'private'].includes(next)) {
    throw new Error('Visibility must be public, unlisted, or private.');
  }
  record.visibility = next;
  await writeRecord(user, record);
  return record;
}

/** Longest a single tag may be, and how many a demo may carry. */
export const MAX_TAG_LENGTH = 24;
export const MAX_TAGS = 12;

/**
 * Normalize a tag list: trimmed, deduped case-insensitively, capped.
 *
 * Tags are whatever the uploader wants them to be (scrim, faceit, an opponent
 * name), so there is no vocabulary to validate against. What is enforced is
 * shape: no empties, no duplicates that differ only in case, no essays.
 */
export function normalizeTags(raw) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(raw) ? raw : []) {
    const tag = String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Replace a demo's tag list. */
export async function setDemoTags(user, id, tags) {
  const demoId = sanitizeId(id);
  const record = await readRecord(user, demoId);
  if (!record) return null;
  record.tags = normalizeTags(tags);
  await writeRecord(user, record);
  return record;
}

/**
 * Count one round view against a demo.
 *
 * Counts round opens, not demo opens: watching six rounds of a match is six.
 * That is the question the number answers ("how much has this been looked at"),
 * and it is the only one the viewer can report without tracking sessions.
 */
export async function bumpDemoViews(user, id) {
  const demoId = sanitizeId(id);
  const record = await readRecord(user, demoId);
  if (!record) return null;
  record.views = (Number(record.views) || 0) + 1;
  await writeRecord(user, record);
  return record;
}

/**
 * Stamp the match's best-rated player onto the record.
 *
 * The library listing has no stats index in hand and cannot afford to open one
 * per demo, so the answer is written here when the index is built and read for
 * free afterwards. A no-op when nothing changed, because every write clears the
 * listing cache.
 */
export async function setDemoTopPlayer(user, id, top) {
  const demoId = sanitizeId(id);
  const record = await readRecord(user, demoId);
  if (!record) return null;
  const next = top
    ? {
        id: String(top.id || ''),
        name: String(top.name || ''),
        rating: Math.round((Number(top.rating) || 0) * 100) / 100
      }
    : null;
  const held = record.topPlayer || null;
  const same =
    (!next && !held) ||
    (next &&
      held &&
      held.id === next.id &&
      held.name === next.name &&
      held.rating === next.rating);
  if (same) return record;
  if (next) record.topPlayer = next;
  else delete record.topPlayer;
  await writeRecord(user, record);
  return record;
}

/**
 * Persist a fully materialized demo (manifest + round files) without
 * re-deriving round ids. Used by server ingest and by import of local packages.
 *
 * Accepts either the plain v1 pair (`.json` + `.bin`) or the compact library
 * form (`.json.zst` + `.tickz` + optional `.c100.bin`). Plain entries are
 * recompressed on write; compact entries are stored as-is.
 *
 * @param {string} user
 * @param {object} record
 * @param {Map<string, Uint8Array>|Iterable<[string, Uint8Array]>} files
 */
export async function writeMaterialized(user, record, files) {
  await ensureDirs(user);
  const demoId = sanitizeId(record.id);
  /** @type {Map<string, { metaJson?: Buffer, metaZst?: Buffer, ticksBin?: Buffer, tickz?: Buffer, c100?: Buffer }>} */
  const byStem = new Map();

  for (const [name, data] of files) {
    const n = String(name).replace(/\\/g, '/');
    if (n === 'manifest.json') continue;
    if (!n.startsWith('rounds/') || n.includes('..')) {
      throw new Error(`Unexpected package entry: ${name}`);
    }
    const base = path.basename(n);
    const stem = base.split('.')[0];
    if (!stem.endsWith(`~${demoId}`)) {
      throw new Error(`Round file does not match demo id: ${base}`);
    }
    const buf = Buffer.from(data);
    let entry = byStem.get(stem);
    if (!entry) {
      entry = {};
      byStem.set(stem, entry);
    }
    if (base.endsWith('.json.zst')) entry.metaZst = buf;
    else if (base.endsWith('.json')) entry.metaJson = buf;
    else if (base.endsWith(TICKZ_EXT)) entry.tickz = buf;
    else if (base.endsWith(COARSE_EXT)) entry.c100 = buf;
    else if (base.endsWith('.bin')) entry.ticksBin = buf;
    else throw new Error(`Unexpected round file: ${base}`);
  }

  const dir = roundsDir(user);
  for (const [stem, entry] of byStem) {
    if (entry.metaZst) {
      await fsp.writeFile(path.join(dir, `${stem}.json.zst`), entry.metaZst);
      await fsp.rm(path.join(dir, `${stem}.json`), { force: true });
    } else if (entry.metaJson) {
      await writeRoundMeta(user, stem, JSON.parse(entry.metaJson.toString('utf8')));
    } else {
      throw new Error(`Package is missing meta for ${stem}.`);
    }

    if (entry.tickz) {
      await fsp.writeFile(path.join(dir, `${stem}${TICKZ_EXT}`), entry.tickz);
      if (entry.c100) {
        await fsp.writeFile(path.join(dir, `${stem}${COARSE_EXT}`), entry.c100);
      } else {
        const raw = Buffer.from(await decodeTickzAsync(entry.tickz));
        await fsp.writeFile(
          path.join(dir, `${stem}${COARSE_EXT}`),
          Buffer.from(sliceStride(raw, COARSE_STRIDE))
        );
      }
      await fsp.rm(path.join(dir, `${stem}.bin`), { force: true });
    } else if (entry.ticksBin) {
      await writeRoundTicks(user, stem, entry.ticksBin);
    } else {
      throw new Error(`Package is missing ticks for ${stem}.`);
    }
  }

  await writeRecord(user, { ...record, id: demoId });
  return record;
}

// ---- record listing ---------------------------------------------------------
//
// listDemos is the hottest read in the server. Every library page, every round
// open and every tick request resolves visibility through it, and it used to
// re-read and re-parse every record JSON in the library, one await at a time,
// for each of those. Opening a 25-round demo against a 300-demo library meant
// roughly 7,500 sequential file reads before a single tick was served.
//
// Two changes: the reads happen in parallel batches, and the parsed result is
// cached in memory until something writes to the library. The cache is keyed by
// library rather than by caller because the store is one shared directory.
//
// Records handed out here are shared, so treat them as read-only. Every write
// path goes through writeRecord or deleteDemo, and both drop the entry.

/** @type {Map<string, {records: object[], expires: number}>} */
const recordListCache = new Map();
/** Safety net for anything that writes to the directory behind our back. */
const RECORD_LIST_TTL_MS = 30 * 1000;
/** Drop the cached listing and storage totals for one library, or for all. */
export function invalidateDemoList(user = undefined) {
  if (user === undefined) {
    recordListCache.clear();
    usageCache.clear();
    roundNamesCache.clear();
    return;
  }
  const key = userKey(user);
  recordListCache.delete(key);
  usageCache.delete(key);
  roundNamesCache.delete(key);
}

/**
 * Cold-cache builds in flight, so concurrent misses share one scan.
 *
 * Without this, the requests a page fires on load -- demos, stats, status, a
 * round open -- each miss the empty cache of a freshly deployed container and
 * each run the FULL library read side by side. Ten tabs' worth of that on a
 * few thousand records is tens of thousands of file reads doing the same work,
 * which is what a post-deploy "API may be down" actually was.
 *
 * @type {Map<string, Promise<object[]>>}
 */
const recordListInflight = new Map();

export async function listDemos(user, { fresh = false } = {}) {
  const key = userKey(user);
  if (!fresh) {
    const hit = recordListCache.get(key);
    // A copy of the array: callers sort and splice their own view of it.
    if (hit && hit.expires > Date.now()) return hit.records.slice();
    const inflight = recordListInflight.get(key);
    if (inflight) return (await inflight).slice();
  }

  const build = (async () => {
    const dir = demosDir(user);
    const files = (await listFiles(dir)).filter((f) => f.endsWith('.json'));
    const records = [];
    for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
      const batch = await Promise.all(
        files.slice(i, i + READ_CONCURRENCY).map(async (f) => {
          try {
            return JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          } catch {
            /* skip a corrupt record rather than fail the whole listing */
            return null;
          }
        })
      );
      for (const record of batch) if (record) records.push(record);
    }
    records.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    recordListCache.set(key, { records, expires: Date.now() + RECORD_LIST_TTL_MS });
    return records;
  })();

  // `fresh` builds register too: a quota check that is already re-reading the
  // directory may as well be the scan everyone else piggybacks on.
  recordListInflight.set(key, build);
  try {
    return (await build).slice();
  } finally {
    recordListInflight.delete(key);
  }
}

/**
 * Every ready record, projected to the fields team naming needs.
 *
 * The caller is the parse worker (lineupNames.js): a separate process, with a
 * capped heap, holding a whole parsed demo, that needs to know who the library
 * already has under which team name before it writes its round files. listDemos
 * would leave every full manifest — rounds and all — resident in that process
 * for the sake of ten player ids per demo. So this reads the same files and
 * keeps only the projection: a few hundred bytes per demo instead of tens of
 * kilobytes, and nothing cached afterwards.
 *
 * @returns {Promise<Array<{ id, uploadedAt, team1, team2, players }>>}
 */
export async function listDemoLineups(user) {
  const dir = demosDir(user);
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    const batch = await Promise.all(
      files.slice(i, i + READ_CONCURRENCY).map(async (f) => {
        try {
          const r = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          // A demo still uploading or parsing has no roster to match against.
          if ((r.status || 'ready') !== 'ready') return null;
          return {
            id: String(r.id || ''),
            uploadedAt: Number(r.uploadedAt) || Number(r.parsedAt) || 0,
            team1: { id: r.team1?.id || '', name: r.team1?.name || '' },
            team2: { id: r.team2?.id || '', name: r.team2?.name || '' },
            players: (Array.isArray(r.players) ? r.players : []).map((p) => ({
              id: p?.id || '',
              name: p?.name || '',
              steamId: p?.steamId ? String(p.steamId) : '',
              team: p?.team === 2 ? 2 : 1
            }))
          };
        } catch {
          /* skip a corrupt record rather than fail the whole scan */
          return null;
        }
      })
    );
    for (const rec of batch) if (rec) out.push(rec);
  }
  return out;
}

/**
 * Storage totals, cached.
 *
 * This rides along on every library listing but only changes when something is
 * uploaded, parsed or deleted, and walking the rounds directory is the most
 * expensive thing in the request. A stale byte count for a few seconds costs
 * nothing; recomputing it per request costs the whole page.
 *
 * Writes clear it through invalidateDemoList, and quota checks that must not
 * race an upload pass `fresh: true`.
 *
 * @type {Map<string, {value: object, expires: number}>}
 */
const usageCache = new Map();
const USAGE_TTL_MS = 15 * 1000;

/**
 * Builds in flight, so concurrent misses share one walk. A page load fires
 * /status and /demos side by side and both ride on usage(); without this a
 * cold cache ran two full stat walks of the rounds directory at once.
 *
 * @type {Map<string, Promise<object>>}
 */
const usageInflight = new Map();

export async function usage(user, { fresh = false } = {}) {
  const key = userKey(user);
  if (!fresh) {
    const hit = usageCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const inflight = usageInflight.get(key);
    if (inflight) return inflight;
  }
  const build = (async () => {
    const [demoBytes, roundBytes, commsBytes, records] = await Promise.all([
      dirBytes(demosDir(user)),
      dirBytes(roundsDir(user)),
      // Attached recordings are small next to a demo (~2 MB against hundreds),
      // but they are still the library's bytes on the library's disk, and a
      // meter that quietly omits a whole category stops being a meter.
      dirBytes(commsDir(user)),
      listDemos(user, { fresh })
    ]);
    const bytes = demoBytes + roundBytes + commsBytes;
    const value = {
      demos: records.length,
      bytes,
      maxBytes: MAX_BYTES,
      demoBytes,
      roundBytes,
      commsBytes,
      bytesLeft: Math.max(0, MAX_BYTES - bytes)
    };
    usageCache.set(key, { value, expires: Date.now() + USAGE_TTL_MS });
    return value;
  })();
  // Fresh builds register too: a quota check already walking the directory may
  // as well be the walk everyone else piggybacks on.
  usageInflight.set(key, build);
  try {
    return await build;
  } finally {
    usageInflight.delete(key);
  }
}

/**
 * Bytes admitted through the quota gate whose files are not on disk yet, per
 * library. This is what lets checkQuota read the CACHED usage number: two
 * uploads arriving together each see the other's reservation, so they cannot
 * both be admitted against the same headroom — which was the only race the
 * old `fresh: true` walk actually protected against, at the price of a full
 * stat of the rounds directory (hundreds of thousands of files at library
 * scale) on every single upload request. Two upload tabs at once made that
 * walk the thing every other request queued behind.
 *
 * @type {Map<string, number>}
 */
const reservedUploadBytes = new Map();

/**
 * Reserve `bytes` of quota headroom. Returns a release function that is safe
 * to call more than once; the caller (or the ingest batch it hands off to)
 * MUST call it, or the headroom stays spoken for until the process restarts.
 */
export function reserveQuotaBytes(user, bytes) {
  const key = userKey(user);
  const n = Math.max(0, Number(bytes) || 0);
  if (n > 0) reservedUploadBytes.set(key, (reservedUploadBytes.get(key) || 0) + n);
  let released = false;
  return () => {
    if (released || n === 0) return;
    released = true;
    const left = (reservedUploadBytes.get(key) || 0) - n;
    if (left > 0) reservedUploadBytes.set(key, left);
    else reservedUploadBytes.delete(key);
  };
}

function quotaBytesReserved(user) {
  return reservedUploadBytes.get(userKey(user)) || 0;
}

/**
 * Check an upload against the per-upload cap and the library quota before a
 * byte is written. `incoming` is the declared Content-Length; the writer
 * enforces both again while streaming, so a lying or absent header cannot
 * overrun either limit.
 *
 * `allowed` is what the caller must cap the stream at: the smaller of what is
 * left in the library and what one upload may be.
 *
 * Reads the cached usage plus live reservations, NOT a fresh walk. The cache
 * is at most 15 s stale and every write path invalidates it, so the exposure
 * is bounded by what can land on disk in 15 s — while the walk it replaces
 * was O(library) work per upload request, on the request path, made worse by
 * exactly the things (ingest, another tab's upload) that make the library
 * grow. `reserve: true` holds the declared size until released.
 */
export async function checkQuota(user, incoming = 0, { reserve = false } = {}) {
  const u = await usage(user);
  const reserved = quotaBytesReserved(user);
  const held = u.bytes + reserved;
  const bytesLeft = Math.max(0, MAX_BYTES - held);
  const gb = (n) => (n / 1024 ** 3).toFixed(n >= 1024 ** 3 ? 0 : 1);

  if (incoming > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `That upload is ${gb(incoming)} GB. One upload can be up to ${gb(MAX_UPLOAD_BYTES)} GB, however many demos it holds.`,
      usage: u
    };
  }
  if (incoming > 0 && held + incoming > MAX_BYTES) {
    return {
      ok: false,
      error: `Not enough shared storage. The server holds ${gb(MAX_BYTES)} GB total.`,
      usage: u
    };
  }
  return {
    ok: true,
    usage: u,
    allowed: Math.min(bytesLeft, MAX_UPLOAD_BYTES),
    // Declared-size reservation only: a stream with no Content-Length is still
    // capped by `allowed` while it writes, it just cannot pre-claim headroom.
    release: reserve ? reserveQuotaBytes(user, incoming) : null
  };
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

/**
 * Rebuild a demo's .aim4replay package from what the library already stores.
 *
 * The stored round files ARE the package contents (.json.zst + .tickz +
 * .c100.bin, written by materialize.js), so this is a read and a re-wrap, not
 * a re-encode — no parsing, no recompression. The 3D viewer uses it to open a
 * library demo by id with the same decoder it uses for a dropped file, which
 * is why it hands back the whole match rather than a round at a time.
 *
 * @returns {Promise<Uint8Array|null>} null when the demo has no rounds stored
 */
export async function buildDemoPackage(user, id) {
  const record = await readRecord(user, id);
  if (!record) return null;
  const dir = roundsDir(user);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const suffix = `~${id}`;
  const entries = [['manifest.json', Buffer.from(JSON.stringify(record), 'utf8')]];
  for (const name of names.sort()) {
    // Round files carry the owning demo id in their stem, which is what makes
    // a whole-match read a filename filter rather than an index lookup.
    const stem = name.replace(/\.(json\.zst|tickz|c100\.bin|json|bin)$/, '');
    if (!stem.endsWith(suffix)) continue;
    try {
      entries.push([`rounds/${name}`, await fsp.readFile(path.join(dir, name))]);
    } catch {
      /* a file vanished mid-read; the package is still usable without it */
    }
  }
  if (entries.length === 1) return null;
  const { encodeReplayPackage } = await import('../../src/replays/shared/replayPackage.js');
  return encodeReplayPackage(entries);
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
export async function writeRoundMeta(user, stem, meta) {
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
  // Round files are most of the library's bytes, so the storage meter is stale
  // until this clears it.
  invalidateDemoList(user);
  return stem;
}

/**
 * The rounds directory holds ~3 files per round, so at library scale a
 * readdir here walks hundreds of thousands of dirents — and the round
 * collector runs on every filter change in the demo browser. Names only
 * change when a round is written or a demo deleted, both of which funnel
 * through invalidateDemoList; the TTL is the safety net for anything writing
 * to the volume behind this process's back.
 *
 * @type {Map<string, {names: string[], expires: number}>}
 */
const roundNamesCache = new Map();
const ROUND_NAMES_TTL_MS = 5 * 60 * 1000;

/** Names only. This is what makes filtering cheap. Treat the array as read-only. */
export async function listRoundNames(user) {
  const key = userKey(user);
  const hit = roundNamesCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.names;
  const files = await listFiles(roundsDir(user));
  const stems = new Set();
  for (const f of files) {
    // Meta is the round's existence: a stem with only a tick file is a partial
    // write, and the collector has nothing to filter it on anyway.
    if (f.endsWith('.json') || f.endsWith('.json.zst')) stems.add(f.split('.')[0]);
  }
  const names = [...stems];
  roundNamesCache.set(key, { names, expires: Date.now() + ROUND_NAMES_TTL_MS });
  return names;
}

/**
 * The collector: filter a whole library by name, fast, then hand back just
 * the matches for the client to load lazily.
 *
 * Chunked, because "fast" stopped being true at library scale: collectRounds
 * is pure string parsing per name, and one pass over a six-figure rounds
 * directory was a measured ~60-90 ms with the loop held the whole way — per
 * request, on an endpoint the demo browser hits on every filter change. The
 * slices keep the same names order and the same limit semantics; the yields
 * between them are where every other request gets to run.
 */
const COLLECT_CHUNK = 15_000;

export async function findRounds(user, query = {}, opts = {}) {
  const names = await listRoundNames(user);
  const limit = opts.limit ?? Infinity;
  const out = [];
  for (let i = 0; i < names.length && out.length < limit; i += COLLECT_CHUNK) {
    out.push(
      ...collectRounds(names.slice(i, i + COLLECT_CHUNK), query, {
        ...opts,
        limit: limit - out.length
      })
    );
    if (i + COLLECT_CHUNK < names.length) await new Promise(setImmediate);
  }
  return sortRounds(out);
}

export async function readRoundMeta(user, file) {
  const stem = sanitizeStem(file);
  const dir = roundsDir(user);
  for (const ext of META_EXTS) {
    const raw = await readIfPresent(path.join(dir, `${stem}${ext}`));
    if (!raw) continue;
    // Threadpool zstd, not sync: a round meta is ~27 KB compressed and this
    // runs per round on the viewer, packs and stats paths — the sync form was
    // main-loop time multiplied by whatever batch size the caller used.
    const meta = JSON.parse(
      ext.endsWith('.zst') ? await zstdDecompress(raw) : raw.toString('utf8')
    );
    // The second firewall check (12.1), the one that travels with the file.
    // The key check above cannot help once a round has been copied into a
    // real library by hand; the marker can. Neither check subsumes the other.
    assertReal(meta, 'demoStore');
    return meta;
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

  // Async decode: the zstd runs on the threadpool. This function is on the
  // request path of the viewer, the packs route and the stats builders, and
  // the sync form was a loop stall per round read.
  const tickz = await readIfPresent(path.join(dir, `${stem}${TICKZ_EXT}`));
  if (tickz) {
    return step === 1 ? decodeTickzAsync(tickz) : decodeTickzStrideAsync(tickz, step);
  }

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
      const playerId = String(raw.playerId || '').slice(0, 64);
      const rule = String(raw.rule || '').slice(0, 64);
      out.push({
        id: String(raw.id || '').slice(0, 32) || `n${out.length}`,
        tick: Number.isFinite(tick) ? Math.max(0, Math.round(tick)) : 0,
        text,
        kind: raw.kind === 'coach' ? 'coach' : 'user',
        mark: raw.mark === 'ok' || raw.mark === 'x' ? raw.mark : '',
        ...(playerId ? { playerId } : {}),
        ...(rule ? { rule } : {}),
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

/**
 * Create or update one playlist. Returns the whole list.
 *
 * `actor` carries the account the playlist belongs to. A playlist is either
 * private (its owner alone) or team (everyone on the team it was made for),
 * and only the owner may edit it once it exists.
 *
 * @param {{id: string, username: string, admin?: boolean, teamId?: string}} [actor]
 */
export async function upsertPlaylist(user, patch = {}, actor = null) {
  const list = await readPlaylists(user);
  const id = String(patch.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const existing = id ? list.find((p) => p.id === id) : null;

  if (existing && actor && !actor.admin && existing.ownerId && existing.ownerId !== actor.id) {
    const err = new Error('That playlist belongs to someone else.');
    err.status = 403;
    throw err;
  }
  const scope = patch.scope === 'team' ? 'team' : patch.scope === 'private' ? 'private' : null;

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
    if (scope) existing.scope = scope;
    if (scope === 'team' && actor?.teamId) existing.teamId = actor.teamId;
    if (scope === 'private') existing.teamId = '';
  } else {
    list.push({
      id: crypto.randomBytes(6).toString('hex'),
      name,
      rounds,
      ownerId: actor?.id || '',
      ownerName: actor?.username || '',
      scope: scope || 'private',
      teamId: scope === 'team' ? actor?.teamId || '' : '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return savePlaylists(user, list);
}

export async function removePlaylist(user, id, actor = null) {
  const key = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const list = await readPlaylists(user);
  const target = list.find((p) => p.id === key);
  if (target && actor && !actor.admin && target.ownerId && target.ownerId !== actor.id) {
    const err = new Error('That playlist belongs to someone else.');
    err.status = 403;
    throw err;
  }
  const next = list.filter((p) => p.id !== key);
  if (next.length === list.length) return null;
  return savePlaylists(user, next);
}

// ---- Saved views ------------------------------------------------------------
//
// A chart spec, a Pattern Finder query and a Database filter are all the same
// thing on disk: a small JSON object plus the page it belongs to. Saving one
// turns a finding into something that survives the session, and the share id
// makes it something you can send.
//
// The spec is stored opaquely. The server has no opinion about what a chart
// looks like, only about how big it is and who may see it.

export const MAX_SAVED_VIEWS = 200;
/** A spec bigger than this is not a view, it is a payload. */
const MAX_VIEW_SPEC_BYTES = 16 * 1024;
export const VIEW_PAGES = ['charts', 'patterns', 'database'];

const viewsPath = (user) => path.join(userDir(user), 'views.json');

export async function readSavedViews(user) {
  try {
    const raw = JSON.parse(await fsp.readFile(viewsPath(user), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function saveViews(user, list) {
  await fsp.mkdir(userDir(user), { recursive: true });
  await fsp.writeFile(viewsPath(user), JSON.stringify(list, null, 2));
  return list;
}

function cleanViewSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const text = JSON.stringify(spec);
  if (text.length > MAX_VIEW_SPEC_BYTES) {
    const err = new Error('That view is too large to save.');
    err.status = 400;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Create or update one saved view. Returns the whole list.
 *
 * Same ownership rules as playlists: private to its owner, or shared with the
 * team it was made for. The share id is separate from the record id so a link
 * stays valid across renames and cannot be guessed from a list position.
 */
export async function upsertSavedView(user, patch = {}, actor = null) {
  const list = await readSavedViews(user);
  const id = String(patch.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const existing = id ? list.find((v) => v.id === id) : null;

  if (existing && actor && !actor.admin && existing.ownerId && existing.ownerId !== actor.id) {
    const err = new Error('That view belongs to someone else.');
    err.status = 403;
    throw err;
  }
  if (!existing && list.length >= MAX_SAVED_VIEWS) {
    const err = new Error(`You can keep ${MAX_SAVED_VIEWS} saved views. Delete one first.`);
    err.status = 409;
    throw err;
  }

  const page = VIEW_PAGES.includes(patch.page) ? patch.page : existing?.page;
  if (!page) {
    const err = new Error('A saved view needs a page.');
    err.status = 400;
    throw err;
  }
  const name = cleanPlaylistName(patch.name) || existing?.name || 'Untitled view';
  const spec = patch.spec === undefined ? existing?.spec || {} : cleanViewSpec(patch.spec) || {};
  const scope = patch.scope === 'team' ? 'team' : patch.scope === 'private' ? 'private' : null;

  if (existing) {
    existing.name = name;
    existing.page = page;
    existing.spec = spec;
    existing.updatedAt = Date.now();
    if (scope) existing.scope = scope;
    if (scope === 'team' && actor?.teamId) existing.teamId = actor.teamId;
    if (scope === 'private') existing.teamId = '';
  } else {
    list.push({
      id: crypto.randomBytes(6).toString('hex'),
      shareId: crypto.randomBytes(8).toString('base64url'),
      name,
      page,
      spec,
      ownerId: actor?.id || '',
      ownerName: actor?.username || '',
      scope: scope || 'private',
      teamId: scope === 'team' ? actor?.teamId || '' : '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return saveViews(user, list);
}

export async function removeSavedView(user, id, actor = null) {
  const key = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const list = await readSavedViews(user);
  const target = list.find((v) => v.id === key);
  if (target && actor && !actor.admin && target.ownerId && target.ownerId !== actor.id) {
    const err = new Error('That view belongs to someone else.');
    err.status = 403;
    throw err;
  }
  const next = list.filter((v) => v.id !== key);
  if (next.length === list.length) return null;
  return saveViews(user, next);
}

/** Resolve a share id. The id is the authorisation, same as an export token. */
export async function savedViewByShareId(user, shareId) {
  const key = String(shareId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!key) return null;
  const list = await readSavedViews(user);
  return list.find((v) => v.shareId === key) || null;
}

/** Remove a demo and every round parsed from it. Always cleans up on disk. */
export async function deleteDemo(user, id) {
  const demoId = sanitizeId(id);
  if (!demoId) return null;
  const record = await readRecord(user, demoId);
  await fsp.rm(demoPath(user, demoId), { force: true });
  await fsp.rm(recordPath(user, demoId), { force: true });
  invalidateDemoList(user);
  const dir = roundsDir(user);
  for (const f of await listFiles(dir)) {
    if (f.includes(`~${demoId}.`)) await fsp.rm(path.join(dir, f), { force: true });
  }
  // Again, after the round files are gone: a round listing rebuilt between the
  // two would otherwise cache the deleted names for the TTL.
  invalidateDemoList(user);
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
  // Voice comms are attached to a demo and mean nothing without it. Imported
  // late to keep the dependency one-way: commsStore builds its paths on this
  // module's userDir().
  try {
    const { deleteComms } = await import('./commsStore.js');
    await deleteComms(user, demoId);
  } catch {
    /* nothing attached, or the folder never existed */
  }
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
