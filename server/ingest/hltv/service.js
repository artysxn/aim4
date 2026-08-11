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
import { cursorProgress, readCursor, seekCursor } from './cursor.js';
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

function ingestLogPath(c) {
  return path.join(c.stateDir, 'ingest.log');
}

/** Supervisor lines go into the same file the admin console tails. */
async function appendIngestLog(c, message) {
  const line = `${new Date().toISOString()} [supervisor] ${message}\n`;
  try {
    await fsp.mkdir(c.stateDir, { recursive: true });
    await fsp.appendFile(ingestLogPath(c), line);
  } catch {
    /* never block control plane on log IO */
  }
}

/**
 * Launch the child. Internal: callers go through start() or the supervisor, so
 * the desired-state flag and the spawn cannot drift apart.
 */
async function spawnIngester(c, options = {}) {
  await fsp.mkdir(c.stateDir, { recursive: true });
  await fsp.mkdir(c.workDir, { recursive: true });

  const args = [CLI, 'run', '--continuous'];
  // Resolved config already coerces local-without-inbox → hltv. Still force
  // both argv and child env so a leftover Coolify AIM4_INGEST_SOURCE=local
  // cannot win inside the detached process.
  let source = String(options.source || c.source || 'hltv').trim().toLowerCase() || 'hltv';
  const inbox = String(options.inbox || c.inbox || '').trim();
  if (source === 'local' && !inbox) source = 'hltv';
  args.push('--source', source);
  if (inbox) args.push('--inbox', inbox);
  if (options.since || c.since) args.push('--since', options.since || c.since);

  // Raw descriptors, not pipes. A detached child that logs through a pipe to
  // its parent dies with the parent; one holding its own fd does not.
  const logPath = ingestLogPath(c);
  await appendIngestLog(
    c,
    `spawning source=${source}${inbox ? ` inbox=${inbox}` : ''} args=${args.slice(1).join(' ')}`
  );
  const logFd = fs.openSync(logPath, 'a');

  const childEnv = {
    ...process.env,
    AIM4_INGEST_SOURCE: source
  };
  if (inbox) childEnv.AIM4_INGEST_INBOX = inbox;
  else delete childEnv.AIM4_INGEST_INBOX;

  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv
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
  await appendIngestLog(c, `spawned pid=${child.pid}`);
  return child.pid;
}

async function onChildExit(c, code, signal) {
  await fsp.rm(c.lockPath, { force: true }).catch(() => {});
  await appendIngestLog(
    c,
    `child exited code=${code}${signal ? ` signal=${signal}` : ''}` +
      (state.failures ? ` failures=${state.failures}` : '')
  );
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

  if (await isRunning()) {
    await appendIngestLog(c, 'start requested but already running');
    return { started: false, reason: 'already running', enabled: true };
  }

  await appendIngestLog(c, 'start requested');
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
    await appendIngestLog(c, 'stop requested but not running');
    return { stopped: false, reason: 'not running', enabled: false };
  }
  try {
    await appendIngestLog(c, `stop requested; signaling pid=${pid}`);
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    await appendIngestLog(c, `stop failed: ${err.message}`);
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
  await appendIngestLog(c, `supervisor restart pid=${pid}`);
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
  const [running, file, desired, cursor] = await Promise.all([
    isRunning(),
    readStatus(c.statusPath),
    readDesired(c),
    readCursor(c)
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

  const seq = cursorProgress(cursor);
  const liveCursor = running && file.cursor ? { ...seq, ...file.cursor } : seq;
  if (!next && liveCursor.nextId) {
    next = { matchId: String(liveCursor.nextId), label: `demo/${liveCursor.nextId}`, playedAt: null };
  }

  const total = liveCursor.total || counts?.total || 0;
  const done = liveCursor.done || counts?.done || 0;
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
    cursor: liveCursor,
    progress: {
      done,
      total,
      left: liveCursor.left,
      percent: liveCursor.percent,
      loopsPerHour: liveCursor.loopsPerHour,
      atFrontier: liveCursor.atFrontier,
      nextId: liveCursor.nextId,
      lastSuccessId: liveCursor.lastSuccessId,
      startId: liveCursor.startId
    },
    recent: file.recent || [],
    lastError: file.lastError || null,
    config: {
      source: c.source,
      inbox: c.inbox || null,
      since: c.since,
      demoStart: c.demoStart,
      frontierWaitMs: c.frontierWaitMs,
      batchSize: c.batchSize,
      pollIntervalMs: c.pollIntervalMs,
      library: c.library || null
    },
    updatedAt: file.updatedAt || null
  };
}

/** Jump the sequential walker. Safe while stopped; while running takes effect on the next loop. */
export async function seek(nextId) {
  const c = cfg();
  const cursor = await seekCursor(c, nextId);
  await appendIngestLog(c, `seek cursor -> demo/${cursor.nextId}`);
  return { ok: true, cursor: cursorProgress(cursor), ...(await status()) };
}

const LOG_TAIL_DEFAULT = 999;
const LOG_READ_BYTES_CAP = 2 * 1024 * 1024;

/**
 * Last N lines of the detached ingester's stdout/stderr log.
 * Polled by the admin console while the panel is open.
 */
export async function readIngestLog({ tail = LOG_TAIL_DEFAULT } = {}) {
  const c = cfg();
  const logPath = path.join(c.stateDir, 'ingest.log');
  const maxLines = Math.max(1, Math.min(LOG_TAIL_DEFAULT, Number(tail) || LOG_TAIL_DEFAULT));
  try {
    const stat = await fsp.stat(logPath);
    const readSize = Math.min(stat.size, LOG_READ_BYTES_CAP);
    const fh = await fsp.open(logPath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, Math.max(0, stat.size - readSize));
      let text = buf.toString('utf8');
      if (stat.size > readSize) {
        const cut = text.indexOf('\n');
        text = cut >= 0 ? text.slice(cut + 1) : text;
      }
      const lines = text.split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return {
        path: logPath,
        lines: lines.slice(-maxLines),
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
        truncated: stat.size > readSize || lines.length > maxLines
      };
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { path: logPath, lines: [], bytes: 0, mtime: null, truncated: false };
    }
    throw err;
  }
}
