// ---------------------------------------------------------------------------
// replays/statsHotService.js
// Owns the resident store: builds it, caches it, answers queries from it.
// ---------------------------------------------------------------------------

import { createPacker } from './statsHotStore.js';
import { aggregateHot, aggregateTeamsHot } from './statsHotAggregate.js';
import { loadStoredEntry } from './statsIndex.js';

/**
 * @type {Map<string, {
 *   packer: object, store: object, ids: Set<string>, builtAt: number, appends: number
 * }>}
 */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const building = new Map();

/**
 * Above this many new demos at once, a full rebuild is the better deal: the
 * append path re-runs finish() per batch and grows the columns geometrically,
 * and a first-ever load looks like "everything is new".
 */
const APPEND_LIMIT = 250;

/**
 * Per-demo identity. A reparse or rename changes it, so a record whose key
 * moved is not the demo we packed even though the id matches.
 */
function recordKey(r) {
  return `${r.id}:${r.parsedAt || 0}:${r.roundCount || 0}`;
}

/** One library, one store. Keyed on the user, not on the record set. */
const LIB = (user) => `lib:${user}`;

/**
 * Build (or reuse) the store for one library.
 *
 * Concurrent callers share one build: at four thousand demos this reads every
 * index off disk, and letting two requests do that at once is how a server runs
 * out of memory.
 */
export async function getHotStore(io, user, records, opts = {}) {
  const key = LIB(user);
  const wanted = new Map(records.map((r) => [recordKey(r), r]));

  const hit = cache.get(key);
  if (hit) {
    // Nothing changed: serve what is resident.
    let missing = 0;
    for (const k of wanted.keys()) if (!hit.ids.has(k)) missing++;
    const removed = hit.ids.size - (wanted.size - missing);
    if (!missing && !removed) return hit.store;

    // Additions only — the common case, since uploads append. Pack just the new
    // demos onto the existing columns instead of re-reading four thousand
    // indexes to learn what we already knew.
    if (!removed && missing <= APPEND_LIMIT) {
      const pending = building.get(key);
      if (pending) return pending;
      const job = (async () => {
        for (const [k, record] of wanted) {
          if (hit.ids.has(k)) continue;
          const entry = await loadStoredEntry(io, user, record.id);
          if (entry?.rounds?.length) hit.packer.add(entry);
          hit.ids.add(k);
        }
        // finish() hands back views over the current buffers, so it must be
        // re-run after an append: growth reallocates, and the previous views
        // would still point at the old ones.
        hit.store = hit.packer.finish();
        hit.builtAt = Date.now();
        hit.appends += 1;
        return hit.store;
      })().finally(() => {
        if (building.get(key) === job) building.delete(key);
      });
      building.set(key, job);
      return job;
    }
    // A demo left the library, or too many arrived to be worth appending.
    // Holes would need tombstones and the columns are cheap to rebuild.
    cache.delete(key);
  }

  const inflight = building.get(key);
  if (inflight) return inflight;

  const job = (async () => {
    // Capacity from the manifests, which the caller already holds. A hint only
    // — the packer grows if a record's roundCount is short.
    let capacity = 0;
    for (const r of records) capacity += Number(r.roundCount) || 0;
    const packer = createPacker(capacity || 1024);

    // Streamed, one entry at a time. Collecting them first would put ~1.8 GB of
    // parsed indexes on the heap next to the store being built from them, which
    // is the allocation that blew the heap before paging was introduced.
    let done = 0;
    for (const record of records) {
      const entry = await loadStoredEntry(io, user, record.id);
      done += 1;
      opts.onProgress?.({ done, total: records.length, phase: 'packing' });
      if (entry?.rounds?.length) packer.add(entry);
    }
    const store = packer.finish();
    // Only one build is kept: each is hundreds of MB.
    cache.clear();
    cache.set(key, {
      packer,
      store,
      ids: new Set(wanted.keys()),
      builtAt: Date.now(),
      appends: 0
    });
    return store;
  })().finally(() => {
    if (building.get(key) === job) building.delete(key);
  });

  building.set(key, job);
  return job;
}

/** Player table for a filter, computed against the resident store. */
export async function hotPlayers(io, user, records, filter = {}, opts = {}) {
  const store = await getHotStore(io, user, records, opts);
  return aggregateHot(store, filter, visibilityMask(store, opts.allowedIds || null));
}

/**
 * Visibility as a mask over the resident store.
 *
 * The store is built from the whole library so there is exactly one copy of it
 * however many people are looking. Building it per access level instead would
 * both multiply the memory and thrash: an admin and a free account alternating
 * requests would each see the other's demos as added or removed and force a
 * full repack every time.
 *
 * @param {object} store
 * @param {Set<string>|null} allowedIds demo ids the caller may read
 * @returns {Uint8Array|null} null when the caller may read everything
 */
function visibilityMask(store, allowedIds) {
  if (!allowedIds) return null;
  if (allowedIds.size === store.demos.length) {
    // Everything is readable; skip the per-round check entirely.
    let all = true;
    for (const d of store.demos) {
      if (!allowedIds.has(d.id)) {
        all = false;
        break;
      }
    }
    if (all) return null;
  }
  const mask = new Uint8Array(store.demos.length);
  for (let i = 0; i < store.demos.length; i++) {
    if (allowedIds.has(store.demos[i].id)) mask[i] = 1;
  }
  return mask;
}

/**
 * Both tables under one filter.
 *
 * The team table needs the player table anyway (its average rating and hover
 * breakdown are built from it), so asking for both costs one pass, not two.
 *
 * @param {object[]} records   the whole library, so every caller shares a store
 * @param {{ allowedIds?: Set<string>, teams?: boolean }} [opts]
 */
export async function hotTables(io, user, records, filter = {}, opts = {}) {
  const store = await getHotStore(io, user, records, opts);
  const allow = visibilityMask(store, opts.allowedIds || null);
  const players = aggregateHot(store, filter, allow);
  const teams =
    opts.teams === false ? null : aggregateTeamsHot(store, filter, players, allow);
  // The filter bar's map list comes from the library, not from the filtered
  // result — otherwise picking a map would leave you unable to pick another.
  const maps = [...store.maps.values].filter(Boolean).sort();
  return { players, teams, maps };
}

/** What the store currently holds, for diagnostics. */
export function hotStoreStatus() {
  const out = [];
  for (const [key, v] of cache) {
    out.push({
      key,
      builtAt: v.builtAt,
      appends: v.appends,
      rounds: v.store.nRounds,
      players: v.store.players.size,
      demos: v.store.demos.length,
      bytes: v.store.bytes
    });
  }
  return out;
}

export function invalidateHotStore() {
  cache.clear();
}
