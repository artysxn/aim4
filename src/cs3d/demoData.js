// ---------------------------------------------------------------------------
// src/cs3d/demoData.js
// Read an .aim4replay package IN THE BROWSER for the 3D demo viewer: the
// manifest, every round's meta, and — on demand — a round's tick buffer.
//
// The package is the same compact form the server library stores
// (rounds/<id>.json.zst + .tickz, see replayPackage.js), so the only thing
// the browser is missing is zstd, supplied by fzstd (~8 KB). The .tickz
// container walk below mirrors server/replays/tickCodec.js — same magic,
// same prefix, same block layout; the columnar transform itself is already
// shared (tickPacked.js), which is the part where writer/reader drift would
// decode into plausible garbage. If tickCodec's container ever changes
// shape, this file changes with it.
//
// Nothing here touches the network or the library: the file comes from a
// drag-drop (or, in dev, a ?demo= fetch), which is what lets the viewer run
// against the 383 packages on disk with no backend at all.
// ---------------------------------------------------------------------------

import { decompress } from 'fzstd';
import { decodeReplayPackage } from '../replays/shared/replayPackage.js';
import { unpackColumnarInto } from '../replays/shared/tickPacked.js';
import { readHeader, HEADER_BYTES, TICK_BYTES } from '../replays/shared/tickFormat.js';

// tickCodec.js container constants, restated for the browser (that file
// imports node:zlib at module scope and cannot load here).
const TICKZ_MAGIC = 0x5a543441; // "A4TZ"
const TICKZ_VERSION = 1;
const CODEC_RAW = 1;
const CODEC_COLUMNAR = 2;
const PREFIX_BYTES = 48;
const SRC_HEADER_AT = 16;

const text = new TextDecoder();

/** .json.zst → object (or plain .json for a v1 package). */
function readMeta(files, stem) {
  const zst = files.get(`rounds/${stem}.json.zst`);
  if (zst) return JSON.parse(text.decode(decompress(zst)));
  const plain = files.get(`rounds/${stem}.json`);
  if (plain) return JSON.parse(text.decode(plain));
  return null;
}

/** .tickz (or v1 .bin) → a tickFormat v1 ArrayBuffer, byte for byte. */
function readTicks(files, stem) {
  const raw = files.get(`rounds/${stem}.bin`);
  if (raw) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const tickz = files.get(`rounds/${stem}.tickz`);
  if (!tickz) return null;
  const view = new DataView(tickz.buffer, tickz.byteOffset, tickz.byteLength);
  if (view.getUint32(0, true) !== TICKZ_MAGIC) throw new Error('bad .tickz magic');
  if (view.getUint16(4, true) !== TICKZ_VERSION) throw new Error('unsupported .tickz version');
  const codec = view.getUint8(6);
  const blockTicks = view.getUint16(8, true);
  const blockCount = view.getUint32(12, true);
  const srcHeader = tickz.subarray(SRC_HEADER_AT, SRC_HEADER_AT + HEADER_BYTES);
  const header = readHeader(new DataView(srcHeader.slice().buffer));

  const out = new Uint8Array(HEADER_BYTES + header.tickCount * TICK_BYTES);
  out.set(srcHeader, 0);
  let offset = PREFIX_BYTES + blockCount * 4;
  for (let i = 0; i < blockCount; i++) {
    const length = view.getUint32(PREFIX_BYTES + i * 4, true);
    const rows = Math.min(blockTicks, header.tickCount - i * blockTicks);
    const plain = decompress(tickz.subarray(offset, offset + length));
    offset += length;
    const at = HEADER_BYTES + i * blockTicks * TICK_BYTES;
    if (codec === CODEC_COLUMNAR) unpackColumnarInto(plain, rows, out, at);
    else if (codec === CODEC_RAW) out.set(plain, at);
    else throw new Error(`unknown .tickz codec ${codec}`);
  }
  return out.buffer;
}

/**
 * Decode a package's bytes into a demo the viewer can drive.
 *
 * Metas are decoded up front (small, and the round list needs them); tick
 * buffers decode lazily per round and only the current round is kept.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {string} name  for display (usually the file name)
 */
export function loadDemoBytes(bytes, name = 'demo') {
  const { files } = decodeReplayPackage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  let manifest = null;
  const manifestRaw = files.get('manifest.json');
  if (manifestRaw) {
    try {
      manifest = JSON.parse(text.decode(manifestRaw));
    } catch {
      manifest = null;
    }
  }

  const rounds = [];
  for (const fileName of files.keys()) {
    const m = /^rounds\/(.+?)\.(tickz|bin)$/.exec(fileName);
    if (!m) continue;
    const stem = m[1];
    let meta = null;
    try {
      meta = readMeta(files, stem);
    } catch {
      continue;
    }
    if (!meta) continue;
    rounds.push({ stem, round: meta.round ?? rounds.length + 1, meta });
  }
  rounds.sort((a, b) => a.round - b.round);
  if (!rounds.length) throw new Error('No rounds in this package.');

  const mapCode = String(rounds[0].meta.map || manifest?.map || '').toUpperCase();

  let cache = null; // { stem, header, view } — one decoded round at a time
  return {
    name,
    manifest,
    mapCode,
    rounds,
    /** Decode (or return the cached) tick buffer for one round. */
    loadRound(stem) {
      if (cache?.stem === stem) return cache;
      const buf = readTicks(files, stem);
      if (!buf) throw new Error(`Round ${stem} has no tick data.`);
      const view = new DataView(buf);
      cache = { stem, header: readHeader(view), view };
      return cache;
    }
  };
}

/**
 * One library round as a demo the viewer can play. Import round uses this
 * instead of the whole-match package, which is why picking a round no longer
 * waits on every other round's ticks.
 *
 * @param {object} o
 * @param {string} o.name
 * @param {object} [o.manifest]
 * @param {string} o.mapCode
 * @param {string} o.stem
 * @param {object} o.meta
 * @param {ArrayBuffer|DataView} o.ticks
 */
export function demoFromLoadedRound({ name, manifest, mapCode, stem, meta, ticks }) {
  const view = ticks instanceof DataView ? ticks : new DataView(ticks);
  const header = readHeader(view);
  const cache = { stem, header, view };
  return {
    name: name || 'demo',
    manifest: manifest || null,
    mapCode: String(mapCode || meta?.map || '').toUpperCase(),
    rounds: [{ stem, round: meta?.round ?? 1, meta }],
    loadRound(want) {
      if (want !== stem) throw new Error(`Round ${want} has no tick data.`);
      return cache;
    }
  };
}

/** Drag-dropped File → demo. */
export async function loadDemoFile(file) {
  return loadDemoBytes(await file.arrayBuffer(), file.name);
}
