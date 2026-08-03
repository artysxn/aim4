// ---------------------------------------------------------------------------
// server/ingest/hltv/sources/local.js
// Archives already on disk.
//
// The pipeline does not care where an archive came from, only that it can be
// listed and then made available at a path. This source lists a directory of
// HLTV downloads and hands their paths straight over, which makes the whole
// unpack -> parse -> name -> ingest -> clean loop testable and runnable with no
// network at all.
//
// It is also the fallback when hltv.org is unreachable: point --inbox at a
// folder someone fills by hand and the rest of the system is unchanged.
//
// Archives are never deleted from the inbox by this source. Cleanup only
// removes what the pipeline copied into the work directory, because deleting
// the operator's own files on a parse failure would be unrecoverable.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ACCEPTED_EXTS, classifyUpload } from '../../../replays/archive.js';
import { parseArchiveFilename } from '../hltvNames.js';

const ARCHIVE_EXTS = ACCEPTED_EXTS.filter((e) => e !== '.dem');

export function createLocalSource(cfg) {
  const inbox = cfg.inbox;

  return {
    name: 'local',

    /** Preflight, so a misconfigured run fails at startup and not per match. */
    async check() {
      if (!inbox) throw new Error('source=local needs --inbox <dir> (or AIM4_INGEST_INBOX)');
      const stat = await fsp.stat(inbox).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`Inbox is not a directory: ${inbox}`);
      return { ok: true, detail: inbox };
    },

    /**
     * Every archive in the inbox, as ledger rows.
     *
     * The HLTV token in the filename is the match identity: it is unique per
     * match and stable across re-downloads, which is what stops a re-scan from
     * duplicating work already done.
     */
    async discover({ since, until } = {}) {
      const names = await fsp.readdir(inbox).catch(() => []);
      const rows = [];
      for (const name of names) {
        if (name.startsWith('.')) continue;
        if (!ARCHIVE_EXTS.some((ext) => name.toLowerCase().endsWith(ext))) continue;
        if (!classifyUpload(name)) continue;

        // An inbox is usually a downloads folder, so it holds plenty of
        // archives that are not matches. HLTV names every match archive
        // "<event>-<team>-vs-<team>-bo<n>-<token>", so requiring "-vs-" keeps
        // unrelated zips out of the ledger instead of queueing them to fail.
        if (!/-vs-/i.test(name)) continue;

        const full = path.join(inbox, name);
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat?.isFile()) continue;

        const meta = parseArchiveFilename(name);
        // No HLTV date available offline, so the file's own mtime orders the
        // queue. Chronological order is what the progress display reports.
        const playedAt = new Date(stat.mtimeMs).toISOString();
        if (since && playedAt < since) continue;
        if (until && playedAt > until) continue;

        rows.push({
          matchId: meta.token || name.replace(/\.[^.]+$/, ''),
          source: 'local',
          archiveName: name,
          archivePath: full,
          archiveBytes: stat.size,
          event: meta.event,
          bestOf: meta.bestOf,
          playedAt,
          matchUrl: null
        });
      }
      return rows;
    },

    /**
     * "Fetching" is a copy into the work directory.
     *
     * A copy rather than a reference, so stage 4 can delete its working copy
     * without touching the operator's inbox, and so a partially consumed
     * archive is never the only one that exists.
     */
    async fetchArchive(row, destPath, { onProgress } = {}) {
      const src = row.archivePath || path.join(inbox, row.archiveName);
      const stat = await fsp.stat(src);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(src, destPath);
      onProgress?.({ received: stat.size, total: stat.size });
      return { path: destPath, bytes: stat.size };
    }
  };
}
