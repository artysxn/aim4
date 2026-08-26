// ---------------------------------------------------------------------------
// replays/statsHotService.js
// Owns the resident store: builds it, caches it, answers queries from it.
// ---------------------------------------------------------------------------

import { createPacker } from './statsHotStore.js';
import {
  aggregateHot,
  aggregateHotMatches,
  aggregateTeamsHot,
  attachRolesHot,
  filterRolesHot
} from './statsHotAggregate.js';
import { loadStoredEntry } from './statsIndex.js';
import { attachExpectedRatings } from '../../src/replays/shared/expectedRating.js';

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

/** Let other HTTP requests in between JSON.parse / packer.add bursts. */
function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
 * When a build FAILS, wait this long before anyone may start another.
 *
 * Without it a failing build is a death spiral: the rejected promise leaves
 * the cache empty, the next request starts the whole scan again, fails the
 * same way, and the process spends its life re-reading five thousand files —
 * which from outside looks like "the backend is up but nothing loads".
 */
const BUILD_RETRY_MS = 5 * 60 * 1000;
let lastBuildFailure = { at: 0, message: '' };

/**
 * One entry into the packer, contained.
 *
 * An index written by an older code path — or healed with inert defaults —
 * can carry a round shape the packer's rating context does not expect. That
 * must cost ONE demo its row, never the whole store: an exception here used
 * to reject the shared build promise, and with every /aggregate caller
 * parked on that promise, one poisoned file took the endpoint down.
 */
function addGuarded(packer, entry) {
  try {
    packer.add(entry);
    return true;
  } catch (err) {
    console.warn(`[stats] hot store skipped ${entry?.id || 'unknown'}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Build (or reuse) the store for one library.
 *
 * Concurrent callers share one build: at four thousand demos this reads every
 * index off disk, and letting two requests do that at once is how a server runs
 * out of memory.
 *
 * `opts.requireWarm`: never make an HTTP request wait for a cold build. A
 * resident or cheaply-appendable store is returned as usual; a cold one starts
 * building DETACHED and this resolves null so the route can answer "still
 * building" immediately. The request path sets this; boot code and tests,
 * which genuinely want to await the build, do not.
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
        let n = 0;
        for (const [k, record] of wanted) {
          if (hit.ids.has(k)) continue;
          const entry = await loadStoredEntry(io, user, record.id);
          if (entry?.rounds?.length) addGuarded(hit.packer, entry);
          hit.ids.add(k);
          n += 1;
          if (n % 8 === 0) await yieldEventLoop();
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
  if (inflight) {
    // A build is running. The request path never waits on it — that is how
    // one cold build made every /aggregate caller hang together.
    if (opts.requireWarm) return null;
    return inflight;
  }

  if (opts.requireWarm) {
    // Cold. Kick the build detached and answer null now; the route says
    // "still building" and the caller falls back to the paged path. Respect
    // the failure cooldown so a build that cannot succeed does not restart
    // per request forever.
    if (Date.now() - lastBuildFailure.at < BUILD_RETRY_MS) return null;
    startBuild(io, user, records).catch(() => {});
    return null;
  }

  return startBuild(io, user, records, opts);
}

function startBuild(io, user, records, opts = {}) {
  const key = LIB(user);
  const wanted = new Map(records.map((r) => [recordKey(r), r]));
  const startedAt = Date.now();

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
    let skipped = 0;
    for (const record of records) {
      const entry = await loadStoredEntry(io, user, record.id);
      done += 1;
      opts.onProgress?.({ done, total: records.length, phase: 'packing' });
      if (entry?.rounds?.length && !addGuarded(packer, entry)) skipped += 1;
      // JSON.parse + rating context for one demo is sync. Without this a cold
      // pack after deploy holds the only thread until every index is in, so
      // Database /status / everything else looks down until it finishes.
      if (done % 8 === 0) await yieldEventLoop();
    }
    if (skipped) console.warn(`[stats] hot store built with ${skipped} demos skipped`);
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
    console.log(
      `[stats] hot store built: ${records.length} demos in ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
    lastBuildFailure = { at: 0, message: '' };
    return store;
  })();

  const tracked = job
    .catch((err) => {
      // Record the failure BEFORE rethrowing, so the cooldown holds whether or
      // not anyone was awaiting this build. The message goes to the log in
      // full: this is the line that explains every "statistics never load".
      lastBuildFailure = { at: Date.now(), message: String(err?.message || err) };
      console.error('[stats] hot store build failed:', err);
      throw err;
    })
    .finally(() => {
      if (building.get(key) === tracked) building.delete(key);
    });

  building.set(key, tracked);
  return tracked;
}

/** Player table for a filter, computed against the resident store. */
export async function hotPlayers(io, user, records, filter = {}, opts = {}) {
  const store = await getHotStore(io, user, records, opts);
  if (!store) return null;
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
  // requireWarm and the store is cold: the route answers "still building".
  if (!store) return null;
  await yieldEventLoop();
  const allow = visibilityMask(store, opts.allowedIds || null);
  let players = aggregateHot(store, filter, allow);
  // Roles ride along whenever the caller asked for them or is filtering on
  // them. Teams are built from the UNFILTERED player rows on purpose: a team's
  // numbers are the whole side's, and narrowing to one role would quietly turn
  // the Teams tab into "these teams, counting only their AWPers".
  const teams =
    opts.teams === false ? null : aggregateTeamsHot(store, filter, players, allow);
  if (opts.roles || filter.role) {
    players = attachRolesHot(store, filter, allow, players);
    if (filter.role) players = filterRolesHot(players, filter.role);
  }
  if (teams) attachExpectedRatings(players, teams);
  else {
    for (const p of players) delete p.clubGames;
  }
  // The filter bar's map list comes from the library, not from the filtered
  // result — otherwise picking a map would leave you unable to pick another.
  const maps = [...store.maps.values].filter(Boolean).sort();
  return { players, teams, maps };
}

/**
 * Per-match rows for one player or team, computed against the resident store.
 *
 * `demoIds` bounds the work: the caller already knows which matches the entity
 * played from the roster catalogue, so this never walks the library looking.
 */
export async function hotMatches(io, user, records, demoIds, filter = {}, opts = {}) {
  const store = await getHotStore(io, user, records, opts);
  // requireWarm and the store is cold: the route answers "still building".
  if (!store) return null;
  const allow = visibilityMask(store, opts.allowedIds || null);
  const rows = aggregateHotMatches(store, demoIds, filter, allow, opts.want || {});
  const demoById = new Map(store.demos.map((d) => [d.id, d]));
  // Stamp each row with the match it describes. The client needs the same
  // identity columns the payload path gave it — map, score, result, opponent —
  // and only the store knows which side the entity was on.
  return rows.map((row) => {
    const demo = demoById.get(row.demoId) || {};
    return {
      ...row,
      clubGames: undefined,
      map: demo.map || '',
      name1: demo.name1 || '',
      name2: demo.name2 || '',
      t1: demo.t1 || '',
      t2: demo.t2 || '',
      winner: demo.winner || 0,
      uploadedAt: demo.uploadedAt || 0
    };
  });
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
  return {
    stores: out,
    building: building.size > 0,
    // Why statistics are not loading, when they are not. Empty means no
    // failed build on record.
    lastBuildFailure: lastBuildFailure.at
      ? { at: lastBuildFailure.at, message: lastBuildFailure.message }
      : null
  };
}

export function invalidateHotStore() {
  cache.clear();
}
