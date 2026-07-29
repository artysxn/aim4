// Run: node server/replays/tickCodec.test.js
//
// The load-bearing property is that decode(encode(x)) is x, byte for byte.
// Everything above readRoundTicks() assumes tickFormat v1 and addresses it
// arithmetically, so a codec that is "close enough" would put players in the
// wrong place rather than fail loudly.

import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  POS_SCALE,
  ANGLE_SCALE,
  writeHeader,
  readRecord,
  sliceStride,
  wrapAngle
} from '../../src/replays/shared/tickFormat.js';
import {
  CODEC_RAW,
  CODEC_COLUMNAR,
  encodeTickz,
  decodeTickz,
  decodeTickzStride,
  readTickzHeader
} from './tickCodec.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/** Same saturation writeRecord applies, so the fixture stays in i16 range. */
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v || 0)));

/** A tickFormat v1 buffer built exactly the way writeRound builds one. */
function makeBuffer(tickCount, fill) {
  const buf = Buffer.alloc(HEADER_BYTES + tickCount * TICK_BYTES);
  writeHeader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), {
    tickCount,
    firstTick: 12345,
    stride: 1,
    tickRate: 64,
    playerCount: PLAYER_SLOTS
  });
  fill(buf);
  return buf;
}

/** Worst case for a delta codec: every varint width, both i16 extremes. */
function randomFill(buf) {
  for (let i = HEADER_BYTES; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
}

/**
 * What a round actually looks like: players walking, aim drifting with the
 * occasional flick, and the discrete fields sitting still for long stretches.
 * The ratio this reports is indicative only. Real demo data is the measurement
 * that counts, and CS:GO-era .dem files cannot produce it.
 */
function realisticFill(buf) {
  const players = [];
  for (let s = 0; s < PLAYER_SLOTS; s++) {
    players.push({
      x: (Math.random() - 0.5) * 3000,
      y: (Math.random() - 0.5) * 3000,
      z: Math.random() * 200,
      yaw: Math.random() * 360 - 180,
      pitch: 0,
      vx: 0,
      vy: 0,
      health: 100,
      armor: 100,
      weapon: 3 + ((Math.random() * 5) | 0),
      side: s < 5 ? 2 : 3
    });
  }
  const rows = (buf.length - HEADER_BYTES) / TICK_BYTES;
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      const p = players[s];
      // Accelerate toward a wandering heading, capped near CS run speed.
      p.vx = p.vx * 0.9 + (Math.random() - 0.5) * 1.2;
      p.vy = p.vy * 0.9 + (Math.random() - 0.5) * 1.2;
      p.x += p.vx;
      p.y += p.vy;
      p.yaw += (Math.random() - 0.5) * 2;
      if (Math.random() < 0.002) p.yaw += (Math.random() - 0.5) * 120; // flick
      p.pitch += (Math.random() - 0.5) * 0.6;
      if (Math.random() < 0.0004) p.health = Math.max(0, p.health - 30);
      if (Math.random() < 0.0002) p.weapon = 1 + ((Math.random() * 20) | 0);

      const o = HEADER_BYTES + r * TICK_BYTES + s * 16;
      buf.writeInt16LE(i16(p.x * POS_SCALE), o + 0);
      buf.writeInt16LE(i16(p.y * POS_SCALE), o + 2);
      buf.writeInt16LE(i16(p.z * POS_SCALE), o + 4);
      buf.writeInt16LE(i16(wrapAngle(p.yaw) * ANGLE_SCALE), o + 6);
      buf.writeInt16LE(i16(p.pitch * ANGLE_SCALE), o + 8);
      buf.writeUInt8(p.health, o + 10);
      buf.writeUInt8(p.armor, o + 11);
      buf.writeUInt8(p.weapon, o + 12);
      buf.writeUInt8(p.health > 0 ? 1 : 0, o + 13);
      buf.writeUInt8(0, o + 14);
      buf.writeUInt8(p.side, o + 15);
    }
  }
}

/** Field-level check, so a padding-only or header-only match cannot pass. */
function assertFieldsMatch(a, b, rows, label) {
  const va = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const vb = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const oa = {};
  const ob = {};
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      readRecord(va, r, s, oa);
      readRecord(vb, r, s, ob);
      for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'health', 'armor', 'weapon', 'flags', 'flash', 'teamNum']) {
        assert(oa[k] === ob[k], `${label}: row ${r} slot ${s} field ${k}: ${oa[k]} !== ${ob[k]}`);
      }
    }
  }
}

function roundTrip(buf, codec, label) {
  const enc = encodeTickz(buf, { codec });
  const dec = Buffer.from(decodeTickz(enc));
  assert(Buffer.compare(buf, dec) === 0, `${label}: not byte-identical`);
  const rows = (buf.length - HEADER_BYTES) / TICK_BYTES;
  assertFieldsMatch(buf, dec, rows, label);
  return enc;
}

// ---- correctness ------------------------------------------------------------

for (const [name, fill] of [
  ['random', randomFill],
  ['realistic', realisticFill]
]) {
  for (const rows of [0, 1, 7, 511, 512, 513, 2048]) {
    const buf = makeBuffer(rows, fill);
    roundTrip(buf, CODEC_RAW, `raw/${name}/${rows}`);
    roundTrip(buf, CODEC_COLUMNAR, `columnar/${name}/${rows}`);
  }
}

// A short block size forces many blocks over a small buffer, which is where an
// off-by-one in the block index would show up.
{
  const buf = makeBuffer(1000, realisticFill);
  const enc = encodeTickz(buf, { codec: CODEC_COLUMNAR, blockTicks: 16 });
  assert(readTickzHeader(enc).blockCount === 63, 'block count for blockTicks 16');
  assert(Buffer.compare(buf, Buffer.from(decodeTickz(enc))) === 0, 'small blocks round-trip');
}

// ---- strided reads must match sliceStride exactly ---------------------------

{
  const buf = makeBuffer(7000, realisticFill);
  for (const codec of [CODEC_RAW, CODEC_COLUMNAR]) {
    const enc = encodeTickz(buf, { codec });
    for (const stride of [1, 2, 100, 997]) {
      const want = Buffer.from(sliceStride(buf, stride));
      const got = Buffer.from(decodeTickzStride(enc, stride));
      assert(
        Buffer.compare(want, got) === 0,
        `stride ${stride} codec ${codec}: differs from sliceStride`
      );
    }
  }
}

// ---- ratio ------------------------------------------------------------------

{
  const rows = 7000; // ~110 s round at 64 tick
  const buf = makeBuffer(rows, realisticFill);
  const raw = encodeTickz(buf, { codec: CODEC_RAW });
  const col = encodeTickz(buf, { codec: CODEC_COLUMNAR });
  const pct = (n) => `${(100 - (n / buf.length) * 100).toFixed(1)}% smaller`;
  console.log(`  source        ${(buf.length / 1024).toFixed(0)} KB`);
  console.log(`  codec raw     ${(raw.length / 1024).toFixed(0)} KB  ${pct(raw.length)}`);
  console.log(`  codec column  ${(col.length / 1024).toFixed(0)} KB  ${pct(col.length)}`);
  console.log('  (synthetic motion; real demo data is the measurement that counts)');
}

console.log('tickCodec: all assertions passed');
