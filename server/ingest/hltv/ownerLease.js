import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const OWNER_HEARTBEAT_MS = 2_000;
export const OWNER_STALE_MS = 30_000;

const ownerDir = (cfg) => path.join(cfg.stateDir, 'ingest-owners');
const safeToken = (token) => String(token || '').replace(/[^a-zA-Z0-9_-]/g, '');
const ownerFile = (cfg, token) => path.join(ownerDir(cfg), `${safeToken(token)}.json`);

async function atomicWrite(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

export async function writeOwnerHeartbeat(cfg, { token, pid = process.pid, host = os.hostname() }) {
  if (!safeToken(token)) throw new Error('Ingest owner token is required');
  const owner = {
    token: safeToken(token),
    pid: Number(pid) || 0,
    host: String(host || ''),
    heartbeatAt: new Date().toISOString()
  };
  await atomicWrite(ownerFile(cfg, owner.token), owner);
  return owner;
}

export async function removeOwner(cfg, token) {
  if (!safeToken(token)) return;
  await fsp.rm(ownerFile(cfg, token), { force: true }).catch(() => {});
}

export async function readOwners(cfg) {
  const dir = ownerDir(cfg);
  const names = await fsp.readdir(dir).catch(() => []);
  const owners = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (owner?.token && owner?.pid && owner?.host && owner?.heartbeatAt) owners.push(owner);
    } catch {
      /* partial or stale owner file */
    }
  }
  return owners;
}

export function ownerIsFresh(
  owner,
  { now = Date.now(), host = os.hostname(), localAlive } = {}
) {
  if (!owner?.pid || !owner?.heartbeatAt) return false;
  if (owner.host === host && typeof localAlive === 'function') {
    return Boolean(localAlive(owner.pid));
  }
  const heartbeat = Date.parse(owner.heartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat <= OWNER_STALE_MS;
}

/**
 * Return the newest live owner across all container PID namespaces.
 * Stale token files are removed opportunistically.
 */
export async function findLiveOwner(cfg, options = {}) {
  const owners = await readOwners(cfg);
  const live = [];
  for (const owner of owners) {
    if (ownerIsFresh(owner, options)) live.push(owner);
    else await removeOwner(cfg, owner.token);
  }
  live.sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt));
  return live[0] || null;
}
