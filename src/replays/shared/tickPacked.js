// ---------------------------------------------------------------------------
// replays/shared/tickPacked.js
// The columnar transform for tick rows, defined once for both directions.
//
// Interleaved, a player's x sits 160 bytes from its next value and every byte
// between it belongs to someone else. Transposed into per-slot, per-field
// streams of zigzag varint deltas, consecutive bytes are the same quantity
// moving smoothly, and the fields that barely move (health, armor, weapon,
// side are constant for nearly a whole round) collapse into long runs of zeros.
// That is what makes a round compress ~13x instead of ~4x.
//
// It is shared rather than duplicated because both sides have to agree byte for
// byte: the server's .tickz blocks and the /ticks?fmt=packed wire body are the
// same transform, and a field table that drifted between writer and reader
// would decode into plausible-looking garbage rather than fail.
//
// The wire container adds a fixed prefix so a response is self-describing:
//
//    0  u32     magic "A4TP"
//    4  u16     version
//    6  u16     reserved
//    8  u8[32]  the source tickFormat header, copied verbatim
//   40  ..      the varint stream
//
// The header is copied rather than rebuilt for the same reason tickCodec copies
// it: a straight copy cannot drift from what the writer produced.
// ---------------------------------------------------------------------------

import { HEADER_BYTES, RECORD_BYTES, PLAYER_SLOTS, TICK_BYTES } from './tickFormat.js';

export const PACKED_MAGIC = 0x50543441; // "A4TP" in a hex dump
export const PACKED_VERSION = 1;
export const PACKED_PREFIX_BYTES = 40;
const PACKED_HEADER_AT = 8;

/**
 * One player record, field by field. Order here is the order the columns are
 * written in, so it is part of the format: appending is fine, reordering is a
 * version bump.
 */
export const FIELDS = [
  { off: 0, size: 2, signed: true }, // x
  { off: 2, size: 2, signed: true }, // y
  { off: 4, size: 2, signed: true }, // z
  { off: 6, size: 2, signed: true }, // yaw
  { off: 8, size: 2, signed: true }, // pitch
  { off: 10, size: 1, signed: false }, // health
  { off: 11, size: 1, signed: false }, // armor
  { off: 12, size: 1, signed: false }, // weapon
  { off: 13, size: 1, signed: false }, // flags
  { off: 14, size: 1, signed: false }, // flash
  { off: 15, size: 1, signed: false } // side
];

// A field list that does not cover the record exactly would drop bytes on the
// floor and still round-trip most of a round, so it is checked at load.
{
  const covered = FIELDS.reduce((n, f) => n + f.size, 0);
  if (covered !== RECORD_BYTES) {
    throw new Error(`tickPacked: FIELDS cover ${covered} bytes, record is ${RECORD_BYTES}`);
  }
}

/** Widest a zigzag varint can get here: i16 deltas span 17 bits -> 3 bytes. */
export const MAX_VARINT = 3;

/** Upper bound on the packed size of `rows` tick rows. */
export const packedCapacity = (rows) => rows * PLAYER_SLOTS * FIELDS.length * MAX_VARINT;

/**
 * Transpose tick rows into per-slot, per-field streams of zigzag varint deltas.
 *
 * @param {Uint8Array} rowBytes  tick rows ONLY, no tickFormat header
 * @param {number} rows
 * @param {Uint8Array} [into]    reusable scratch of at least packedCapacity(rows)
 * @returns {Uint8Array} a view into `into` (or a fresh array) of exactly the
 *   bytes written — not a copy, so treat it as borrowed
 */
export function packColumnar(rowBytes, rows, into = null) {
  const out = into || new Uint8Array(packedCapacity(rows));
  const view = new DataView(rowBytes.buffer, rowBytes.byteOffset, rowBytes.byteLength);
  let p = 0;
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    const base = slot * RECORD_BYTES;
    for (const f of FIELDS) {
      let prev = 0;
      const two = f.size === 2;
      for (let r = 0; r < rows; r++) {
        const o = r * TICK_BYTES + base + f.off;
        const v = two ? view.getInt16(o, true) : rowBytes[o];
        const d = v - prev;
        prev = v;
        // Zigzag so that -1 costs one byte instead of five.
        let z = ((d << 1) ^ (d >> 31)) >>> 0;
        while (z >= 0x80) {
          out[p++] = (z & 0x7f) | 0x80;
          z >>>= 7;
        }
        out[p++] = z;
      }
    }
  }
  return out.subarray(0, p);
}

/**
 * Undo packColumnar into an existing buffer.
 *
 * Writing into a caller-owned buffer at an offset is what lets the same
 * implementation serve both readers: tickCodec unpacks a block at offset 0,
 * while the viewer unpacks a whole round straight after the 32-byte header it
 * has already copied in.
 *
 * @param {Uint8Array} packed
 * @param {number} rows
 * @param {Uint8Array} out
 * @param {number} [outOffset]
 */
export function unpackColumnarInto(packed, rows, out, outOffset = 0) {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let p = 0;
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    const base = slot * RECORD_BYTES;
    for (const f of FIELDS) {
      let prev = 0;
      const two = f.size === 2;
      for (let r = 0; r < rows; r++) {
        let z = 0;
        let shift = 0;
        for (;;) {
          const b = packed[p++];
          z |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        z >>>= 0;
        const v = prev + ((z >>> 1) ^ -(z & 1));
        prev = v;
        const o = outOffset + r * TICK_BYTES + base + f.off;
        if (two) view.setInt16(o, v, true);
        else out[o] = v & 0xff;
      }
    }
  }
  return out;
}

// ---- wire container ---------------------------------------------------------

/** True when `buf` opens with the packed wire magic. */
export function isPacked(buf) {
  const b = asBytes(buf);
  if (b.length < PACKED_PREFIX_BYTES) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return dv.getUint32(0, true) === PACKED_MAGIC;
}

/**
 * Wrap a whole tickFormat v1 buffer as a packed wire body.
 *
 * @param {ArrayBuffer|Uint8Array} source  a full tickFormat buffer
 * @param {number} rows                    source header's tickCount
 * @returns {Uint8Array}
 */
export function encodePacked(source, rows) {
  const src = asBytes(source);
  const body = packColumnar(src.subarray(HEADER_BYTES), rows);
  const out = new Uint8Array(PACKED_PREFIX_BYTES + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PACKED_MAGIC, true);
  dv.setUint16(4, PACKED_VERSION, true);
  out.set(src.subarray(0, HEADER_BYTES), PACKED_HEADER_AT);
  out.set(body, PACKED_PREFIX_BYTES);
  return out;
}

/**
 * Undo encodePacked, back to the exact tickFormat v1 bytes it was built from.
 *
 * @param {ArrayBuffer|Uint8Array} source
 * @returns {ArrayBuffer}
 */
export function decodePacked(source) {
  const b = asBytes(source);
  if (!isPacked(b)) throw new Error('tickPacked: bad magic, not a packed tick body');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== PACKED_VERSION) {
    throw new Error(`tickPacked: unsupported version ${version}`);
  }
  // tickCount lives at offset 8 of the tickFormat header, which sits at 8 here.
  const rows = dv.getUint32(PACKED_HEADER_AT + 8, true);
  const out = new Uint8Array(HEADER_BYTES + rows * TICK_BYTES);
  out.set(b.subarray(PACKED_HEADER_AT, PACKED_HEADER_AT + HEADER_BYTES), 0);
  unpackColumnarInto(b.subarray(PACKED_PREFIX_BYTES), rows, out, HEADER_BYTES);
  return out.buffer;
}

function asBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
