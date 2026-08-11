// ---------------------------------------------------------------------------
// server/ingest/hltv/cleanup.js
// Clearing the shelf. This is what makes the run's disk use constant.
//
// Parsing is roughly 200:1, so once a map is in the library its 200 MB source
// is dead weight. Delete it immediately and the working set stays at one batch
// (~1.5-3 GB) no matter how many thousand matches the run gets through.
//
// Deletion is driven by ledger state and never by scanning the work directory,
// with exactly one exception: the orphan sweep at startup, which is the only
// thing that can safely reason about directories no ledger row claims. A crash
// mid-parse must not delete a demo a retry still needs.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Remove one match's working directory: the archive and its extracted demos. */
export async function cleanMatch(workDir, matchId) {
  const dir = path.join(workDir, String(matchId));
  const freed = await dirBytes(dir);
  await fsp.rm(dir, { recursive: true, force: true });
  return { dir, freed };
}

/**
 * Remove work directories no live ledger row claims.
 *
 * Runs once at startup, before any download. These are the leftovers of a
 * crash, and without this a long run slowly fills the volume with the debris of
 * every interruption. It is the only place allowed to delete by directory scan.
 *
 * @param {string} workDir
 * @param {(matchId: string) => boolean} isLive  true while a row still needs its files
 */
export async function sweepOrphans(workDir, isLive) {
  const entries = await fsp.readdir(workDir, { withFileTypes: true }).catch(() => []);
  const removed = [];
  let freed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isLive(entry.name)) continue;
    const result = await cleanMatch(workDir, entry.name);
    freed += result.freed;
    removed.push(entry.name);
  }
  return { removed, freed };
}

export async function dirBytes(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(full);
    } else {
      total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/** Free bytes on the volume holding `dir`, for the pre-batch headroom check. */
export async function freeBytes(dir) {
  try {
    const stat = await fsp.statfs(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.POSITIVE_INFINITY; // cannot tell; do not block the run
  }
}
