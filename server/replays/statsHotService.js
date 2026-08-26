// ---------------------------------------------------------------------------
// replays/statsHotService.js
// Owns the resident store: builds it, caches it, answers queries from it.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { createPacker } from './statsHotStore.js';
import { loadSnapshot, saveSnapshot } from './statsHotSnapshot.js';
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
 *
 * Team names are part of the key because the packed columns CARRY them: the
 * Teams table groups by the names baked in at pack time. Without the name
 * hash, renaming a team (one demo by hand, or the whole library through the
 * identity rescan) left the resident store — and the snapshot on disk —
 * serving the old names until the process died. With it, a renamed demo reads
 * as removed-plus-added, which is exactly the signal that forces the rebuild.
 */
function recordKey(r) {
  let h = 0x811c9dc5;
  const names = `${r.team1?.name || ''}|${r.team2?.name || ''}`;
  for (let i = 0; i < names.length; i++) {
    h ^= names.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${r.id}:${r.parsedAt || 0}:${r.roundCount || 0}:${h.toString(36)}`;
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
 * Where the running build is, for anyone who asks.
 *
 * The build is detached — no request waits on it — which means no request can
 * see it either, and "still loading" with no number is indistinguishable from
 * "stuck". The loop below updates this as it goes; the 503 responses and the
 * admin status endpoint both read it, so a client can say "1,234 of 4,900,
 * about 90s left" instead of asking the user to take it on faith.
 *
 * @type {Map<string, { done: number, total: number, startedAt: number }>}
 */
const buildProgress = new Map();

/** Progress plus a rate-based ETA, or null when nothing is building. */
export function hotBuildProgress(user) {
  const p = buildProgress.get(LIB(user));
  if (!p) return null;
  const elapsed = (Date.now() - p.startedAt) / 1000;
  const eta =
    p.done > 0 && p.total > p.done
      ? Math.max(1, Math.round((elapsed / p.done) * (p.total - p.done)))
      : null;
  return { done: p.done, total: p.total, elapsedSeconds: Math.round(elapsed), etaSeconds: eta };
}

// ---------------------------------------------------------------------------
// Snapshot: the packed store on disk, so a deploy does not cold-build it.
//
// Written (debounced) after every successful build or append; tried once per
// process before the first build. The load path installs a cache entry through
// the same packer the live build uses, so appends afterwards behave as if the
// process had built the store itself. Everything about a snapshot is
// best-effort: a missing, torn or stale file falls through to exactly the
// behavior this file already has — background build, 503 until warm.
// ---------------------------------------------------------------------------

const SNAPSHOT_FILE = '_hotstore.a4s';
/** Trailing debounce, so a burst of uploads writes the file once, not per demo. */
const snapshotWriteDelayMs = () => Number(process.env.AIM4_HOT_SNAPSHOT_DELAY_MS ?? 10_000);
const snapshotEnabled = () =>
  String(process.env.AIM4_HOT_SNAPSHOT || '').toLowerCase() !== 'off';
/** @type {Map<string, { done?: boolean, promise?: Promise<void> }>} */
const snapshotState = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const snapshotTimers = new Map();
/** @type {Map<string, Promise<void>>} */
const snapshotWrites = new Map();

const snapshotPath = (io, user) => path.join(io.userDir(user), 'stats', SNAPSHOT_FILE);

/**
 * Try the snapshot exactly once per process (per library). Resolves when the
 * attempt is over, having installed a cache entry on success. `wanted` is the
 * live record set: a snapshot the append path could not carry to current —
 * demos removed, or more new ones than APPEND_LIMIT — is not worth the
 * hydration copy and is skipped before it costs anything.
 */
function ensureSnapshotLoaded(io, user, wanted) {
  const key = LIB(user);
  const st = snapshotState.get(key);
  if (st?.done) return null;
  if (st?.promise) return st.promise;
  const promise = (async () => {
    const snap = await loadSnapshot(snapshotPath(io, user));
    if (!snap) return;
    const have = new Set(snap.ids);
    let missing = 0;
    for (const k of wanted.keys()) if (!have.has(k)) missing++;
    const removed = have.size - (wanted.size - missing);
    if (removed > 0 || missing > APPEND_LIMIT) {
      console.log(
        `[stats] hot snapshot stale (${missing} new, ${removed} removed), rebuilding instead`
      );
      return;
    }
    // Hydrate through the packer so appends work; the store served is the
    // packer's own finish(), and the file's buffers are garbage after this.
    const packer = createPacker(snap.store.nRounds, snap.store);
    const store = packer.finish();
    cache.clear();
    cache.set(key, {
      packer,
      store,
      ids: have,
      builtAt: snap.savedAt || Date.now(),
      appends: 0
    });
    console.log(
      `[stats] hot store loaded from snapshot: ${store.demos.length} demos, ` +
        `${Math.round(store.bytes / 1048576)} MB, ${missing} to append`
    );
  })()
    .catch((err) => {
      console.warn('[stats] hot snapshot ignored:', err?.message || err);
    })
    .finally(() => {
      snapshotState.set(key, { done: true });
    });
  snapshotState.set(key, { promise });
  return promise;
}

/** Debounced, deduped write of the current cache entry for this library. */
function scheduleSnapshotWrite(io, user) {
  if (!snapshotEnabled()) return;
  const key = LIB(user);
  clearTimeout(snapshotTimers.get(key));
  const timer = setTimeout(() => {
    snapshotTimers.delete(key);
    if (snapshotWrites.has(key)) {
      // A write is running with older columns; go again after it.
      snapshotWrites.get(key).finally(() => scheduleSnapshotWrite(io, user));
      return;
    }
    const hit = cache.get(key);
    if (!hit) return;
    const startedAt = Date.now();
    const job = saveSnapshot(snapshotPath(io, user), hit.store, hit.ids)
      .then((bytes) => {
        // The file now reflects a store this process trusts; a later load may
        // try it again (invalidation clears the once-per-process latch).
        snapshotState.set(key, { done: true });
        console.log(
          `[stats] hot snapshot written: ${Math.round(bytes / 1048576)} MB in ` +
            `${Date.now() - startedAt} ms`
        );
      })
      .catch((err) => {
        console.warn('[stats] hot snapshot write failed:', err?.message || err);
      })
      .finally(() => {
        if (snapshotWrites.get(key) === job) snapshotWrites.delete(key);
      });
    snapshotWrites.set(key, job);
  }, snapshotWriteDelayMs());
  // Never the reason the process stays alive.
  timer.unref?.();
  snapshotTimers.set(key, timer);
}

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

  // Cold process, snapshot on disk: try that before any thought of building.
  // The request path (requireWarm) answers "still building" while the file
  // loads rather than waiting on it; the load is seconds, not minutes, so the
  // next poll is warm. The awaited path (tests, boot code) waits.
  if (!cache.has(key) && !building.has(key) && snapshotEnabled()) {
    const loading = ensureSnapshotLoaded(io, user, wanted);
    if (loading) {
      if (opts.requireWarm) return null;
      await loading;
    }
  }

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
        scheduleSnapshotWrite(io, user);
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
  buildProgress.set(key, { done: 0, total: records.length, startedAt });

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
      const bp = buildProgress.get(key);
      if (bp) bp.done = done;
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
    scheduleSnapshotWrite(io, user);
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
      buildProgress.delete(key);
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
export function visibilityMask(store, allowedIds) {
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

/**
 * Rewrite team names on demos the resident store already holds.
 *
 * A rename changes recordKey (the names are hashed into it), and the normal
 * consequence of a changed key is a FULL rebuild: minutes of CPU and a cold
 * Database, for what is a two-string edit. It does not have to be, because the
 * names are the one thing the packed columns do not hold — `store.demos[i]` is
 * a plain object, and `finish()` hands back that same array, so patching it
 * updates the packer, the resident store and any later append at once.
 *
 * The ids set is re-stamped to match, otherwise the very next request compares
 * keys, sees the demo as removed-and-added, and rebuilds anyway.
 *
 * @param {string} user
 * @param {object[]} records  renamed records (id + team1/team2 + fingerprint)
 * @returns {number} demos patched
 */
export function patchHotStoreTeamNames(io, user, records) {
  const hit = cache.get(LIB(user));
  if (!hit || !records?.length) return 0;
  const at = new Map(hit.store.demos.map((d, i) => [d.id, i]));
  let n = 0;
  for (const r of records) {
    const i = at.get(r.id);
    if (i === undefined) continue;
    hit.store.demos[i].name1 = r.team1?.name || '';
    hit.store.demos[i].name2 = r.team2?.name || '';
    // The old key carried the old name hash; drop it whatever it was.
    for (const k of hit.ids) {
      if (k.startsWith(`${r.id}:`)) hit.ids.delete(k);
    }
    hit.ids.add(recordKey(r));
    n += 1;
  }
  if (n) {
    hit.builtAt = Date.now();
    scheduleSnapshotWrite(io, user);
  }
  return n;
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
  const progress = [...buildProgress.entries()].map(([key, p]) => ({
    key,
    done: p.done,
    total: p.total,
    startedAt: p.startedAt
  }));
  return {
    stores: out,
    building: building.size > 0,
    progress,
    snapshot: {
      enabled: snapshotEnabled(),
      writing: snapshotWrites.size > 0,
      pendingWrite: snapshotTimers.size > 0
    },
    // Why statistics are not loading, when they are not. Empty means no
    // failed build on record.
    lastBuildFailure: lastBuildFailure.at
      ? { at: lastBuildFailure.at, message: lastBuildFailure.message }
      : null
  };
}

export function invalidateHotStore() {
  cache.clear();
  // The cooldown is a brake on retrying a build that just failed. Dropping the
  // store is a deliberate "build it again", so it must not be held behind a
  // failure the caller has, by definition, already responded to.
  lastBuildFailure = { at: 0, message: '' };
  // The once-per-process snapshot latch opens again: after an invalidate the
  // next cold call may load whatever the last WRITE left on disk (writes only
  // happen after a build this process trusted), and the staleness check
  // against the live records still guards the file on every load.
  snapshotState.clear();
  for (const t of snapshotTimers.values()) clearTimeout(t);
  snapshotTimers.clear();
}
