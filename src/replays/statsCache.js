// ---------------------------------------------------------------------------
// replays/statsCache.js
// One in-memory stats payload shared by Database, Charts, and Pattern Finder.
// ---------------------------------------------------------------------------

import { fetchStats as fetchStatsNetwork, STATS_LIBRARY_PAGE } from './api.js';

/**
 * Stats pages in flight at once.
 *
 * A page costs server time to pack, network time to ship, and worker time to
 * parse — three different resources, and running them one page at a time idles
 * two of them at every moment. Three is enough to keep all three busy without
 * asking one browser tab to hold four pages of a library in memory at once.
 */
export const PAGE_PIPELINE = 3;
import { payloadCovers, resolveColumns } from './shared/statsColumns.js';

/**
 * @typedef {{
 *   key: string, scope: string, columns: string[]|null, payload: any,
 *   at: number, complete: boolean, nextOffset: number
 * }} CacheSlot
 */
const emptySlot = () => ({
  key: '',
  scope: '',
  columns: null,
  payload: null,
  at: 0,
  complete: false,
  nextOffset: 0
});

/**
 * TWO slots, not one: the full-library payload (the Database's ~GB download)
 * and the latest scoped pull. With a single slot, any scoped fetch anywhere —
 * the Demo Manager's round-tag lookup on every filter change, a team page
 * warming its rounds — overwrote the slot and threw the entire library away,
 * so Charts or Pattern Finder opened next had to download it all again.
 * @type {CacheSlot}
 */
let librarySlot = emptySlot();
/** @type {CacheSlot} */
let scopedSlot = emptySlot();
/** Bumped whenever the payloads are cleared so panels drop stale local copies. */
let cacheGeneration = 0;

const getSlot = (scope) => (scope === 'library' ? librarySlot : scopedSlot);
const setSlot = (scope, slot) => {
  if (scope === 'library') librarySlot = slot;
  else scopedSlot = slot;
  return slot;
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
  return cacheGeneration;
}

/**
 * A cached payload usable for this request: same scope, and holding at least
 * the columns asked for. A wider pull satisfies a narrower one, so navigating
 * Database → Performance reuses what is already in memory instead of refetching.
 */
export function peekStatsCache(demoIds = null, columns = null) {
  const scope = !demoIds?.length
    ? 'library'
    : `demos:${[...demoIds].map(String).sort().join(',')}`;
  const slot = getSlot(scope);
  if (!slot.payload || !slot.complete) return null;
  if (slot.scope !== scope) return null;
  const needed = resolveColumns(columns ?? null).groups;
  if (!payloadCovers(slot.payload, slot.columns, needed)) return null;
  return slot.payload;
}

export function invalidateStatsCache() {
  // Drop the stored payloads so the next idle fetch is fresh. Leave an
  // in-flight pull and its batch listeners alone so later pages still paint.
  librarySlot = emptySlot();
  scopedSlot = emptySlot();
  cacheGeneration += 1;
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

/**
 * The network call one page makes. Swappable so the paging pipeline — which
 * decides ordering, overlap and when to stop — can be tested without a server.
 */
let statsFetcher = fetchStatsNetwork;

/** Test seam: install a stand-in fetcher, or restore the real one with no argument. */
export function setStatsFetcher(fn) {
  statsFetcher = fn || fetchStatsNetwork;
}

async function fetchStatsPage(slice, opts) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await statsFetcher(slice, opts);
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
  const held = getSlot(scope);
  const reusable =
    !opts.force &&
    held.payload &&
    held.complete &&
    held.scope === scope &&
    payloadCovers(held.payload, held.columns, wantGroups);
  if (reusable) {
    opts.onProgress?.({
      type: 'progress',
      phase: 'cache',
      done: 1,
      total: 1
    });
    emitBatch(key, {
      payload: held.payload,
      offset: 0,
      loaded: held.payload.demos?.length || 0,
      total: held.payload.demos?.length || 0,
      hasMore: false,
      complete: true
    });
    unlisten();
    return held.payload;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const slot = getSlot(scope);
      const resume =
        !opts.force && slot.key === key && slot.payload && !slot.complete;
      const heldColumns = resume ? slot.columns : wantGroups;
      const merged = resume && slot.payload ? slot.payload : { demos: [] };
      if (!merged.demos) merged.demos = [];
      const scoped = demoIds?.length ? [...demoIds] : null;
      // A SCOPED request — the Pattern Finder handing us one map's demos —
      // goes in ONE request. The server cuts the page by weight
      // (statsIndex.js STATS_PAGE_BYTES), so asking for the whole list is safe:
      // if it really is too big to ship at once, the reply is short and the
      // loop below picks up the rest. On the narrow contract that page is a
      // fifth the size it used to be, so a map fits.
      //
      // A library-wide pull keeps paging: it has no scope to bound it, and the
      // Database's table paints from the first page while the rest arrives.
      const page = scoped ? Math.max(1, scoped.length) : STATS_LIBRARY_PAGE;
      let offset = resume ? Math.max(0, Number(slot.nextOffset) || 0) : 0;
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
      /**
       * Demos actually merged. The only number a reader can act on: pages are
       * fetched PAGE_PIPELINE at a time, so at any moment several are in flight
       * and none of their demos are in the payload yet.
       */
      let mergedLoaded = 0;

      /**
       * Fetch ONE page. Everything page-specific — the slice, the progress
       * relay's page window — is closed over here so the pipeline below only
       * has to decide when to start it.
       */
      const fetchPage = (pageStart) => {
        const slice = scoped ? scoped.slice(pageStart, pageStart + page) : null;
        const pageCount = scoped ? slice.length : page;
        // Progress events describe the page in flight: `done` counts within it,
        // and a scoped request is sent with offset 0 because the slicing happens
        // here. Neither is what a caller wants to show a user, so the two
        // library-wide numbers are stamped on here, where the scope is known.
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
              // What has merged, plus how far into the page that merges NEXT.
              // Counting every page in flight is what pinned a 4 889-demo
              // library at "1 200 loaded": page 0 lands, three more launch, the
              // furthest reports 900 + its own 300, and the display jumps
              // straight to a number nothing had reached — then sits there,
              // because the pages behind it can only ever confirm what it had
              // already claimed. Pages ahead of the merge point are in flight,
              // not loaded, and are worth nothing to whoever is waiting.
              const next =
                pageStart <= mergedLoaded ? Math.max(mergedLoaded, pageStart + within) : mergedLoaded;
              // Monotonic: with pages in flight together these arrive
              // interleaved, and a counter that goes backwards is worse than
              // one that stalls.
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
        return fetchStatsPage(slice, {
          onProgress: relayProgress,
          offset: scoped ? 0 : pageStart,
          limit: page,
          columns
        });
      };

      /** Take one finished page: merge it, remember it, tell the subscribers. */
      const absorb = (pageStart, chunk) => {
        const incomingLen = mergeChunk(merged, chunk);
        const loaded = merged.demos.length;
        mergedLoaded = Math.max(mergedLoaded, loaded);
        const total = scoped
          ? scoped.length
          : Math.max(Number(chunk?.total) || 0, Number(chunk?.libraryTotal) || 0, loaded);
        const more = statsPageHasMore({
          scoped: Boolean(scoped),
          scopedLen: scoped ? scoped.length : 0,
          offset: pageStart,
          pageSize: page,
          chunk,
          incomingLen
        });
        setSlot(scope, {
          key,
          scope,
          columns: Array.isArray(chunk?.columns) ? chunk.columns : heldColumns,
          payload: merged,
          at: Date.now(),
          complete: false,
          nextOffset: pageStart + (scoped ? incomingLen || page : page)
        });
        emitBatch(key, {
          payload: merged,
          offset: pageStart,
          loaded,
          total,
          hasMore: more,
          complete: false
        });
        return { more, chunk };
      };

      // ---- the pipeline ----------------------------------------------------
      //
      // Pages used to run strictly one at a time: fetch, wait for the server to
      // pack it, wait for the bytes, wait for the worker to parse them, merge,
      // and only then ask for the next one. Every one of those waits is on a
      // different resource, so the whole chain idles three of them at any
      // moment — which is what the pause between each 300 looked like.
      //
      // Now up to PAGE_PIPELINE are in flight while their predecessors are
      // still being parsed and merged. Pages are still MERGED in order, so the
      // payload is byte-identical to what the serial loop produced; only the
      // waiting overlaps.
      // A SCOPED request already knows its own size — the caller handed us the
      // demo list — so every page can start at once. Only a library-wide pull
      // has to fetch page 0 first and read the total off it; guessing there
      // would mean speculative requests past the end.
      let totalDemos;
      const offsets = [];
      if (scoped) {
        // One request for the whole scope. The server may still answer short —
        // it cuts a page by weight — so follow up from wherever it stopped
        // until the scope is covered. Normally that is a single pass.
        totalDemos = scoped.length;
        while (offset < totalDemos) {
          const chunk = await fetchPage(offset);
          const before = merged.demos.length;
          const { more } = absorb(offset, chunk);
          const served = merged.demos.length - before;
          hasMore = more;
          // No progress means the server cannot serve this demo at all; step
          // over it rather than asking for it forever.
          offset += served > 0 ? served : 1;
          if (!more && offset >= totalDemos) break;
          if (!more && served === 0) break;
        }
        totalDemos = merged.demos.length;
      } else {
        const first = await fetchPage(offset);
        const { more } = absorb(offset, first);
        hasMore = more;
        totalDemos = Math.max(
          Number(first?.total) || 0,
          Number(first?.libraryTotal) || 0,
          merged.demos.length
        );
        if (hasMore) {
          for (let o = offset + page; o < totalDemos; o += page) offsets.push(o);
        }
      }
      if (offsets.length) {
        /** offset → in-flight page. Never more than PAGE_PIPELINE of them. */
        const flight = new Map();
        let launched = 0;
        const launch = () => {
          while (flight.size < PAGE_PIPELINE && launched < offsets.length) {
            const o = offsets[launched++];
            flight.set(o, fetchPage(o));
          }
        };
        launch();
        for (const o of offsets) {
          const chunk = await flight.get(o);
          flight.delete(o);
          launch();
          const res = absorb(o, chunk);
          hasMore = res.more;
          // A short page means the library ended earlier than its own count
          // said. Stop merging, and let the ones already in flight fall away.
          if (!hasMore) break;
        }
      }
      offset = Number(getSlot(scope).nextOffset) || merged.demos.length;
      hasMore = false;
      emitBatch(key, {
        payload: merged,
        offset,
        loaded: merged.demos.length,
        total: scoped ? scoped.length : Math.max(totalDemos, merged.demos.length),
        hasMore: false,
        complete: true
      });
      setSlot(scope, {
        ...getSlot(scope),
        key,
        scope,
        payload: merged,
        at: Date.now(),
        complete: !hasMore,
        nextOffset: hasMore ? offset : merged.demos.length
      });
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
