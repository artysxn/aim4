// ---------------------------------------------------------------------------
// server/ingest/hltv/sources/hltv.js
// Archives from hltv.org.
//
// Discovery pages and archive downloads run through the shared CloakBrowser
// transport. The browser session is reused for the life of the ingester so
// cookies survive from preflight through discovery and downloads.
//
// Everything downstream of here is source-agnostic and already proven against
// the `local` source, so if access is arranged this file is the only thing that
// has to start working.
//
// The selectors live in one object on purpose. HLTV markup changes, and the
// failure mode to avoid is silently writing thousands of half-empty rows, so
// every required field throws by name when it is missing.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fsp from 'node:fs/promises';
import { ChallengeError, HttpError, looksLikeChallenge } from '../fetcher.js';
import { parseArchiveFilename } from '../hltvNames.js';
import { createCloakSession } from '../cloakBrowser.js';

const BASE = 'https://www.hltv.org';

/**
 * Where each field comes from. Kept together so a markup change is one edit and
 * one obvious diff rather than a hunt through the file.
 */
export const SELECTORS = {
  resultRow: /<div class="result-con"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g,
  matchHref: /href="(\/matches\/(\d+)\/[^"]+)"/,
  resultDate: /data-zonedgrouping-entry-unix="(\d+)"/,
  demoHref: /href="(\/download\/demo\/(\d+))"/,
  teamName: /class="teamName"[^>]*>([^<]+)</g,
  eventName: /class="event text-ellipsis"[^>]*>\s*<a[^>]*>([^<]+)</,
  stars: /class="stars"[^>]*>([\s\S]*?)<\/div>/
};

function must(value, field, url) {
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `HLTV page ${url} had no ${field}. The markup has probably changed; ` +
        'update SELECTORS in sources/hltv.js rather than letting rows be written half-empty.'
    );
  }
  return value;
}

export function createHltvSource(cfg) {
  const browser = createCloakSession(cfg);
  let inFlight = 0;
  let nextAllowedAt = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Preserve the ingester's existing concurrency and jitter limits. */
  async function gated(work) {
    while (inFlight >= cfg.batchSize) await sleep(250);
    const now = Date.now();
    const startAt = Math.max(now, nextAllowedAt);
    const wait = startAt - now;
    nextAllowedAt =
      startAt +
      cfg.minDelayMs +
      Math.random() * Math.max(0, cfg.maxDelayMs - cfg.minDelayMs);
    if (wait > 0) await sleep(wait);
    inFlight++;
    try {
      return await work();
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  }

  async function getText(url) {
    const page = await gated(() => browser.getText(url));
    if (looksLikeChallenge(page.text)) throw new ChallengeError(url, page.status);
    if (page.status < 200 || page.status >= 300) throw new HttpError(url, page.status);
    return page.text;
  }

  return {
    name: 'hltv',

    /** Fail loudly at startup rather than once per match. */
    async check() {
      await getText(`${BASE}/results`);
      return { ok: true, detail: 'hltv.org reachable through CloakBrowser' };
    },

    /**
     * Walk /results backwards until `since`, then read each match page for the
     * demo id, both team names and the event.
     */
    async discover({ since, until, maxPages = 50 } = {}) {
      const rows = [];
      for (let page = 0; page < maxPages; page++) {
        const url = `${BASE}/results?offset=${page * 100}`;
        const html = await getText(url);

        const matches = [...html.matchAll(SELECTORS.resultRow)];
        if (!matches.length) break;

        let reachedFloor = false;
        for (const [block] of matches.map((m) => [m[0]])) {
          const href = SELECTORS.matchHref.exec(block);
          const unix = SELECTORS.resultDate.exec(block);
          if (!href) continue;
          const playedAt = unix ? new Date(Number(unix[1])).toISOString() : null;
          if (since && playedAt && playedAt < since) {
            reachedFloor = true;
            continue;
          }
          if (until && playedAt && playedAt > until) continue;
          rows.push({ matchId: href[2], matchPath: href[1], playedAt });
        }
        if (reachedFloor) break;
      }

      // Match pages, one at a time, for the demo id and the real team names.
      const out = [];
      for (const row of rows) {
        const url = `${BASE}${row.matchPath}`;
        const html = await getText(url);
        const demo = SELECTORS.demoHref.exec(html);
        if (!demo) continue; // no demo uploaded; normal, especially for old events

        const names = [...html.matchAll(SELECTORS.teamName)].map((m) => m[1].trim());
        const event = SELECTORS.eventName.exec(html);
        must(names[0], 'team 1 name', url);
        must(names[1], 'team 2 name', url);

        out.push({
          matchId: row.matchId,
          source: 'hltv',
          hltvDemoId: demo[2],
          matchUrl: url,
          playedAt: row.playedAt,
          event: event ? event[1].trim() : '',
          teams: [{ name: names[0] }, { name: names[1] }]
        });
      }
      return out;
    },

    /** Open the download URL in CloakBrowser and stream the archive to disk. */
    async fetchArchive(row, destPath, { onProgress } = {}) {
      const url = `${BASE}/download/demo/${row.hltvDemoId}`;
      const got = await gated(() =>
        browser.download(url, path.dirname(destPath), {
          fallbackName: path.basename(destPath),
          maxBytes: cfg.maxArchiveBytes,
          onProgress
        })
      );
      const filename = got.filename;
      const target = got.path;

      // An HTML error page saved as .rar is the classic failure; catch it here
      // rather than letting the parser try to make sense of it.
      const head = Buffer.alloc(4);
      const fh = await fsp.open(target, 'r');
      await fh.read(head, 0, 4, 0);
      await fh.close();
      const magic = head.toString('latin1');
      if (!magic.startsWith('Rar!') && !magic.startsWith('PK') && magic[0] !== '\x1f') {
        throw new Error(`Downloaded file is not an archive (magic ${JSON.stringify(magic)})`);
      }

      // Record the real HLTV filename: it carries the team and event metadata.
      row.archiveName = filename;
      const meta = parseArchiveFilename(filename);
      if (meta.event && !row.event) row.event = meta.event;
      if (meta.bestOf) row.bestOf = meta.bestOf;

      return { path: target, bytes: got.bytes };
    },

    async close() {
      await browser.close();
    }
  };
}
