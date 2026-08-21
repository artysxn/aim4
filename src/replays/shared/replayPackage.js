// ---------------------------------------------------------------------------
// replays/shared/replayPackage.js
// Binary container for a locally-parsed demo ready to import on the server.
//
// The package holds exactly what the library stores after a server-side parse:
// a demo record (manifest) plus compact round files named with the round-id
// scheme so the library collector can filter without opening files.
//
// Layout (little-endian):
//   magic      8 bytes   "AIM4RPLY"
//   version   u32        1 = plain .json/.bin, 2 = compact library form
//   count     u32        number of files
//   repeated:
//     nameLen u16
//     name    utf8
//     dataLen u32
//     data    bytes
//
// File names inside a v2 package (what the local tool writes):
//   manifest.json
//   rounds/<roundId>~<demoId>.json.zst
//   rounds/<roundId>~<demoId>.tickz
//   rounds/<roundId>~<demoId>.c100.bin
//
// v1 packages (legacy) carry .json + .bin instead; import still accepts them.
// ---------------------------------------------------------------------------

export const PACKAGE_MAGIC = 'AIM4RPLY';
/** Current encode version: compact on-disk forms. */
export const PACKAGE_VERSION = 2;
/** Versions decodeReplayPackage accepts. */
export const PACKAGE_VERSIONS = new Set([1, 2]);
export const PACKAGE_EXT = '.aim4replay';

/** True when `buf` starts with the AIM4 replay magic. SPA HTML is not a package. */
export function isReplayPackage(buf) {
  const bytes =
    buf instanceof Uint8Array
      ? buf
      : buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : buf?.buffer
          ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          : null;
  if (!bytes || bytes.length < 8) return false;
  return new TextDecoder().decode(bytes.subarray(0, 8)) === PACKAGE_MAGIC;
}

/**
 * @param {Iterable<[string, Uint8Array|ArrayBuffer|Buffer]>} files
 * @returns {Uint8Array}
 */
export function encodeReplayPackage(files) {
  const entries = [];
  for (const [name, data] of files) {
    const n = String(name).replace(/\\/g, '/');
    if (!n || n.includes('..')) throw new Error(`Bad package entry name: ${name}`);
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    entries.push({ name: n, bytes });
  }

  let total = 8 + 4 + 4;
  const nameBufs = [];
  for (const e of entries) {
    const nb = new TextEncoder().encode(e.name);
    if (nb.length > 0xffff) throw new Error(`Package entry name too long: ${e.name}`);
    nameBufs.push(nb);
    total += 2 + nb.length + 4 + e.bytes.length;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(PACKAGE_MAGIC), 0);
  view.setUint32(8, PACKAGE_VERSION, true);
  view.setUint32(12, entries.length, true);
  let o = 16;
  for (let i = 0; i < entries.length; i++) {
    const nb = nameBufs[i];
    const e = entries[i];
    view.setUint16(o, nb.length, true);
    o += 2;
    out.set(nb, o);
    o += nb.length;
    view.setUint32(o, e.bytes.length, true);
    o += 4;
    out.set(e.bytes, o);
    o += e.bytes.length;
  }
  return out;
}

/**
 * @param {Uint8Array|ArrayBuffer|Buffer} buf
 * @returns {{ version: number, files: Map<string, Uint8Array> }}
 */
export function decodeReplayPackage(buf) {
  const bytes =
    buf instanceof Uint8Array
      ? buf
      : buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (bytes.length < 16) throw new Error('Package too small.');
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== PACKAGE_MAGIC) throw new Error('Not an AIM4 replay package.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  if (!PACKAGE_VERSIONS.has(version)) {
    throw new Error(
      `Unsupported package version ${version} (need ${[...PACKAGE_VERSIONS].join(' or ')}).`
    );
  }
  const count = view.getUint32(12, true);
  const files = new Map();
  let o = 16;
  for (let i = 0; i < count; i++) {
    if (o + 6 > bytes.length) throw new Error('Truncated package.');
    const nameLen = view.getUint16(o, true);
    o += 2;
    if (o + nameLen + 4 > bytes.length) throw new Error('Truncated package.');
    const name = new TextDecoder().decode(bytes.subarray(o, o + nameLen));
    o += nameLen;
    const dataLen = view.getUint32(o, true);
    o += 4;
    if (o + dataLen > bytes.length) throw new Error('Truncated package.');
    if (!name || name.includes('..') || name.startsWith('/')) {
      throw new Error(`Bad package entry name: ${name}`);
    }
    files.set(name, bytes.subarray(o, o + dataLen));
    o += dataLen;
  }
  return { version, files };
}
