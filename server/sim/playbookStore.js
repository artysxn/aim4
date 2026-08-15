// ---------------------------------------------------------------------------
// server/sim/playbookStore.js
// Read a map's tape file without holding its coordinates in memory.
//
// The 32 Hz re-mine changed what a tape file is. v1 was landmarks -- a few
// dozen [t, anchorId] pairs per role, so a whole map fitted in 40 MB and the
// loader could read the file into a string and parse it. v2 records where the
// pro actually stood and looked, every second tick, for the whole round:
//
//   full   152,692 B/entry        light      3,075 B/entry
//   paths are 98% of the file     71.5s of coordinates per role
//
// which took the corpus from 212 MB to 9.13 GB and broke two limits at once:
//
//   1. readFile(file, 'utf8') throws above MAX_STRING_LENGTH (0.54 GB). Six
//      of seven maps are over it. The old loader caught that and fell through
//      to the shipped v1 file, so the re-mine would have been silently
//      invisible -- bots still steering by landmarks, nothing reporting a
//      fault.
//   2. Parsed, 9.13 GB of JSON becomes ~15 GB of JS arrays. No cap raise
//      fixes that one.
//
// Neither needs fixing, because neither is necessary. A round pins ONE tape.
// The picker matches on side, call, econ and clock -- the 2% -- and only the
// pinned tape's coordinates are ever read. So this keeps the light half in
// memory and leaves the paths on disk, fetched by byte offset at pin time:
//
//   <map>.jsonl        untouched, the source of truth, written by the miner
//   <map>.meta.jsonl   entries with "path":null and a [offset, length] each
//
// Hydration is SYNCHRONOUS on purpose. `pathAt` is called from inside the
// engine's tick loop, which has no way to await, so this uses readSync on a
// held descriptor: ~150 KB, once per pinned tape, off the page cache.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Bump when the sidecar's shape changes; a mismatch rebuilds it. */
export const META_VERSION = 2;

/** Bytes per read while scanning. Big enough that syscalls stop mattering. */
const CHUNK = 1 << 22;

/**
 * Hydrated tapes kept before the oldest is dropped back to disk.
 *
 * A round uses one tape, so this is roughly 500 rounds of slack on a working
 * set of one. Generous because dropping a tape a bot is still following would
 * silently demote it to landmark steering, and the memory is ~150 KB each.
 */
const HYDRATE_CAP = 512;

/**
 * Below this, scan and keep the offsets in memory rather than writing a
 * sidecar.
 *
 * The shipped v1 tapes are 8-46 MB and scan in well under a second, so a
 * sidecar buys nothing and costs a derived file sitting in a committed
 * directory looking like something a human wrote.
 */
const MIN_SIDECAR_BYTES = 256 * 1024 * 1024;

const NL = 0x0a;

/**
 * Cut the coordinate arrays out of a tape line without parsing them.
 *
 * The alternative is JSON.parse on 150 KB per entry and then throwing 98% of
 * the result away, which is ~50x the work on a 9 GB scan. Safe to do
 * textually: a path array holds only digits, commas and minus signs, so the
 * first `]` after it is its own, and no string field in a tape can contain
 * the key -- they are ids, steam ids, contract and call names.
 */
function stripPaths(line) {
  const KEY = '"path":[';
  let i = line.indexOf(KEY);
  if (i < 0) return { line, samples: null };
  let out = '';
  let from = 0;
  // Sample count per stripped path, in occurrence order — which is role
  // order, because every v2 role serialises its own path key. The light
  // entry keeps the LENGTH of what was cut so tapeEndSeconds can price a
  // tape's reach without hydrating it.
  const samples = [];
  while (i >= 0) {
    const end = line.indexOf(']', i + KEY.length);
    if (end < 0) break;
    const inner = line.slice(i + KEY.length, end);
    let values = 0;
    if (inner.length) {
      values = 1;
      for (let c = inner.indexOf(','); c >= 0; c = inner.indexOf(',', c + 1)) values += 1;
    }
    samples.push(Math.floor(values / 3));
    out += `${line.slice(from, i)}"path":null`;
    from = end + 1;
    i = line.indexOf(KEY, from);
  }
  return { line: out + line.slice(from), samples };
}

function metaPathFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  return path.join(dir, `${base}.meta.jsonl`);
}

/**
 * Scan a tape file once, writing the light sidecar beside it.
 *
 * Streams in fixed chunks and splits on 0x0A rather than using readline,
 * because the byte offset of each line IS the index -- without it there is
 * nothing to seek to later. Splitting on the raw byte is safe in UTF-8: 0x0A
 * never appears inside a multi-byte sequence.
 *
 * @param {string} file
 * @param {(p: {bytes: number, total: number, entries: number}) => void} [onProgress]
 * @returns {Promise<{entries: object[], wrote: boolean}>}
 */
export async function buildMeta(file, onProgress = null) {
  const st = await fsp.stat(file);
  const metaFile = metaPathFor(file);
  const tmp = `${metaFile}.tmp`;

  const keep = st.size >= MIN_SIDECAR_BYTES;
  const fh = await fsp.open(file, 'r');
  const out = keep ? fs.createWriteStream(tmp, { encoding: 'utf8' }) : null;
  const write = (s) => {
    if (!out) return Promise.resolve();
    return out.write(s) ? Promise.resolve() : new Promise((r) => out.once('drain', r));
  };

  const entries = [];
  let ok = false;
  try {
    await write(`${JSON.stringify({ v: META_VERSION, size: st.size, mtimeMs: st.mtimeMs })}\n`);

    const buf = Buffer.allocUnsafe(CHUNK);
    let leftover = null;
    let base = 0; // byte offset in the file of leftover's first byte
    let pos = 0;
    let lastReport = 0;

    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      if (leftover) {
        chunk = Buffer.concat([leftover, chunk]);
        leftover = null;
      }

      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(NL, from);
        if (nl < 0) break;
        const off = base + from;
        const len = nl - from;
        if (len > 1) {
          // trimEnd, because a file written with CRLF would otherwise leave a
          // stray \r inside the record. The offset and length stay measured
          // against the RAW bytes: that is what hydration seeks to, and
          // JSON.parse tolerates the trailing whitespace on the way back.
          const stripped = stripPaths(chunk.toString('utf8', from, nl).trimEnd());
          const e = JSON.parse(stripped.line);
          if (e?.roles) {
            // The reach of the cut path, in seconds, stamped per role: the
            // matcher prices "does this tape still have anything to say at
            // this clock" from the light entry alone (tapeEndSeconds).
            if (stripped.samples) {
              for (let r = 0; r < e.roles.length && r < stripped.samples.length; r += 1) {
                const hz = e.roles[r]?.pathHz;
                if (hz > 0 && stripped.samples[r] > 0) {
                  e.roles[r].pathSeconds = Math.round(stripped.samples[r] / hz);
                }
              }
            }
            e._at = [off, len];
            entries.push(e);
            // Re-serialised rather than spliced. Appending the offset by
            // string surgery means trusting the last byte to be `}`, and the
            // cost of being sure is a 3 KB stringify per entry.
            await write(`${JSON.stringify(e)}\n`);
          }
        }
        from = nl + 1;
      }
      base += from;
      if (from < chunk.length) leftover = Buffer.from(chunk.subarray(from));

      if (onProgress && pos - lastReport > CHUNK * 16) {
        lastReport = pos;
        onProgress({ bytes: pos, total: st.size, entries: entries.length });
      }
    }
    ok = true;
  } finally {
    await fh.close();
    if (out) await new Promise((r) => out.end(r));
  }

  // Rename only on a clean scan: a half-written sidecar whose header still
  // matches would look authoritative and serve a truncated corpus forever.
  if (!ok || !keep) {
    if (out) await fsp.rm(tmp, { force: true });
    if (ok && onProgress) onProgress({ bytes: st.size, total: st.size, entries: entries.length });
    return { entries, wrote: false };
  }
  let wrote = true;
  try {
    await fsp.rename(tmp, metaFile);
  } catch {
    // A read-only source dir (a deploy serving simdata/) is fine: the entries
    // are already in hand, the next boot just pays for the scan again.
    await fsp.rm(tmp, { force: true }).catch(() => {});
    wrote = false;
  }
  if (onProgress) onProgress({ bytes: st.size, total: st.size, entries: entries.length });
  return { entries, wrote };
}

/** Read the sidecar, or null when it is missing or no longer describes `file`. */
async function readMeta(file) {
  const metaFile = metaPathFor(file);
  let text;
  let st;
  try {
    [text, st] = await Promise.all([fsp.readFile(metaFile, 'utf8'), fsp.stat(file)]);
  } catch {
    return null;
  }
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  let header;
  try {
    header = JSON.parse(text.slice(0, nl));
  } catch {
    return null;
  }
  // The offsets are only meaningful against the exact file they were taken
  // from; a re-mine invalidates every one of them.
  if (header?.v !== META_VERSION || header.size !== st.size || header.mtimeMs !== st.mtimeMs) {
    return null;
  }
  const entries = [];
  let from = nl + 1;
  for (;;) {
    const end = text.indexOf('\n', from);
    const line = text.slice(from, end < 0 ? undefined : end);
    if (line.trim()) {
      const e = JSON.parse(line);
      if (e?.roles) entries.push(e);
    }
    if (end < 0) break;
    from = end + 1;
  }
  return entries;
}

/**
 * Open a tape file for querying.
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]  reported only when scanning
 * @returns {Promise<{entries: object[], hydrate: (e: object) => object, close: () => void, scanned: boolean}>}
 */
export async function openPlaybookFile(file, { onProgress = null } = {}) {
  let entries = await readMeta(file);
  const scanned = !entries;
  if (!entries) ({ entries } = await buildMeta(file, onProgress));

  let fd = null;
  let buf = null;
  const live = [];

  /**
   * Attach this entry's coordinates, reading them off disk.
   *
   * Idempotent, and safe to call on a v1 entry (nothing to attach) or after
   * the entry has been dropped (it is simply re-read).
   */
  const hydrate = (entry) => {
    if (!entry || entry._hot || !Array.isArray(entry._at)) return entry;
    const [off, len] = entry._at;
    try {
      if (fd === null) fd = fs.openSync(file, 'r');
      if (!buf || buf.length < len) buf = Buffer.allocUnsafe(Math.max(len, 1 << 18));
      const n = fs.readSync(fd, buf, 0, len, off);
      const full = JSON.parse(buf.toString('utf8', 0, n));
      const roles = entry.roles || [];
      const fullRoles = full?.roles || [];
      for (let i = 0; i < roles.length; i += 1) {
        const p = fullRoles[i]?.path;
        if (Array.isArray(p)) roles[i].path = p;
      }
      entry._hot = true;
      live.push(entry);
    } catch {
      // Falling back to the landmark waypoints is a real answer -- degraded,
      // not broken -- so a bad read costs precision, not the round.
      return entry;
    }
    while (live.length > HYDRATE_CAP) {
      const old = live.shift();
      if (old === entry) continue;
      old._hot = false;
      for (const r of old.roles || []) r.path = null;
    }
    return entry;
  };

  const close = () => {
    if (fd !== null) fs.closeSync(fd);
    fd = null;
    buf = null;
  };

  return { entries, hydrate, close, scanned };
}
