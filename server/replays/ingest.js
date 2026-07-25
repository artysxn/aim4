// ---------------------------------------------------------------------------
// replays/ingest.js
// Bridges a parsed demo into the library: assigns every round its name and
// writes the round files. The parser stays unaware of the naming scheme, and
// the store stays unaware of parsing; this is the seam between them.
// ---------------------------------------------------------------------------

import { materializeDemo } from './materialize.js';
import { writeMaterialized } from './demoStore.js';

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
  await writeMaterialized(user, record, files);
  return record;
}
