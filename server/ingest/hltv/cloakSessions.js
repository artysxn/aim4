// ---------------------------------------------------------------------------
// server/ingest/hltv/cloakSessions.js
// Force-close every CloakBrowser / Chromium process that can hold a Pro license
// seat or the shared profile lock. Used on ingest Off, boot, hard restart, and
// before probe when ingest is not running.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (!alive(pid)) return false;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* not a group leader */
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Linux: scan /proc for cmdlines that match any needle. */
async function pidsFromProc(needles) {
  const out = new Set();
  if (!needles.length) return out;
  const entries = await fsp.readdir('/proc').catch(() => []);
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!pid || pid === process.pid) continue;
    const raw = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (!raw) continue;
    const cmd = raw.replace(/\0/g, ' ');
    if (needles.some((n) => n && cmd.includes(n))) out.add(pid);
  }
  return out;
}

/** macOS / fallback: `ps` + substring match. */
async function pidsFromPs(needles) {
  const out = new Set();
  if (!needles.length) return out;
  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
      maxBuffer: 8 * 1024 * 1024
    });
    for (const line of String(stdout).split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2] || '';
      if (!pid || pid === process.pid) continue;
      if (needles.some((n) => n && cmd.includes(n))) out.add(pid);
    }
  } catch {
    /* ps unavailable */
  }
  return out;
}

async function pkillPattern(pattern) {
  if (!pattern) return;
  try {
    await execFileAsync('pkill', ['-9', '-f', pattern]);
  } catch {
    /* exit 1 = no match */
  }
}

/**
 * Find and SIGKILL every process that looks like a CloakBrowser Chromium
 * session for this deploy (binary under ~/.cloakbrowser, or --user-data-dir
 * under our profile root).
 *
 * @param {{ profileRoot?: string }} [opts]
 * @returns {Promise<number[]>}
 */
export async function killCloakBrowserProcesses({ profileRoot = '' } = {}) {
  const home = os.homedir();
  const needles = [
    path.join(home, '.cloakbrowser', 'chromium'),
    '/.cloakbrowser/chromium',
    'cloakbrowser/chromium',
    profileRoot ? String(profileRoot) : '',
    // Playwright / Cloak persistent contexts
    profileRoot ? `--user-data-dir=${profileRoot}` : '',
    profileRoot ? `--user-data-dir=${path.join(profileRoot, 'hltv')}` : '',
    profileRoot ? `--user-data-dir=${path.join(profileRoot, 'probe')}` : ''
  ].filter(Boolean);

  const fromProc = await pidsFromProc(needles);
  const pids = fromProc.size ? fromProc : await pidsFromPs(needles);

  // Read SingletonLock PIDs too (chrome may not show profile path in argv).
  if (profileRoot) {
    const sessions = await fsp.readdir(profileRoot).catch(() => []);
    for (const name of sessions) {
      const lock = path.join(profileRoot, name, 'SingletonLock');
      const target = await fsp.readlink(lock).catch(() => '');
      const match = /^(.*)-(\d+)$/.exec(target);
      const lockPid = Number(match?.[2]) || 0;
      if (lockPid) pids.add(lockPid);
    }
  }

  const killed = [];
  for (const pid of pids) {
    if (killPid(pid)) killed.push(pid);
  }

  // Belt and suspenders: pkill by binary / profile path.
  await pkillPattern('.cloakbrowser/chromium');
  await pkillPattern('cloakbrowser/chromium');
  if (profileRoot) await pkillPattern(profileRoot);

  return killed;
}

/** Remove Chromium Singleton* files under the profile root. */
export async function clearCloakProfileLocks(profileRoot) {
  if (!profileRoot) return 0;
  let cleared = 0;
  const sessions = await fsp.readdir(profileRoot).catch(() => []);
  for (const name of sessions) {
    const dir = path.join(profileRoot, name);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(dir, file);
      const existed = await fsp.access(p).then(() => true, () => false);
      if (!existed) continue;
      await fsp.rm(p, { force: true }).catch(() => {});
      cleared += 1;
    }
  }
  return cleared;
}
