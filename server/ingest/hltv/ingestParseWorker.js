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
import { PARSER_REVISION } from '../../demoparser/schema.js';

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

  // One gate on top of the duplicate check: a match we already hold is still
  // worth writing when the copy we hold was made by an OLDER parser. Revisions
  // 1-2 stored zeros for jump and crouch (demoparser2 silently ignored the
  // prop names they asked with), and that cannot be repaired from the stored
  // ticks — only a reparse fixes it, and we have just done one.
  //
  // The upgrade writes under the EXISTING demo id rather than the fresh one.
  // That is the whole difference between an upgrade and a duplicate: keeping
  // the id means every link, note, tag and stat that points at this match
  // still points at it afterwards. Minting a new id here would leave the stale
  // copy in place and add a second one beside it.
  const dupRevision = dup ? (dup.parser?.revision ?? 1) : null;
  const upgrading = Boolean(dup) && dupRevision < PARSER_REVISION;

  if (dup && !upgrading) {
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

  const targetId = upgrading ? dup.id : demoId;

  send({ type: 'progress', stage: 'store', round: 0, total: demo.rounds?.length || 0 });
  const record = await ingestDemo(
    library,
    targetId,
    demo,
    {
      filename: filename || path.basename(file),
      sizeBytes: Number(sizeBytes) || 0,
      source: 'hltv',
      // An upgrade keeps the moment it was first seen; only a genuinely new
      // demo is dated now. Same for who owns it and who may see it —
      // ingestDemo carries uploader and visibility off the existing record,
      // and these are the rest of what a viewer would notice going missing.
      uploadedAt: upgrading
        ? Date.parse(dup.uploadedAt) || Date.parse(row.playedAt) || Date.now()
        : Date.parse(row.playedAt) || Date.now(),
      uploaderId: upgrading ? dup.uploaderId || INGEST_UPLOADER.id : INGEST_UPLOADER.id,
      uploaderName: upgrading ? dup.uploaderName || INGEST_UPLOADER.username : INGEST_UPLOADER.username,
      visibility: upgrading ? dup.visibility || 'public' : 'public'
    },
    (p) => send({ type: 'progress', stage: 'store', ...p })
  );

  if (upgrading) {
    if (dup.tags) record.tags = dup.tags;
    if (Number.isFinite(dup.views)) record.views = dup.views;
    if (dup.topPlayer) record.topPlayer = dup.topPlayer;
    record.reparsedAt = new Date().toISOString();
  }

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
      // An upgrade is neither a duplicate nor a new demo; the pipeline counts
      // it as stored (it wrote files), and this says which id it landed on so
      // the log does not look like a mismatch.
      upgraded: upgrading || undefined,
      upgradedFrom: upgrading ? dupRevision : undefined,
      demoId: targetId,
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
