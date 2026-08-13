// ---------------------------------------------------------------------------
// scripts/lib/radarMask.mjs
// Decode a radar PNG to RGBA in node, with no dependencies.
//
// The browser bakes the walkable mask through a canvas. Offline tools have no
// canvas, and without the mask they get no possession lattice at all — which is
// why the baseline sampler used to silently produce nothing. PNG is just zlib
// over filtered scanlines, and the radars are all 8-bit RGBA non-interlaced, so
// node's own zlib is enough.
//
// Node-only: lives under scripts/ so it never reaches the browser bundle.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { MAPS } from '../../src/replays/shared/roundId.js';
import { maskFromRgba } from '../../src/replays/zones/zoneOverlay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RADAR_DIR = path.join(__dirname, '../../public/maps/radar');

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode an 8-bit RGB/RGBA non-interlaced PNG.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Uint8Array }} RGBA
 */
export function decodePng(buf) {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  /** @type {Buffer[]} */
  const idat = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = off + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(body);
      height = buf.readUInt32BE(body + 4);
      bitDepth = buf[body + 8];
      colorType = buf[body + 9];
      if (buf[body + 12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(body, body + len));
    } else if (type === 'IEND') {
      break;
    }
    off = body + len + 4;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`unsupported color type ${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) v = x + paeth(a, b, c);
      else throw new Error(`bad PNG filter ${filter}`);
      line[i] = v & 0xff;
    }
    src += stride;

    const rowOut = y * width * 4;
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = rowOut + x * 4;
      out[di] = line[si];
      out[di + 1] = line[si + 1];
      out[di + 2] = line[si + 2];
      out[di + 3] = channels === 4 ? line[si + 3] : 255;
    }
    prev.set(line);
  }

  return { width, height, data: out };
}

/**
 * Walkable bitmask for a map code, or null when the radar is missing.
 *
 * Stacked maps have two radars and therefore two masks. Nuke's `lowerFile` is
 * a genuinely different floor plan over the same world x/y, split at the
 * calibration's `lowerZ`, so asking for the wrong level gives a mask that is
 * confidently wrong rather than empty.
 *
 * @param {string} mapCode
 * @param {'default'|'lower'} [level]
 * @returns {Promise<Uint8Array|null>}
 */
export async function loadRadarMask(mapCode, level = 'default') {
  const entry = MAPS[mapCode];
  const file = level === 'lower' ? entry?.lowerFile : entry?.file;
  if (!file) return null;
  let buf;
  try {
    buf = await fs.readFile(path.join(RADAR_DIR, `${file}.png`));
  } catch {
    return null;
  }
  const { width, height, data } = decodePng(buf);
  if (width !== 1024 || height !== 1024) {
    throw new Error(`${file}.png is ${width}x${height}, expected 1024x1024`);
  }
  return maskFromRgba(data);
}
