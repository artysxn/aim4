// ---------------------------------------------------------------------------
// server/ingest/hltv/proxyPool.js
// Download, verify, and persist CloakBrowser proxies for HLTV transport.
//
// Source: https://stormsia.github.io/proxy-list/proxies.json
// Verify: https://httpbin.org/ip through each candidate before promoting it.
// Settings and working proxies live under stateDir (volume-backed).
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export const PROXIES_JSON_URL = 'https://stormsia.github.io/proxy-list/proxies.json';
export const VERIFY_URL = 'https://httpbin.org/ip';

const DEFAULT_SETTINGS = { attempts: 5, random: true };
const VERIFY_TIMEOUT_MS = 10_000;
const REFRESH_CANDIDATES = 40;
const REFRESH_CONCURRENCY = 8;
/** Dead exits stay out of the pool at least this long (Cloudflare burns). */
export const PROXY_BLACKLIST_TTL_MS = 24 * 60 * 60 * 1000;
/** Once this many exits have survived a real HLTV download, rotate among them only. */
export const CONFIRMED_ROTATION_SIZE = 6;

const settingsPath = (cfg) => path.join(cfg.stateDir, 'proxy-settings.json');
const workingPath = (cfg) => path.join(cfg.stateDir, 'working-proxies.json');
const cachePath = (cfg) => path.join(cfg.stateDir, 'proxy-cache.json');
const refreshPath = (cfg) => path.join(cfg.stateDir, 'proxy-refresh.json');
const blacklistPath = (cfg) => path.join(cfg.stateDir, 'proxy-blacklist.json');

function blacklistTtlMs(cfg = {}) {
  const raw = Number(cfg.cloakProxyBlacklistMs ?? process.env.AIM4_CLOAK_PROXY_BLACKLIST_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return PROXY_BLACKLIST_TTL_MS;
}

async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

export function proxyUrlFromEntry(entry) {
  const protocol = String(entry?.protocol || '').toLowerCase();
  const host = String(entry?.host || '').trim();
  const port = Number(entry?.port);
  if (!host || !Number.isFinite(port)) return '';
  if (protocol !== 'http' && protocol !== 'https' && protocol !== 'socks5') return '';
  return `${protocol}://${host}:${port}`;
}

/** CloakBrowser / Playwright: http(s) and socks5. socks4 is skipped. */
export function isSupportedProxy(proxy) {
  try {
    const scheme = new URL(proxy).protocol.replace(/:$/, '').toLowerCase();
    return scheme === 'http' || scheme === 'https' || scheme === 'socks5';
  } catch {
    return false;
  }
}

export function parseProxyLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\n,\r]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!isSupportedProxy(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export function redactProxy(proxy) {
  if (!proxy) return '';
  try {
    const u = new URL(proxy);
    return u.host || String(proxy);
  } catch {
    return String(proxy).replace(/^[^@]*@/, '');
  }
}

export async function readProxySettings(cfg) {
  try {
    const raw = JSON.parse(await fsp.readFile(settingsPath(cfg), 'utf8'));
    const attempts = Math.max(1, Math.min(50, Number(raw.attempts) || DEFAULT_SETTINGS.attempts));
    const random = raw.random === undefined ? DEFAULT_SETTINGS.random : Boolean(raw.random);
    return { attempts, random, updatedAt: raw.updatedAt || null, fromFile: true };
  } catch {
    return {
      attempts: Math.max(1, Math.min(50, Number(cfg.cloakProxyAttempts) || DEFAULT_SETTINGS.attempts)),
      random:
        cfg.cloakProxyRandom === undefined
          ? DEFAULT_SETTINGS.random
          : Boolean(cfg.cloakProxyRandom),
      updatedAt: null,
      fromFile: false
    };
  }
}

export async function writeProxySettings(cfg, patch = {}) {
  const current = await readProxySettings(cfg);
  const next = {
    attempts: Math.max(
      1,
      Math.min(50, Number(patch.attempts ?? current.attempts) || DEFAULT_SETTINGS.attempts)
    ),
    random:
      patch.random === undefined ? current.random : Boolean(patch.random),
    updatedAt: new Date().toISOString()
  };
  await atomicWrite(settingsPath(cfg), next);
  return next;
}

export async function readWorkingProxies(cfg) {
  try {
    const raw = JSON.parse(await fsp.readFile(workingPath(cfg), 'utf8'));
    return Array.isArray(raw) ? raw.filter((e) => e?.url && isSupportedProxy(e.url)) : [];
  } catch {
    return [];
  }
}

/**
 * Exits that have completed a real HLTV download (not merely httpbin verify).
 * Blacklisted urls are omitted.
 */
export async function readConfirmedProxies(cfg) {
  const blocked = await readProxyBlacklist(cfg);
  const list = await readWorkingProxies(cfg);
  return list
    .filter((e) => e.confirmed && !blocked.has(e.url))
    .sort((a, b) => String(b.lastOkAt || '').localeCompare(String(a.lastOkAt || '')));
}

async function writeWorkingProxies(cfg, list) {
  await atomicWrite(workingPath(cfg), list);
}

/**
 * Trim confirmed flags so at most CONFIRMED_ROTATION_SIZE stay confirmed.
 * Newest lastOkAt wins.
 */
function capConfirmed(list, size = CONFIRMED_ROTATION_SIZE) {
  const confirmed = list
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.confirmed);
  if (confirmed.length <= size) return list;
  confirmed.sort((a, b) =>
    String(b.e.lastOkAt || '').localeCompare(String(a.e.lastOkAt || ''))
  );
  const keep = new Set(confirmed.slice(0, size).map(({ e }) => e.url));
  return list.map((e) => (e.confirmed && !keep.has(e.url) ? { ...e, confirmed: false } : e));
}

/**
 * Record a proxy that successfully fetched an HLTV archive.
 * `confirmed: true` (default) counts toward the 6-exit rotation set.
 */
export async function recordWorkingProxy(
  cfg,
  { url, exitIp = '', country = '', confirmed = true } = {}
) {
  if (!url || !isSupportedProxy(url)) return;
  // A just-successful exit must not stay blacklisted.
  await clearProxyBlacklist(cfg, url).catch(() => {});
  const list = await readWorkingProxies(cfg);
  const now = new Date().toISOString();
  const idx = list.findIndex((e) => e.url === url);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      exitIp: exitIp || list[idx].exitIp || '',
      country: country || list[idx].country || '',
      lastOkAt: now,
      fails: 0,
      confirmed: Boolean(confirmed || list[idx].confirmed)
    };
  } else {
    list.push({
      url,
      exitIp: exitIp || '',
      country: country || '',
      verifiedAt: now,
      lastOkAt: now,
      fails: 0,
      confirmed: Boolean(confirmed)
    });
  }
  const next = capConfirmed(list, CONFIRMED_ROTATION_SIZE);
  // Cap stored winners so the file stays small. Do not reorder to the front:
  // that made every demo reopen on the same exit and burn reputation.
  await writeWorkingProxies(cfg, next.slice(0, 200));
}

/**
 * Active blacklist map: proxy url -> epoch ms when it may be tried again.
 * Expired rows are pruned on read.
 * @returns {Promise<Map<string, number>>}
 */
export async function readProxyBlacklist(cfg) {
  const now = Date.now();
  let raw = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(blacklistPath(cfg), 'utf8'));
    raw = Array.isArray(parsed?.entries) ? parsed.entries : Array.isArray(parsed) ? parsed : [];
  } catch {
    return new Map();
  }
  const map = new Map();
  let dirty = false;
  for (const entry of raw) {
    const url = String(entry?.url || '');
    const until = Number(entry?.untilMs) || 0;
    if (!url || !isSupportedProxy(url) || until <= now) {
      dirty = true;
      continue;
    }
    map.set(url, until);
  }
  if (dirty) await writeProxyBlacklist(cfg, map).catch(() => {});
  return map;
}

async function writeProxyBlacklist(cfg, map) {
  const entries = [...map.entries()]
    .map(([url, untilMs]) => ({ url, untilMs }))
    .sort((a, b) => a.untilMs - b.untilMs);
  await atomicWrite(blacklistPath(cfg), {
    updatedAt: new Date().toISOString(),
    entries
  });
}

/** Drop one url from the blacklist (e.g. after a later success). */
export async function clearProxyBlacklist(cfg, url) {
  if (!url) return;
  const map = await readProxyBlacklist(cfg);
  if (!map.delete(url)) return;
  await writeProxyBlacklist(cfg, map);
}

/**
 * Temporarily ban an exit. Default TTL is 24h.
 * Also removes it from the preferred working list.
 */
export async function blacklistProxy(
  cfg,
  url,
  { reason = '', ttlMs = blacklistTtlMs(cfg) } = {}
) {
  if (!url || !isSupportedProxy(url)) return null;
  const map = await readProxyBlacklist(cfg);
  const untilMs = Date.now() + Math.max(60_000, Number(ttlMs) || PROXY_BLACKLIST_TTL_MS);
  map.set(url, untilMs);
  await writeProxyBlacklist(cfg, map);

  const list = await readWorkingProxies(cfg);
  const next = list.filter((e) => e.url !== url);
  if (next.length !== list.length) await writeWorkingProxies(cfg, next);

  return {
    url,
    untilMs,
    untilAt: new Date(untilMs).toISOString(),
    reason: reason || null
  };
}

/**
 * @param {object} cfg
 * @param {string} url
 * @param {{ hard?: boolean, reason?: string }} [opts]
 *   hard=true (Cloudflare / blocked) → 24h blacklist.
 *   Soft fails still need three strikes, then blacklist.
 * @returns {Promise<{ blacklisted: boolean }>}
 */
export async function markProxyFailed(cfg, url, { hard = false, reason = '' } = {}) {
  if (!url) return { blacklisted: false };
  if (hard) {
    await blacklistProxy(cfg, url, { reason: reason || 'hard-fail' });
    return { blacklisted: true };
  }
  const list = await readWorkingProxies(cfg);
  const idx = list.findIndex((e) => e.url === url);
  if (idx < 0) {
    // Cache/pool exit that never made preferred: still ban on hard only.
    // Soft transport flakes on unproven exits are handled by `used` per attempt.
    return { blacklisted: false };
  }
  const fails = (list[idx].fails || 0) + 1;
  if (fails >= 3) {
    await blacklistProxy(cfg, url, { reason: reason || 'soft-fail-x3' });
    return { blacklisted: true };
  }
  list[idx] = { ...list[idx], fails };
  await writeWorkingProxies(cfg, list);
  return { blacklisted: false };
}

async function readCache(cfg) {
  try {
    const raw = JSON.parse(await fsp.readFile(cachePath(cfg), 'utf8'));
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return {
      fetchedAt: raw.fetchedAt || null,
      entries: entries.filter((e) => e?.url && isSupportedProxy(e.url))
    };
  } catch {
    return { fetchedAt: null, entries: [] };
  }
}

async function writeCache(cfg, entries) {
  await atomicWrite(cachePath(cfg), {
    fetchedAt: new Date().toISOString(),
    source: PROXIES_JSON_URL,
    entries
  });
}

export async function readRefreshState(cfg) {
  try {
    return JSON.parse(await fsp.readFile(refreshPath(cfg), 'utf8'));
  } catch {
    return { running: false };
  }
}

async function writeRefreshState(cfg, state) {
  await atomicWrite(refreshPath(cfg), state);
}

/**
 * Merge admin/env proxy settings into a config object (used by probe + session).
 */
export async function applyProxySettings(cfg) {
  const settings = await readProxySettings(cfg);
  cfg.cloakProxyAttempts = settings.attempts;
  cfg.cloakProxyRandom = settings.random;
  return { cfg, settings };
}

/**
 * Pool order: HLTV-confirmed winners, other working, optional AIM4_CLOAK_PROXY,
 * last fetch cache, file. Blacklisted exits (24h) are omitted entirely.
 *
 * When `confirmedCount >= CONFIRMED_ROTATION_SIZE`, callers should rotate among
 * the confirmed prefix only; the rest of the list is discovery fodder for when
 * the rotation set shrinks after a blacklist.
 */
export async function loadProxyPool(cfg = {}) {
  const blocked = await readProxyBlacklist(cfg);
  const working = await readWorkingProxies(cfg);
  const confirmed = working.filter((e) => e.confirmed && !blocked.has(e.url));
  const otherWorking = working.filter((e) => !e.confirmed && !blocked.has(e.url));

  const chunks = [];
  chunks.push(...confirmed.map((e) => e.url));
  chunks.push(...otherWorking.map((e) => e.url));

  const single = cfg.cloakProxy || process.env.AIM4_CLOAK_PROXY || '';
  if (single) chunks.push(...parseProxyLines(single));
  if (Array.isArray(cfg.cloakProxies)) {
    chunks.push(...parseProxyLines(cfg.cloakProxies.join('\n')));
  }

  const cache = await readCache(cfg);
  chunks.push(...cache.entries.map((e) => e.url));

  const file = cfg.cloakProxyFile || process.env.AIM4_CLOAK_PROXY_FILE || '';
  if (file) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    if (text) chunks.push(...parseProxyLines(text));
  }
  return parseProxyLines(chunks.join('\n')).filter((url) => !blocked.has(url));
}

/** How many confirmed exits are currently eligible for the rotation set. */
export async function confirmedRotationCount(cfg) {
  return (await readConfirmedProxies(cfg)).length;
}

export async function fetchRemoteProxies({ signal } = {}) {
  const res = await fetch(PROXIES_JSON_URL, {
    signal,
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Proxy list HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Proxy list JSON was not an array');
  const entries = [];
  const seen = new Set();
  for (const row of data) {
    const url = proxyUrlFromEntry(row);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    entries.push({
      url,
      protocol: String(row.protocol || '').toLowerCase(),
      timeout: Number(row.timeout) || 0,
      exitIp: row.exit_ip || '',
      country: row.geolocation?.country?.iso_code || '',
      city: row.geolocation?.city?.names?.en || '',
      asn: row.asn?.autonomous_system_organization || ''
    });
  }
  // Faster endpoints first; caller may shuffle afterward.
  entries.sort((a, b) => (a.timeout || 99) - (b.timeout || 99));
  return entries;
}

function agentForProxy(proxyUrl) {
  const scheme = new URL(proxyUrl).protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'socks5') return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Confirm the proxy can reach the public internet and report an exit IP.
 */
export function verifyProxy(proxyUrl, { timeoutMs = VERIFY_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const onAbort = () => done({ ok: false, error: 'cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });

    let agent;
    try {
      agent = agentForProxy(proxyUrl);
    } catch (err) {
      signal?.removeEventListener('abort', onAbort);
      done({ ok: false, error: err.message });
      return;
    }

    const req = https.get(
      VERIFY_URL,
      { agent, timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) req.destroy();
        });
        res.on('end', () => {
          signal?.removeEventListener('abort', onAbort);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            done({ ok: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          try {
            const json = JSON.parse(body);
            const exitIp = json.origin || json.ip || '';
            done({ ok: Boolean(exitIp), exitIp, error: exitIp ? '' : 'no exit IP' });
          } catch {
            done({ ok: false, error: 'bad JSON' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      signal?.removeEventListener('abort', onAbort);
      done({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      done({ ok: false, error: err.message });
    });
  });
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function mapPool(items, concurrency, worker) {
  const results = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

/**
 * Download the public list, cache it, verify a batch via httpbin, store winners.
 */
export async function refreshProxyPool(cfg, { onLog, signal } = {}) {
  const log = (msg) => {
    try {
      onLog?.(msg);
    } catch {
      /* ignore */
    }
  };

  const running = await readRefreshState(cfg);
  if (running.running) {
    return { busy: true, ...running };
  }

  const startedAt = new Date().toISOString();
  await writeRefreshState(cfg, {
    running: true,
    startedAt,
    phase: 'fetch',
    fetched: 0,
    verified: 0,
    failed: 0
  });

  try {
    log(`Fetching ${PROXIES_JSON_URL}`);
    const remote = await fetchRemoteProxies({ signal });
    await writeCache(cfg, remote);
    log(`Cached ${remote.length} http/socks5 proxies`);

    const candidates = shuffle(remote).slice(0, REFRESH_CANDIDATES);
    log(`Verifying ${candidates.length} via ${VERIFY_URL}`);
    await writeRefreshState(cfg, {
      running: true,
      startedAt,
      phase: 'verify',
      fetched: remote.length,
      verified: 0,
      failed: 0,
      candidates: candidates.length
    });

    let verified = 0;
    let failed = 0;
    const winners = [];
    await mapPool(candidates, REFRESH_CONCURRENCY, async (entry) => {
      if (signal?.aborted) return;
      const result = await verifyProxy(entry.url, { signal });
      if (result.ok) {
        verified++;
        winners.push({
          url: entry.url,
          exitIp: result.exitIp || entry.exitIp || '',
          country: entry.country || '',
          verifiedAt: new Date().toISOString(),
          lastOkAt: new Date().toISOString(),
          fails: 0
        });
        log(`OK ${redactProxy(entry.url)} exit ${result.exitIp || '?'}`);
      } else {
        failed++;
      }
      if ((verified + failed) % 5 === 0) {
        await writeRefreshState(cfg, {
          running: true,
          startedAt,
          phase: 'verify',
          fetched: remote.length,
          verified,
          failed,
          candidates: candidates.length
        });
      }
    });

    const existing = await readWorkingProxies(cfg);
    const blocked = await readProxyBlacklist(cfg);
    const byUrl = new Map(existing.map((e) => [e.url, e]));
    for (const w of winners) {
      if (blocked.has(w.url)) continue;
      const prev = byUrl.get(w.url);
      byUrl.set(w.url, prev ? { ...prev, ...w, fails: 0 } : w);
    }
    const merged = [...byUrl.values()]
      .filter((e) => !blocked.has(e.url))
      .sort((a, b) => String(b.lastOkAt || '').localeCompare(String(a.lastOkAt || '')));
    await writeWorkingProxies(cfg, merged.slice(0, 200));

    const done = {
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      phase: 'done',
      fetched: remote.length,
      verified,
      failed,
      working: merged.length,
      summary: `Verified ${verified}/${candidates.length}. Working pool: ${merged.length}.`
    };
    await writeRefreshState(cfg, done);
    log(done.summary);
    return done;
  } catch (err) {
    const failed = {
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      phase: 'error',
      error: err.message,
      summary: err.message
    };
    await writeRefreshState(cfg, failed);
    throw err;
  }
}

export async function proxyStatus(cfg) {
  const [settings, working, cache, refresh, blacklist, confirmed] = await Promise.all([
    readProxySettings(cfg),
    readWorkingProxies(cfg),
    readCache(cfg),
    readRefreshState(cfg),
    readProxyBlacklist(cfg),
    readConfirmedProxies(cfg)
  ]);
  const blacklisted = [...blacklist.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 40)
    .map(([url, untilMs]) => ({
      host: redactProxy(url),
      untilAt: new Date(untilMs).toISOString()
    }));
  const rotation = confirmed.slice(0, CONFIRMED_ROTATION_SIZE);
  return {
    settings,
    workingCount: working.length,
    confirmedCount: rotation.length,
    rotationSize: CONFIRMED_ROTATION_SIZE,
    rotationOnly: rotation.length >= CONFIRMED_ROTATION_SIZE,
    confirmed: rotation.map((e) => ({
      host: redactProxy(e.url),
      country: e.country || '',
      exitIp: e.exitIp || '',
      lastOkAt: e.lastOkAt || e.verifiedAt || null
    })),
    working: working.slice(0, 40).map((e) => ({
      host: redactProxy(e.url),
      country: e.country || '',
      exitIp: e.exitIp || '',
      lastOkAt: e.lastOkAt || e.verifiedAt || null,
      confirmed: Boolean(e.confirmed)
    })),
    blacklistCount: blacklist.size,
    blacklistTtlMs: blacklistTtlMs(cfg),
    blacklisted,
    cacheCount: cache.entries.length,
    cacheFetchedAt: cache.fetchedAt,
    refresh,
    source: PROXIES_JSON_URL,
    verifyUrl: VERIFY_URL
  };
}

/** In-process refresh so the admin API can return immediately and poll. */
let refreshJob = null;

export async function startProxyRefresh(cfg, { onLog } = {}) {
  const current = await readRefreshState(cfg);
  if (current.running || refreshJob) {
    return { started: false, busy: true, ...(await proxyStatus(cfg)) };
  }
  refreshJob = refreshProxyPool(cfg, { onLog })
    .catch((err) => {
      onLog?.(`Proxy refresh failed: ${err.message}`);
    })
    .finally(() => {
      refreshJob = null;
    });
  return { started: true, busy: false, ...(await proxyStatus(cfg)) };
}
