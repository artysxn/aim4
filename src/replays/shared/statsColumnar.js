// ---------------------------------------------------------------------------
// replays/shared/statsColumnar.js
// A columnar container for one demo's stats index.
//
// The stored index is a single JSON blob, so the server must parse all of it to
// answer any question about it. Measured on a 4100-demo library: 6.6 s of
// JSON.parse to produce a 99 MB projected response — the parse dominates, and
// no amount of response projection touches it, because the columns are
// interleaved in the text.
//
// Layout, one file per demo:
//
//   [4]  magic "A4C1"
//   [4]  header length, big-endian uint32
//   [n]  header JSON — identity, roster, per-round identity columns, and a
//        directory of {group: [offset, length]} into the block region
//   [..] blocks, one per column group, each columnar: {key: [perRound…]}
//
// Reading a contract seeks to just its blocks. Identity lives in the header
// because every read needs it and it is small.
//
// The format is deliberately dumb — JSON inside each block, not a bespoke
// binary encoding. The win is *not* reading the bytes you do not need; packing
// them tighter is a later concern, and keeping blocks as JSON means a block can
// be inspected with a text editor when something looks wrong.
// ---------------------------------------------------------------------------

import {
  COLUMN_GROUPS,
  IDENTITY_ENTRY_KEYS,
  IDENTITY_ROW_KEYS
} from './statsColumns.js';

export const COLUMNAR_MAGIC = 0x41344331; // "A4C1"
export const COLUMNAR_VERSION = 1;

/**
 * Pack one stats index entry.
 *
 * @param {object} entry
 * @param {{ stamp?: string }} [opts] `stamp` identifies the source this was
 *   built from; a reader compares it and falls back when it no longer matches.
 * @returns {Uint8Array}
 */
export function encodeColumnar(entry, opts = {}) {
  const rounds = Array.isArray(entry?.rounds) ? entry.rounds : [];
  const dir = {};
  const header = {
    cv: COLUMNAR_VERSION,
    stamp: String(opts.stamp || ''),
    nRounds: rounds.length,
    groups: dir,
    // Which groups actually carry data. A group can be absent from an older
    // index; the reader must be able to tell that apart from "not requested".
    have: []
  };
  for (const k of IDENTITY_ENTRY_KEYS) {
    if (entry[k] !== undefined) header[k] = entry[k];
  }
  header.rows = rounds.map((r) => {
    const o = {};
    for (const k of IDENTITY_ROW_KEYS) if (r[k] !== undefined) o[k] = r[k];
    return o;
  });

  const encoder = new TextEncoder();
  const blocks = [];
  let offset = 0;
  for (const [name, def] of Object.entries(COLUMN_GROUPS)) {
    const payload = {};
    let present = false;
    for (const k of def.rows) {
      const col = rounds.map((r) => (r[k] === undefined ? null : r[k]));
      if (col.some((v) => v !== null)) present = true;
      payload[k] = col;
    }
    for (const k of def.entry || []) {
      if (entry[k] !== undefined) {
        payload[k] = entry[k];
        present = true;
      }
    }
    const buf = encoder.encode(JSON.stringify(payload));
    dir[name] = [offset, buf.length];
    if (present) header.have.push(name);
    offset += buf.length;
    blocks.push(buf);
  }

  const headerBuf = encoder.encode(JSON.stringify(header));
  const total = 8 + headerBuf.length + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, COLUMNAR_MAGIC);
  view.setUint32(4, headerBuf.length);
  out.set(headerBuf, 8);
  let at = 8 + headerBuf.length;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/**
 * Read the header alone. Cheap: it never touches the block region, so a
 * staleness check costs one small read rather than a parse of the whole demo.
 *
 * @param {Uint8Array} bytes at least the first 8 + headerLength bytes
 * @returns {{ header: object, blockBase: number } | null}
 */
export function decodeHeader(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== COLUMNAR_MAGIC) return null;
  const hLen = view.getUint32(4);
  if (bytes.length < 8 + hLen) return null;
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hLen)));
  } catch {
    return null;
  }
  if (header?.cv !== COLUMNAR_VERSION) return null;
  return { header, blockBase: 8 + hLen };
}

/** Byte range of one group's block, or null when the file has no such group. */
export function blockRange(header, blockBase, group) {
  const loc = header?.groups?.[group];
  if (!Array.isArray(loc) || !loc[1]) return null;
  return { start: blockBase + loc[0], length: loc[1] };
}

/**
 * Rebuild an entry from a header plus the blocks a contract asked for.
 *
 * @param {object} header
 * @param {Map<string, string>} blockText  group id → decoded block JSON text
 * @returns {object} entry shaped exactly like a projected stats index
 */
export function assembleEntry(header, blockText) {
  const entry = { rounds: (header.rows || []).map((r) => ({ ...r })) };
  for (const k of IDENTITY_ENTRY_KEYS) {
    if (header[k] !== undefined) entry[k] = header[k];
  }
  for (const [group, text] of blockText) {
    let cols;
    try {
      cols = JSON.parse(text);
    } catch {
      continue;
    }
    const def = COLUMN_GROUPS[group];
    if (!def) continue;
    for (const k of def.rows) {
      const col = cols[k];
      if (!Array.isArray(col)) continue;
      for (let i = 0; i < entry.rounds.length && i < col.length; i++) {
        if (col[i] !== null) entry.rounds[i][k] = col[i];
      }
    }
    for (const k of def.entry || []) {
      if (cols[k] !== undefined && cols[k] !== null) entry[k] = cols[k];
    }
  }
  // Legacy geography flags the aggregator still reads.
  entry.positions = false;
  entry.pz = 0;
  return entry;
}
