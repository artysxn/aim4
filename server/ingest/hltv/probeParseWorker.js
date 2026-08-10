// ---------------------------------------------------------------------------
// server/ingest/hltv/probeParseWorker.js
// Parse one .dem into a .aim4replay package, as a SEPARATE PROCESS.
//
// Forked by probe.js for the same reason jobs.js forks parseWorker.js: the
// native parser's memory is unbounded from the parent's point of view, and an
// OOM here must kill this process, not the API server and every live match in
// it.
//
// Unlike parseWorker.js this does NOT ingest into the library. The probe is a
// check, not an import: its product is a standalone .aim4replay package (the
// same bytes tools/parse-demo-local.js writes), so a probe run can never
// pollute the shared library.
//
//   argv[2] = JSON { file, outPath, meta: { filename, sizeBytes, uploadedAt } }
//   IPC out: { type: 'progress', ... } | { type: 'done', summary } |
//            { type: 'error', error }
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseDemo } from '../../demoparser/index.js';
import { compactMaterializedFiles, materializeDemo } from '../../replays/materialize.js';
import { newDemoId } from '../../replays/demoStore.js';
import { encodeReplayPackage } from '../../../src/replays/shared/replayPackage.js';

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    /* parent gone; nothing useful left to do */
  }
};

async function run() {
  const { file, outPath, meta = {} } = JSON.parse(process.argv[2] || '{}');
  if (!file || !outPath) throw new Error('probeParseWorker needs { file, outPath }');

  const demo = await parseDemo(file, {
    onProgress: (p) => send({ type: 'progress', ...p })
  });

  send({ type: 'progress', stage: 'store', round: 0, total: demo.rounds.length });
  const { record, files: plain } = materializeDemo(demo, newDemoId(), {
    filename: meta.filename || path.basename(file),
    sizeBytes: meta.sizeBytes || 0,
    uploadedAt: meta.uploadedAt || Date.now(),
    source: 'probe'
  });

  send({ type: 'progress', stage: 'compact' });
  const packaged = encodeReplayPackage(compactMaterializedFiles(plain));

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, packaged);

  send({
    type: 'done',
    summary: {
      map: record.map,
      mapName: record.mapName,
      score: record.score,
      team1: record.team1?.name || '',
      team2: record.team2?.name || '',
      roundCount: record.roundCount,
      packageBytes: packaged.byteLength
    }
  });
  process.exit(0);
}

run().catch((err) => {
  send({ type: 'error', error: err?.message || String(err) });
  process.exit(1);
});
