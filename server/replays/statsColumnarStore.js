// ---------------------------------------------------------------------------
// replays/statsColumnarStore.js
// A columnar sidecar next to each stats index, read only for the columns a
// request asked for.
//
// Deliberately a *cache*, not a replacement: `<demoId>.json` stays the source
// of truth, and the sidecar carries a stamp of the JSON it was built from. Any
// mismatch — a rebuild, an enrichment pass, a version bump — makes the reader
// fall through to the existing path, which then refreshes the sidecar. So the
// worst case of a stale or corrupt sidecar is today's speed, never a wrong
// answer, and none of the enrichment logic in statsIndex has to change.
//
//   server/data/replays/<user>/stats/<demoId>.json   source of truth
//   server/data/replays/<user>/stats/<demoId>.a4c    columnar sidecar
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  assembleEntry,
  blockRange,
  decodeHeader,
  encodeColumnar
} from '../../src/replays/shared/statsColumnar.js';

const statsDir = (userDir) => path.join(userDir, 'stats');

const jsonPath = (io, user, id) => path.join(statsDir(io.userDir(user)), `${id}.json`);
const colPath = (io, user, id) => path.join(statsDir(io.userDir(user)), `${id}.a4c`);

/** How many header bytes to read before knowing the real header length. */
const HEADER_PROBE = 64 * 1024;

/** Identity of the JSON an sidecar was built from. Cheap to compute. */
function stampOf(stat) {
  if (!stat) return '';
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

/**
 * Read one demo's index, decoding only `groups`.
 *
 * @param {object} io
 * @param {string} user
 * @param {string} demoId
 * @param {string[]} groups column groups to decode
 * @param {{ require?: string[] }} [opts] groups that must actually carry data.
 *   Used for columns the slow path can enrich on demand (heldGun): serving a
 *   sidecar that predates the enrichment would silently withhold them.
 * @returns {Promise<object|null>} the projected entry, or null when the
 *   sidecar is absent or stale and the caller should use the JSON path
 */
export async function readColumnar(io, user, demoId, groups, opts = {}) {
  let jsonStat;
  try {
    jsonStat = await fsp.stat(jsonPath(io, user, demoId));
  } catch {
    return null;
  }
  const want = stampOf(jsonStat);

  let fh;
  try {
    fh = await fsp.open(colPath(io, user, demoId), 'r');
  } catch {
    return null;
  }
  try {
    const probe = new Uint8Array(HEADER_PROBE);
    const { bytesRead } = await fh.read(probe, 0, HEADER_PROBE, 0);
    let decoded = decodeHeader(probe.subarray(0, bytesRead));
    if (!decoded && bytesRead >= 8) {
      // Header longer than the probe: read exactly what it declared.
      const view = new DataView(probe.buffer, 0, 8);
      const hLen = view.getUint32(4);
      if (hLen > 0 && hLen < 64 * 1024 * 1024) {
        const full = new Uint8Array(8 + hLen);
        await fh.read(full, 0, full.length, 0);
        decoded = decodeHeader(full);
      }
    }
    if (!decoded) return null;
    const { header, blockBase } = decoded;
    // The sidecar describes a JSON that has since changed. Fall through.
    if (header.stamp !== want) return null;
    const have = new Set(header.have || []);
    for (const g of opts.require || []) {
      if (!have.has(g)) return null;
    }

    const blockText = new Map();
    const decoder = new TextDecoder();
    for (const g of groups) {
      const range = blockRange(header, blockBase, g);
      if (!range) continue;
      const buf = new Uint8Array(range.length);
      await fh.read(buf, 0, range.length, range.start);
      blockText.set(g, decoder.decode(buf));
    }
    return assembleEntry(header, blockText);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Write (or refresh) the sidecar for an entry already read from JSON.
 *
 * Best-effort and non-blocking for the caller: a failed write costs the next
 * read its speed, nothing else. Never let it fail a request.
 */
export async function writeColumnar(io, user, demoId, entry) {
  try {
    const stat = await fsp.stat(jsonPath(io, user, demoId));
    const bytes = encodeColumnar(entry, { stamp: stampOf(stat) });
    const target = colPath(io, user, demoId);
    // Write via a temp file so a reader never sees a half-written sidecar.
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** Drop a sidecar (demo deleted, or an explicit rebuild). */
export async function forgetColumnar(io, user, demoId) {
  await fsp.rm(colPath(io, user, demoId), { force: true }).catch(() => {});
}
