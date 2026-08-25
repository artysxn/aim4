// ---------------------------------------------------------------------------
// replays/roundPackWire.js
// The wire container for batched round packs.
//
// The Pattern Finder's shape search reads meta + coarse ticks for every round
// it touches. Fetching those one round at a time is two HTTP round-trips per
// round through the browser's six-connection cap — a whole-map search is tens
// of thousands of requests and the phase is pure network latency. One batched
// response carries N rounds instead.
//
// Layout, front to back:
//
//   "A4PK"                     4 bytes, magic
//   header length              u32, big-endian
//   header JSON                { v, entries: [{ file, meta, ticksLen }] }
//   tick blobs                 concatenated, in entry order
//
// Meta rides inside the header JSON (it is JSON already); ticks are opaque
// bytes. ticksLen 0 means "no tick blob for this entry" — a real tick buffer
// is never empty. meta null means the round was missing or not readable by
// this caller; the client falls back to its per-round path for those.
// ---------------------------------------------------------------------------

export const ROUND_PACK_MAGIC = 'A4PK';

const MAGIC_BYTES = [0x41, 0x34, 0x50, 0x4b]; // "A4PK"

/**
 * @param {Array<{ file: string, meta: object|null, ticks?: Uint8Array|ArrayBuffer|null }>} entries
 * @returns {Uint8Array}
 */
export function encodeRoundPacks(entries) {
  const blobs = [];
  const headerEntries = [];
  for (const e of entries || []) {
    let ticks = e.ticks || null;
    if (ticks instanceof ArrayBuffer) ticks = new Uint8Array(ticks);
    headerEntries.push({
      file: String(e.file || ''),
      meta: e.meta ?? null,
      ticksLen: ticks ? ticks.byteLength : 0
    });
    if (ticks && ticks.byteLength) blobs.push(ticks);
  }
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({ v: 1, entries: headerEntries })
  );
  let bodyLen = 0;
  for (const b of blobs) bodyLen += b.byteLength;
  const out = new Uint8Array(8 + headerBytes.byteLength + bodyLen);
  out.set(MAGIC_BYTES, 0);
  new DataView(out.buffer).setUint32(4, headerBytes.byteLength);
  out.set(headerBytes, 8);
  let at = 8 + headerBytes.byteLength;
  for (const b of blobs) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Array<{ file: string, meta: object|null, ticks: ArrayBuffer|null }>|null}
 *   null when the buffer is not a round-pack body (wrong magic, truncated) —
 *   the caller treats that as "this server does not speak the format".
 */
export function decodeRoundPacks(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 8) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC_BYTES[i]) return null;
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (headerLen <= 0 || 8 + headerLen > bytes.byteLength) return null;
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  } catch {
    return null;
  }
  if (!header || !Array.isArray(header.entries)) return null;
  const out = [];
  let at = 8 + headerLen;
  for (const e of header.entries) {
    const len = Math.max(0, Number(e?.ticksLen) || 0);
    let ticks = null;
    if (len) {
      if (at + len > bytes.byteLength) return null;
      // A copy, so a pack outlives the (possibly pooled) response buffer.
      ticks = bytes.buffer.slice(bytes.byteOffset + at, bytes.byteOffset + at + len);
      at += len;
    }
    out.push({ file: String(e?.file || ''), meta: e?.meta ?? null, ticks });
  }
  return out;
}
