// ---------------------------------------------------------------------------
// server/ingest/hltv/sources/hltv.js
// Archives from hltv.org via sequential /download/demo/{id} URLs.
//
// Downloads run through the shared CloakBrowser transport. The browser session
// is reused for the life of the ingester so cookies and the proxy pool survive
// across demo ids.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fsp from 'node:fs/promises';
import { ChallengeError, looksLikeChallenge } from '../fetcher.js';
import { parseArchiveFilename } from '../hltvNames.js';
import { createCloakSession } from '../cloakBrowser.js';
import {
  MissingDemoError,
  classifyDownloadedBytes,
  isMissingDownloadError
} from '../classify.js';

const BASE = 'https://www.hltv.org';

export function createHltvSource(cfg) {
  const browser = createCloakSession({ ...cfg, cloakSessionName: 'ingest' });
  let inFlight = 0;
  let nextAllowedAt = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function gated(work) {
    while (inFlight >= Math.max(1, cfg.batchSize || 1)) await sleep(250);
    const now = Date.now();
    const startAt = Math.max(now, nextAllowedAt);
    const wait = startAt - now;
    nextAllowedAt =
      startAt +
      (cfg.minDelayMs || 0) +
      Math.random() * Math.max(0, (cfg.maxDelayMs || 0) - (cfg.minDelayMs || 0));
    if (wait > 0) await sleep(wait);
    inFlight++;
    try {
      return await work();
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  }

  return {
    name: 'hltv',
    /** Pipeline uses sequential demo-id walking instead of /results crawl. */
    sequential: true,

    async check() {
      // Cheap reachability: open results; challenge is fatal and surfaces early.
      const page = await gated(() => browser.getText(`${BASE}/results`, { settleMs: 2000 }));
      if (looksLikeChallenge(page.text)) {
        throw new ChallengeError(`${BASE}/results`, page.status);
      }
      return { ok: true, detail: 'hltv.org reachable through CloakBrowser' };
    },

    /**
     * Download one demo id. Throws MissingDemoError on HLTV 404 / Page not found,
     * ChallengeError-shaped blocked errors from CloakBrowser, or generic errors.
     */
    async fetchDemoById(demoId, destPath, { onProgress } = {}) {
      const id = Number(demoId);
      const url = `${BASE}/download/demo/${id}`;
      let got;
      try {
        got = await gated(() =>
          browser.download(url, path.dirname(destPath), {
            fallbackName: path.basename(destPath),
            maxBytes: cfg.maxArchiveBytes,
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

    /** Compatibility for any leftover callers that still pass a ledger row. */
    async fetchArchive(row, destPath, { onProgress } = {}) {
      const got = await this.fetchDemoById(row.hltvDemoId || row.matchId, destPath, {
        onProgress
      });
      row.archiveName = got.filename;
      if (got.event && !row.event) row.event = got.event;
      if (got.bestOf) row.bestOf = got.bestOf;
      return { path: got.path, bytes: got.bytes };
    },

    async close() {
      await browser.close();
    }
  };
}
