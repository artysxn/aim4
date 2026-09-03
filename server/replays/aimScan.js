// ---------------------------------------------------------------------------
// replays/aimScan.js
// The aim rating rescan: a background walk that measures the motion half of
// every demo's Aim rating, without the site noticing.
//
// Two things make this different from the admin passes in statsIndex.js, and
// both of them are the point:
//
//   1. It is NOT a library job. The tools in statsIndex hold the thread for the
//      length of a library and are gated against each other by libraryJobBusy;
//      this one runs beside ordinary traffic for as long as it takes, one demo
//      at a time, releasing the loop after every round and pausing outright
//      while any of those tools is running.
//   2. Its queue is REORDERABLE, and a player visit does not start a library
//      job. Opening Performance for a player measures THAT player's pending
//      demos, even if no site-wide rescan is running, and then stops. The
//      remaining thousands wait for the admin "Rescan aim rating" pass, which
//      is the overnight job. If a library rescan IS already going, the same
//      visit only jumps the line; everything else keeps its place behind them.
//
// What "done" means lives in the stats index itself: `entry.a2v` is the version
// of the motion pass that wrote its rows. The ledger on disk beside it is a
// CACHE of that answer, so a cold process does not have to open four thousand
// JSON files to know what is left. A missing or stale ledger costs one JSON
// read per demo to rebuild and never costs a wrong answer, because the scanner
// re-checks `a2v` before it measures anything.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { AIM_MOTION_VERSION } from '../../src/replays/shared/aimMotion.js';
import { refreshAimMotion } from './statsIndex.js';
import { refreshHotStore } from './statsHotService.js';

/** Written next to the stats indexes it summarises. */
const LEDGER_NAME = 'aim-scan.json';

/**
 * Pause between demos, in ms.
 *
 * Not a throttle on the work so much as a promise to the event loop: the pass
 * is allowed to take all night, and the one thing it may never do is make a
 * page slower while it does.
 */
const BREATHE_MS = Number(process.env.AIM4_AIM_SCAN_BREATHE_MS || 120);
/** How long to wait before re-checking a pause condition. */
const PAUSE_POLL_MS = 2000;
/** Ledger writes are debounced this long so a fast run is not a write storm. */
const LEDGER_FLUSH_MS = 4000;

/** @type {{ userDir: Function, readRoundMeta: Function, readRoundTicks: Function, getZones?: Function }|null} */
let io = null;
/** @type {(() => Promise<object[]>)|null} */
let listRecords = null;
/** Set by the admin router so the scan stands aside for a library rebuild. */
let pauseWhen = () => false;

/** Demo ids known to be measured at AIM_MOTION_VERSION. */
let done = new Set();
/** Demos the scan has looked at and cannot measure (no index, unreadable). */
let unscannable = new Set();
let ledgerUser = '';
let ledgerLoaded = false;
let ledgerDirty = false;
let ledgerTimer = null;

/** Pending demo ids, front first. */
let queue = [];
/** Membership test for `queue`, kept in step with it. */
let queued = new Set();

let running = false;
let stopping = false;
let force = false;
/**
 * 'queued'  player visit: only ids already in `queue`.
 * 'library' admin rescan: every demo the ledger has not finished.
 */
let runScope = 'library';
/**
 * Admin asked for the overnight pass while a player-scoped run is still on
 * that player's demos. The loop rebuilds the full pending list at the next
 * breath instead of no-op'ing until they finish.
 */
let expandToLibrary = false;
/** Promotions that arrived before initAimScan wired storage. */
let deferredPromote = [];
let startedAt = 0;
let finishedAt = 0;
let startedBy = '';
let current = null;
let lastError = null;
const report = { measured: 0, current: 0, skipped: 0, failed: 0, rounds: 0 };

/**
 * Wire the scan to a library. Called once at boot.
 *
 * @param {object} opts
 * @param {object} opts.io           the same storage shim statsIndex takes
 * @param {string} opts.user         the library owner (the shared library)
 * @param {() => Promise<object[]>} opts.listRecords
 */
export async function initAimScan({ io: storage, user, listRecords: list }) {
  io = storage;
  ledgerUser = user;
  listRecords = list;
  if (deferredPromote.length) {
    const ids = deferredPromote;
    deferredPromote = [];
    await prioritizeAimScan(ids);
  }
}

/** The scan stands aside whenever `fn()` is true. */
export function setAimScanPauseWhen(fn) {
  pauseWhen = typeof fn === 'function' ? fn : () => false;
}

const ledgerPath = () => path.join(io.userDir(ledgerUser), 'stats', LEDGER_NAME);

async function loadLedger() {
  if (ledgerLoaded) return;
  ledgerLoaded = true;
  try {
    const raw = JSON.parse(await fsp.readFile(ledgerPath(), 'utf8'));
    // A ledger written by an older motion pass describes a statistic that no
    // longer exists. Dropping it is the whole mechanism by which bumping
    // AIM_MOTION_VERSION re-queues the library.
    if (raw?.v === AIM_MOTION_VERSION) {
      done = new Set(Array.isArray(raw.ids) ? raw.ids : []);
      unscannable = new Set(Array.isArray(raw.skipped) ? raw.skipped : []);
    }
  } catch {
    /* no ledger yet: every demo is pending until proven otherwise */
  }
}

function markLedgerDirty() {
  ledgerDirty = true;
  if (ledgerTimer) return;
  ledgerTimer = setTimeout(() => {
    ledgerTimer = null;
    void flushLedger();
  }, LEDGER_FLUSH_MS);
  // A debounced write must not be the reason a process cannot exit.
  ledgerTimer.unref?.();
}

async function flushLedger() {
  if (!ledgerDirty || !io) return;
  ledgerDirty = false;
  const body = JSON.stringify({
    v: AIM_MOTION_VERSION,
    ids: [...done],
    skipped: [...unscannable]
  });
  try {
    const file = ledgerPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
  } catch {
    // The ledger is a cache. Losing it costs the next run one JSON read per
    // demo, which is exactly what the run does when there has never been one.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rebuild the pending list from the current library.
 *
 * Order is newest demo first, which is both what a reader is most likely to
 * open and what makes the count fall against the part of the library anyone is
 * looking at.
 */
async function rebuildQueue(records) {
  await loadLedger();
  const ready = (records || []).filter((r) => (r.status || 'ready') === 'ready');
  ready.sort((a, b) => (b.uploadedAt || b.parsedAt || 0) - (a.uploadedAt || a.parsedAt || 0));
  queue = [];
  queued = new Set();
  for (const r of ready) {
    if (!force && (done.has(r.id) || unscannable.has(r.id))) continue;
    queue.push(r.id);
    queued.add(r.id);
  }
  return ready;
}

/**
 * How many of these demos are still waiting, without disturbing the queue.
 *
 * Answers off the ledger alone. A demo the ledger has never heard of counts as
 * pending, which is the safe direction: the reader is told there is work left
 * and the scanner discovers in one JSON read that there is not.
 */
export function aimScanPending(ids) {
  const list = Array.isArray(ids) ? ids : [];
  let pending = 0;
  for (const id of list) {
    if (!done.has(id) && !unscannable.has(id)) pending += 1;
  }
  return pending;
}

/** Has the ledger been read yet? Callers that need a true count await this. */
export async function ensureAimScanLedger() {
  if (!io) return;
  await loadLedger();
}

/**
 * Move these demos to the front of the queue and start a player-scoped scan
 * if nothing is running.
 *
 * A player visit measures only these ids, then stops. It does not enqueue the
 * rest of the library: that is the admin overnight rescan. If a library rescan
 * is already running, this only jumps the line.
 *
 * Ids already measured are ignored; ids the queue does not hold yet are
 * inserted, because a scan that finished before this player's demos were
 * uploaded has an empty queue and would otherwise answer "nothing pending"
 * forever.
 *
 * @returns {Promise<{ pending: number, running: boolean }>}
 */
export async function prioritizeAimScan(ids, { start = true } = {}) {
  const wantedRaw = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!io || !listRecords) {
    deferredPromote.push(...wantedRaw);
    return { pending: wantedRaw.length, running: false };
  }
  await loadLedger();
  const wanted = (Array.isArray(ids) ? ids : []).filter(
    (id) => id && !done.has(id) && !unscannable.has(id)
  );
  if (!wanted.length) return { pending: 0, running };

  const front = [];
  const seen = new Set();
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    front.push(id);
    queued.add(id);
  }
  // The rest of the queue, minus anything just promoted.
  queue = [...front, ...queue.filter((id) => !seen.has(id))];
  if (start && !running) void startAimScan({ reason: 'player' });
  return { pending: front.length, running: true };
}

/** One demo. Never throws: a demo that fails is counted and left behind. */
async function scanOne(id, recordsById) {
  const record = recordsById.get(id);
  if (!record) {
    // Deleted while queued. Nothing to measure and nothing to remember.
    return;
  }
  current = record.filename || record.id;
  try {
    const res = await refreshAimMotion(io, ledgerUser, record, { force });
    if (res.state === 'updated') {
      report.measured += 1;
      report.rounds += res.rounds;
      done.add(id);
    } else if (res.state === 'current') {
      report.current += 1;
      done.add(id);
    } else {
      report.skipped += 1;
      unscannable.add(id);
    }
  } catch (err) {
    report.failed += 1;
    lastError = err?.message || String(err);
    // Not added to either set: a failure is worth retrying on the next run,
    // and leaving it out of the ledger is how that happens.
  }
  markLedgerDirty();
}

async function runLoop() {
  let records = await listRecords();
  let recordsById = new Map(records.map((r) => [r.id, r]));
  if (runScope === 'queued') {
    // Player visit: do not pull in the rest of the library. Opening
    // Performance is how someone measures their own matches today without
    // starting the overnight job for everybody else.
    queue = queue.filter(
      (id) => recordsById.has(id) && (force || (!done.has(id) && !unscannable.has(id)))
    );
    queued = new Set(queue);
  } else {
    // A reader may have promoted their demos before this loop existed. The
    // rebuild below is library-wide and would drop that order, so it is taken
    // first and put back on the front afterwards.
    const promoted = queue.filter((id) => recordsById.has(id));
    const promotedSet = new Set(promoted);
    await rebuildQueue(records);
    if (promoted.length) {
      queue = [...promoted, ...queue.filter((id) => !promotedSet.has(id))];
      queued = new Set(queue);
    }
  }

  while (!stopping && (queue.length || expandToLibrary)) {
    if (expandToLibrary) {
      expandToLibrary = false;
      runScope = 'library';
      records = await listRecords();
      recordsById = new Map(records.map((r) => [r.id, r]));
      const promoted = queue.filter((id) => recordsById.has(id));
      const promotedSet = new Set(promoted);
      await rebuildQueue(records);
      if (promoted.length) {
        queue = [...promoted, ...queue.filter((id) => !promotedSet.has(id))];
        queued = new Set(queue);
      }
      continue;
    }
    if (pauseWhen()) {
      // A library rebuild is writing the same files. Wait it out rather than
      // racing it: both passes persist whole entries, and the loser's column
      // would be the one silently dropped.
      current = null;
      await sleep(PAUSE_POLL_MS);
      continue;
    }
    const id = queue.shift();
    queued.delete(id);
    await scanOne(id, recordsById);
    await sleep(BREATHE_MS);
  }

  current = null;
  await flushLedger();
  // The Database reads aim ratings off the hot store, which was packed before
  // any of this existed. Once, at the end, and as a REFRESH, not a drop: the
  // resident store keeps answering while a detached rebuild reads the indexes
  // this scan just rewrote. Dropping it here was the 503 that sent every open
  // client to page the raw library, on every Performance visit, all day.
  if (report.measured > 0) refreshHotStore();
}

/**
 * Start the scan if it is not already going.
 *
 * @param {{ force?: boolean, startedBy?: string, reason?: string }} [opts]
 *   force re-measures demos already at the current version.
 *   reason 'player' scans only the ids already queued (a Performance visit).
 *   Anything else rebuilds the library-wide pending list.
 */
export async function startAimScan(opts = {}) {
  if (!io || !listRecords) throw new Error('Aim scan is not wired to a library.');
  if (running) {
    // Overnight: Rescan arriving while a player-scoped run is still going
    // should pick up the rest of the library, not sit as a no-op until they
    // finish. Force still waits: wiping the ledger under a live pass is how
    // you measure the same demo twice in one run.
    if (opts.reason !== 'player' && runScope === 'queued' && !opts.force) {
      expandToLibrary = true;
      if (opts.startedBy) startedBy = opts.startedBy;
    }
    return aimScanStatus();
  }
  running = true;
  stopping = false;
  force = Boolean(opts.force);
  expandToLibrary = false;
  runScope = opts.reason === 'player' ? 'queued' : 'library';
  startedAt = Date.now();
  finishedAt = 0;
  startedBy = opts.startedBy || opts.reason || '';
  lastError = null;
  report.measured = 0;
  report.current = 0;
  report.skipped = 0;
  report.failed = 0;
  report.rounds = 0;
  if (force) {
    done = new Set();
    unscannable = new Set();
    markLedgerDirty();
  }

  // Detached: the caller gets a status, not a wait.
  void (async () => {
    try {
      await runLoop();
    } catch (err) {
      lastError = err?.message || String(err);
    } finally {
      await flushLedger();
      const chain = expandToLibrary && !stopping;
      expandToLibrary = false;
      running = false;
      stopping = false;
      force = false;
      current = null;
      if (chain) {
        void startAimScan({ startedBy, reason: 'library' });
        return;
      }
      finishedAt = Date.now();
    }
  })();

  return aimScanStatus();
}

/** Ask the loop to stop after the demo it is on. */
export function stopAimScan() {
  if (running) stopping = true;
  return aimScanStatus();
}

export function aimScanStatus() {
  const pending = queue.length;
  const finished = report.measured + report.current + report.skipped + report.failed;
  return {
    running,
    stopping,
    version: AIM_MOTION_VERSION,
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
    startedBy: startedBy || null,
    /** 'queued' is one player's demos; 'library' is the overnight pass. */
    scope: running ? runScope : null,
    /** Admin rescan was requested; the loop will pull in the rest next. */
    expanding: expandToLibrary,
    ms: startedAt ? (finishedAt || Date.now()) - startedAt : 0,
    /** Demos measured or confirmed current since this run began. */
    done: finished,
    /** Still queued. */
    pending,
    total: finished + pending,
    percent: finished + pending > 0 ? Math.round((finished / (finished + pending)) * 100) : 100,
    current,
    scanned: done.size,
    unscannable: unscannable.size,
    report: { ...report },
    error: lastError
  };
}

/** Tests and a fresh boot both want a clean slate. */
export function resetAimScanForTests() {
  io = null;
  listRecords = null;
  ledgerUser = '';
  done = new Set();
  unscannable = new Set();
  queue = [];
  queued = new Set();
  ledgerLoaded = false;
  ledgerDirty = false;
  running = false;
  stopping = false;
  force = false;
  runScope = 'library';
  expandToLibrary = false;
  deferredPromote = [];
  startedAt = 0;
  finishedAt = 0;
  current = null;
  lastError = null;
  report.measured = 0;
  report.current = 0;
  report.skipped = 0;
  report.failed = 0;
  report.rounds = 0;
  if (ledgerTimer) {
    clearTimeout(ledgerTimer);
    ledgerTimer = null;
  }
}
