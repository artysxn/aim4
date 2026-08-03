// ---------------------------------------------------------------------------
// server/ingest/hltv/service.js
// The switch behind the admin page. Flip it on, walk away, it keeps running.
//
// "Keeps running" has to survive three separate things, and each needs its own
// mechanism:
//
//   1. The admin closing the tab.       The work is a server process, so this
//                                       is free. Only the UI poll stops.
//   2. The API server restarting.       A deploy or a crash of the website must
//                                       not take the backfill with it. The
//                                       ingester is spawned DETACHED with its
//                                       own log file descriptors, so it has no
//                                       remaining tie to the parent.
//   3. The whole box rebooting, or the  Intent is persisted to desired.json,
//      ingester itself dying.           and a supervisor re-spawns whenever the
//                                       switch says "on" but nothing is alive.
//
// Point 2 is the subtle one. Piping a detached child's stdout back to the
// parent keeps a handle open between them: when the parent dies the pipe breaks
// and the child takes an EPIPE on its next log line. A backgrounded process
// therefore has to own its own output fds, which is why the log file is opened
// here and handed over as raw descriptors rather than piped.
//
// Communication stays one-way and file-based, because either side can restart
// independently:
//
//   parent -> child   spawn arguments, then SIGTERM to stop
//   child  -> parent  status.json, rewritten on every pipeline event
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openLedger } from './ledger.js';
import { emptyStatus, readStatus, writeStatus } from './status.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.js');

/** In-process bookkeeping. None of it is authoritative; the files are. */
const state = {
  /** Consecutive short-lived exits, for restart backoff. */
  failures: 0,
  nextSpawnAllowedAt: 0,
  lastSpawnAt: 0,
  supervisor: null
};

const cfg = () => loadConfig({});

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file) {
  try {
    return Number(await fsp.readFile(file, 'utf8')) || null;
  } catch {
    return null;
  }
}

const desiredPath = (c) => path.join(c.stateDir, 'desired.json');

/**
 * The switch position, persisted.
 *
 * This is what makes the admin page a control panel rather than a launch
 * button: the answer to "should this be running" outlives every process
 * involved, so a reboot resumes instead of quietly staying off.
 */
async function readDesired(c) {
  try {
    const raw = JSON.parse(await fsp.readFile(desiredPath(c), 'utf8'));
    return { enabled: Boolean(raw.enabled), ...raw };
  } catch {
    return { enabled: false };
  }
}

async function writeDesired(c, patch) {
  const current = await readDesired(c);
  const next = { ...current, ...patch, changedAt: new Date().toISOString() };
  await fsp.mkdir(c.stateDir, { recursive: true });
  const tmp = `${desiredPath(c)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, desiredPath(c));
  return next;
}

export async function isRunning() {
  return alive(await readPid(cfg().lockPath));
}

/**
 * Launch the child. Internal: callers go through start() or the supervisor, so
 * the desired-state flag and the spawn cannot drift apart.
 */
async function spawnIngester(c, options = {}) {
  await fsp.mkdir(c.stateDir, { recursive: true });
  await fsp.mkdir(c.workDir, { recursive: true });

  const args = [CLI, 'run', '--continuous'];
  if (options.source || c.source) args.push('--source', options.source || c.source);
  if (options.inbox || c.inbox) args.push('--inbox', options.inbox || c.inbox);
  if (options.since || c.since) args.push('--since', options.since || c.since);

  // Raw descriptors, not pipes. A detached child that logs through a pipe to
  // its parent dies with the parent; one holding its own fd does not.
  const logPath = path.join(c.stateDir, 'ingest.log');
  const logFd = fs.openSync(logPath, 'a');

  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env
    });
  } finally {
    // The child has inherited the descriptor; this process does not need it.
    fs.closeSync(logFd);
  }

  child.on('exit', (code, signal) => {
    const shortLived = Date.now() - state.lastSpawnAt < 30_000;
    // A child that dies almost immediately is failing, not finishing. Back off
    // so a broken config cannot become a spawn loop.
    if (shortLived && code !== 0 && signal !== 'SIGTERM') {
      state.failures = Math.min(state.failures + 1, 6);
      state.nextSpawnAllowedAt = Date.now() + Math.min(2 ** state.failures * 30_000, 15 * 60_000);
    } else {
      state.failures = 0;
      state.nextSpawnAllowedAt = 0;
    }
    void onChildExit(c, code, signal);
  });

  child.unref();
  state.lastSpawnAt = Date.now();
  await fsp.writeFile(c.lockPath, String(child.pid));
  return child.pid;
}

async function onChildExit(c, code, signal) {
  await fsp.rm(c.lockPath, { force: true }).catch(() => {});
  const status = await readStatus(c.statusPath).catch(() => emptyStatus());
  const clean = code === 0 || signal === 'SIGTERM';
  await writeStatus(c.statusPath, {
    ...status,
    running: false,
    pid: null,
    current: null,
    stoppedAt: new Date().toISOString(),
    lastError: clean
      ? status.lastError
      : `Ingester exited with code ${code}${signal ? ` (${signal})` : ''}. ` +
        'The supervisor will restart it while the switch is on.'
  }).catch(() => {});
}

/**
 * Turn it on. Idempotent.
 *
 * Two copies sharing a ledger and a work directory would double the request
 * rate and race each other's files, so an already-running ingester is left
 * alone rather than joined by a second.
 */
export async function start(options = {}) {
  const c = cfg();
  await writeDesired(c, { enabled: true, ...options });
  // Clear any backoff: an explicit start is a person saying "try again now".
  state.failures = 0;
  state.nextSpawnAllowedAt = 0;

  if (await isRunning()) return { started: false, reason: 'already running', enabled: true };

  const pid = await spawnIngester(c, options);
  await writeStatus(c.statusPath, {
    ...emptyStatus(),
    running: true,
    pid,
    startedAt: new Date().toISOString()
  });
  return { started: true, pid, enabled: true };
}

/**
 * Turn it off.
 *
 * SIGTERM, not SIGKILL: the pipeline traps it, finishes the match it is on and
 * flushes the ledger. Killing mid-parse leaves a half-written record and a work
 * directory to sweep on the next start.
 */
export async function stop() {
  const c = cfg();
  await writeDesired(c, { enabled: false });

  const pid = await readPid(c.lockPath);
  if (!pid || !alive(pid)) {
    await fsp.rm(c.lockPath, { force: true }).catch(() => {});
    return { stopped: false, reason: 'not running', enabled: false };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, reason: err.message, enabled: false };
  }
  return { stopped: true, pid, enabled: false, note: 'finishing the current match first' };
}

/**
 * Reconcile reality with the switch. Safe to call as often as you like.
 *
 * This is what makes the thing survive a reboot and a crash: nothing else ever
 * needs to remember to restart it.
 */
export async function supervise() {
  const c = cfg();
  const desired = await readDesired(c);
  if (!desired.enabled) return { action: 'none', enabled: false };
  if (await isRunning()) return { action: 'none', enabled: true, running: true };
  if (Date.now() < state.nextSpawnAllowedAt) {
    return {
      action: 'backoff',
      enabled: true,
      retryInMs: state.nextSpawnAllowedAt - Date.now(),
      failures: state.failures
    };
  }
  const pid = await spawnIngester(c, desired);
  console.log(`[ingest] supervisor restarted the ingester (pid ${pid})`);
  return { action: 'restarted', enabled: true, pid };
}

/**
 * Boot hook. Reconciles once, then keeps watching.
 *
 * The interval is the only thing standing between "the box rebooted at 3am" and
 * "the backfill has been off since 3am".
 */
export function startSupervisor({ intervalMs = 60_000 } = {}) {
  if (state.supervisor) return state.supervisor;
  supervise().catch((err) => console.warn(`[ingest] supervisor: ${err.message}`));
  state.supervisor = setInterval(() => {
    supervise().catch((err) => console.warn(`[ingest] supervisor: ${err.message}`));
  }, intervalMs);
  state.supervisor.unref?.();
  return state.supervisor;
}

export function stopSupervisor() {
  if (state.supervisor) clearInterval(state.supervisor);
  state.supervisor = null;
}

/** Everything the admin page renders. */
export async function status() {
  const c = cfg();
  const [running, file, desired] = await Promise.all([
    isRunning(),
    readStatus(c.statusPath),
    readDesired(c)
  ]);

  let counts = file.counts;
  let next = file.next;
  // The status file is only as fresh as the last event, so when nothing is
  // running read the ledger directly rather than showing stale totals.
  if (!running || !counts) {
    try {
      const ledger = await openLedger(c.ledgerPath);
      counts = ledger.counts();
      const pending = ledger.oldestPending();
      next = pending
        ? {
            matchId: pending.matchId,
            label: pending.archiveName || pending.matchId,
            playedAt: pending.playedAt
          }
        : null;
    } catch {
      /* no ledger yet */
    }
  }

  const total = counts?.total || 0;
  const done = counts?.done || 0;
  return {
    /** The switch. True means "should be running", independent of whether it is. */
    enabled: Boolean(desired.enabled),
    running,
    pid: running ? file.pid || (await readPid(c.lockPath)) : null,
    startedAt: file.startedAt || null,
    stoppedAt: file.stoppedAt || null,
    current: running ? file.current : null,
    idleUntil: running ? file.idleUntil || null : null,
    /** Set when the switch is on but the process is not up: a crash loop. */
    restartBackoffMs:
      desired.enabled && !running && state.nextSpawnAllowedAt > Date.now()
        ? state.nextSpawnAllowedAt - Date.now()
        : 0,
    counts: counts || null,
    next,
    progress: { done, total, percent: total ? Math.round((done / total) * 1000) / 10 : 0 },
    recent: file.recent || [],
    lastError: file.lastError || null,
    config: {
      source: c.source,
      inbox: c.inbox || null,
      since: c.since,
      batchSize: c.batchSize,
      pollIntervalMs: c.pollIntervalMs,
      library: c.library || null
    },
    updatedAt: file.updatedAt || null
  };
}
