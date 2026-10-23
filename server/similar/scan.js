// ---------------------------------------------------------------------------
// server/similar/scan.js
// Similar Rounds: scan every round on a map for the moment on screen.
//
// Runs in the desktop app's own server, on the PC's own cores, which is the
// reason it is a desktop feature: a map is thousands of rounds, and the
// browser has one thread to spare and six connections to fetch with.
//
//   1. the round on screen is fetched and indexed, and the question is read
//      off it (src/replays/similar/roundSimilarity.js)
//   2. the map's rounds in the same economy are listed by name; the round
//      names carry the buy of both teams, so nothing is opened to do this
//   3. rounds already indexed by an earlier scan are scored straight away;
//      the rest are fetched 150 at a time and indexed and scored on worker
//      threads while the next batches download
//   4. the closest rounds come back, best first
//
// The data is read through this server's own /api/replays routes, with the
// caller's sign-in, so a scan sees exactly the rounds the person can open:
// the online library when the app is online, this PC's demos when it is not.
//
// Indexes are kept between scans (AIM4_SIMILAR_CACHE_MB of memory, 512 by default),
// so asking again at another moment or for the other side costs CPU only.
// ---------------------------------------------------------------------------

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { decodeRoundPacks } from '../../src/replays/shared/roundPackWire.js';
import {
  SCAN_STRIDE,
  INDEX_VERSION,
  buildQuery,
  buildRoundIndex,
  econBucket,
  econLabel,
  indexBytes
} from '../../src/replays/similar/roundSimilarity.js';

/** Rounds per /rounds/packs request (the route allows 400). */
export const BATCH_FILES = 150;
/** Pack requests in flight at once. */
const FETCH_CONCURRENCY = 4;
/** Indexed rounds sent to a worker per score task. */
const SCORE_CHUNK = 400;
/** The closest rounds sent back. */
export const RESULT_LIMIT = 500;
/** Workers wind down after this long with nothing to do. */
const IDLE_MS = 2 * 60 * 1000;
const PROGRESS_MS = 200;

const CACHE_BYTES = Math.max(64, Number(process.env.AIM4_SIMILAR_CACHE_MB) || 512) * 1024 * 1024;
/** A kept index is refetched after this, in case its round was re-parsed. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// ---- worker pool ------------------------------------------------------------

export function threadCount() {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // One core stays with the server and the window.
  return Math.max(1, Math.min(16, cores - 1));
}

const WORKER_URL = new URL('./scanWorker.js', import.meta.url);

function createPool(size) {
  /** @type {Array<{ worker: Worker, busy: object|null }>} */
  const slots = [];
  const queue = [];
  let nextId = 1;
  let idleTimer = null;

  const spawn = () => {
    const slot = { worker: new Worker(WORKER_URL), busy: null };
    slot.worker.on('message', (msg) => {
      const job = slot.busy;
      slot.busy = null;
      if (job && msg?.id === job.id) {
        if (msg.ok) job.resolve(msg);
        else job.reject(new Error(msg.error || 'scan worker failed'));
      }
      pump();
    });
    const fail = (err) => {
      const job = slot.busy;
      slot.busy = null;
      const i = slots.indexOf(slot);
      if (i >= 0) slots.splice(i, 1);
      job?.reject(err instanceof Error ? err : new Error(`scan worker stopped (${err})`));
      pump();
    };
    slot.worker.on('error', fail);
    slot.worker.on('exit', (code) => {
      if (slots.includes(slot)) fail(code);
    });
    slots.push(slot);
    return slot;
  };

  const windDown = () => {
    if (queue.length || slots.some((s) => s.busy)) return;
    for (const s of slots.splice(0)) void s.worker.terminate();
  };

  function pump() {
    clearTimeout(idleTimer);
    while (queue.length) {
      let slot = slots.find((s) => !s.busy);
      if (!slot && slots.length < size) slot = spawn();
      if (!slot) break;
      const job = queue.shift();
      slot.busy = job;
      slot.worker.postMessage({ ...job.task, id: job.id }, job.transfer);
    }
    if (!queue.length && !slots.some((s) => s.busy)) {
      idleTimer = setTimeout(windDown, IDLE_MS);
      idleTimer.unref?.();
    }
  }

  return {
    size,
    run(task, transfer = []) {
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, task, transfer, resolve, reject });
        pump();
      });
    },
    async close() {
      clearTimeout(idleTimer);
      for (const job of queue.splice(0)) job.reject(new Error('scan pool closed'));
      await Promise.all(slots.splice(0).map((s) => s.worker.terminate()));
    }
  };
}

let pool = null;
function getPool() {
  pool ||= createPool(threadCount());
  return pool;
}

/** For tests: stop the threads so the process can exit. */
export async function closeScanPool() {
  const p = pool;
  pool = null;
  await p?.close();
}

// ---- index cache ------------------------------------------------------------

/** @type {Map<string, { index: object, bytes: number, at: number }>} */
const cache = new Map();
let cacheBytes = 0;

function cacheGet(file) {
  const e = cache.get(file);
  if (!e) return null;
  cache.delete(file);
  if (Date.now() - e.at > CACHE_TTL_MS || e.index.v !== INDEX_VERSION) {
    cacheBytes -= e.bytes;
    return null;
  }
  // Most recently used goes to the back; eviction takes from the front.
  cache.set(file, e);
  return e.index;
}

function cachePut(index) {
  if (!index?.file) return;
  const old = cache.get(index.file);
  if (old) {
    cache.delete(index.file);
    cacheBytes -= old.bytes;
  }
  const bytes = indexBytes(index);
  cache.set(index.file, { index, bytes, at: Date.now() });
  cacheBytes += bytes;
  for (const [file, e] of cache) {
    if (cacheBytes <= CACHE_BYTES) break;
    cache.delete(file);
    cacheBytes -= e.bytes;
  }
}

export function cacheStats() {
  return { rounds: cache.size, bytes: cacheBytes, budget: CACHE_BYTES };
}

/** For tests. */
export function clearScanCache() {
  cache.clear();
  cacheBytes = 0;
}

// ---- reading the library ----------------------------------------------------

async function fetchPacks(api, files, signal) {
  const res = await fetch(`${api.base}/api/replays/rounds/packs`, {
    method: 'POST',
    headers: { ...api.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, stride: SCAN_STRIDE, ticks: true, meta: 'similar' }),
    signal
  });
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'Sign in to scan rounds.' : `Could not load rounds (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res.arrayBuffer();
}

async function listRounds(api, query, signal) {
  const params = new URLSearchParams({ maps: query.map, limit: '1000000' });
  const [own, other] = query.sides;
  if (other) {
    // Both seats are fixed: one unordered pair of buys, checked per side once
    // each round's sides are known.
    params.set('econA', String(econBucket(query.econ[own])));
    params.set('econB', String(econBucket(query.econ[other])));
  } else {
    params.set('economies', String(econBucket(query.econ[own])));
  }
  if (query.team) params.set('teams', query.team);
  const res = await fetch(`${api.base}/api/replays/rounds?${params}`, { headers: api.headers, signal });
  if (!res.ok) {
    const err = new Error(
      res.status === 401 ? 'Sign in to scan rounds.' : `Could not list the rounds on this map (${res.status}).`
    );
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const files = [];
  const seen = new Set();
  for (const r of body?.rounds || []) {
    const f = String(r?.file || r?.name || r?.id || '');
    if (!f || seen.has(f) || !/^[A-Za-z0-9_~-]+$/.test(f)) continue;
    seen.add(f);
    files.push(f);
  }
  return files;
}

/** A tiny counting semaphore: decoded batches waiting for a thread are memory. */
function gate(limit) {
  let held = 0;
  const waiting = [];
  return {
    async take() {
      if (held < limit) {
        held += 1;
        return;
      }
      await new Promise((r) => waiting.push(r));
      held += 1;
    },
    give() {
      held -= 1;
      waiting.shift()?.();
    }
  };
}

// ---- the scan ---------------------------------------------------------------

/**
 * @param {object} args
 * @param {{ base: string, headers: Record<string, string> }} args.api
 *   where /api/replays is answered, and the caller's own headers for it
 * @param {object} args.ask   the request: file, tick, side, both, mode, strokes, team
 * @param {(event: object) => void} args.emit
 * @param {AbortSignal} [args.signal]
 */
export async function runScan({ api, ask, emit, signal }) {
  const started = Date.now();
  const aborted = () => signal?.aborted;

  // 1. The round on screen, and the question.
  emit({ type: 'phase', phase: 'source' });
  const sourcePacks = decodeRoundPacks(await fetchPacks(api, [ask.file], signal));
  const sp = sourcePacks?.[0];
  if (!sp?.meta || !sp?.ticks) throw Object.assign(new Error('Could not open this round.'), { status: 404 });
  const source = buildRoundIndex(sp.meta, sp.ticks, ask.file);
  cachePut(source);
  const query = buildQuery(source, ask);
  for (const s of query.sides) {
    if (!query.econ[s]) throw Object.assign(new Error('This round has no economy to match.'), { status: 422 });
  }

  // 2. Every round on the map in the same economy.
  emit({ type: 'phase', phase: 'list' });
  const listed = (await listRounds(api, query, signal)).filter((f) => f !== ask.file);
  if (aborted()) return null;
  const held = [];
  const missing = [];
  for (const f of listed) {
    const index = cacheGet(f);
    if (index) held.push(index);
    else missing.push(f);
  }
  const total = listed.length;
  emit({ type: 'start', total, cached: held.length, threads: getPool().size });

  let done = 0;
  let failed = 0;
  let lastProgress = 0;
  const results = [];
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_MS) return;
    lastProgress = now;
    emit({ type: 'progress', done, total });
  };
  const take = (out) => {
    for (const r of out.results || []) results.push(r);
  };

  const p = getPool();
  const work = [];

  // 3a. What an earlier scan already indexed: CPU only.
  for (let i = 0; i < held.length; i += SCORE_CHUNK) {
    const chunk = held.slice(i, i + SCORE_CHUNK);
    work.push(
      p.run({ kind: 'score', indexes: chunk, query }).then((out) => {
        take(out);
        done += chunk.length;
        progress();
      })
    );
  }

  // 3b. The rest, downloaded while the threads work. A fetch waits for a
  // free thread before it takes another batch off the wire, so a slow PC
  // never holds more than a few undecoded batches.
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH_FILES) batches.push(missing.slice(i, i + BATCH_FILES));
  let nextBatch = 0;
  const room = gate(p.size + 2);
  const fetcher = async () => {
    while (nextBatch < batches.length && !aborted()) {
      const files = batches[nextBatch++];
      let buffer = null;
      for (let attempt = 0; attempt < 2 && !buffer && !aborted(); attempt++) {
        try {
          buffer = await fetchPacks(api, files, signal);
        } catch (err) {
          if (err?.name === 'AbortError' || err?.status === 401) throw err;
        }
      }
      if (aborted()) return;
      if (!buffer) {
        failed += files.length;
        done += files.length;
        progress();
        continue;
      }
      await room.take();
      work.push(
        p
          .run({ kind: 'build', buffer, query }, [buffer])
          .then((out) => {
            for (const index of out.indexes || []) cachePut(index);
            take(out);
            failed += out.missing?.length || 0;
          })
          .catch(() => {
            failed += files.length;
          })
          .finally(() => {
            done += files.length;
            room.give();
            progress();
          })
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, batches.length) }, fetcher));
  await Promise.all(work);
  if (aborted()) return null;
  progress(true);

  // 4. Best first. Ties go to the more dominant round: it is the one worth
  // watching first.
  results.sort((a, b) => b.similarity - a.similarity || b.dominance - a.dominance);
  const out = {
    type: 'done',
    map: query.map,
    elapsed: query.elapsed,
    side: query.perspective,
    sides: query.sides,
    mode: query.mode,
    econ: Object.fromEntries(query.sides.map((s) => [s, econLabel(query.econ[s])])),
    scanned: total,
    matched: results.length,
    failed,
    ms: Date.now() - started,
    results: results.slice(0, RESULT_LIMIT)
  };
  emit(out);
  return out;
}
