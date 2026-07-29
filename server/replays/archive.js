// ---------------------------------------------------------------------------
// replays/archive.js
// Turn one upload into the .dem files inside it.
//
// Accepts .dem, .gz, .zst and .zip. Everything is streamed: a 450 MB demo
// inside a zip is inflated straight to its own file and never exists as a
// Buffer, because the box this runs on has 4 GB and the parser is going to want
// most of it. That rules out unzipper/adm-zip, which is why the zip reader here
// is hand-rolled on node:zlib rather than a dependency.
//
// Only entries whose name ends in .dem are extracted. Every other entry is
// skipped before a byte of it is inflated, so a zip full of screenshots and
// config files costs nothing and stores nothing.
//
// Nothing here trusts the archive:
//   - names are reduced to their basename, so "../../etc/x.dem" cannot escape
//   - encrypted entries are refused rather than written as garbage
//   - output is metered against the caller's byte budget while it streams, so a
//     zip bomb aborts partway instead of after it has filled the disk
//   - archives nested inside archives are ignored, not recursed
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Upload suffixes the library accepts. */
export const ACCEPTED_EXTS = ['.dem', '.zip', '.gz', '.zst'];

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** The trailing comment may be up to 64 KB, so the EOCD is somewhere in here. */
const EOCD_SEARCH_BYTES = 66 * 1024;

export function classifyUpload(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.dem')) return 'dem';
  if (name.endsWith('.zip')) return 'zip';
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'tar';
  if (name.endsWith('.gz')) return 'gz';
  if (name.endsWith('.zst')) return 'zst';
  return null;
}

export function isAcceptedUpload(filename) {
  const kind = classifyUpload(filename);
  return kind !== null && kind !== 'tar';
}

/** Strip one compression suffix to guess the demo name inside. */
function innerName(filename) {
  const base = path.basename(String(filename || 'match.dem'));
  const stripped = base.replace(/\.(gz|zst)$/i, '');
  return /\.dem$/i.test(stripped) ? stripped : `${stripped}.dem`;
}

/**
 * A writable that refuses to exceed `allowedBytes`.
 *
 * The check has to happen while the stream runs, not after: the whole point is
 * that a compressed file does not declare its real size, so the only honest
 * moment to stop is when the budget actually runs out.
 */
async function writeMetered(readable, target, allowedBytes) {
  let written = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (written > allowedBytes) {
        cb(new Error('The archive expands to more than the available space.'));
        return;
      }
      cb(null, chunk);
    }
  });
  try {
    await pipeline(readable, meter, fs.createWriteStream(target));
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw err;
  }
  return written;
}

// ---- zip --------------------------------------------------------------------

async function readAt(handle, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/**
 * Locate the central directory by scanning backwards for the EOCD signature.
 *
 * Zip64 is handled because a multi-demo archive genuinely can exceed the 4 GB
 * and 65535-entry limits of the original format, and a plain zip reader would
 * silently report the truncated values instead of failing.
 */
async function readCentralDirectory(handle, fileSize) {
  const tailLen = Math.min(EOCD_SEARCH_BYTES, fileSize);
  const tail = await readAt(handle, tailLen, fileSize - tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid .zip file (no end-of-archive record).');

  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // Saturated fields mean the real values live in the zip64 record.
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD64_LOCATOR_SIG) {
        loc = i;
        break;
      }
    }
    if (loc < 0) throw new Error('Zip64 archive is missing its locator record.');
    const eocd64At = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await readAt(handle, 56, eocd64At);
    if (rec.readUInt32LE(0) !== EOCD64_SIG) throw new Error('Zip64 record is corrupt.');
    entries = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }

  return { entries, central: await readAt(handle, cdSize, cdOffset) };
}

function parseCentralDirectory(central, entries) {
  const out = [];
  let p = 0;
  for (let i = 0; i < entries && p + 46 <= central.length; i++) {
    if (central.readUInt32LE(p) !== CENTRAL_SIG) break;
    const flags = central.readUInt16LE(p + 8);
    const method = central.readUInt16LE(p + 10);
    let compressedSize = central.readUInt32LE(p + 20);
    const nameLen = central.readUInt16LE(p + 28);
    const extraLen = central.readUInt16LE(p + 30);
    const commentLen = central.readUInt16LE(p + 32);
    let localOffset = central.readUInt32LE(p + 42);
    const name = central.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // Zip64 extended information overrides whichever fields were saturated.
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const extra = central.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const size = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          // Fields appear in a fixed order, but only the saturated ones are
          // present, so each has to be consumed conditionally.
          if (central.readUInt32LE(p + 24) === 0xffffffff) r += 8; // uncompressed
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(extra.readBigUInt64LE(r));
            r += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(extra.readBigUInt64LE(r));
          break;
        }
        q += 4 + size;
      }
    }

    out.push({ name, method, flags, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Where an entry's data actually starts. The central directory records the
 * local header offset, and the local header's own name/extra lengths can differ
 * from the central copy, so they have to be read rather than assumed.
 */
async function dataOffset(handle, entry) {
  const head = await readAt(handle, 30, entry.localOffset);
  if (head.readUInt32LE(0) !== LOCAL_SIG) {
    throw new Error(`Corrupt entry in archive: ${entry.name}`);
  }
  return entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

async function extractZip(source, targetFor, allowedBytes, onFile) {
  const handle = await fsp.open(source, 'r');
  try {
    const { size } = await handle.stat();
    const { entries, central } = await readCentralDirectory(handle, size);
    const all = parseCentralDirectory(central, entries);

    // The filter is the feature: everything that is not a demo is dropped here,
    // before anything is opened, inflated or written.
    const demos = all.filter(
      (e) => !e.name.endsWith('/') && /\.dem$/i.test(e.name) && e.compressedSize > 0
    );
    if (!demos.length) {
      throw new Error('No .dem files were found in that archive.');
    }

    const written = [];
    let budget = allowedBytes;
    for (const entry of demos) {
      if (entry.flags & 0x1) {
        throw new Error(`"${path.basename(entry.name)}" is encrypted and cannot be read.`);
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(
          `"${path.basename(entry.name)}" uses an unsupported compression method.`
        );
      }
      // basename only: an entry named "../../x.dem" must land beside the others.
      const name = path.basename(entry.name);
      const target = targetFor(name);
      const from = await dataOffset(handle, entry);
      const raw = handle.createReadStream({
        start: from,
        end: from + entry.compressedSize - 1,
        autoClose: false
      });
      const body = entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
      const bytes = await writeMetered(body, target, budget);
      budget -= bytes;
      written.push({ name, path: target, sizeBytes: bytes });
      onFile?.({ name, sizeBytes: bytes });
    }
    return written;
  } finally {
    await handle.close();
  }
}

// ---- entry point ------------------------------------------------------------

/**
 * Unpack an upload into one or more .dem files.
 *
 * @param {object} opts
 * @param {string} opts.source        path to the uploaded file
 * @param {string} opts.filename      the name the client sent
 * @param {(name: string) => string} opts.targetFor  where to put an extracted demo
 * @param {number} opts.allowedBytes  remaining quota, enforced while streaming
 * @param {(f: {name: string, sizeBytes: number}) => void} [opts.onFile]
 * @returns {Promise<Array<{name: string, path: string, sizeBytes: number}>>}
 */
export async function unpackUpload({ source, filename, targetFor, allowedBytes, onFile }) {
  const kind = classifyUpload(filename);

  if (kind === 'dem') {
    const name = path.basename(filename);
    const target = targetFor(name);
    // Already in place from the upload stream; just adopt it.
    if (path.resolve(source) !== path.resolve(target)) await fsp.rename(source, target);
    const { size } = await fsp.stat(target);
    onFile?.({ name, sizeBytes: size });
    return [{ name, path: target, sizeBytes: size }];
  }

  if (kind === 'gz' || kind === 'zst') {
    const name = innerName(filename);
    const target = targetFor(name);
    const body = fs
      .createReadStream(source)
      .pipe(kind === 'gz' ? zlib.createGunzip() : zlib.createZstdDecompress());
    const sizeBytes = await writeMetered(body, target, allowedBytes);
    onFile?.({ name, sizeBytes });
    return [{ name, path: target, sizeBytes }];
  }

  if (kind === 'zip') {
    return extractZip(source, targetFor, allowedBytes, onFile);
  }

  if (kind === 'tar') {
    throw new Error('Upload a .zip, .gz or .zst rather than a .tar.gz.');
  }
  throw new Error('Upload a .dem file, or a .zip, .gz or .zst containing one.');
}
