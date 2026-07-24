// ---------------------------------------------------------------------------
// replays/shared/tickFormat.js
// The on-disk / on-wire layout for per-tick player state, defined once and
// shared by the writer (backend parser) and the reader (viewer). Everything
// is fixed-width so any tick can be addressed arithmetically, which is what
// lets the timeline's first pass ask for "every 100th tick" and get a strided
// read instead of a full file scan.
//
//   [ 32 byte header ][ tick 0: 10 player records ][ tick 1: ... ] ...
//
// One player record is 16 bytes:
//   0  x      int16   position, quantized (POS_SCALE units per game unit)
//   2  y      int16
//   4  z      int16
//   6  yaw    int16   view angle, ANGLE_SCALE hundredths of a degree
//   8  pitch  int16
//  10  health uint8
//  11  armor  uint8
//  12  weapon uint8   index into the round's weapon dictionary
//  13  flags  uint8   see FLAG_*
//  14  flash  uint8   remaining flash blind, 20ths of a second, capped
//  15  --     uint8   reserved
//
// A 110 second round at 64 tick is ~7000 ticks -> 1.1 MB for all ten players;
// the same round at stride 100 is ~11 KB, which is why the coarse pass over a
// whole match feels instant.
// ---------------------------------------------------------------------------

export const TICK_MAGIC = 0x41345254; // "A4RT"
export const TICK_VERSION = 1;

export const HEADER_BYTES = 32;
export const RECORD_BYTES = 16;
export const PLAYER_SLOTS = 10;
export const TICK_BYTES = RECORD_BYTES * PLAYER_SLOTS;

/** Positions are stored in quarter units: +/- 8191 game units. */
export const POS_SCALE = 4;
/** Angles are stored in hundredths of a degree. */
export const ANGLE_SCALE = 100;
/** Flash time is stored in 20ths of a second, saturating at 255 (12.75 s). */
export const FLASH_SCALE = 20;

export const FLAG_ALIVE = 1 << 0;
export const FLAG_DUCKING = 1 << 1;
export const FLAG_SCOPED = 1 << 2;
export const FLAG_DEFUSING = 1 << 3;
export const FLAG_PLANTING = 1 << 4;
export const FLAG_HAS_BOMB = 1 << 5;
export const FLAG_AIRBORNE = 1 << 6;
export const FLAG_HAS_HELMET = 1 << 7;

const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v || 0)));
const clampU8 = (v) => Math.max(0, Math.min(255, Math.round(v || 0)));

/**
 * @typedef {object} TickHeader
 * @property {number} version
 * @property {number} tickCount   number of tick rows in this buffer
 * @property {number} firstTick   demo tick of row 0
 * @property {number} stride      demo ticks between consecutive rows (1 = full)
 * @property {number} tickRate    demo ticks per second
 * @property {number} playerCount slots actually filled (<= PLAYER_SLOTS)
 */

export function writeHeader(view, header) {
  view.setUint32(0, TICK_MAGIC, true);
  view.setUint16(4, TICK_VERSION, true);
  view.setUint16(6, RECORD_BYTES, true);
  view.setUint32(8, header.tickCount >>> 0, true);
  view.setInt32(12, header.firstTick | 0, true);
  view.setUint32(16, Math.max(1, header.stride | 0), true);
  view.setUint16(20, header.tickRate || 64, true);
  view.setUint8(22, Math.min(PLAYER_SLOTS, header.playerCount || PLAYER_SLOTS));
  view.setUint8(23, PLAYER_SLOTS);
  // bytes 24-31 reserved
}

export function readHeader(buffer) {
  const view = buffer instanceof DataView ? buffer : new DataView(toArrayBuffer(buffer));
  const magic = view.getUint32(0, true);
  if (magic !== TICK_MAGIC) throw new Error('tickFormat: bad magic, not a tick buffer');
  const version = view.getUint16(4, true);
  if (version !== TICK_VERSION) {
    throw new Error(`tickFormat: unsupported version ${version} (expected ${TICK_VERSION})`);
  }
  return {
    version,
    recordBytes: view.getUint16(6, true),
    tickCount: view.getUint32(8, true),
    firstTick: view.getInt32(12, true),
    stride: view.getUint32(16, true),
    tickRate: view.getUint16(20, true),
    playerCount: view.getUint8(22),
    slots: view.getUint8(23) || PLAYER_SLOTS
  };
}

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  // Node Buffer / typed array view.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Byte offset of one player's record inside a tick buffer. */
export function recordOffset(row, slot) {
  return HEADER_BYTES + row * TICK_BYTES + slot * RECORD_BYTES;
}

export function totalBytes(tickCount) {
  return HEADER_BYTES + tickCount * TICK_BYTES;
}

/**
 * Write one player's state. `state` uses game units and degrees; quantization
 * happens here so no caller has to know the encoding.
 */
export function writeRecord(view, row, slot, state) {
  const o = recordOffset(row, slot);
  view.setInt16(o + 0, clampI16((state.x || 0) * POS_SCALE), true);
  view.setInt16(o + 2, clampI16((state.y || 0) * POS_SCALE), true);
  view.setInt16(o + 4, clampI16((state.z || 0) * POS_SCALE), true);
  view.setInt16(o + 6, clampI16(wrapAngle(state.yaw) * ANGLE_SCALE), true);
  view.setInt16(o + 8, clampI16((state.pitch || 0) * ANGLE_SCALE), true);
  view.setUint8(o + 10, clampU8(state.health));
  view.setUint8(o + 11, clampU8(state.armor));
  view.setUint8(o + 12, clampU8(state.weapon));
  view.setUint8(o + 13, clampU8(state.flags));
  view.setUint8(o + 14, clampU8((state.flash || 0) * FLASH_SCALE));
}

/**
 * Read one player's state back into game units. Reuses `out` when given so
 * the renderer can walk a whole tick without allocating ten objects a frame.
 */
export function readRecord(view, row, slot, out = {}) {
  const o = recordOffset(row, slot);
  out.x = view.getInt16(o + 0, true) / POS_SCALE;
  out.y = view.getInt16(o + 2, true) / POS_SCALE;
  out.z = view.getInt16(o + 4, true) / POS_SCALE;
  out.yaw = view.getInt16(o + 6, true) / ANGLE_SCALE;
  out.pitch = view.getInt16(o + 8, true) / ANGLE_SCALE;
  out.health = view.getUint8(o + 10);
  out.armor = view.getUint8(o + 11);
  out.weapon = view.getUint8(o + 12);
  out.flags = view.getUint8(o + 13);
  out.flash = view.getUint8(o + 14) / FLASH_SCALE;
  out.alive = (out.flags & FLAG_ALIVE) !== 0;
  return out;
}

export function wrapAngle(deg) {
  let a = Number(deg) || 0;
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a;
}

/**
 * Shortest-path angular interpolation, so a droplet spinning past 180 degrees
 * turns the short way instead of whipping around the compass.
 */
export function lerpAngle(a, b, t) {
  const delta = wrapAngle(b - a);
  return wrapAngle(a + delta * t);
}

/**
 * Extract every Nth row into a fresh, self-describing buffer. Used by the
 * backend to answer coarse-pass requests without decoding anything: it is a
 * pure memcpy of the rows the client asked for.
 */
export function sliceStride(source, stride, srcHeader = null) {
  const header = srcHeader || readHeader(source);
  const step = Math.max(1, stride | 0);
  const src = source instanceof DataView ? source : new DataView(toArrayBuffer(source));
  const rows = step === 1 ? header.tickCount : Math.ceil(header.tickCount / step);
  const out = new ArrayBuffer(totalBytes(rows));
  const dst = new DataView(out);
  writeHeader(dst, {
    tickCount: rows,
    firstTick: header.firstTick,
    stride: header.stride * step,
    tickRate: header.tickRate,
    playerCount: header.playerCount
  });
  const srcBytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  const dstBytes = new Uint8Array(out);
  for (let i = 0; i < rows; i++) {
    const from = HEADER_BYTES + i * step * TICK_BYTES;
    dstBytes.set(srcBytes.subarray(from, from + TICK_BYTES), HEADER_BYTES + i * TICK_BYTES);
  }
  return out;
}
