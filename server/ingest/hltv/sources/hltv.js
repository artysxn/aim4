// ---------------------------------------------------------------------------
// server/ingest/hltv/sources/hltv.js
// Sequential demo-id walker.
//
// Download transport is exclusively createProbeTool() (the admin Probe tool).
// This module only chooses the next /download/demo/{id} URL and classifies
// the bytes for the ledger / cursor.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fsp from 'node:fs/promises';
import { ChallengeError } from '../fetcher.js';
import { parseArchiveFilename } from '../hltvNames.js';
import { createProbeTool } from '../downloadDemo.js';
import {
  MissingDemoError,
  classifyDownloadedBytes,
  isMissingDownloadError
} from '../classify.js';

const BASE = 'https://www.hltv.org';

export function createHltvSource(cfg) {
  const tool = createProbeTool(cfg, {
    onLog: (message) => console.log(`[probe-tool] ${message}`)
  });
  let inFlight = 0;
  let nextAllowedAt = 0;
  let firstDownload = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function gated(work) {
    while (inFlight >= 1) await sleep(250);
    if (!firstDownload) {
      const now = Date.now();
      const startAt = Math.max(now, nextAllowedAt);
      const wait = startAt - now;
      nextAllowedAt =
        startAt +
        (cfg.minDelayMs || 0) +
        Math.random() * Math.max(0, (cfg.maxDelayMs || 0) - (cfg.minDelayMs || 0));
      if (wait > 0) await sleep(wait);
    }
    firstDownload = false;
    inFlight++;
    try {
      return await work();
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  }

  return {
    name: 'hltv',
    sequential: true,

    async check() {
      return {
        ok: true,
        detail: 'hltv sequential: one URL at a time via createProbeTool()'
      };
    },

    async fetchDemoById(demoId, destPath, { onProgress, signal } = {}) {
      const id = Number(demoId);
      const url = `${BASE}/download/demo/${id}`;
      let got;
      try {
        // Exact probe tool. One URL. No parallel downloads.
        got = await gated(() =>
          tool.download(url, path.dirname(destPath), {
            fallbackName: path.basename(destPath),
            maxBytes: cfg.maxArchiveBytes,
            signal,
            onProgress
          })
        );
      } catch (err) {
        if (err?.blocked || err?.fatal) throw err;
        if (isMissingDownloadError(err)) throw new MissingDemoError(id, err.message);
        throw err;
      }

      const target = got.path;
      const fh = await fsp.open(target, 'r');
      const head = Buffer.alloc(Math.min(4096, got.bytes || 4096));
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      await fh.close();
      const classified = classifyDownloadedBytes(head.subarray(0, bytesRead));

      if (classified.kind === 'missing') {
        await fsp.rm(target, { force: true }).catch(() => {});
        throw new MissingDemoError(id, classified.title || 'Page not found');
      }
      if (classified.kind === 'challenge') {
        await fsp.rm(target, { force: true }).catch(() => {});
        const err = new ChallengeError(url, 403);
        err.fatal = false;
        err.blocked = true;
        err.proxyRetryable = true;
        throw err;
      }
      if (classified.kind !== 'archive') {
        await fsp.rm(target, { force: true }).catch(() => {});
        throw new Error(
          `Downloaded file is not an archive (${classified.kind}` +
            `${classified.title ? `, title "${classified.title}"` : ''})`
        );
      }

      const filename = got.filename;
      const meta = parseArchiveFilename(filename);
      return {
        path: target,
        bytes: got.bytes,
        filename,
        event: meta.event || '',
        bestOf: meta.bestOf || null
      };
    },

    async fetchArchive(row, destPath, { onProgress, signal } = {}) {
      const got = await this.fetchDemoById(row.hltvDemoId || row.matchId, destPath, {
        onProgress,
        signal
      });
      row.archiveName = got.filename;
      if (got.event && !row.event) row.event = got.event;
      if (got.bestOf) row.bestOf = got.bestOf;
      return { path: got.path, bytes: got.bytes };
    },

    async close() {
      await tool.close();
    }
  };
}
