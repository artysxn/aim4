// ---------------------------------------------------------------------------
// server/ingest/hltv/process.js
// One archive: unpack, parse each map, name the teams, write to the library.
//
// Parsing runs in a forked ingestParseWorker.js. demoparser is native Rust; a
// panic aborts that worker (SIGABRT) instead of the continuous ingest process,
// so one corrupt overtime split cannot stop the overnight walk.
// ---------------------------------------------------------------------------

import { fork } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackUpload } from '../../replays/archive.js';
import { newDemoId } from '../../replays/demoStore.js';
import { describeArchive, isOverpassFilename, parseDemoFilename } from './hltvNames.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'ingestParseWorker.js');
const WORKER_HEAP_MB = Number(process.env.AIM4_PARSE_HEAP_MB || 1024);
const PARSE_STALL_MS = Number(process.env.AIM4_INGEST_PARSE_STALL_MS || 15 * 60 * 1000);

/**
 * Unpack one archive into `dir`, keeping HLTV's own entry names.
 */
export async function unpackArchive(archivePath, dir, { allowedBytes }) {
  await fsp.mkdir(dir, { recursive: true });
  const seen = new Set();
  const extracted = await unpackUpload({
    source: archivePath,
    filename: path.basename(archivePath),
    allowedBytes,
    targetFor: (name) => {
      let base = path.basename(name);
      while (seen.has(base)) base = `dup-${base}`;
      seen.add(base);
      return path.join(dir, base);
    }
  });
  return extracted;
}

/**
 * Parse one .dem in a child process. Crashes become Error results, not process death.
 */
function parseOneMapForked(payload, onProgress) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [JSON.stringify(payload)], {
      execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });

    let settled = false;
    let stallTimer = null;
    const touch = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(
          new Error(
            `Parse made no progress for ${Math.round(PARSE_STALL_MS / 60000)} minutes`
          )
        );
      }, PARSE_STALL_MS);
      stallTimer.unref?.();
    };

    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      err ? reject(err) : resolve(result);
    };

    touch();
    child.on('message', (msg) => {
      if (msg?.type === 'progress') {
        touch();
        onProgress?.(msg);
      } else if (msg?.type === 'done') {
        settle(null, msg.result);
      } else if (msg?.type === 'error') {
        settle(new Error(msg.error || 'Parse worker error'));
      }
    });
    child.on('error', (err) => settle(err));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const crashed =
        signal === 'SIGABRT' ||
        signal === 'SIGSEGV' ||
        signal === 'SIGILL' ||
        signal === 'SIGBUS' ||
        code === null;
      settle(
        new Error(
          crashed
            ? `Parse worker crashed (${signal || 'no exit code'}); skipping this map`
            : `Parse worker exited with code ${code}`
        )
      );
    });
  });
}

/**
 * Parse and ingest every map in an already-unpacked archive.
 *
 * @param {object} opts
 * @param {string} opts.library
 * @param {object} opts.row
 * @param {{name: string, path: string, sizeBytes: number}[]} opts.demos
 * @param {number} [opts.concurrency]
 * @param {(e: object) => void} [opts.onProgress]
 */
export async function parseAndIngest({ library, row, demos, concurrency = 1, onProgress }) {
  const described = describeArchive(row.archiveName || '', demos.map((d) => d.name));
  const teams = described.teams;
  const byName = new Map(described.maps.map((m) => [m.filename, m]));

  const results = [];
  const queue = [...demos];

  const worker = async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const slot = byName.get(entry.name) || parseDemoFilename(entry.name) || {};
      const label = entry.name;
      const mapNumber = slot.mapNumber ?? null;

      if (isOverpassFilename(entry.name)) {
        onProgress?.({
          stage: 'parse',
          map: label,
          mapNumber,
          skipped: 'overpass'
        });
        results.push({
          ok: true,
          skipped: true,
          reason: 'overpass',
          name: entry.name,
          mapNumber
        });
        continue;
      }

      onProgress?.({ stage: 'parse', map: label, mapNumber });

      try {
        const result = await parseOneMapForked(
          {
            file: entry.path,
            library,
            demoId: newDemoId(),
            sizeBytes: entry.sizeBytes,
            filename: entry.name,
            archiveTeams: teams,
            row: {
              matchId: row.matchId,
              matchUrl: row.matchUrl || null,
              playedAt: row.playedAt || null,
              event: row.event || '',
              bestOf: row.bestOf ?? null,
              archiveName: row.archiveName || ''
            },
            described: {
              event: described.event || '',
              bestOf: described.bestOf ?? null
            },
            mapNumber
          },
          (p) => onProgress?.({ stage: p.stage || 'parse', map: label, ...p })
        );
        results.push(result);
      } catch (err) {
        // One bad / crashing map must not lose the rest of the series, and must
        // not take down continuous ingest.
        console.warn(`[parse] ${label}: ${err?.message || err}`);
        results.push({
          ok: false,
          name: entry.name,
          mapNumber,
          error: err?.message || String(err),
          crashed: /crashed|SIGABRT|SIGSEGV|SIGILL|SIGBUS/i.test(String(err?.message || err))
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  results.sort((a, b) => (a.mapNumber ?? 99) - (b.mapNumber ?? 99));
  return { described, results };
}
