// Round-trip and rejection cases for the batched round-pack container.
import assert from 'node:assert/strict';
import { decodeRoundPacks, encodeRoundPacks } from './roundPackWire.js';

const ticksA = new Uint8Array([1, 2, 3, 4, 5]);
const ticksC = new Uint8Array(1024).map((_, i) => i % 251);

const encoded = encodeRoundPacks([
  { file: 'RndA~d1', meta: { map: 'de_nuke', round: 3 }, ticks: ticksA },
  { file: 'RndB~d1', meta: { map: 'de_nuke', round: 4 }, ticks: null },
  { file: 'RndC~d2', meta: null, ticks: ticksC.buffer },
  { file: 'RndD~d2', meta: null, ticks: null }
]);

const packs = decodeRoundPacks(encoded);
assert.ok(packs, 'decodes its own encoding');
assert.equal(packs.length, 4);

assert.equal(packs[0].file, 'RndA~d1');
assert.deepEqual(packs[0].meta, { map: 'de_nuke', round: 3 });
assert.deepEqual([...new Uint8Array(packs[0].ticks)], [...ticksA]);

assert.equal(packs[1].meta.round, 4);
assert.equal(packs[1].ticks, null, 'meta-only entry carries no blob');

assert.equal(packs[2].meta, null);
assert.deepEqual([...new Uint8Array(packs[2].ticks)], [...ticksC], 'ArrayBuffer input round-trips');

assert.equal(packs[3].meta, null);
assert.equal(packs[3].ticks, null, 'denied/missing entry is explicit');

// The decoded blob must survive the source buffer being reused.
const copy = new Uint8Array(encoded);
const fromCopy = decodeRoundPacks(copy);
copy.fill(0);
assert.deepEqual([...new Uint8Array(fromCopy[0].ticks)], [...ticksA], 'blobs are copies');

// A view into a larger buffer (offset ≠ 0) must decode identically.
const padded = new Uint8Array(encoded.byteLength + 16);
padded.set(encoded, 8);
const view = new Uint8Array(padded.buffer, 8, encoded.byteLength);
assert.equal(decodeRoundPacks(view).length, 4, 'offset views decode');

// Not the format → null, never a throw.
assert.equal(decodeRoundPacks(new Uint8Array([1, 2, 3])), null);
assert.equal(decodeRoundPacks(new TextEncoder().encode('{"error":"nope"}')), null);
assert.equal(decodeRoundPacks(encoded.slice(0, encoded.byteLength - 3)), null, 'truncated body rejected');

const empty = decodeRoundPacks(encodeRoundPacks([]));
assert.ok(Array.isArray(empty) && empty.length === 0, 'empty batch round-trips');

console.log('roundPackWire.test.js OK');
