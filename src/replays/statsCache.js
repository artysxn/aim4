// ---------------------------------------------------------------------------
// replays/statsCache.js
// One in-memory stats payload shared by Database, Charts, and Pattern Finder.
// ---------------------------------------------------------------------------

import { fetchStats as fetchStatsNetwork } from './api.js';

/** @type {{ key: string, payload: any, at: number, generation: number }} */
let cache = { key: '', payload: null, at: 0, generation: 0 };

/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

/**
 * @param {string[] | null | undefined} demoIds
 */
export function statsCacheKey(demoIds = null) {
  if (!demoIds?.length) return 'library';
  return `demos:${[...demoIds].map(String).sort().join(',')}`;
}

/** Bumps whenever the shared payload is cleared so panels drop stale local copies. */
export function statsCacheGeneration() {
  return cache.generation;
}

export function peekStatsCache(demoIds = null) {
  const key = statsCacheKey(demoIds);
  if (cache.key === key && cache.payload) return cache.payload;
  return null;
}

export function invalidateStatsCache() {
  cache = {
    key: '',
    payload: null,
    at: 0,
    generation: (cache.generation || 0) + 1
  };
  inflight.clear();
}

/**
 * Fetch (or reuse) the stats library. Concurrent callers with the same key
 * share one network request.
 *
 * @param {string[] | null} [demoIds]
 * @param {{ onProgress?: (p: object) => void, force?: boolean }} [opts]
 */
export async function getStatsPayload(demoIds = null, opts = {}) {
  const key = statsCacheKey(demoIds);
  if (!opts.force && cache.key === key && cache.payload) {
    opts.onProgress?.({
      type: 'progress',
      phase: 'cache',
      done: 1,
      total: 1
    });
    return cache.payload;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchStatsNetwork(demoIds, { onProgress: opts.onProgress })
      .then((payload) => {
        cache = {
          key,
          payload,
          at: Date.now(),
          generation: cache.generation || 0
        };
        return payload;
      })
      .finally(() => {
        if (inflight.get(key) === pending) inflight.delete(key);
      });
    inflight.set(key, pending);
  } else if (opts.onProgress) {
    // A second consumer still wants progress labels while the first fetch runs.
    opts.onProgress({ type: 'progress', phase: 'receiving', done: 0, total: 0 });
  }
  return pending;
}
