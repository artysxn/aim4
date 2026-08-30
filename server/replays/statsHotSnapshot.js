// ---------------------------------------------------------------------------
// replays/statsHotSnapshot.js
// The packed store, on disk, so a deploy does not cold-build it.
//
// The cold build after every deploy is the last expensive window the hot store
// has: minutes of background CPU re-deriving a few hundred MB of columns from
// thousands of index files, during the busiest minute of the process's life,
// while /aggregate answers 503 and every client rides the slow paged path.
// The columns themselves are flat typed arrays — the one shape that costs
// nothing to write and nothing to parse. So they are written once after a
// build and read back at the next boot: one sequential file read instead of
// the library walk.
//
// This is a CACHE with the same contract the .a4c sidecars have: any doubt —
// wrong magic, wrong layout, a library that moved on too far — and the file is
// ignored, which lands the process exactly where it is today (background
// build, 503 until warm). A bad snapshot can cost the speedup; it can never
// cost a wrong answer, because validation happens before a byte of it reaches
// the cache.
//
// Format: magic, u32 header length, JSON header, then each column's raw bytes
// in the order the header names them. The header carries everything that is
// not a typed array (demo identities, interner tables, the record keys the
// store covers) plus a layout stamp — field lists joined verbatim — so a code
// change that reshapes any vector silently invalidates every older file.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import {
  AIM_FIELDS,
  AIM_MOTION_WIDTH,
  DUEL_BUCKETS,
  R3_FIELDS,
  SEAT,
  UTILITY_FIELDS,
  createInterner
} from './statsHotStore.js';

const MAGIC = 'A4S1';

/**
 * What the columns MEAN, not just how wide they are. Any change to the packed
 * vectors changes one of these strings, and a mismatch discards the file.
 */
function layoutStamp() {
  return {
    seat: SEAT,
    duelBuckets: DUEL_BUCKETS,
    r3: R3_FIELDS.join('|'),
    aim: AIM_FIELDS.join('|'),
    // Width, not names: the motion vector is packed and read back by index.
    // Any change to its length is a different statistic in the same slots.
    motion: `a2:${AIM_MOTION_WIDTH}`,
    util: UTILITY_FIELDS.join('|'),
    // The round-library tag run: off/len per round into key/side/clock. Named
    // here so every snapshot written before the tags existed is discarded — the
    // columns are read back by name, and a store missing them would answer a
    // call filter with "no round has ever made that call".
    tags: 'off|len:key|side|at'
  };
}

const CTORS = {
  Int8Array,
  Uint8Array,
  Int32Array,
  Float32Array,
  Float64Array
};

const INTERNERS = ['maps', 'sides', 'players', 'names', 'files', 'tags'];

/** Column keys in the store, in a fixed serialization order. */
function columnKeys(store) {
  return Object.keys(store).filter((k) => ArrayBuffer.isView(store[k]));
}

/**
 * Write the store to `file`, atomically.
 *
 * The columns go to a temp file first and rename claims the real name only
 * after everything is on disk, so a crash mid-write leaves the previous
 * snapshot (or nothing) — never a torn file that load would have to distrust.
 *
 * @param {string} file
 * @param {object} store  a finished store
 * @param {Iterable<string>} ids  record keys this store covers
 */
export async function saveSnapshot(file, store, ids) {
  const columns = columnKeys(store).map((name) => ({
    name,
    ctor: store[name].constructor.name,
    bytes: store[name].byteLength
  }));
  const header = {
    v: 1,
    layout: layoutStamp(),
    nRounds: store.nRounds,
    nSeats: store.nSeats,
    nTags: store.nTags || 0,
    seatsPerRound: store.seatsPerRound,
    duelStride: store.duelStride,
    savedAt: Date.now(),
    ids: [...ids],
    demos: store.demos,
    interners: Object.fromEntries(INTERNERS.map((k) => [k, store[k].values])),
    columns
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(8);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(headerBuf.length, 4);

  const tmp = `${file}.tmp-${process.pid}`;
  const out = createWriteStream(tmp);
  const write = (buf) => (out.write(buf) ? Promise.resolve() : new Promise((r) => out.once('drain', r)));
  try {
    await write(prefix);
    await write(headerBuf);
    for (const { name } of columns) {
      const v = store[name];
      // A zero-copy view over the column's exact bytes; subarray-backed
      // columns share a buffer with their packer, so offset and length matter.
      await write(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    }
    out.end();
    await finished(out);
    await fsp.rename(tmp, file);
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return prefix.length + headerBuf.length + columns.reduce((n, c) => n + c.bytes, 0);
}

/**
 * Read a snapshot back, or null for "no usable snapshot" — absent, torn,
 * or written by code with a different column layout. Never throws for a bad
 * file: the caller's fallback is a rebuild, and that must not need a catch.
 *
 * @param {string} file
 * @returns {Promise<{ store: object, ids: string[], savedAt: number }|null>}
 */
export async function loadSnapshot(file) {
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch {
    return null;
  }
  try {
    if (buf.length < 8 || buf.toString('ascii', 0, 4) !== MAGIC) return null;
    const headerLen = buf.readUInt32LE(4);
    if (8 + headerLen > buf.length) return null;
    const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen));
    if (header.v !== 1) return null;
    const want = layoutStamp();
    const got = header.layout || {};
    for (const k of Object.keys(want)) if (got[k] !== want[k]) return null;

    const store = {
      nRounds: header.nRounds,
      nSeats: header.nSeats,
      nTags: header.nTags || 0,
      seatsPerRound: header.seatsPerRound,
      duelStride: header.duelStride,
      demos: header.demos
    };
    for (const k of INTERNERS) {
      const it = createInterner();
      for (const v of header.interners[k] || []) it.id(v);
      store[k] = it;
    }
    let off = 8 + headerLen;
    let bytes = 0;
    for (const { name, ctor, bytes: len } of header.columns) {
      const Ctor = CTORS[ctor];
      if (!Ctor || off + len > buf.length) return null;
      // Copied out rather than viewed in place: Float64Array views need 8-byte
      // alignment the file offset does not guarantee, and the file buffer
      // should be collectable once the store is live.
      const col = new Ctor(len / Ctor.BYTES_PER_ELEMENT);
      Buffer.from(col.buffer).set(buf.subarray(off, off + len));
      store[name] = col;
      off += len;
      bytes += len;
    }
    store.bytes = bytes;
    return { store, ids: header.ids || [], savedAt: header.savedAt || 0 };
  } catch {
    return null;
  }
}
