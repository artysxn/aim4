// ---------------------------------------------------------------------------
// replays/autoIndex.js
// Stats indexing as part of arriving, not part of being looked at.
//
// Manual uploads already schedule their index after the parse (routes.js,
// jobs.js). Imports did not: ingest could land two hundred demos overnight
// and the database would not count one of them until a visitor's first
// request paid for all two hundred index builds at once. Every import path —
// HLTV ingest, the probe, the Drive queue, .aim4replay uploads — now calls
// scheduleImportIndex, so a demo starts counting the moment it lands.
//
// Kept apart from routes.js because importPackage.js must be able to call it
// without pulling the whole route surface (and its sample-demo read wrappers,
// which imports never need) into every ingest worker.
// ---------------------------------------------------------------------------

import { readRoundMeta, readRoundTicks, userDir } from './demoStore.js';
import { scheduleStatsIndex } from './statsIndex.js';
import { getZones } from '../zonesStore.js';
import { getCoachSmokes } from '../coachSmokesStore.js';

export const libraryStatsIo = {
  userDir,
  readRoundMeta,
  readRoundTicks,
  getZones,
  getCoachUtilities: getCoachSmokes
};

/**
 * Build the demo's stats index in the background. Fire-and-forget by design:
 * an import must never fail, or wait, because analytics were slow.
 */
export function scheduleImportIndex(user, record, done) {
  if (!record?.id || record.status !== 'ready') return;
  try {
    scheduleStatsIndex(libraryStatsIo, user, record, done);
  } catch (err) {
    console.warn(`[replays] could not schedule stats index for ${record.id}:`, err?.message || err);
  }
}
