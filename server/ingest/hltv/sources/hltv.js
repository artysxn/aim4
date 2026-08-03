// ---------------------------------------------------------------------------
// server/ingest/hltv/sources/hltv.js
// Archives from hltv.org.
//
// STATUS: blocked. Every hltv.org endpoint, /robots.txt included, answers 403
// with a Cloudflare managed challenge to any non-browser client. This source is
// written and correct, and it will halt at the first request until that
// changes. The remedy is access (permission, an allowlisted address, an
// official feed), not a workaround: see fetcher.js for the line this project
// does not cross.
//
// Everything downstream of here is source-agnostic and already proven against
// the `local` source, so if access is arranged this file is the only thing that
// has to start working.
//
// The selectors live in one object on purpose. HLTV markup changes, and the
// failure mode to avoid is silently writing thousands of half-empty rows, so
// every required field throws by name when it is missing.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createFetcher } from '../fetcher.js';
import { parseArchiveFilename } from '../hltvNames.js';

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
  const http = createFetcher(cfg);

  return {
    name: 'hltv',

    /** Fail loudly at startup rather than once per match. */
    async check() {
      const probe = await http.probe();
      if (probe.ok) return { ok: true, detail: 'hltv.org reachable' };
      throw new Error(
        probe.challenge
          ? 'hltv.org is serving a Cloudflare managed challenge to this host, so ' +
            'automated download is not possible from here. Use --source local with ' +
            'an --inbox of archives, or arrange access with HLTV. This project does ' +
            'not attempt to defeat the challenge.'
          : `hltv.org preflight failed: ${probe.error}`
      );
    },

    /**
     * Walk /results backwards until `since`, then read each match page for the
     * demo id, both team names and the event.
     */
    async discover({ since, until, maxPages = 50 } = {}) {
      const rows = [];
      for (let page = 0; page < maxPages; page++) {
        const url = `${BASE}/results?offset=${page * 100}`;
        const html = await http.getText(url);

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
        const html = await http.getText(url);
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

    /** Stream the archive to disk. Never buffered: these are hundreds of MB. */
    async fetchArchive(row, destPath, { onProgress } = {}) {
      const url = `${BASE}/download/demo/${row.hltvDemoId}`;
      const res = await http.get(url, { attempts: 3 });

      const disposition = res.headers.get('content-disposition') || '';
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
      const filename = named ? decodeURIComponent(named[1]) : path.basename(destPath);
      const target = path.join(path.dirname(destPath), filename);

      const total = Number(res.headers.get('content-length')) || 0;
      if (total && total > cfg.maxArchiveBytes) {
        throw new Error(`Archive is ${total} bytes, over the ${cfg.maxArchiveBytes} cap`);
      }

      await fsp.mkdir(path.dirname(target), { recursive: true });
      let received = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        received += chunk.length;
        if (received > cfg.maxArchiveBytes) body.destroy(new Error('Archive exceeded the size cap'));
        onProgress?.({ received, total });
      });
      const { createWriteStream } = await import('node:fs');
      await pipeline(body, createWriteStream(target));

      const stat = await fsp.stat(target);
      if (!stat.size) throw new Error('Downloaded archive is empty');

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

      return { path: target, bytes: stat.size };
    }
  };
}
