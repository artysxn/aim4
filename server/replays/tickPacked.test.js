// Run: node server/replays/tickPacked.test.js
//
// The wire body the viewer receives for a full-detail round. Same load-bearing
// property as the on-disk codec: decodePacked(encodePacked(x)) is x, byte for
// byte. Everything above fetchRoundTicks assumes tickFormat v1 and addresses it
// arithmetically, so a transform that is "close enough" would put players in
// the wrong place rather than fail loudly.
//
// It also pins the two properties the deploy depends on: the magic is what the
// client branches on (not a header a proxy could rewrite), and the transform is
// the same one tickCodec writes into .tickz blocks — a drift between the two
// would decode into plausible garbage.

import zlib from 'node:zlib';
import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  writeHeader,
  writeRecord,
  readHeader,
  readRecord
} from '../../src/replays/shared/tickFormat.js';
import {
  PACKED_PREFIX_BYTES,
  decodePacked,
  encodePacked,
  isPacked,
  packColumnar,
  unpackColumnarInto
} from '../../src/replays/shared/tickPacked.js';
import { decodeTickz, encodeTickz } from './tickCodec.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function makeBuffer(tickCount, fill) {
  const buf = Buffer.alloc(HEADER_BYTES + tickCount * TICK_BYTES);
  writeHeader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), {
    tickCount,
    firstTick: 54321,
    stride: 1,
    tickRate: 64,
    playerCount: PLAYER_SLOTS
  });
  fill(buf);
  return buf;
}

/** Deterministic pseudo-random, so a failure is reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Worst case for a delta codec: extremes, jumps, and long constant runs. */
function fillMixed(buf, ticks) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rand = rng(7);
  for (let r = 0; r < ticks; r++) {
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      const wild = slot % 3 === 0;
      writeRecord(view, r, slot, {
        // A wild slot teleports (max varint width); the rest drift smoothly.
        x: wild ? (rand() - 0.5) * 16000 : Math.sin(r / 40 + slot) * 2000,
        y: wild ? (rand() - 0.5) * 16000 : Math.cos(r / 40 + slot) * 2000,
        z: slot * 13,
        yaw: wild ? (rand() - 0.5) * 360 : ((r * 3 + slot * 30) % 360) - 180,
        pitch: -89 + (r % 179),
        // Constant for the whole round: the run-of-zeros case.
        health: slot === 1 ? 100 : Math.max(0, 100 - (r % 101)),
        armor: 100,
        weapon: slot,
        flags: r % 2 ? 1 : 0,
        flash: r % 7,
        side: slot < 5 ? 'T' : 'CT'
      });
    }
  }
}

// ---- round-trip -------------------------------------------------------------

for (const ticks of [0, 1, 2, 511, 512, 513, 4096]) {
  const src = makeBuffer(ticks, (b) => fillMixed(b, ticks));
  const wire = encodePacked(src, ticks);
  assert(isPacked(wire), `isPacked false for ${ticks} ticks`);
  const back = Buffer.from(decodePacked(wire));
  assert(
    Buffer.compare(back, src) === 0,
    `packed round-trip differs at ${ticks} ticks (${back.length} vs ${src.length})`
  );
  // The header has to survive verbatim, not be rebuilt: playerCount 0 and any
  // reserved bytes a future writer sets must come back unchanged.
  const h = readHeader(back);
  assert(h.tickCount === ticks && h.firstTick === 54321 && h.stride === 1, 'header drifted');
}
console.log('  packed round-trip is byte-exact, 0 to 4096 ticks');

// Values, not just bytes: a transform that shuffled fields between slots could
// still round-trip as bytes if it were symmetric.
{
  const ticks = 300;
  const src = makeBuffer(ticks, (b) => fillMixed(b, ticks));
  const back = Buffer.from(decodePacked(encodePacked(src, ticks)));
  const a = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const b = new DataView(back.buffer, back.byteOffset, back.byteLength);
  for (const row of [0, 1, 149, 299]) {
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      const x = readRecord(a, row, slot, {});
      const y = readRecord(b, row, slot, {});
      for (const k of Object.keys(x)) {
        assert(x[k] === y[k], `row ${row} slot ${slot} field ${k}: ${x[k]} !== ${y[k]}`);
      }
    }
  }
  console.log('  every field of every slot survives, not just the byte total');
}

// ---- the transform is shared with the on-disk codec -------------------------
// tickCodec packs 512-tick blocks with the same functions. If the two ever
// diverged, a .tickz written by one and read by the other would be garbage.
{
  const ticks = 1500;
  const src = makeBuffer(ticks, (b) => fillMixed(b, ticks));
  const viaDisk = Buffer.from(decodeTickz(encodeTickz(src)));
  const viaWire = Buffer.from(decodePacked(encodePacked(src, ticks)));
  assert(Buffer.compare(viaDisk, src) === 0, '.tickz round-trip differs');
  assert(Buffer.compare(viaWire, viaDisk) === 0, 'wire and disk codecs disagree');
  console.log('  wire body and .tickz blocks agree on the same transform');
}

// unpackColumnarInto writes at an offset, which is what lets both callers share
// one implementation. Check it does not touch anything before that offset.
{
  const ticks = 64;
  const src = makeBuffer(ticks, (b) => fillMixed(b, ticks));
  const rowsOnly = src.subarray(HEADER_BYTES);
  const packed = packColumnar(rowsOnly, ticks);
  const out = new Uint8Array(HEADER_BYTES + ticks * TICK_BYTES).fill(0xab);
  unpackColumnarInto(packed, ticks, out, HEADER_BYTES);
  for (let i = 0; i < HEADER_BYTES; i++) {
    assert(out[i] === 0xab, `unpack wrote before its offset at byte ${i}`);
  }
  assert(
    Buffer.compare(Buffer.from(out.subarray(HEADER_BYTES)), Buffer.from(rowsOnly)) === 0,
    'offset unpack differs'
  );
  console.log('  unpack respects its output offset');
}

// ---- what the client actually branches on -----------------------------------
{
  const ticks = 200;
  const src = makeBuffer(ticks, (b) => fillMixed(b, ticks));
  // A plain tickFormat buffer must NOT look packed: this is the fallback that
  // keeps a new client working against a server that has not shipped the format,
  // and against responses already sitting in the HTTP cache.
  assert(!isPacked(src), 'a plain tick buffer was mistaken for a packed one');
  assert(!isPacked(new Uint8Array(4)), 'a runt buffer was mistaken for a packed one');
  assert(!isPacked(new Uint8Array(PACKED_PREFIX_BYTES)), 'zeroed bytes read as packed');
  console.log('  plain buffers are never mistaken for packed ones');
}

// ---- size, which is the whole point ----------------------------------------
{
  const ticks = 7000; // ~110 s at 64 tick, a normal round
  const src = makeBuffer(ticks, (b) => fillMixed(b, ticks));
  const rowsGz = zlib.gzipSync(src, { level: 6 }).length;
  const packedGz = zlib.gzipSync(Buffer.from(encodePacked(src, ticks)), { level: 6 }).length;
  console.log(
    `  ${(src.length / 1024).toFixed(0)} KB round: gzip(rows) ${(rowsGz / 1024).toFixed(0)} KB ` +
      `-> gzip(packed) ${(packedGz / 1024).toFixed(0)} KB`
  );
  // Deliberately loose: this fixture has a third of its slots teleporting every
  // tick, which no real round does, so it is a floor rather than a target.
  assert(packedGz < rowsGz, 'the packed body was not smaller than the rows');
}

console.log('tickPacked: all assertions passed');
