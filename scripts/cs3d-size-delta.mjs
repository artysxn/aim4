// ---------------------------------------------------------------------------
// scripts/cs3d-size-delta.mjs
// What does real movement data cost on disk?
//
// PARSER_REVISION 3 adds three things to every tick row that were previously
// constant or zero: FLAG_AIRBORNE, FLAG_DUCKING, and the duck amount in the
// side byte's high nibble. None of them grow the record — it is still 16
// bytes — but they all cost COMPRESSED size, because .tickz packs columns as
// zigzag varint deltas and a column that never changes collapses to nearly
// nothing. `side` used to be exactly that: one value per player per round.
// Giving it a duck nibble turns a free column into a live one.
//
// This measures the real delta on one match, and attributes it, by taking the
// new package and selectively reverting parts of the encoding:
//
//   as parsed     revision 3, everything on
//   no nibble     duck amount zeroed, movement flags kept  (boolean crouch)
//   no movement   nibble AND both flag bits zeroed         (= revision 2)
//
//   node scripts/cs3d-size-delta.mjs <new.aim4replay> [old.aim4replay]
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { decodeReplayPackage } from '../src/replays/shared/replayPackage.js';
import { decodeTickz, encodeTickz } from '../server/replays/tickCodec.js';
import {
  readHeader,
  HEADER_BYTES,
  TICK_BYTES,
  RECORD_BYTES,
  PLAYER_SLOTS,
  recordOffset,
  FLAG_AIRBORNE,
  FLAG_DUCKING,
  SIDE_MASK
} from '../src/replays/shared/tickFormat.js';

const [newPath, oldPath] = process.argv.slice(2);
if (!newPath) {
  console.error('usage: node scripts/cs3d-size-delta.mjs <new.aim4replay> [old.aim4replay]');
  process.exit(1);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const pct = (a, b) => `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(2)}%`;

/** Sum entry sizes by kind. */
async function inspect(file) {
  const { files } = decodeReplayPackage(await fsp.readFile(file));
  const out = { total: (await fsp.stat(file)).size, tickz: 0, meta: 0, c100: 0, other: 0, rounds: 0 };
  for (const [name, bytes] of files) {
    if (name.endsWith('.tickz')) {
      out.tickz += bytes.length;
      out.rounds++;
    } else if (name.endsWith('.json.zst')) out.meta += bytes.length;
    else if (name.endsWith('.c100.bin')) out.c100 += bytes.length;
    else out.other += bytes.length;
  }
  return { ...out, files };
}

/**
 * Re-encode every round with parts of the movement data stripped, to price
 * each piece against the same compressor settings that produced the original.
 */
function reencode(files, { stripNibble = false, stripFlags = false }) {
  let total = 0;
  for (const [name, bytes] of files) {
    if (!name.endsWith('.tickz')) continue;
    const raw = Buffer.from(decodeTickz(Buffer.from(bytes)));
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const header = readHeader(view);
    if (stripNibble || stripFlags) {
      for (let row = 0; row < header.tickCount; row++) {
        for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
          const o = recordOffset(row, slot);
          if (stripNibble) view.setUint8(o + 15, view.getUint8(o + 15) & SIDE_MASK);
          if (stripFlags) {
            view.setUint8(o + 13, view.getUint8(o + 13) & ~(FLAG_AIRBORNE | FLAG_DUCKING));
          }
        }
      }
    }
    total += encodeTickz(raw).length;
  }
  return total;
}

const fresh = await inspect(newPath);
console.log(`${path.basename(newPath)}  —  ${fresh.rounds} rounds`);
console.log(`  package total   ${kb(fresh.total)}`);
console.log(`  ticks (.tickz)  ${kb(fresh.tickz)}`);
console.log(`  meta (.json.zst) ${kb(fresh.meta)}`);
if (fresh.c100) console.log(`  coarse (.c100)  ${kb(fresh.c100)}`);

console.log('\nattribution — same rounds, re-encoded with pieces removed:');
const asIs = reencode(fresh.files, {});
const noNibble = reencode(fresh.files, { stripNibble: true });
const noMovement = reencode(fresh.files, { stripNibble: true, stripFlags: true });
console.log(`  as parsed (revision 3)        ${kb(asIs)}`);
console.log(`  without the duck nibble       ${kb(noNibble)}   ${pct(noNibble, asIs)}`);
console.log(`  without any movement data     ${kb(noMovement)}   ${pct(noMovement, asIs)}`);
console.log(`\n  the continuous duck costs     ${kb(asIs - noNibble)}  (${pct(asIs, noNibble)} over a boolean)`);
console.log(`  all movement data costs       ${kb(asIs - noMovement)}  (${pct(asIs, noMovement)} over revision 2)`);

if (oldPath) {
  const old = await inspect(oldPath);
  console.log(`\nmeasured against the real pre-fix parse (${path.basename(oldPath)}):`);
  console.log(`  package total   ${kb(old.total)} -> ${kb(fresh.total)}   ${pct(fresh.total, old.total)}`);
  console.log(`  ticks           ${kb(old.tickz)} -> ${kb(fresh.tickz)}   ${pct(fresh.tickz, old.tickz)}`);
  console.log(`  meta            ${kb(old.meta)} -> ${kb(fresh.meta)}   ${pct(fresh.meta, old.meta)}`);
  const perRound = (fresh.total - old.total) / Math.max(1, fresh.rounds);
  console.log(`\n  ${(perRound / 1024).toFixed(1)} KB per round, ${((fresh.total - old.total) / 1024).toFixed(0)} KB per match`);
  console.log(`  extrapolated over 4200 matches: ${(((fresh.total - old.total) * 4200) / 1024 ** 3).toFixed(2)} GB added`);
}
