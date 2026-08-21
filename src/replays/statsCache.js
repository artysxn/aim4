// ---------------------------------------------------------------------------
// replays/statsCache.js
// One in-memory stats payload shared by Database, Charts, and Pattern Finder.
// ---------------------------------------------------------------------------

import { fetchStats as fetchStatsNetwork, STATS_LIBRARY_PAGE } from './api.js';
import { payloadCovers, resolveColumns } from './shared/statsColumns.js';

/**
 * @type {{
 *   key: string, scope: string, columns: string[]|null, payload: any,
 *   at: number, generation: number, complete: boolean, nextOffset: number
 * }}
 */
let cache = {
  key: '',
  scope: '',
  columns: null,
  payload: null,
  at: 0,
  generation: 0,
  complete: false,
  nextOffset: 0
};

/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

/** @type {Map<string, Set<(info: object) => void>>} */
const batchListeners = new Map();

/**
 * @param {string[] | null | undefined} demoIds
 */
export function statsCacheKey(demoIds = null, columns = null) {
  const scope = !demoIds?.length
    ? 'library'
    : `demos:${[...demoIds].map(String).sort().join(',')}`;
  // The contract is part of the identity: a "shapes" pull and a "rating" pull
  // over the same demos are different payloads, and serving one for the other
  // is how a page ends up rendering a rating built from league averages.
  const groups = resolveColumns(columns ?? null).groups;
  return `${scope}|${groups.join('+') || 'baseline'}`;
}

/** Bumps whenever the shared payload is cleared so panels drop stale local copies. */
export function statsCacheGeneration() {
  return cache.generation;
}

/**
 * A cached payload usable for this request: same scope, and holding at least
 * the columns asked for. A wider pull satisfies a narrower one, so navigating
 * Database → Performance reuses what is already in memory instead of refetching.
 */
export function peekStatsCache(demoIds = null, columns = null) {
  if (!cache.payload || !cache.complete) return null;
  const scope = !demoIds?.length
    ? 'library'
    : `demos:${[...demoIds].map(String).sort().join(',')}`;
  if (cache.scope !== scope) return null;
  const needed = resolveColumns(columns ?? null).groups;
  if (!payloadCovers(cache.payload, cache.columns, needed)) return null;
  return cache.payload;
}

export function invalidateStatsCache() {
  // Drop the stored payload so the next idle fetch is fresh. Leave an in-flight
  // pull and its batch listeners alone so later pages still paint.
  cache = {
    key: '',
    scope: '',
    columns: null,
    payload: null,
    at: 0,
    generation: (cache.generation || 0) + 1,
    complete: false,
    nextOffset: 0
  };
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
  const seen = new Set(merged.demos.map((d) => d?.id).filter(Boolean));
  for (const demo of incoming) {
    const id = demo?.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.demos.push(demo);
  }
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
 * Whether another GET /stats page is still owed.
 *
 * A missing `hasMore` must not mean "done": that is how a full first page
 * (300 demos) was treated as the whole library. A full page means keep going
 * until the server says otherwise or a short page arrives.
 *
 * @param {{
 *   scoped: boolean,
 *   scopedLen: number,
 *   offset: number,
 *   pageSize: number,
 *   chunk: object | null | undefined,
 *   incomingLen: number
 * }} args
 */
export function statsPageHasMore(args) {
  const pageSize = Math.max(1, Number(args.pageSize) || STATS_LIBRARY_PAGE);
  const offset = Math.max(0, Number(args.offset) || 0);
  if (args.scoped) return offset + pageSize < (Number(args.scopedLen) || 0);
  const chunk = args.chunk;
  if (chunk && Object.prototype.hasOwnProperty.call(chunk, 'hasMore')) {
    return Boolean(chunk.hasMore);
  }
  const total = Math.max(Number(chunk?.total) || 0, Number(chunk?.libraryTotal) || 0);
  if (total > 0) return offset + pageSize < total;
  return (Number(args.incomingLen) || 0) >= pageSize;
}

/**
 * Progress phases whose `done` counts demos inside the page being fetched.
 * `packing`, `receiving` and `building-table` describe the transfer of a page
 * that has already been counted, and carry a page-sized `total` with no
 * `libraryTotal` — treating their numbers as library progress is a bug.
 */
const DEMO_PHASES = new Set([
  'start',
  'loading',
  'building',
  'rebuilding',
  'enriching',
  'ready'
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStatsPage(slice, opts) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchStatsNetwork(slice, opts);
    } catch (err) {
      lastErr = err;
      if (attempt === 2) break;
      await delay(400 * (attempt + 1));
    }
  }
  throw lastErr;
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
  const columns = opts.columns ?? null;
  const key = statsCacheKey(demoIds, columns);
  const scope = !demoIds?.length
    ? 'library'
    : `demos:${[...demoIds].map(String).sort().join(',')}`;
  const wantGroups = resolveColumns(columns).groups;
  const unlisten = listenBatch(key, opts.onBatch);
  const reusable =
    !opts.force &&
    cache.payload &&
    cache.complete &&
    cache.scope === scope &&
    payloadCovers(cache.payload, cache.columns, wantGroups);
  if (reusable) {
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
      const resume =
        !opts.force && cache.key === key && cache.payload && !cache.complete;
      const heldColumns = resume ? cache.columns : wantGroups;
      const merged = resume && cache.payload ? cache.payload : { demos: [] };
      if (!merged.demos) merged.demos = [];
      const scoped = demoIds?.length ? [...demoIds] : null;
      const page = STATS_LIBRARY_PAGE;
      let offset = resume ? Math.max(0, Number(cache.nextOffset) || 0) : 0;
      let hasMore = true;
      /**
       * Library-wide progress, tracked across every page of this request.
       *
       * Kept here rather than derived per event because most progress lines
       * cannot answer "of how many": `total` on a progress event is the size of
       * the page in flight (300), and the `packing` / `receiving` lines that end
       * each page carry no `libraryTotal` at all. Reading `total` as a library
       * count is what made a 4100-demo library report "300 of 300".
       */
      let libraryTotalSeen = 0;
      let libraryLoadedSeen = 0;
      while (true) {
        const slice = scoped ? scoped.slice(offset, offset + page) : null;
        if (scoped && !slice.length) {
          hasMore = false;
          break;
        }
        // Progress events describe the page in flight: `done` counts within it,
        // and a scoped request is sent with offset 0 because the slicing happens
        // here. Neither is what a caller wants to show a user, so the two
        // library-wide numbers are stamped on here, where the scope is known.
        const pageStart = offset;
        const pageCount = scoped ? slice.length : page;
        const relayProgress = opts.onProgress
          ? (p) => {
              const phase = String(p?.phase || '');
              // Only two sources may set the library size: our own scope, and
              // the server's explicit `libraryTotal`. Never `total`.
              if (scoped) {
                libraryTotalSeen = scoped.length;
              } else {
                const stated = Number(p?.libraryTotal) || 0;
                if (stated > 0) libraryTotalSeen = Math.max(libraryTotalSeen, stated);
              }
              // Demo-counting phases advance within the page. The rest
              // (packing / receiving / building-table) describe shipping a page
              // whose demos are already accounted for, so they land on its end.
              const done = Math.max(0, Number(p?.done) || 0);
              const within = DEMO_PHASES.has(phase) ? Math.min(done, pageCount) : pageCount;
              const next = pageStart + within;
              libraryLoadedSeen = Math.max(
                libraryLoadedSeen,
                libraryTotalSeen ? Math.min(next, libraryTotalSeen) : next
              );
              opts.onProgress({
                ...p,
                libraryLoaded: libraryLoadedSeen,
                libraryTotal: libraryTotalSeen
              });
            }
          : undefined;
        const chunk = await fetchStatsPage(slice, {
          onProgress: relayProgress,
          offset: scoped ? 0 : offset,
          limit: page,
          columns
        });
        const incomingLen = mergeChunk(merged, chunk);
        const loaded = merged.demos.length;
        const total = scoped
          ? scoped.length
          : Math.max(Number(chunk?.total) || 0, Number(chunk?.libraryTotal) || 0, loaded);
        hasMore = statsPageHasMore({
          scoped: Boolean(scoped),
          scopedLen: scoped ? scoped.length : 0,
          offset,
          pageSize: page,
          chunk,
          incomingLen
        });
        const nextOffset = offset + (scoped ? slice.length : page);
        cache = {
          key,
          scope,
          columns: Array.isArray(chunk?.columns) ? chunk.columns : heldColumns,
          payload: merged,
          at: Date.now(),
          generation: cache.generation || 0,
          complete: !hasMore,
          nextOffset
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
        offset = nextOffset;
      }
      cache = {
        ...cache,
        key,
        scope,
        payload: merged,
        at: Date.now(),
        complete: !hasMore,
        nextOffset: hasMore ? offset : merged.demos.length
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
