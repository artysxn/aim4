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

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { cursorProgress, readCursor, seekCursor } from './cursor.js';
import { openLedger } from './ledger.js';
import { cancelProbe } from './probe.js';
import { emptyStatus, readStatus, writeStatus } from './status.js';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.js');

/** In-process bookkeeping. None of it is authoritative; the files are. */
const state = {
  /** Consecutive short-lived exits, for restart backoff. */
  failures: 0,
  nextSpawnAllowedAt: 0,
  lastSpawnAt: 0,
  supervisor: null,
  /** Serialize spawnIngester so Hard Restart + onChildExit cannot double-start. */
  spawnChain: Promise.resolve(),
  /** While true, supervise() must not spawn (hard restart owns the spawn). */
  holdSpawn: false
};

/**
 * Cloak Pro tracks seats on their license server. After SIGKILL the local
 * chrome is gone but the seat can linger for well over a minute. Hard Restart
 * that respawns in a few seconds walks straight back into session-limit.
 */
const SESSION_LIMIT_BACKOFF_MS = 180_000;
/** Extra settle after local cloak PIDs are gone (hard stop / hard restart). */
const LICENSE_SETTLE_MS = 60_000;

function isSessionLimitMessage(msg) {
  return /session limit reached/i.test(String(msg || ''));
}

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
 *
 * Serialized: a late exit handler must never wipe the lock of a newer child
 * and let supervise() start a second ingest (profile lock + ETXTBSY hell).
 */
async function spawnIngester(c, options = {}) {
  const run = async () => {
    if (await isRunning()) {
      const existing = await readPid(c.lockPath);
      await appendIngestLog(c, `spawn skipped; already running pid=${existing}`);
      return existing;
    }

    // Never launch a second chrome while an orphan still holds a Pro seat.
    const leftovers = await remainingCloakPids(c);
    if (leftovers.length) {
      await appendIngestLog(
        c,
        `spawn: sweeping ${leftovers.length} leftover cloak pid(s) [${leftovers
          .slice(0, 12)
          .join(',')}]`
      );
      await killAllIngestRelated(c);
      const clear = await waitUntilCloakClear(c, 'pre-spawn', 15_000);
      if (!clear) {
        state.nextSpawnAllowedAt = Math.max(
          state.nextSpawnAllowedAt,
          Date.now() + SESSION_LIMIT_BACKOFF_MS
        );
        throw new Error(
          `CloakBrowser leftovers still alive; holding spawn ${Math.round(
            SESSION_LIMIT_BACKOFF_MS / 1000
          )}s`
        );
      }
    }

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
      AIM4_INGEST_SOURCE: source,
      // CloakBrowser uses its own Xvfb (:100). Do not inherit the API server's
      // xvfb-run DISPLAY (:99) — Hard Restart used to kill that and leave a
      // stale socket that lied about a working X server.
      AIM4_CLOAK_XVFB_DISPLAY: process.env.AIM4_CLOAK_XVFB_DISPLAY || '100',
      CLOAKBROWSER_CACHE_DIR:
        process.env.CLOAKBROWSER_CACHE_DIR || c.cloakBrowserCacheDir || ''
    };
    delete childEnv.DISPLAY;
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

    const childPid = child.pid;
    child.on('exit', (code, signal) => {
      const shortLived = Date.now() - state.lastSpawnAt < 30_000;
      const killed = signal === 'SIGKILL' || signal === 'SIGTERM';
      const nativeCrash =
        signal === 'SIGABRT' ||
        signal === 'SIGSEGV' ||
        signal === 'SIGILL' ||
        signal === 'SIGBUS';
      // Continuous ingest should not end in seconds. Treat short-lived exits
      // (including mysterious code 0) as crashes so we back off and respawn.
      // Cap backoff hard: overnight must not sit for many minutes after one
      // native abort (parse is forked now; if the CLI still dies, recover fast).
      if (nativeCrash) {
        state.failures = Math.min(state.failures + 1, 4);
        state.nextSpawnAllowedAt =
          Date.now() + Math.min(2 ** state.failures * 3_000, 30_000);
      } else if (shortLived && !killed) {
        state.failures = Math.min(state.failures + 1, 6);
        state.nextSpawnAllowedAt =
          Date.now() + Math.min(2 ** state.failures * 2_000, 60_000);
      } else if (!killed && code !== 0) {
        state.failures = Math.min(state.failures + 1, 6);
        state.nextSpawnAllowedAt =
          Date.now() + Math.min(2 ** state.failures * 5_000, 60_000);
      } else {
        state.failures = 0;
        state.nextSpawnAllowedAt = 0;
      }
      void onChildExit(c, code, signal, childPid);
    });

    child.unref();
    state.lastSpawnAt = Date.now();
    await fsp.writeFile(c.lockPath, String(childPid));
    await appendIngestLog(c, `spawned pid=${childPid}`);
    return childPid;
  };

  const next = state.spawnChain.then(run, run);
  state.spawnChain = next.catch(() => {});
  return next;
}

async function onChildExit(c, code, signal, exitedPid) {
  const lockPid = await readPid(c.lockPath);
  if (exitedPid && lockPid && lockPid !== exitedPid) {
    // Late exit of a SIGKILL'd previous child after Hard Restart already
    // spawned a replacement. Clearing the lock here is what caused double
    // ingest (profile-in-use + Missing X server storms).
    await appendIngestLog(
      c,
      `child exited pid=${exitedPid} code=${code}` +
        `${signal ? ` signal=${signal}` : ''} but lock holds pid=${lockPid}; leaving lock`
    );
    return;
  }
  await fsp.rm(c.lockPath, { force: true }).catch(() => {});
  await appendIngestLog(
    c,
    `child exited pid=${exitedPid || '?'} code=${code}${signal ? ` signal=${signal}` : ''}` +
      (state.failures ? ` failures=${state.failures}` : '')
  );
  const status = await readStatus(c.statusPath).catch(() => emptyStatus());
  const shortLived = Date.now() - state.lastSpawnAt < 30_000;
  const sessionLimit =
    code === 78 ||
    isSessionLimitMessage(status.lastError) ||
    isSessionLimitMessage(status.current?.error);
  if (sessionLimit) {
    // Rapid respawn is what wedges the Pro seat. Sweep orphans and wait.
    state.failures = Math.max(state.failures, 5);
    state.nextSpawnAllowedAt = Date.now() + SESSION_LIMIT_BACKOFF_MS;
    await appendIngestLog(
      c,
      `session-limit: sweeping cloak; holding spawn ${Math.round(
        SESSION_LIMIT_BACKOFF_MS / 1000
      )}s`
    );
    await killAllIngestRelated(c);
    await waitUntilCloakClear(c, 'session-limit', 15_000);
  }
  const clean = (code === 0 || signal === 'SIGTERM') && !shortLived && !sessionLimit;
  await writeStatus(c.statusPath, {
    ...status,
    running: false,
    pid: null,
    current: null,
    stoppedAt: new Date().toISOString(),
    lastError: sessionLimit
      ? String(status.lastError || 'CloakBrowser Pro: session limit reached')
      : clean
        ? status.lastError
        : `Ingester exited with code ${code}${signal ? ` (${signal})` : ''}` +
          (shortLived ? ' after only a few seconds.' : '.') +
          ' The supervisor will restart it while the switch is on.'
  }).catch(() => {});

  // Do not wait for the supervisor interval — Starting for up to 60s feels stuck.
  if (state.holdSpawn) {
    await appendIngestLog(c, 'child exit: spawn hold active; not auto-respawning');
    return;
  }
  const desired = await readDesired(c);
  if (desired.enabled) {
    const delay = Math.max(0, state.nextSpawnAllowedAt - Date.now());
    // Honor the full backoff (session-limit is minutes). Capping at 5s used to
    // spam supervise() while seats were still held remotely.
    setTimeout(() => {
      supervise().catch((err) => console.warn(`[ingest] supervisor: ${err.message}`));
    }, delay).unref?.();
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

  if (await isRunning()) {
    await appendIngestLog(c, 'start requested but already running');
    return { started: false, reason: 'already running', enabled: true };
  }

  await appendIngestLog(c, 'start requested');
  // Explicit On still must not stack chrome on a full Pro seat. Sweep first;
  // keep a short settle so a human click after Hard Stop can succeed.
  const leftovers = await remainingCloakPids(c);
  if (leftovers.length) {
    await appendIngestLog(
      c,
      `start: sweeping ${leftovers.length} leftover cloak pid(s) before spawn`
    );
    await killAllIngestRelated(c);
    await waitUntilCloakClear(c, 'start', 20_000);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  state.failures = 0;
  // If a session-limit hold is still active, do not zero it on a frantic click.
  if (Date.now() < state.nextSpawnAllowedAt) {
    const wait = state.nextSpawnAllowedAt - Date.now();
    await appendIngestLog(
      c,
      `start: session-limit hold active; supervisor will spawn in ${Math.round(wait / 1000)}s`
    );
    return {
      started: false,
      reason: 'session-limit backoff',
      enabled: true,
      retryInMs: wait
    };
  }
  state.nextSpawnAllowedAt = 0;

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

/** Kill one PID. Never touches this API process. */
function killPid(pid) {
  const n = Number(pid);
  if (!n || n === process.pid) return false;
  try {
    process.kill(n, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Kill the detached ingest process group. Off must win immediately. */
function killIngestPid(pid) {
  if (!pid || Number(pid) === process.pid) return false;
  let killed = false;
  try {
    process.kill(-pid, 'SIGKILL');
    killed = true;
  } catch {
    /* Windows / not a group leader */
  }
  if (killPid(pid)) killed = true;
  return killed;
}

/** Children of pid (best-effort; macOS/Linux pgrep -P). */
async function childPids(pid) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8'
    });
    return stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 1 && n !== process.pid);
  } catch {
    return [];
  }
}

/** Depth-first kill of a process tree (CloakBrowser/Xvfb grandchildren). */
async function killProcessTree(pid) {
  if (!pid || !alive(pid)) return [];
  const killed = [];
  for (const child of await childPids(pid)) {
    killed.push(...(await killProcessTree(child)));
  }
  if (killPid(pid)) killed.push(pid);
  return killed;
}

/**
 * PIDs holding Chromium SingletonLock under the CloakBrowser profile root.
 * Symlink target looks like `hostname-693`.
 */
async function profileLockPids(profileRoot) {
  const pids = new Set();
  if (!profileRoot) return pids;
  const sessions = await fsp.readdir(profileRoot).catch(() => []);
  for (const name of sessions) {
    const dir = path.join(profileRoot, name);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const target = await fsp.readlink(path.join(dir, 'SingletonLock')).catch(() => '');
    const match = /-(\d+)$/.exec(String(target || ''));
    const lockPid = Number(match?.[1]) || 0;
    if (lockPid > 1 && lockPid !== process.pid) pids.add(lockPid);
  }
  return pids;
}

/** Drop Chromium Singleton* locks so a fresh child can open the profile. */
async function clearProfileLocks(profileRoot) {
  if (!profileRoot) return;
  const sessions = await fsp.readdir(profileRoot).catch(() => []);
  for (const name of sessions) {
    const dir = path.join(profileRoot, name);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await fsp.rm(path.join(dir, lock), { force: true }).catch(() => {});
    }
  }
}

/**
 * PIDs whose command line matches a pgrep -f pattern. Never includes our pid.
 */
async function pidsMatching(pattern) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 1 && n !== process.pid);
  } catch {
    return [];
  }
}

/**
 * pgrep -f patterns that identify our CloakBrowser chrome / ingest helpers.
 * Pro seats track live chrome binaries, not profile locks — orphans often have
 * the cache path in argv but not "cloakbrowser-profile".
 */
function cloakKillPatterns(c) {
  const cloakDisplay = process.env.AIM4_CLOAK_XVFB_DISPLAY || '100';
  const patterns = [
    'ingest/hltv/cli\\.js',
    'ingest/hltv/ingestParseWorker\\.js',
    'ingest/hltv/probeParseWorker\\.js',
    'cloakbrowser-profile',
    'cloakbrowser-cache',
    `Xvfb :${cloakDisplay}`
  ];
  // Absolute cache / profile dirs (escaped) so we catch chrome even if cwd differs.
  for (const dir of [c.cloakBrowserCacheDir, c.cloakProfileDir]) {
    if (!dir) continue;
    const esc = String(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(esc);
  }
  // Licensed Pro chrome binary name from CloakBrowser packages.
  patterns.push('chromium-[0-9.]+-pro/chrome');
  patterns.push('chromium-[0-9.]+-pro');
  return patterns;
}

/**
 * Linux /proc scan for chrome/Xvfb that pgrep -f sometimes misses (truncated
 * cmdline, altered argv0). Matches user-data-dir / cache / pro chrome paths.
 */
async function pidsFromProcCmdline(c) {
  const found = new Set();
  if (process.platform === 'win32') return found;
  const needles = [
    'cloakbrowser-profile',
    'cloakbrowser-cache',
    'chromium-',
    '-pro/chrome',
    `Xvfb :${process.env.AIM4_CLOAK_XVFB_DISPLAY || '100'}`
  ];
  if (c.cloakBrowserCacheDir) needles.push(String(c.cloakBrowserCacheDir));
  if (c.cloakProfileDir) needles.push(String(c.cloakProfileDir));
  let entries = [];
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
    let cmd = '';
    try {
      cmd = (await fsp.readFile(`/proc/${pid}/cmdline`)).toString('utf8');
    } catch {
      continue;
    }
    const text = cmd.replace(/\0/g, ' ');
    if (!text) continue;
    // Require a cloak/pro marker so we never sweep the host's unrelated chrome.
    const ours =
      /cloakbrowser/i.test(text) ||
      /chromium-[\d.]+-pro/i.test(text) ||
      (c.cloakBrowserCacheDir && text.includes(c.cloakBrowserCacheDir)) ||
      (c.cloakProfileDir && text.includes(c.cloakProfileDir));
    if (!ours) continue;
    if (needles.some((n) => n && text.includes(n))) found.add(pid);
  }
  return found;
}

/** Live PIDs that still look like our CloakBrowser / ingest stack. */
async function remainingCloakPids(c) {
  const found = new Set();
  for (const pid of await profileLockPids(c.cloakProfileDir)) {
    if (alive(pid)) found.add(pid);
  }
  for (const pattern of cloakKillPatterns(c)) {
    for (const pid of await pidsMatching(pattern)) found.add(pid);
  }
  for (const pid of await pidsFromProcCmdline(c)) found.add(pid);
  return [...found];
}

/**
 * Kill every process that can hold a CloakBrowser license seat or profile lock:
 * ingest CLI, probe parse workers, Chromium using our profile/cache dir, and
 * Cloak Xvfb (:100). Never kill the API server's xvfb-run display (:99).
 */
async function killAllIngestRelated(c) {
  const killed = new Set();
  const log = (msg) => appendIngestLog(c, msg);
  const cloakDisplay = process.env.AIM4_CLOAK_XVFB_DISPLAY || '100';

  try {
    const probe = await cancelProbe();
    if (probe?.cancelled) await log('hard reset: cancelled running probe');
  } catch (err) {
    await log(`hard reset: probe cancel failed: ${err?.message || err}`);
  }

  const lockPid = await readPid(c.lockPath);
  if (lockPid) {
    for (const pid of await killProcessTree(lockPid)) killed.add(pid);
    killIngestPid(lockPid);
    killed.add(lockPid);
    await log(`hard reset: killed ingest tree pid=${lockPid}`);
  }
  await fsp.rm(c.lockPath, { force: true }).catch(() => {});

  for (const pid of await profileLockPids(c.cloakProfileDir)) {
    for (const child of await killProcessTree(pid)) killed.add(child);
    if (killPid(pid)) killed.add(pid);
    await log(`hard reset: killed profile lock holder pid=${pid}`);
  }

  // Narrow patterns only: never pkill bare "chromium" / "node" / Xvfb :99.
  for (const pattern of cloakKillPatterns(c)) {
    const matches = await pidsMatching(pattern);
    for (const pid of matches) {
      // CLI is a session leader; use group kill. Browser/Xvfb: tree kill.
      if (pattern.includes('cli\\.js')) killIngestPid(pid);
      else await killProcessTree(pid);
      if (killPid(pid)) killed.add(pid);
    }
    if (matches.length) {
      await log(`hard reset: pgrep ${pattern} -> ${matches.join(',')}`);
    }
  }

  const procHits = [...(await pidsFromProcCmdline(c))];
  for (const pid of procHits) {
    await killProcessTree(pid);
    if (killPid(pid)) killed.add(pid);
  }
  if (procHits.length) {
    await log(`hard reset: /proc cmdline -> ${procHits.join(',')}`);
  }

  await clearProfileLocks(c.cloakProfileDir);
  await fsp.rm(`/tmp/.X11-unix/X${cloakDisplay}`, { force: true }).catch(() => {});
  await fsp.rm(`/tmp/.X${cloakDisplay}-lock`, { force: true }).catch(() => {});
  return [...killed];
}

/**
 * Keep sweeping until no CloakBrowser-related PIDs remain (or timeout).
 * Pro license seats drop only after the chrome process is actually gone.
 */
async function waitUntilCloakClear(c, label, maxMs = 20_000) {
  const started = Date.now();
  let pass = 0;
  while (Date.now() - started < maxMs) {
    const left = await remainingCloakPids(c);
    if (!left.length) {
      if (pass > 0) {
        await appendIngestLog(
          c,
          `${label}: cloak clear after ${Math.round((Date.now() - started) / 1000)}s`
        );
      }
      return true;
    }
    pass++;
    await appendIngestLog(
      c,
      `${label}: waiting for ${left.length} cloak pid(s) to die [${left.slice(0, 12).join(',')}]`
    );
    for (const pid of left) {
      await killProcessTree(pid);
      killPid(pid);
    }
    await clearProfileLocks(c.cloakProfileDir);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const leftover = await remainingCloakPids(c);
  if (leftover.length) {
    await appendIngestLog(
      c,
      `${label}: cloak still alive after ${Math.round(maxMs / 1000)}s: ${leftover.join(',')}`
    );
    return false;
  }
  return true;
}

/**
 * Turn it off. Writes desired=false first, then kills the ingest CLI and any
 * orphan CloakBrowser chrome/Xvfb that can hold a Pro license seat.
 */
export async function stop() {
  const c = cfg();
  await writeDesired(c, { enabled: false });
  state.holdSpawn = true;

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

  try {
    await appendIngestLog(
      c,
      pid && alive(pid)
        ? `stop requested; full cloak sweep (ingest pid=${pid})`
        : 'stop requested; full cloak sweep (ingest not running)'
    );
    const killed = await killAllIngestRelated(c);
    await waitUntilCloakClear(c, 'stop', 12_000);
    await appendIngestLog(
      c,
      `stop done; killed ${killed.length} pid(s)` +
        (killed.length ? ` [${killed.slice(0, 20).join(',')}]` : '')
    );
    return {
      stopped: Boolean(pid) || killed.length > 0,
      pid: pid || null,
      enabled: false,
      killedPids: killed,
      note: 'killed'
    };
  } finally {
    state.holdSpawn = false;
  }
}

/**
 * Shared kill sweep for Hard Stop / Hard Restart: ingest CLI, parse workers,
 * CloakBrowser chrome (profile + cache), Cloak Xvfb. Leaves desired=false.
 * Waits until no matching PIDs remain so Pro seats can drop before respawn.
 */
async function hardKillSweep(c, label) {
  state.holdSpawn = true;
  await writeDesired(c, { enabled: false });
  state.nextSpawnAllowedAt = Date.now() + 45_000;

  const oldPid = await readPid(c.lockPath);
  const killed = await killAllIngestRelated(c);
  await appendIngestLog(
    c,
    `${label}: killed ${killed.length} pid(s)` +
      (killed.length ? ` [${killed.slice(0, 20).join(',')}]` : '')
  );

  await writeStatus(c.statusPath, {
    ...emptyStatus(),
    running: false,
    pid: null,
    current: null,
    stoppedAt: new Date().toISOString(),
    lastError: null
  }).catch(() => {});

  // First beat, then keep sweeping until chrome is gone (Pro seat tracking).
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const again = await killAllIngestRelated(c);
  if (again.length) {
    await appendIngestLog(c, `${label}: second sweep killed ${again.length} pid(s)`);
  }
  await waitUntilCloakClear(c, label, 25_000);
  // Extra settle for remote Pro license accounting after SIGKILL. Too short
  // and Hard Restart immediately hits "session limit reached".
  await appendIngestLog(
    c,
    `${label}: waiting ${Math.round(LICENSE_SETTLE_MS / 1000)}s for Pro seat release`
  );
  await new Promise((resolve) => setTimeout(resolve, LICENSE_SETTLE_MS));
  // One last sweep in case chrome respawned during the settle (supervisor race).
  const final = await killAllIngestRelated(c);
  if (final.length) {
    await appendIngestLog(c, `${label}: post-settle sweep killed ${final.length} pid(s)`);
    await waitUntilCloakClear(c, `${label}-post`, 10_000);
  }

  state.failures = 0;
  state.nextSpawnAllowedAt = 0;
  state.lastSpawnAt = 0;

  return {
    oldPid: oldPid || null,
    killedPids: [...new Set([...killed, ...again, ...final])]
  };
}

/**
 * Full kill sweep and leave Off. Use when Off alone leaves chrome/Xvfb/parse
 * workers alive or the switch looks stuck on Stopping.
 */
export async function hardStop() {
  const c = cfg();
  await appendIngestLog(c, 'hard stop requested');
  try {
    const { oldPid, killedPids } = await hardKillSweep(c, 'hard stop');
    await writeDesired(c, { enabled: false });
    await appendIngestLog(c, 'hard stop done; switch Off');
    return {
      stopped: true,
      enabled: false,
      killedPid: oldPid,
      killedPids
    };
  } finally {
    state.holdSpawn = false;
  }
}

/**
 * Kill every ingest/CloakBrowser/Xvfb/probe process, clear profile locks, wait
 * for license seats, then start clean. Use when session-limit or
 * "profile already in use" errors leave the host wedged.
 */
export async function hardRestart(options = {}) {
  const c = cfg();
  await appendIngestLog(c, 'hard restart requested');

  try {
    const { oldPid, killedPids } = await hardKillSweep(c, 'hard reset');

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
    return {
      restarted: true,
      pid,
      enabled: true,
      killedPid: oldPid,
      killedPids
    };
  } finally {
    state.holdSpawn = false;
  }
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
    // Belt-and-braces: while Off, also reap orphan CloakBrowser chrome that
    // still holds a Pro seat after the CLI exited uncleanly.
    const pid = await readPid(c.lockPath);
    const leftovers = await remainingCloakPids(c);
    if ((pid && alive(pid)) || leftovers.length) {
      await appendIngestLog(
        c,
        `supervisor Off sweep` +
          (pid && alive(pid) ? ` ingest=${pid}` : '') +
          (leftovers.length ? ` cloak=[${leftovers.slice(0, 12).join(',')}]` : '')
      );
      await killAllIngestRelated(c);
      return { action: 'killed-stray', enabled: false };
    }
    return { action: 'none', enabled: false };
  }
  if (state.holdSpawn) {
    await appendIngestLog(c, 'supervise: spawn hold (hard restart in progress)');
    return { action: 'hold', enabled: true };
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
  try {
    const pid = await spawnIngester(c, desired);
    console.log(`[ingest] supervisor restarted the ingester (pid ${pid})`);
    await appendIngestLog(c, `supervisor restart pid=${pid}`);
    return { action: 'restarted', enabled: true, pid };
  } catch (err) {
    const msg = String(err?.message || err);
    await appendIngestLog(c, `supervisor spawn failed: ${msg}`);
    if (isSessionLimitMessage(msg) || /leftovers still alive/i.test(msg)) {
      state.nextSpawnAllowedAt = Date.now() + SESSION_LIMIT_BACKOFF_MS;
    } else {
      state.failures = Math.min(state.failures + 1, 6);
      state.nextSpawnAllowedAt =
        Date.now() + Math.min(2 ** state.failures * 5_000, 60_000);
    }
    return {
      action: 'spawn-failed',
      enabled: true,
      error: msg,
      retryInMs: Math.max(0, state.nextSpawnAllowedAt - Date.now())
    };
  }
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
  // Also reap orphan chrome that still holds a Pro seat (status polls often).
  if (!desired.enabled) {
    const stray = await readPid(c.lockPath);
    const leftovers = await remainingCloakPids(c);
    if ((stray && alive(stray)) || leftovers.length) {
      await appendIngestLog(
        c,
        `status poll Off sweep` +
          (stray && alive(stray) ? ` ingest=${stray}` : '') +
          (leftovers.length ? ` cloak=[${leftovers.slice(0, 12).join(',')}]` : '')
      );
      await killAllIngestRelated(c);
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
      frontierLookahead: c.frontierLookahead,
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
