// ---------------------------------------------------------------------------
// replays/tickCodec.js
// Compressed container for round tick buffers: ".tickz" on disk in place of
// ".bin", decoded back to a byte-identical tickFormat v1 buffer on read.
//
// The point is archival size, not a new wire format. Nothing above
// readRoundTicks() ever sees a .tickz — the viewer, the stats index and the
// analytics all keep receiving exactly the bytes writeRound() used to store,
// which is why none of src/ changes. decode(encode(x)) === x is asserted by
// scripts/compact-replays.mjs before any .bin is deleted.
//
// Why blocks rather than one compressed stream: the tick buffer is addressed
// arithmetically (recordOffset(row, slot)), and a single stream would force a
// full decompress to reach any row. Blocks of 512 ticks keep the seek cost at
// one block, ~82 KB raw.
//
// Layout:
//    0  u32       magic "A4TZ"
//    4  u16       container version
//    6  u8        codec (see CODEC_*)
//    7  u8        reserved
//    8  u16       ticks per block
//   10  u16       reserved
//   12  u32       block count
//   16  u8[32]    the source tickFormat header, copied verbatim
//   48  u32[n]    compressed length of each block
//   ..            the blocks, back to back
//
// The source header is stored verbatim rather than re-derived. Rebuilding it
// through writeHeader() would round-trip a playerCount of 0 into 10 and would
// silently normalize anything a future writer puts in the reserved bytes; a
// straight copy cannot drift from the original no matter what wrote it.
// ---------------------------------------------------------------------------

import zlib from 'node:zlib';
import {
  HEADER_BYTES,
  TICK_BYTES,
  readHeader
} from '../../src/replays/shared/tickFormat.js';
import {
  packColumnar,
  packedCapacity,
  unpackColumnarInto
} from '../../src/replays/shared/tickPacked.js';

export const TICKZ_MAGIC = 0x5a543441; // "A4TZ" in a hex dump
export const TICKZ_VERSION = 1;
export const TICKZ_EXT = '.tickz';

/** Raw 160-byte tick rows, compressed as-is. */
export const CODEC_RAW = 1;
/** Per-slot, per-field columns, delta + zigzag varint, then compressed. */
export const CODEC_COLUMNAR = 2;

export const DEFAULT_BLOCK_TICKS = 512;
export const DEFAULT_LEVEL = 12;

const PREFIX_BYTES = 48;
const SRC_HEADER_AT = 16;

function zstd(buf, level) {
  return zlib.zstdCompressSync(buf, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level }
  });
}

function unzstd(buf) {
  return zlib.zstdDecompressSync(buf);
}

// ---- codec 2: columns, deltas, varints --------------------------------------
// The transform itself lives in src/replays/shared/tickPacked.js: the viewer's
// wire body uses the same one, and a field table that drifted between the two
// would decode into plausible garbage rather than fail.

function packBlock(raw, rows) {
  const out = packColumnar(raw, rows, new Uint8Array(packedCapacity(rows)));
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function unpackBlock(packed, rows) {
  const raw = Buffer.alloc(rows * TICK_BYTES);
  unpackColumnarInto(packed, rows, raw, 0);
  return raw;
}

// ---- container --------------------------------------------------------------

function toBuffer(source) {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}

/**
 * Compress a tickFormat v1 buffer.
 *
 * @param {ArrayBuffer|Buffer|Uint8Array} source
 * @param {{codec?: number, blockTicks?: number, level?: number}} [opts]
 * @returns {Buffer}
 */
export function encodeTickz(source, opts = {}) {
  const src = toBuffer(source);
  const header = readHeader(src); // throws on a non-tick buffer, which is the point
  const codec = opts.codec ?? CODEC_COLUMNAR;
  const blockTicks = opts.blockTicks || DEFAULT_BLOCK_TICKS;
  const level = opts.level ?? DEFAULT_LEVEL;
  const rowsTotal = header.tickCount;

  const expected = HEADER_BYTES + rowsTotal * TICK_BYTES;
  if (src.length < expected) {
    throw new Error(`tickCodec: buffer is ${src.length} bytes, header claims ${expected}`);
  }

  const blockCount = Math.ceil(rowsTotal / blockTicks) || 0;
  const blocks = [];
  for (let b = 0; b < blockCount; b++) {
    const from = b * blockTicks;
    const rows = Math.min(blockTicks, rowsTotal - from);
    const raw = src.subarray(
      HEADER_BYTES + from * TICK_BYTES,
      HEADER_BYTES + (from + rows) * TICK_BYTES
    );
    blocks.push(zstd(codec === CODEC_COLUMNAR ? packBlock(raw, rows) : raw, level));
  }

  const out = Buffer.alloc(
    PREFIX_BYTES + blockCount * 4 + blocks.reduce((n, b) => n + b.length, 0)
  );
  out.writeUInt32LE(TICKZ_MAGIC, 0);
  out.writeUInt16LE(TICKZ_VERSION, 4);
  out.writeUInt8(codec, 6);
  out.writeUInt16LE(blockTicks, 8);
  out.writeUInt32LE(blockCount, 12);
  src.copy(out, SRC_HEADER_AT, 0, HEADER_BYTES);

  let p = PREFIX_BYTES + blockCount * 4;
  for (let b = 0; b < blockCount; b++) {
    out.writeUInt32LE(blocks[b].length, PREFIX_BYTES + b * 4);
    blocks[b].copy(out, p);
    p += blocks[b].length;
  }
  return out;
}

export function isTickz(buf) {
  const b = toBuffer(buf);
  return b.length >= PREFIX_BYTES && b.readUInt32LE(0) === TICKZ_MAGIC;
}

/** Container fields plus the decoded source header, without touching a block. */
export function readTickzHeader(buf) {
  const b = toBuffer(buf);
  if (!isTickz(b)) throw new Error('tickCodec: bad magic, not a .tickz buffer');
  const version = b.readUInt16LE(4);
  if (version !== TICKZ_VERSION) {
    throw new Error(`tickCodec: unsupported container version ${version}`);
  }
  return {
    version,
    codec: b.readUInt8(6),
    blockTicks: b.readUInt16LE(8),
    blockCount: b.readUInt32LE(12),
    source: readHeader(b.subarray(SRC_HEADER_AT, SRC_HEADER_AT + HEADER_BYTES))
  };
}

function blockAt(b, meta, index) {
  let offset = PREFIX_BYTES + meta.blockCount * 4;
  for (let i = 0; i < index; i++) offset += b.readUInt32LE(PREFIX_BYTES + i * 4);
  const length = b.readUInt32LE(PREFIX_BYTES + index * 4);
  const rows = Math.min(
    meta.blockTicks,
    meta.source.tickCount - index * meta.blockTicks
  );
  const plain = unzstd(b.subarray(offset, offset + length));
  return meta.codec === CODEC_COLUMNAR ? unpackBlock(plain, rows) : plain;
}

/**
 * Decode back to a tickFormat v1 buffer, byte for byte.
 *
 * @param {ArrayBuffer|Buffer|Uint8Array} source
 * @returns {ArrayBuffer}
 */
export function decodeTickz(source) {
  const b = toBuffer(source);
  const meta = readTickzHeader(b);
  const rowsTotal = meta.source.tickCount;
  const out = Buffer.alloc(HEADER_BYTES + rowsTotal * TICK_BYTES);
  b.copy(out, 0, SRC_HEADER_AT, SRC_HEADER_AT + HEADER_BYTES);
  for (let i = 0; i < meta.blockCount; i++) {
    blockAt(b, meta, i).copy(out, HEADER_BYTES + i * meta.blockTicks * TICK_BYTES);
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/**
 * Decode every Nth row into a fresh self-describing buffer, the compressed
 * equivalent of tickFormat's sliceStride. Blocks are decoded one at a time and
 * released, so a coarse pass never holds the whole round in memory.
 *
 * @param {ArrayBuffer|Buffer|Uint8Array} source
 * @param {number} stride
 * @returns {ArrayBuffer}
 */
export function decodeTickzStride(source, stride) {
  const b = toBuffer(source);
  const meta = readTickzHeader(b);
  const step = Math.max(1, stride | 0);
  if (step === 1) return decodeTickz(b);

  const rowsTotal = meta.source.tickCount;
  const rows = Math.ceil(rowsTotal / step);
  const out = Buffer.alloc(HEADER_BYTES + rows * TICK_BYTES);
  // Same trick sliceStride uses: keep the source header and correct only the
  // two fields a thinned buffer changes, so the reader stays arithmetic.
  b.copy(out, 0, SRC_HEADER_AT, SRC_HEADER_AT + HEADER_BYTES);
  out.writeUInt32LE(rows, 8);
  out.writeUInt32LE(meta.source.stride * step, 16);

  let cached = -1;
  let block = null;
  for (let i = 0; i < rows; i++) {
    const row = i * step;
    const bi = Math.floor(row / meta.blockTicks);
    if (bi !== cached) {
      block = blockAt(b, meta, bi);
      cached = bi;
    }
    const from = (row - bi * meta.blockTicks) * TICK_BYTES;
    block.copy(out, HEADER_BYTES + i * TICK_BYTES, from, from + TICK_BYTES);
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
