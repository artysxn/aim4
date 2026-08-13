// ---------------------------------------------------------------------------
// replays/statsCache.js
// One in-memory stats payload shared by Database, Charts, and Pattern Finder.
// ---------------------------------------------------------------------------

import { fetchStats as fetchStatsNetwork, STATS_LIBRARY_PAGE } from './api.js';

/** @type {{ key: string, payload: any, at: number, generation: number, complete: boolean }} */
let cache = { key: '', payload: null, at: 0, generation: 0, complete: false };

/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

/** @type {Map<string, Set<(info: object) => void>>} */
const batchListeners = new Map();

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
  if (cache.key === key && cache.payload && cache.complete) return cache.payload;
  return null;
}

export function invalidateStatsCache() {
  cache = {
    key: '',
    payload: null,
    at: 0,
    generation: (cache.generation || 0) + 1,
    complete: false
  };
  inflight.clear();
  batchListeners.clear();
}

function emitBatch(key, info) {
  for (const fn of batchListeners.get(key) || []) {
    try {
      fn(info);
    } catch {
      /* a panel's paint must not cancel the rest of the library */
    }
  }
}

function listenBatch(key, fn) {
  if (typeof fn !== 'function') return () => {};
  let set = batchListeners.get(key);
  if (!set) {
    set = new Set();
    batchListeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) batchListeners.delete(key);
  };
}

function mergeChunk(merged, chunk) {
  const incoming = Array.isArray(chunk?.demos) ? chunk.demos : [];
  if (!merged.demos) merged.demos = [];
  merged.demos.push(...incoming);
  if (chunk?.entitlements) merged.entitlements = chunk.entitlements;
  for (const [k, v] of Object.entries(chunk || {})) {
    if (k === 'demos' || k === 'offset' || k === 'count' || k === 'hasMore' || k === 'total') {
      continue;
    }
    if (merged[k] === undefined) merged[k] = v;
  }
  return incoming.length;
}

/**
 * Fetch (or reuse) the stats library. Concurrent callers with the same key
 * share one network request. The library is pulled 300 demos at a time so the
 * first page can paint before the rest arrives.
 *
 * @param {string[] | null} [demoIds]
 * @param {{
 *   onProgress?: (p: object) => void,
 *   onBatch?: (info: {
 *     payload: object,
 *     offset: number,
 *     loaded: number,
 *     total: number,
 *     hasMore: boolean,
 *     complete: boolean
 *   }) => void,
 *   force?: boolean
 * }} [opts]
 */
export async function getStatsPayload(demoIds = null, opts = {}) {
  const key = statsCacheKey(demoIds);
  const unlisten = listenBatch(key, opts.onBatch);
  if (!opts.force && cache.key === key && cache.payload && cache.complete) {
    opts.onProgress?.({
      type: 'progress',
      phase: 'cache',
      done: 1,
      total: 1
    });
    emitBatch(key, {
      payload: cache.payload,
      offset: 0,
      loaded: cache.payload.demos?.length || 0,
      total: cache.payload.demos?.length || 0,
      hasMore: false,
      complete: true
    });
    unlisten();
    return cache.payload;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const merged = { demos: [] };
      const scoped = demoIds?.length ? [...demoIds] : null;
      const page = STATS_LIBRARY_PAGE;
      let offset = 0;
      while (true) {
        const slice = scoped ? scoped.slice(offset, offset + page) : null;
        if (scoped && !slice.length) break;
        const chunk = await fetchStatsNetwork(slice, {
          onProgress: opts.onProgress,
          offset: scoped ? 0 : offset,
          limit: page
        });
        mergeChunk(merged, chunk);
        const loaded = merged.demos.length;
        const total = scoped
          ? scoped.length
          : Math.max(Number(chunk?.total) || 0, loaded);
        const hasMore = scoped ? offset + page < scoped.length : Boolean(chunk?.hasMore);
        cache = {
          key,
          payload: merged,
          at: Date.now(),
          generation: cache.generation || 0,
          complete: !hasMore
        };
        emitBatch(key, {
          payload: merged,
          offset,
          loaded,
          total,
          hasMore,
          complete: !hasMore
        });
        if (!hasMore) break;
        offset += scoped ? slice.length : page;
        if (offset >= total) break;
      }
      cache = {
        ...cache,
        key,
        payload: merged,
        at: Date.now(),
        complete: true
      };
      return merged;
    })().finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
  } else if (opts.onProgress) {
    // A second consumer still wants progress labels while the first fetch runs.
    opts.onProgress({ type: 'progress', phase: 'receiving', done: 0, total: 0 });
  }
  try {
    return await pending;
  } finally {
    unlisten();
  }
}
