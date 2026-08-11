// ---------------------------------------------------------------------------
// replays/archive.js
// Turn one upload into the .dem files inside it.
//
// Accepts .dem, .zip, .rar, .tar/.tar.gz/.tar.zst, and bare .gz/.zst. An
// archive may hold as many demos as it likes; .gz and .zst are single-stream
// compressors and can only ever carry one.
//
// Everything except .rar is streamed in process: a 450 MB demo inside a zip is
// inflated straight to its own file and never exists as a Buffer, because the
// box this runs on has 4 GB and the parser is going to want most of it. That
// rules out unzipper/adm-zip, which is why the zip and tar readers here are
// hand-rolled on node:zlib rather than dependencies. .rar is the exception and
// is explained where it is handled.
//
// Only .dem entries are extracted, and only real ones: see isDemoEntry. Every
// other entry is skipped before a byte of it is inflated, so an archive full of
// screenshots and config files costs nothing and stores nothing.
//
// Nothing here trusts the archive:
//   - names are reduced to their basename, so "../../etc/x.dem" cannot escape
//   - encrypted entries are refused rather than written as garbage
//   - output is metered against the caller's byte budget while it streams, so a
//     zip bomb aborts partway instead of after it has filled the disk
//   - archives nested inside archives are ignored, not recursed
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Upload suffixes the library accepts. */
export const ACCEPTED_EXTS = [
  '.dem',
  '.zip',
  '.rar',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.zst',
  '.gz',
  '.zst'
];

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** The trailing comment may be up to 64 KB, so the EOCD is somewhere in here. */
const EOCD_SEARCH_BYTES = 66 * 1024;

/**
 * What kind of thing was uploaded.
 *
 * Order matters: ".tar.gz" has to be recognised as a tar before the bare ".gz"
 * test claims it, or a multi-demo tarball would be treated as a single
 * compressed demo and produce one corrupt file.
 */
export function classifyUpload(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.dem')) return 'dem';
  if (name.endsWith('.zip')) return 'zip';
  if (name.endsWith('.rar')) return 'rar';
  if (name.endsWith('.tar')) return 'tar';
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'tar.gz';
  if (name.endsWith('.tar.zst') || name.endsWith('.tzst')) return 'tar.zst';
  if (name.endsWith('.gz')) return 'gz';
  if (name.endsWith('.zst')) return 'zst';
  return null;
}

export function isAcceptedUpload(filename) {
  return classifyUpload(filename) !== null;
}

/** Strip one compression suffix to guess the demo name inside. */
function innerName(filename) {
  const base = path.basename(String(filename || 'match.dem'));
  const stripped = base.replace(/\.(gz|zst)$/i, '');
  return /\.dem$/i.test(stripped) ? stripped : `${stripped}.dem`;
}

/**
 * Is this archive member a demo worth extracting?
 *
 * The ".dem" test alone is not enough. Anything zipped or tarred on a Mac
 * carries an AppleDouble twin for every file: Finder writes "__MACOSX/._foo.dem"
 * and bsdtar writes "._foo.dem". They end in .dem, they are a few KB of
 * resource-fork metadata, and taking them at face value means storing four junk
 * demos per archive and queueing a parse for each one.
 */
export function isDemoEntry(name) {
  const clean = String(name || '').replace(/\\/g, '/');
  if (clean.endsWith('/')) return false;
  if (/(^|\/)__MACOSX\//.test(clean)) return false;
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  if (base.startsWith('._')) return false;
  return /\.dem$/i.test(base);
}

/** The decompressor a tar flavour needs wrapped around it, if any. */
function tarDecompressor(kind) {
  if (kind === 'tar.gz') return zlib.createGunzip();
  if (kind === 'tar.zst') return zlib.createZstdDecompress();
  return null;
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

// ---- tar --------------------------------------------------------------------

const TAR_BLOCK = 512;

/**
 * Pull bytes off an async iterable a known number at a time.
 *
 * tar is a sequential format and a .tar.gz cannot be seeked, so members that
 * are not demos have to be read past rather than skipped over. Everything here
 * is bounded: headers are one block, and member data is streamed through in
 * whatever chunk sizes arrive rather than accumulated.
 */
class ByteReader {
  constructor(iterable) {
    this.it = iterable[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.eof = false;
  }

  async #pull() {
    if (this.eof) return false;
    const { value, done } = await this.it.next();
    if (done) {
      this.eof = true;
      return false;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    return true;
  }

  /** Exactly `n` bytes, or null at a clean end of stream. */
  async exact(n) {
    while (this.buf.length < n) {
      if (!(await this.#pull())) {
        if (this.buf.length === 0) return null;
        throw new Error('Archive ended in the middle of a record.');
      }
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Hand `n` bytes to `onChunk` as they arrive; discards them when omitted. */
  async consume(n, onChunk) {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.#pull())) {
        throw new Error('Archive ended in the middle of a file.');
      }
      const take = Math.min(left, this.buf.length);
      const chunk = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      if (onChunk) await onChunk(chunk);
    }
  }
}

const cstr = (buf) => {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8').trim();
};

/** tar stores numbers as NUL/space-terminated octal. */
function octal(buf) {
  const s = cstr(buf).replace(/[^0-7]/g, '');
  return s ? parseInt(s, 8) : 0;
}

/**
 * Extract every .dem from a tar stream.
 *
 * Long names are handled two ways because both are in the wild: GNU writes a
 * type 'L' entry whose body is the next member's name, POSIX/PAX writes a type
 * 'x' entry holding "path=..." records. A demo named by a tournament site
 * routinely exceeds the 100 byte legacy field, so neither can be ignored.
 */
async function extractTar(source, kind, targetFor, allowedBytes, onFile) {
  const decompressor = tarDecompressor(kind);
  const raw = fs.createReadStream(source);
  const stream = decompressor ? raw.pipe(decompressor) : raw;
  const reader = new ByteReader(stream);

  const written = [];
  let budget = allowedBytes;
  let longName = null;
  let empties = 0;

  try {
    for (;;) {
      const header = await reader.exact(TAR_BLOCK);
      if (!header) break;

      // Two consecutive zero blocks mark the end of the archive.
      if (header.every((b) => b === 0)) {
        if (++empties >= 2) break;
        continue;
      }
      empties = 0;

      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156]) || '0';
      const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;

      let name = cstr(header.subarray(0, 100));
      const prefix = cstr(header.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
      if (longName) {
        name = longName;
        longName = null;
      }

      if (type === 'L') {
        let collected = Buffer.alloc(0);
        await reader.consume(size, (c) => {
          collected = Buffer.concat([collected, c]);
        });
        await reader.consume(padding);
        longName = cstr(collected);
        continue;
      }
      if (type === 'x' || type === 'g') {
        let collected = Buffer.alloc(0);
        await reader.consume(size, (c) => {
          collected = Buffer.concat([collected, c]);
        });
        await reader.consume(padding);
        // "<len> path=<value>\n", one record per line.
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(collected.toString('utf8'));
        if (m && type === 'x') longName = m[1];
        continue;
      }

      const isFile = type === '0' || type === '\0' || type === '' || type === '7';
      if (!isFile || !isDemoEntry(name)) {
        // Read past it. Nothing is written, which is what keeps junk out.
        await reader.consume(size + padding);
        continue;
      }

      const base = path.basename(name);
      const target = targetFor(base);
      if (size > budget) {
        throw new Error('The archive expands to more than the available space.');
      }
      const out = fs.createWriteStream(target);
      try {
        await reader.consume(size, (chunk) => {
          if (out.write(chunk)) return undefined;
          return new Promise((r) => out.once('drain', r));
        });
        await new Promise((resolve, reject) => {
          out.end(resolve);
          out.once('error', reject);
        });
      } catch (err) {
        out.destroy();
        await fsp.rm(target, { force: true }).catch(() => {});
        throw err;
      }
      await reader.consume(padding);

      budget -= size;
      written.push({ name: base, path: target, sizeBytes: size });
      onFile?.({ name: base, sizeBytes: size });
    }
  } finally {
    raw.destroy();
    decompressor?.destroy();
  }

  if (!written.length) throw new Error('No .dem files were found in that archive.');
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
    const demos = all.filter((e) => isDemoEntry(e.name) && e.compressedSize > 0);
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
      // Its own descriptor per entry rather than handle.createReadStream().
      // The latter registers a 'close' listener on the shared handle for every
      // stream and, with autoClose off, never removes them, so an archive of 11
      // or more demos trips MaxListenersExceededWarning and keeps accumulating
      // from there. A fresh fd per entry is opened and closed in step.
      const raw = fs.createReadStream(source, {
        start: from,
        end: from + entry.compressedSize - 1
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

// ---- rar --------------------------------------------------------------------

/**
 * RAR is the one format here that cannot be read in process.
 *
 * The format is proprietary and its decompressor is not something to
 * reimplement, so this shells out. WASM ports exist but the practical ones
 * decode into memory buffers, which is the wrong shape for a 4 GB host being
 * handed multi-gigabyte archives: a subprocess writing to disk keeps memory
 * flat the way every other path here does.
 *
 * Preference order is deliberate. unar (The Unarchiver) has the most complete
 * RAR5 and solid-archive support; libarchive's bsdtar reads most RAR but is
 * weaker on those. Either is fine for the common case.
 */
const RAR_TOOLS = [
  {
    bin: 'unar',
    // Absolute paths first: some supervised Node launches strip a useful PATH.
    candidates: ['unar', '/usr/bin/unar'],
    args: (src, dir, members) => [
      '-quiet',
      '-no-directory',
      '-output-directory',
      dir,
      src,
      ...members
    ]
  },
  {
    bin: 'bsdtar',
    candidates: ['bsdtar', '/usr/bin/bsdtar'],
    args: (src, dir, members) => ['-x', '-f', src, '-C', dir, '--no-same-owner', ...members]
  }
];

/** Probed once: spawning twice per upload to ask the same question is waste. */
let rarTool;

function findRarTool() {
  if (rarTool !== undefined) return rarTool;
  rarTool = null;
  for (const tool of RAR_TOOLS) {
    for (const bin of tool.candidates || [tool.bin]) {
      // No shell, and ENOENT is the only answer that matters: a binary that
      // exists but dislikes --version is still a binary that exists.
      const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
      if (!(probe.error && probe.error.code === 'ENOENT')) {
        rarTool = { ...tool, bin };
        return rarTool;
      }
    }
  }
  return rarTool;
}

/** Exposed so /api/replays/status can say whether .rar will work here. */
export function rarSupport() {
  const tool = findRarTool();
  return { available: Boolean(tool), tool: tool?.bin || null };
}

/** Every file under `dir`, recursively. */
async function walkFiles(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function extractRar(source, targetFor, allowedBytes, onFile) {
  const tool = findRarTool();
  if (!tool) {
    throw new Error(
      'This server cannot open .rar files (unar / bsdtar missing). ' +
        'Install apt packages unar and libarchive-tools (Dockerfile and nixpacks.toml both list them), then redeploy.'
    );
  }

  // Stage beside the upload, which is on the library volume, so moving the
  // demos into place afterwards is a rename rather than a copy.
  const stage = path.join(
    path.dirname(source),
    `.rar-${crypto.randomBytes(8).toString('hex')}`
  );
  await fsp.mkdir(stage, { recursive: true });

  // execFile, never a shell: entry names come from an untrusted archive and the
  // source path is influenced by the upload filename.
  const run = (members) =>
    new Promise((resolve) => {
      execFile(
        tool.bin,
        tool.args(source, stage, members),
        { timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })
      );
    });

  try {
    // Ask for just the demos first so junk is never written at all. Member
    // patterns are not equally supported everywhere though, and "pattern
    // matched nothing" is indistinguishable from "archive has no demos", so a
    // fruitless selective pass falls back to extracting everything and
    // filtering afterwards. Junk that lands that way lives in the staging
    // directory and goes with it.
    let result = await run(['*.dem']);
    let found = (await walkFiles(stage)).filter((p) => isDemoEntry(path.basename(p)));
    if (!found.length) {
      result = await run([]);
      found = (await walkFiles(stage)).filter((p) => isDemoEntry(path.basename(p)));
    }

    if (!found.length) {
      // A tool failure and an archive with nothing in it look the same from
      // here, so the tool's own message is worth surfacing when there is one.
      const detail = String(result.stderr || result.error?.message || '')
        .trim()
        .split('\n')[0];
      throw new Error(
        detail
          ? `Could not read that .rar: ${detail}`
          : 'No .dem files were found in that archive.'
      );
    }

    let budget = allowedBytes;
    const written = [];
    for (const from of found) {
      const name = path.basename(from);
      const { size } = await fsp.stat(from);
      if (size > budget) {
        throw new Error('The archive expands to more than the available space.');
      }
      const target = targetFor(name);
      await fsp.rename(from, target).catch(async (err) => {
        // Staging may sit on a different filesystem than the library.
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(from, target);
        await fsp.rm(from, { force: true });
      });
      budget -= size;
      written.push({ name, path: target, sizeBytes: size });
      onFile?.({ name, sizeBytes: size });
    }
    return written;
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
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

  if (kind === 'tar' || kind === 'tar.gz' || kind === 'tar.zst') {
    return extractTar(source, kind, targetFor, allowedBytes, onFile);
  }

  if (kind === 'rar') {
    return extractRar(source, targetFor, allowedBytes, onFile);
  }

  throw new Error(
    'Upload a .dem file, or a .zip, .rar, .tar.gz, .gz or .zst containing one.'
  );
}
