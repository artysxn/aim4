// ---------------------------------------------------------------------------
// replays/ingest.js
// Bridges a parsed demo into the library: settles what the two teams are
// called, assigns every round its name and writes the round files. The parser
// stays unaware of the naming scheme, and the store stays unaware of parsing;
// this is the seam between them, and the last moment at which a team name can
// still reach the round ids.
// ---------------------------------------------------------------------------

import { materializeDemo } from './materialize.js';
import { readRecord, writeMaterialized } from './demoStore.js';
import { applyStandingsToDemo } from './teamStandingsDb.js';
import { applyLibraryTeamNames } from './lineupNames.js';

/**
 * Name and persist every round of a parsed demo.
 *
 * @param {string} user
 * @param {string} demoId
 * @param {import('../demoparser/schema.js').NormalizedDemo} demo
 * @param {object} meta         upload metadata (filename, size, uploadedAt)
 * @param {(p: object) => void} [onProgress]
 */
export async function ingestDemo(user, demoId, demo, meta = {}, onProgress = () => {}) {
  // Team names, in the order their claims bind, and all of it BEFORE
  // materializeDemo builds the round ids from them:
  //   1. whatever named the demo already (a clan tag, or HLTV metadata);
  //   2. the Valve standings, for a side whose handles match a VRS roster;
  //   3. the library itself, for a side still carrying a parser-invented label.
  // Step 2 runs here rather than only inside materializeDemo so that step 3
  // sees its result: a VRS org keeps the VRS spelling of its name.
  applyStandingsToDemo(demo);
  const named = await applyLibraryTeamNames(user, demo, { demoId });
  for (const hit of named.applied) {
    console.log(
      `[teams] ${demoId} team${hit.side} named "${hit.name}" ` +
        `from the library (${hit.shared} shared players)`
    );
  }

  const { record, files } = materializeDemo(demo, demoId, meta, onProgress);

  // The materialized record REPLACES the placeholder written when the upload
  // was accepted, and the parser knows nothing about accounts — so ownership
  // has to be carried across the swap or every parsed demo falls back to the
  // legacy uploader and, worse, a private upload comes out public. `meta` wins
  // when a caller stamps it explicitly (imports do); the placeholder fills the
  // rest.
  let placeholder = null;
  try {
    placeholder = await readRecord(user, demoId);
  } catch {
    placeholder = null;
  }
  record.uploaderId = meta.uploaderId || placeholder?.uploaderId || '';
  record.uploaderName = meta.uploaderName || placeholder?.uploaderName || '';
  const visibility = meta.visibility || placeholder?.visibility || '';
  if (visibility) record.visibility = visibility;

  await writeMaterialized(user, record, files);
  return record;
}
