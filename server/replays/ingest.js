// ---------------------------------------------------------------------------
// replays/ingest.js
// Bridges a parsed demo into the library: assigns every round its name and
// writes the round files. The parser stays unaware of the naming scheme, and
// the store stays unaware of parsing; this is the seam between them.
// ---------------------------------------------------------------------------

import { materializeDemo } from './materialize.js';
import { readRecord, writeMaterialized } from './demoStore.js';

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
