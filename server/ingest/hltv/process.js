// ---------------------------------------------------------------------------
// server/ingest/hltv/process.js
// One archive: unpack, parse each map, name the teams, write to the library.
//
// This is the stage that costs real time and real memory, and it reuses the
// library's own machinery rather than reimplementing any of it:
//
//   unpackUpload   archive.js   .rar via bsdtar, .zip in process, junk filtered
//   parseDemo      demoparser   the same parser the website runs
//   ingestDemo     ingest.js    materialize + persist, the parser/store seam
//
// The only thing inserted between them is applyHltvTeams, which has to run
// after the parse and before the ingest. See teamNames.js for why that window
// is the only correct place for it.
//
// Maps are parsed one at a time by default. Three concurrent parses of a
// 128-tick Bo3 will exhaust a small box, and jobs.js already documents how hard
// the parser fights for memory.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { unpackUpload } from '../../replays/archive.js';
import { parseDemo } from '../../demoparser/index.js';
import { ingestDemo } from '../../replays/ingest.js';
import { newDemoId } from '../../replays/demoStore.js';
import { describeArchive, parseDemoFilename } from './hltvNames.js';
import { applyHltvTeams } from './teamNames.js';

/**
 * Unpack one archive into `dir`, keeping HLTV's own entry names.
 *
 * The names matter: `mibr-vs-bestia-m1-cache.dem` is where the team and map
 * metadata comes from, so flattening them to generated ids would throw away the
 * thing that makes offline naming possible.
 */
export async function unpackArchive(archivePath, dir, { allowedBytes }) {
  await fsp.mkdir(dir, { recursive: true });
  const seen = new Set();
  const extracted = await unpackUpload({
    source: archivePath,
    filename: path.basename(archivePath),
    allowedBytes,
    targetFor: (name) => {
      // Collisions are not expected inside one match archive, but a duplicate
      // entry name silently overwriting a map would be invisible later.
      let base = path.basename(name);
      while (seen.has(base)) base = `dup-${base}`;
      seen.add(base);
      return path.join(dir, base);
    }
  });
  return extracted;
}

/**
 * Parse and ingest every map in an already-unpacked archive.
 *
 * @param {object} opts
 * @param {string} opts.library         library key to write into
 * @param {object} opts.row             the ledger row
 * @param {{name: string, path: string, sizeBytes: number}[]} opts.demos
 * @param {number} [opts.concurrency]
 * @param {(e: object) => void} [opts.onProgress]
 */
export async function parseAndIngest({ library, row, demos, concurrency = 1, onProgress }) {
  const described = describeArchive(row.archiveName || '', demos.map((d) => d.name));
  const teams = described.teams;

  // Map filename -> HLTV map slot, so a map is identified by its NAME and not
  // by the order the archive happened to list entries in.
  const byName = new Map(described.maps.map((m) => [m.filename, m]));

  const results = [];
  const queue = [...demos];

  const worker = async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const slot = byName.get(entry.name) || parseDemoFilename(entry.name) || {};
      const label = entry.name;
      onProgress?.({ stage: 'parse', map: label, mapNumber: slot.mapNumber ?? null });

      try {
        const demo = await parseDemo(entry.path, {
          onProgress: (p) => onProgress?.({ stage: 'parse', map: label, ...p })
        });

        // The whole point of this program. Before ingestDemo, never after.
        const naming = applyHltvTeams(demo, teams);

        const demoId = newDemoId();
        onProgress?.({ stage: 'store', map: label });
        const record = await ingestDemo(
          library,
          demoId,
          demo,
          {
            filename: entry.name,
            sizeBytes: entry.sizeBytes,
            source: 'hltv',
            uploadedAt: Date.parse(row.playedAt) || Date.now()
          },
          (p) => onProgress?.({ stage: 'store', map: label, ...p })
        );

        // Provenance, so the naming decision is auditable and a future pass can
        // re-resolve the ones that came back unnamed.
        record.hltv = {
          matchId: row.matchId,
          matchUrl: row.matchUrl || null,
          event: described.event || row.event || '',
          bestOf: described.bestOf ?? row.bestOf ?? null,
          mapNumber: slot.mapNumber ?? null,
          archiveName: row.archiveName || '',
          team1: naming.team1,
          team2: naming.team2,
          confidence: naming.confidence,
          namedFromHltv: naming.applied
        };
        const { writeRecord } = await import('../../replays/demoStore.js');
        await writeRecord(library, record);

        results.push({
          ok: true,
          demoId,
          name: entry.name,
          mapNumber: slot.mapNumber ?? null,
          naming
        });
      } catch (err) {
        // One bad map must not lose the rest of the series.
        results.push({ ok: false, name: entry.name, error: err?.message || String(err) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  results.sort((a, b) => (a.mapNumber ?? 99) - (b.mapNumber ?? 99));
  return { described, results };
}
