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
//   3. The API server restarting.       desired.json is forced Off on boot so a
//                                       deploy never quietly resumes scraping.
//                                       Ledger + demo-cursor (and ingest.log)
//                                       still remember progress; flipping On
//                                       continues from the next demo id.
//   4. The ingester itself dying        While the switch is On, a supervisor
//      while the switch is On.          re-spawns it with backoff.
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
 * While the API process is up, On stays On across child crashes (supervisor).
 * A fresh API boot always forces Off; progress lives in the ledger/cursor.
 */
async function readDesired(c) {
  try {
    const raw = JSON.parse(await fsp.readFile(desiredPath(c), 'utf8'));
    return { enabled: Boolean(raw.enabled), ...raw };
  } catch {
    return { enabled: false };
  }
}

/**
 * Parse the newest demo id mentioned in ingest.log so a missing/stale cursor
 * can still resume after an operator clears state or a partial write.
 * @returns {Promise<number|null>}
 */
async function lastDemoIdFromLog(c) {
  try {
    const { lines } = await readIngestLog({ tail: 999 });
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const m =
        line.match(/cursor:\s*demo\/(\d+)/i) ||
        line.match(/->\s*demo\/(\d+)\s+download/i) ||
        line.match(/seek cursor\s*->\s*demo\/(\d+)/i) ||
        line.match(/demo\/(\d+)\s+(?:missing|waiting|challenge)/i);
      if (m) {
        const id = Number(m[1]);
        if (Number.isFinite(id) && id > 0) return id;
      }
    }
  } catch {
    /* log is optional */
  }
  return null;
}

/**
 * Prefer the on-disk cursor; if the log is ahead, seek forward so On does not
 * re-walk demos that already finished in a prior run.
 */
async function resumeCursorFromState(c) {
  const cursor = await readCursor(c);
  const fromLog = await lastDemoIdFromLog(c);
  if (fromLog == null) {
    await appendIngestLog(
      c,
      `resume cursor demo/${cursor.nextId} (ledger/cursor; no newer log mark)`
    );
    return cursor;
  }
  if (fromLog > Number(cursor.nextId || 0)) {
    const next = await seekCursor(c, fromLog);
    await appendIngestLog(
      c,
      `resume cursor advanced from log demo/${fromLog} (was demo/${cursor.nextId})`
    );
    return next;
  }
  await appendIngestLog(
    c,
    `resume cursor demo/${cursor.nextId} (log last saw demo/${fromLog})`
  );
  return cursor;
}

/**
 * API boot: always leave the switch Off and kill any orphaned child. Does not
 * clear ledger, cursor, or ingest.log.
 */
export async function disableForBoot() {
  const c = cfg();
  await writeDesired(c, { enabled: false });
  const pid = await readPid(c.lockPath);
  if (pid && alive(pid)) {
    await appendIngestLog(c, `boot: forcing Off; SIGKILL pid=${pid}`);
    killIngestPid(pid);
  }
  await fsp.rm(c.lockPath, { force: true }).catch(() => {});
  await releaseCloakProfiles();
  const status = await readStatus(c.statusPath).catch(() => emptyStatus());
  await writeStatus(c.statusPath, {
    ...status,
    running: false,
    pid: null,
    current: null,
    stoppedAt: new Date().toISOString(),
    lastError: null
  }).catch(() => {});
  state.failures = 0;
  state.nextSpawnAllowedAt = 0;
  await appendIngestLog(c, 'boot: ingest left Off (turn On manually to resume)');
  return { enabled: false };
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
    const killed = signal === 'SIGKILL' || signal === 'SIGTERM';
    // Continuous ingest should not end in seconds. Treat short-lived exits
    // (including mysterious code 0) as crashes so we back off and respawn.
    if (shortLived && !killed) {
      state.failures = Math.min(state.failures + 1, 6);
      state.nextSpawnAllowedAt =
        Date.now() + Math.min(2 ** state.failures * 2_000, 60_000);
    } else if (!killed && code !== 0) {
      state.failures = Math.min(state.failures + 1, 6);
      state.nextSpawnAllowedAt =
        Date.now() + Math.min(2 ** state.failures * 5_000, 5 * 60_000);
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
  const shortLived = Date.now() - state.lastSpawnAt < 30_000;
  const clean = (code === 0 || signal === 'SIGTERM') && !shortLived;
  await writeStatus(c.statusPath, {
    ...status,
    running: false,
    pid: null,
    current: null,
    stoppedAt: new Date().toISOString(),
    lastError: clean
      ? status.lastError
      : `Ingester exited with code ${code}${signal ? ` (${signal})` : ''}` +
        (shortLived ? ' after only a few seconds.' : '.') +
        ' The supervisor will restart it while the switch is on.'
  }).catch(() => {});

  // Do not wait for the supervisor interval — Starting for up to 60s feels stuck.
  const desired = await readDesired(c);
  if (desired.enabled) {
    const delay = Math.max(0, state.nextSpawnAllowedAt - Date.now());
    setTimeout(() => {
      supervise().catch((err) => console.warn(`[ingest] supervisor: ${err.message}`));
    }, Math.min(delay, 5_000)).unref?.();
  }
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
  await resumeCursorFromState(c);
  const pid = await spawnIngester(c, options);
  await writeStatus(c.statusPath, {
    ...emptyStatus(),
    running: true,
    pid,
    startedAt: new Date().toISOString()
  });
  return { started: true, pid, enabled: true };
}

/** Kill the detached ingest process group. Off must win immediately. */
function killIngestPid(pid) {
  if (!pid) return false;
  let killed = false;
  try {
    process.kill(-pid, 'SIGKILL');
    killed = true;
  } catch {
    /* Windows / not a group leader */
  }
  try {
    process.kill(pid, 'SIGKILL');
    killed = true;
  } catch {
    /* already gone */
  }
  return killed;
}

/**
 * Turn it off. Writes desired=false first, then SIGKILLs the child so parse /
 * CloakBrowser cannot keep running while the UI says Off.
 */
export async function stop() {
  const c = cfg();
  await writeDesired(c, { enabled: false });

  const pid = await readPid(c.lockPath);
  const status = await readStatus(c.statusPath).catch(() => emptyStatus());
  await writeStatus(c.statusPath, {
    ...status,
    running: false,
    pid: null,
    current: null,
    stoppedAt: new Date().toISOString(),
    lastError: null
  }).catch(() => {});

  if (!pid || !alive(pid)) {
    await fsp.rm(c.lockPath, { force: true }).catch(() => {});
    // Off in the UI but chrome may still hold the shared profile lock.
    await releaseCloakProfiles();
    await appendIngestLog(c, 'stop requested; not running');
    return { stopped: false, reason: 'not running', enabled: false };
  }

  await appendIngestLog(c, `stop requested; SIGKILL pid=${pid}`);
  killIngestPid(pid);
  await fsp.rm(c.lockPath, { force: true }).catch(() => {});
  // Chromium often outlives the node child and keeps SingletonLock (probe then
  // fails with "profile is already in use by process N").
  await releaseCloakProfiles();
  // Second pass in case a grandchild survived the first signal.
  setTimeout(() => {
    if (alive(pid)) killIngestPid(pid);
  }, 500).unref?.();
  return { stopped: true, pid, enabled: false, note: 'killed' };
}

/**
 * Kill orphan Chromium holders of CloakBrowser profiles, then drop Singleton*
 * locks. Ingest Off / SIGKILL often leaves chrome (e.g. pid in SingletonLock)
 * alive; probe then fails with "profile is already in use by process N".
 */
export async function releaseCloakProfiles() {
  const c = cfg();
  const profileRoot = c.cloakProfileDir;
  if (!profileRoot) return { killed: [], cleared: 0 };
  const killed = [];
  let cleared = 0;
  const sessions = await fsp.readdir(profileRoot).catch(() => []);
  for (const name of sessions) {
    const dir = path.join(profileRoot, name);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const lock = path.join(dir, 'SingletonLock');
    const target = await fsp.readlink(lock).catch(() => '');
    const match = /^(.*)-(\d+)$/.exec(target);
    const lockPid = Number(match?.[2]) || 0;
    if (lockPid && lockPid !== process.pid && alive(lockPid)) {
      killIngestPid(lockPid);
      killed.push(lockPid);
    }
    for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(dir, file);
      if (await fsp.rm(p, { force: true }).then(() => true, () => false)) cleared += 1;
    }
  }
  if (killed.length) {
    await appendIngestLog(
      c,
      `released cloak profiles; SIGKILL lock holder(s) ${killed.join(', ')}`
    );
    // Let chrome die before the next launchPersistentContext.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { killed, cleared };
}

/**
 * Kill the child, clear lock/backoff/profile locks, wait briefly, then start.
 * Use when Off/On races leave CloakBrowser/Xvfb wedged.
 */
export async function hardRestart(options = {}) {
  const c = cfg();
  await appendIngestLog(c, 'hard restart requested');

  // Hold the supervisor off while we kill and settle. Writing enabled=true
  // early used to let supervise() spawn a second child mid-wait.
  await writeDesired(c, { enabled: false });
  state.nextSpawnAllowedAt = Date.now() + 30_000;

  const oldPid = await readPid(c.lockPath);
  if (oldPid && alive(oldPid)) {
    await appendIngestLog(c, `hard restart SIGKILL pid=${oldPid}`);
    killIngestPid(oldPid);
    setTimeout(() => {
      if (alive(oldPid)) killIngestPid(oldPid);
    }, 400).unref?.();
  }
  await fsp.rm(c.lockPath, { force: true }).catch(() => {});
  await releaseCloakProfiles();

  await writeStatus(c.statusPath, {
    ...emptyStatus(),
    running: false,
    pid: null,
    current: null,
    stoppedAt: new Date().toISOString(),
    lastError: null
  }).catch(() => {});

  // Let chrome/Xvfb grandchildren die and license seats release before relaunch.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  if (await isRunning()) {
    const still = await readPid(c.lockPath);
    await appendIngestLog(c, `hard restart: still alive pid=${still}; SIGKILL again`);
    killIngestPid(still);
    await fsp.rm(c.lockPath, { force: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  state.failures = 0;
  state.nextSpawnAllowedAt = 0;
  state.lastSpawnAt = 0;
  await writeDesired(c, { enabled: true, ...options });

  await appendIngestLog(c, 'hard restart spawning');
  await resumeCursorFromState(c);
  const pid = await spawnIngester(c, options);
  await writeStatus(c.statusPath, {
    ...emptyStatus(),
    running: true,
    pid,
    startedAt: new Date().toISOString()
  });
  return { restarted: true, pid, enabled: true, killedPid: oldPid || null };
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
  if (!desired.enabled) {
    // Belt-and-braces: a stray child must not keep ingesting after Off.
    const pid = await readPid(c.lockPath);
    if (pid && alive(pid)) {
      await appendIngestLog(c, `supervisor killing stray pid=${pid} (switch off)`);
      killIngestPid(pid);
      await fsp.rm(c.lockPath, { force: true }).catch(() => {});
      return { action: 'killed-stray', enabled: false };
    }
    return { action: 'none', enabled: false };
  }
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
 * Boot hook. Forces the switch Off (manual On required after every API
 * restart), then watches for crashes only while an operator has turned it On.
 */
export function startSupervisor({ intervalMs = 5_000 } = {}) {
  if (state.supervisor) return state.supervisor;
  // Sentinel so a second boot call is a no-op while disableForBoot runs.
  // The real interval is armed only after Off is on disk, otherwise a stale
  // desired.json=true could respawn the child before boot disable finishes.
  let armed = null;
  state.supervisor = {
    unref() {
      armed?.unref?.();
    }
  };
  disableForBoot()
    .then(() => supervise())
    .then(() => {
      armed = setInterval(() => {
        supervise().catch((err) => console.warn(`[ingest] supervisor: ${err.message}`));
      }, intervalMs);
      armed.unref?.();
      state.supervisor = armed;
    })
    .catch((err) => console.warn(`[ingest] supervisor: ${err.message}`));
  return state.supervisor;
}

export function stopSupervisor() {
  if (state.supervisor) clearInterval(state.supervisor);
  state.supervisor = null;
}

/** Everything the admin page renders. */
export async function status() {
  const c = cfg();
  const desired = await readDesired(c);
  // Off must never look "still working" because a child outlived SIGTERM.
  if (!desired.enabled) {
    const stray = await readPid(c.lockPath);
    if (stray && alive(stray)) {
      await appendIngestLog(c, `status poll killing stray pid=${stray}`);
      killIngestPid(stray);
      await fsp.rm(c.lockPath, { force: true }).catch(() => {});
    }
  }

  const [running, file, cursor] = await Promise.all([
    isRunning(),
    readStatus(c.statusPath),
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

/** Truncate ingest.log (keeps the file; supervisor/child reopen with append). */
export async function clearIngestLog() {
  const c = cfg();
  const logPath = ingestLogPath(c);
  await fsp.mkdir(c.stateDir, { recursive: true });
  await fsp.writeFile(logPath, '');
  await appendIngestLog(c, 'console cleared');
  return { ok: true, path: logPath };
}

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
