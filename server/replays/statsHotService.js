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
const appendLimit = () => Number(process.env.AIM4_HOT_APPEND_LIMIT ?? 250);

/**
 * Dead demos tolerated in the columns before a rebuild compacts them away.
 *
 * A reparse or a deletion cannot pull rounds back out of packed columns, so a
 * demo that changed is DEAD-MARKED — its rounds stay in the buffers and the
 * visibility mask stops counting them — and the new version is appended. Each
 * dead demo costs its rounds' bytes until the next full rebuild, so past this
 * many the columns are rebuilt (detached, while the old store keeps serving).
 *
 * Why this exists at all: the ingest pipeline re-materializes existing demos
 * a few at a time, and every one of those used to be `removed > 0` →
 * cache.delete → a full 4,900-demo rebuild → a cold Database for everyone.
 * On 2026-08-27 that drip was measured evicting the store every couple of
 * minutes, which meant the store was cold at almost every moment anyone
 * actually looked at it.
 */
const removeLimit = () => Number(process.env.AIM4_HOT_REMOVE_LIMIT ?? 250);

/** Let other HTTP requests in between JSON.parse / packer.add bursts. */
function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Per-demo identity. A reparse that changed anything, a rename, or a round
 * renumbering changes it, so a record whose key moved is not the demo we
 * packed even though the id matches.
 *
 * Deliberately CONTENT identity, not `parsedAt`: the ingest pipeline
 * re-materializes existing demos in bulk (parser upgrades, re-imports), and
 * every one of those stamps a fresh `parsedAt` even when the parse output is
 * identical. Keying on the timestamp made each of those look like a changed
 * demo — measured on 2026-08-28 as ~300 spurious "changes" a night, which is
 * past the heal limits and forced a full rebuild on every deploy. The round-id
 * list is deterministic content (teams, players, winner, economy, round
 * numbers are hashed into each id), and the parser revision covers a reparse
 * that changed HOW those rounds were measured without changing the list.
 *
 * Team names are part of the key because the packed columns CARRY them: the
 * Teams table groups by the names baked in at pack time. Without the name
 * hash, renaming a team (one demo by hand, or the whole library through the
 * identity rescan) left the resident store — and the snapshot on disk —
 * serving the old names until the process died. With it, a renamed demo reads
 * as removed-plus-added, which is exactly the signal that forces the heal.
 */
const recordKeyCache = new WeakMap();
function recordKey(r) {
  const cached = recordKeyCache.get(r);
  if (cached) return cached;
  let h = 0x811c9dc5;
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(`${r.team1?.name || ''}|${r.team2?.name || ''}`);
  feed(`|${r.parser?.revision ?? ''}:${r.parser?.version || ''}`);
  if (Array.isArray(r.rounds) && r.rounds.length) {
    for (const round of r.rounds) feed(`|${round?.id || ''}`);
  } else {
    // A manifest without its round list cannot prove its content; fall back
    // to the timestamp identity rather than treating every parse as equal.
    feed(`|${r.parsedAt || 0}`);
  }
  const key = `${r.id}:${r.roundCount || 0}:${h.toString(36)}`;
  recordKeyCache.set(r, key);
  return key;
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

/**
 * Where a running HEAL is: the handful of new or reparsed demos being folded
 * into a store that is still serving. Separate from buildProgress because the
 * two mean opposite things to a client — a build says "you got a 503, here is
 * why", a heal says "you got an answer, and it is this many demos behind".
 *
 * @type {Map<string, { done: number, total: number, startedAt: number }>}
 */
const healProgress = new Map();

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

/**
 * What a SERVED answer is currently behind on, or null when it is current.
 *
 * `append`: a heal is folding this many new/reparsed demos into the resident
 * store. `rebuild`: the store was too far behind to heal and a full rebuild is
 * running detached while the old store keeps answering. Either way the caller
 * just got real rows — this is the footnote, not the error. The aggregate
 * route stamps it on 200 responses so the Database can say "1 new demo is
 * being processed" instead of silently serving numbers that are about to move.
 *
 * A rebuild with NO resident store is not "refreshing" — that caller got a
 * 503 with hotBuildProgress, which is the other half of this story.
 */
export function hotRefreshing(user) {
  const key = LIB(user);
  const h = healProgress.get(key);
  if (h && h.total > 0) return { mode: 'append', done: h.done, total: h.total };
  const p = buildProgress.get(key);
  if (p && cache.has(key)) return { mode: 'rebuild', done: p.done, total: p.total };
  return null;
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
    // Drift the heal path can absorb — a few new demos, a few reparsed or
    // deleted ones — does NOT void the file: the store is installed as-is and
    // the first getHotStore call afterwards dead-marks and appends the
    // difference. Discarding on any removal is what kept every deploy cold
    // while the ingest pipeline re-materialized demos in the background.
    if (removed > removeLimit() || missing > appendLimit()) {
      // Past the heal limits, but still a picture of most of the library:
      // install it anyway and let getHotStore serve it STALE while the full
      // rebuild runs detached. Rejecting it here is what made every deploy
      // after a busy ingest night start cold — 503s on /aggregate, and every
      // open Database falling back to downloading the raw library while the
      // rebuild fought those downloads for the same disk and thread. Only a
      // snapshot that no longer covers even half the records is a different
      // library and not worth hydrating.
      const overlap = wanted.size - missing;
      if (overlap * 2 < wanted.size) {
        console.log(
          `[stats] hot snapshot discarded (covers ${overlap}/${wanted.size} demos)`
        );
        return;
      }
      console.log(
        `[stats] hot snapshot stale (${missing} new, ${removed} removed), serving it while rebuilding`
      );
    }
    // Hydrate through the packer so appends work; the store served is the
    // packer's own finish(), and the file's buffers are garbage after this.
    const packer = createPacker(snap.store.nRounds, snap.store);
    const store = packer.finish();
    // Dead-marks ride the demos JSON in the header, so a snapshot written
    // mid-drip reloads with the same rounds masked out it had when saved.
    let dead = 0;
    for (const d of store.demos) if (d.dead) dead++;
    cache.clear();
    cache.set(key, {
      packer,
      store,
      ids: have,
      builtAt: snap.savedAt || Date.now(),
      appends: 0,
      dead
    });
    console.log(
      `[stats] hot store loaded from snapshot: ${store.demos.length} demos, ` +
        `${Math.round(store.bytes / 1048576)} MB, ${missing} new / ${removed} removed to heal`
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

/**
 * Boot-time snapshot LOAD — never a build.
 *
 * The boot-warm essay in server/index.js still holds: starting a BUILD at boot
 * is how the two-hour outage began, and nothing here revives that. Loading a
 * snapshot is a different animal — one bounded file read that either installs
 * a finished store or does nothing — and doing it at boot instead of on the
 * first /aggregate call erases the one remaining 503 window on a deploy that
 * has a snapshot: the first visitor is warm instead of the second.
 *
 * @returns {Promise<boolean>} true when a store is resident afterwards
 */
export async function warmHotStoreFromSnapshot(io, user, records) {
  if (!snapshotEnabled()) return false;
  const key = LIB(user);
  if (cache.has(key)) return true;
  const wanted = new Map(records.map((r) => [recordKey(r), r]));
  const loading = ensureSnapshotLoaded(io, user, wanted);
  if (loading) await loading;
  return cache.has(key);
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
 * `opts.requireWarm`: never make an HTTP request wait for ANY of the work
 * here. A current store is returned as usual; a resident store that is behind
 * the record set is returned AS IS while the heal or rebuild runs detached
 * (hotRefreshing says by how much); only a truly cold store — nothing
 * resident at all — resolves null so the route can answer "still building".
 * The request path sets this; boot code and tests, which genuinely want to
 * await the work, do not.
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

    // A heal or rebuild is already running. The resident store keeps
    // answering — stale by the demos in flight, which hotRefreshing reports —
    // rather than anyone waiting on the job or eating a 503.
    const pending = building.get(key);
    if (pending) {
      if (opts.requireWarm) return hit.store;
      return pending;
    }

    // A bounded change set is HEALED in place: demos whose key left the
    // record set (reparsed, renamed, deleted) are dead-marked — their rounds
    // stay in the columns and visibilityMask stops counting them — and the
    // new versions are appended, exactly like an upload. This is the whole
    // answer to the ingest drip: re-materializing one demo used to be
    // `removed > 0` → cache.delete → a full library rebuild, every few
    // minutes, forever. Dead demos cost their bytes until a rebuild compacts
    // them, which is what removeLimit bounds.
    if (missing <= appendLimit() && removed + hit.dead <= removeLimit()) {
      const job = healStore(io, user, key, hit, wanted);
      building.set(key, job);
      if (opts.requireWarm) {
        // The request path serves the stale store NOW; the heal lands
        // detached. Its failure is the next request's retry, not a crash.
        job.catch((err) =>
          console.warn('[stats] hot store heal failed:', err?.message || err)
        );
        return hit.store;
      }
      return job;
    }

    // Too much changed to heal. The old move was cache.delete — a cold
    // Database for everyone while the rebuild ran. Keep serving the resident
    // store and rebuild DETACHED; startBuild swaps the finished store in
    // whole, and until then every answer is honest-but-stale.
    if (opts.requireWarm) {
      if (Date.now() - lastBuildFailure.at >= BUILD_RETRY_MS) {
        startBuild(io, user, records).catch(() => {});
      }
      return hit.store;
    }
    return startBuild(io, user, records, opts);
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

/**
 * Fold a bounded change set into a store that keeps serving throughout.
 *
 * Dead-marking first, then appends: a reparsed demo is its old copy going
 * dead plus its new copy arriving, and doing the marking up front means even
 * the stale answers served mid-heal have stopped counting rounds that are
 * known to be superseded. The demo id is recovered from the vanished key
 * itself — recordKey starts `${id}:` precisely so a key whose record is gone
 * still says which demo it was.
 *
 * The caller owns putting the job into `building` (and, on the request path,
 * attaching the catch); this just does the work.
 */
function healStore(io, user, key, hit, wanted) {
  const gone = [];
  for (const k of hit.ids) if (!wanted.has(k)) gone.push(k);
  let adding = 0;
  for (const k of wanted.keys()) if (!hit.ids.has(k)) adding++;
  if (adding) healProgress.set(key, { done: 0, total: adding, startedAt: Date.now() });

  const job = (async () => {
    if (gone.length) {
      const liveAt = new Map();
      for (let i = 0; i < hit.store.demos.length; i++) {
        if (!hit.store.demos[i].dead) liveAt.set(hit.store.demos[i].id, i);
      }
      for (const k of gone) {
        const at = liveAt.get(k.slice(0, k.indexOf(':')));
        if (at !== undefined && !hit.store.demos[at].dead) {
          hit.store.demos[at].dead = true;
          hit.dead += 1;
        }
        hit.ids.delete(k);
      }
    }
    let n = 0;
    const hp = healProgress.get(key);
    for (const [k, record] of wanted) {
      if (hit.ids.has(k)) continue;
      const entry = await loadStoredEntry(io, user, record.id);
      if (entry?.rounds?.length) addGuarded(hit.packer, entry);
      hit.ids.add(k);
      n += 1;
      if (hp) hp.done = n;
      // Every demo, not every 8th: one stored index is a sync JSON.parse of
      // up to several MB, and eight back-to-back was a measured ~100 ms hole
      // in the loop while a heal ran. A setImmediate per demo costs microseconds.
      await yieldEventLoop();
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
    healProgress.delete(key);
  });
  return job;
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

    // Streamed with a short read-ahead. One entry at a time keeps the heap
    // bounded (collecting them first was ~1.8 GB and blew it), but strictly
    // sequential read-then-pack leaves the disk idle while the CPU packs and
    // the CPU idle while the disk seeks — measured at 3:1 read-to-pack, which
    // on a cold prod volume is most of the build spent waiting. A lookahead of
    // four keeps the disk queue full while costing four parsed entries of
    // heap, and entries are still packed strictly in order.
    const AHEAD = 4;
    /** @type {Promise<object|null>[]} */
    const ahead = [];
    let queued = 0;
    const pump = () => {
      while (ahead.length < AHEAD && queued < records.length) {
        ahead.push(loadStoredEntry(io, user, records[queued].id));
        queued += 1;
      }
    };
    pump();
    let done = 0;
    let skipped = 0;
    for (let i = 0; i < records.length; i++) {
      const entry = await ahead.shift();
      pump();
      done += 1;
      const bp = buildProgress.get(key);
      if (bp) bp.done = done;
      opts.onProgress?.({ done, total: records.length, phase: 'packing' });
      if (entry?.rounds?.length && !addGuarded(packer, entry)) skipped += 1;
      // JSON.parse + rating context for one demo is sync. Without this a cold
      // pack after deploy holds the only thread until every index is in, so
      // Database /status / everything else looks down until it finishes.
      // Per demo, not per 8: eight parses between yields still held the loop
      // ~100 ms at a stretch, which is a visible hiccup on every live request.
      await yieldEventLoop();
    }
    if (skipped) console.warn(`[stats] hot store built with ${skipped} demos skipped`);
    const store = packer.finish();
    // Only one build is kept: each is hundreds of MB. Until this line the
    // previous store (if any) kept serving; the swap is the first moment a
    // caller can see the rebuilt columns — and the last it can see stale ones.
    cache.clear();
    cache.set(key, {
      packer,
      store,
      ids: new Set(wanted.keys()),
      builtAt: Date.now(),
      appends: 0,
      dead: 0
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
 * Dead demos are cut here too, for every caller: their rounds are still in
 * the packed columns (a heal cannot pull bytes back out of them), and this
 * mask is the single place they stop counting. That makes deadness impossible
 * to forget in a new aggregate — anything that honours visibility honours it.
 *
 * @param {object} store
 * @param {Set<string>|null} allowedIds demo ids the caller may read
 * @returns {Uint8Array|null} null when everything is readable and live
 */
export function visibilityMask(store, allowedIds) {
  const demos = store.demos;
  let mask = null;
  const cut = (i) => {
    if (!mask) {
      mask = new Uint8Array(demos.length);
      mask.fill(1);
    }
    mask[i] = 0;
  };
  for (let i = 0; i < demos.length; i++) {
    if (demos[i].dead) cut(i);
    else if (allowedIds && !allowedIds.has(demos[i].id)) cut(i);
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
  // Skip dead copies: after a heal the same id can appear twice, and the
  // identity stamped on a row must come from the version whose rounds counted.
  const demoById = new Map();
  for (const d of store.demos) if (!d.dead) demoById.set(d.id, d);
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
  // Only live copies may take the rename: a dead copy's key already left
  // hit.ids, and re-keying it would resurrect a demo a heal retired.
  const at = new Map();
  hit.store.demos.forEach((d, i) => {
    if (!d.dead) at.set(d.id, i);
  });
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
      dead: v.dead,
      bytes: v.store.bytes
    });
  }
  const progress = [...buildProgress.entries()].map(([key, p]) => ({
    key,
    done: p.done,
    total: p.total,
    startedAt: p.startedAt
  }));
  const healing = [...healProgress.entries()].map(([key, p]) => ({
    key,
    done: p.done,
    total: p.total,
    startedAt: p.startedAt
  }));
  return {
    stores: out,
    building: building.size > 0,
    progress,
    healing,
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
