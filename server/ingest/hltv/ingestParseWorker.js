// ---------------------------------------------------------------------------
// server/ingest/hltv/ingestParseWorker.js
// Parse + ingest one .dem as a SEPARATE PROCESS.
//
// demoparser is native Rust. A panic (index out of bounds, etc.) can abort the
// process with SIGABRT. That must kill this worker only, never the continuous
// ingest CLI, or one corrupt overtime split stops the overnight walk.
//
//   argv[2] = JSON payload (see process.js)
//   IPC out: { type: 'progress', ... } | { type: 'done', result } |
//            { type: 'error', error }
// ---------------------------------------------------------------------------

import path from 'node:path';
import { parseDemo } from '../../demoparser/index.js';
import { ingestDemo } from '../../replays/ingest.js';
import { writeRecord } from '../../replays/demoStore.js';
import { INGEST_UPLOADER } from '../../replays/identity.js';
import { applyHltvTeams, teamsFromDemoFilename } from './teamNames.js';
import { findLibraryDuplicate, fingerprintDemo } from './duplicates.js';

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    /* parent gone */
  }
};

async function run() {
  const {
    file,
    library,
    demoId,
    sizeBytes,
    filename,
    archiveTeams,
    row = {},
    described = {},
    mapNumber = null
  } = JSON.parse(process.argv[2] || '{}');

  if (!file || !library || !demoId) {
    throw new Error('ingestParseWorker needs { file, library, demoId }');
  }

  const demo = await parseDemo(file, {
    onProgress: (p) => send({ type: 'progress', ...p })
  });

  const naming = applyHltvTeams(
    demo,
    teamsFromDemoFilename(filename || path.basename(file), archiveTeams || [])
  );

  const fingerprint = fingerprintDemo(demo, sizeBytes);
  const dup = await findLibraryDuplicate(library, fingerprint);
  if (dup) {
    send({
      type: 'done',
      result: {
        ok: true,
        duplicate: true,
        demoId: dup.id,
        name: filename || path.basename(file),
        mapNumber,
        naming,
        duplicateOf: dup.id
      }
    });
    process.exit(0);
  }

  send({ type: 'progress', stage: 'store', round: 0, total: demo.rounds?.length || 0 });
  const record = await ingestDemo(
    library,
    demoId,
    demo,
    {
      filename: filename || path.basename(file),
      sizeBytes: Number(sizeBytes) || 0,
      source: 'hltv',
      uploadedAt: Date.parse(row.playedAt) || Date.now(),
      uploaderId: INGEST_UPLOADER.id,
      uploaderName: INGEST_UPLOADER.username,
      visibility: 'public'
    },
    (p) => send({ type: 'progress', stage: 'store', ...p })
  );

  record.hltv = {
    matchId: row.matchId,
    matchUrl: row.matchUrl || null,
    event: described.event || row.event || '',
    bestOf: described.bestOf ?? row.bestOf ?? null,
    mapNumber,
    archiveName: row.archiveName || '',
    team1: naming.team1,
    team2: naming.team2,
    confidence: naming.confidence,
    namedFromHltv: naming.applied
  };
  await writeRecord(library, record);

  send({
    type: 'done',
    result: {
      ok: true,
      duplicate: false,
      demoId,
      name: filename || path.basename(file),
      mapNumber,
      naming
    }
  });
  process.exit(0);
}

run().catch((err) => {
  send({ type: 'error', error: err?.message || String(err) });
  process.exit(1);
});
