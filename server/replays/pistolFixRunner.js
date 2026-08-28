// ---------------------------------------------------------------------------
// replays/pistolFixRunner.js
// Runs the pistol-round repairs over the whole shared library, once, from a
// button in Admin → Tools. New parses fix themselves in materialize; this is
// for every demo that was already on disk when the fix shipped.
//
// In-process background job, one at a time (the probe's pattern): each demo
// costs one round-1 meta and one tick read to check, so a big library is a
// few minutes, not worth a detached process. Demos that were changed get
// their stats index rebuilt immediately, so the database corrects itself
// without waiting for a visitor.
// ---------------------------------------------------------------------------

import { SHARED_LIBRARY } from './auth.js';
import {
  listDemos,
  readRoundMeta,
  readRoundTicks,
  writeMaterialized,
  writeRecord,
  writeRoundMeta
} from './demoStore.js';
import { forgetDemoIndex } from './statsIndex.js';
import { fixStoredDemo } from './pistolFix.js';
import { libraryStatsIo, scheduleImportIndex } from './autoIndex.js';

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  progress: { done: 0, total: 0 },
  result: null,
  error: null
};

export function pistolFixStatus() {
  return { ...state, progress: { ...state.progress } };
}

const io = { readRoundMeta, readRoundTicks, writeRoundMeta, writeMaterialized, writeRecord };

/**
 * Start a sweep. Returns { started } or { busy }. `force` re-examines demos
 * already checked in an earlier run.
 */
export function startPistolFixRun({ force = false } = {}) {
  if (state.running) return { busy: true };
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.progress = { done: 0, total: 0 };
  state.result = null;
  state.error = null;

  void (async () => {
    const result = { scanned: 0, knifeTrimmed: 0, missingPistol: 0, reindexed: 0, failed: 0 };
    try {
      const records = (await listDemos(SHARED_LIBRARY)).filter((r) => r.status === 'ready');
      state.progress.total = records.length;
      for (const record of records) {
        try {
          const outcome = await fixStoredDemo(io, SHARED_LIBRARY, record, { force });
          result.scanned++;
          if (outcome.knifeTrimmed) result.knifeTrimmed++;
          if (outcome.missingPistol) result.missingPistol++;
          if (outcome.changed) {
            // The old index rows carry the pre-fix kills and round numbers.
            await forgetDemoIndex(libraryStatsIo, SHARED_LIBRARY, record.id).catch(() => {});
            scheduleImportIndex(SHARED_LIBRARY, { ...record, status: 'ready' });
            result.reindexed++;
          }
        } catch (err) {
          result.failed++;
          console.warn(`[pistolFix] ${record.id}: ${err?.message || err}`);
        }
        state.progress.done++;
      }
      state.result = result;
    } catch (err) {
      state.error = String(err?.message || err);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}
