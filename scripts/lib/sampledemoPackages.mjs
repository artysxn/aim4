// ---------------------------------------------------------------------------
// scripts/lib/sampledemoPackages.mjs
// Read parsed demos straight out of .aim4replay packages.
//
// The training corpus lives in sampledemos/ as packages, which is the transport
// format the local parser writes and the server imports. Importing them into a
// library first would work, but it would mean the trainer could only ever run
// against a server volume; reading the packages directly means the corpus is
// just a folder of files, and anyone with the folder can retrain.
//
// Node-only: lives under scripts/ so it never reaches the browser bundle.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { decodeReplayPackage, PACKAGE_EXT } from '../../src/replays/shared/replayPackage.js';
import { decodeTickz, isTickz } from '../../server/replays/tickCodec.js';
import { TickTrack } from '../../src/replays/tickStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default corpus location. */
export const SAMPLE_DIR = path.join(__dirname, '../../sampledemos');

/**
 * Package files in a directory, sorted for a stable run order.
 * @param {string} [dir]
 * @returns {Promise<string[]>} absolute paths
 */
export async function listSamplePackages(dir = SAMPLE_DIR) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(PACKAGE_EXT))
    .sort()
    .map((n) => path.join(dir, n));
}

/**
 * Decode one package: the manifest plus a lazy accessor per round.
 *
 * Rounds are decompressed on demand rather than up front. A package is 2-4 MB
 * packed but its stride-1 tick data is over a megabyte per round decompressed,
 * and holding a whole match in memory at once buys nothing when the caller
 * walks rounds in order.
 *
 * @param {string} file
 */
export async function loadPackage(file) {
  const bytes = await fs.readFile(file);
  const { version, files } = decodeReplayPackage(bytes);

  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error(`${path.basename(file)}: no manifest.json`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

  const rounds = Array.isArray(manifest.rounds) ? manifest.rounds : [];

  /**
   * Round meta plus a TickTrack over the full-rate tick buffer.
   * @param {object} entry  manifest.rounds[i]
   */
  function readRound(entry) {
    const stem = `rounds/${entry.file}`;
    const zstJson = files.get(`${stem}.json.zst`);
    const plainJson = files.get(`${stem}.json`);
    if (!zstJson && !plainJson) throw new Error(`${entry.file}: no round JSON`);
    const meta = JSON.parse(
      zstJson
        ? zlib.zstdDecompressSync(Buffer.from(zstJson)).toString('utf8')
        : new TextDecoder().decode(plainJson)
    );

    const tickBytes = files.get(`${stem}.tickz`) || files.get(`${stem}.bin`);
    if (!tickBytes) throw new Error(`${entry.file}: no tick data`);
    const raw = isTickz(tickBytes) ? decodeTickz(tickBytes) : tickBytes;
    // TickTrack wants a standalone ArrayBuffer, and a Buffer view into a larger
    // pool would address the wrong bytes.
    const buffer =
      raw instanceof ArrayBuffer
        ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

    return { meta, track: new TickTrack(buffer) };
  }

  return {
    file,
    name: path.basename(file, PACKAGE_EXT),
    version,
    manifest,
    map: manifest.map,
    rounds,
    readRound
  };
}

/**
 * Walk every round of every package in order.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @param {number} [opts.limit]           stop after this many packages
 * @param {string} [opts.match]           substring filter on the file name
 * @param {string[]} [opts.maps]          map codes to keep
 * @param {string[]} [opts.skipMaps]      map codes to drop
 */
export async function* eachRound({
  dir = SAMPLE_DIR,
  limit = 0,
  match = '',
  maps = null,
  skipMaps = null
} = {}) {
  const files = await listSamplePackages(dir);
  let used = 0;
  for (const file of files) {
    if (limit && used >= limit) break;
    if (match && !path.basename(file).includes(match)) continue;
    const pkg = await loadPackage(file);
    if (maps?.length && !maps.includes(pkg.map)) continue;
    if (skipMaps?.length && skipMaps.includes(pkg.map)) continue;
    used++;
    for (const entry of pkg.rounds) {
      yield { pkg, entry, ...pkg.readRound(entry) };
    }
  }
}
