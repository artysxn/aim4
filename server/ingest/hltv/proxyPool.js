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

/**
 * Last-resort exit IP when the public pool is all challenged / dead.
 * Used after 3 consecutive transport failures in one download/page attempt.
 */
export const DEFAULT_FALLBACK_PROXY = 'http://130.17.12.137:3128';

const DEFAULT_SETTINGS = { attempts: 5, random: true };
const VERIFY_TIMEOUT_MS = 10_000;
const REFRESH_CANDIDATES = 40;
const REFRESH_CONCURRENCY = 8;

const settingsPath = (cfg) => path.join(cfg.stateDir, 'proxy-settings.json');
const workingPath = (cfg) => path.join(cfg.stateDir, 'working-proxies.json');
const cachePath = (cfg) => path.join(cfg.stateDir, 'proxy-cache.json');
const refreshPath = (cfg) => path.join(cfg.stateDir, 'proxy-refresh.json');

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

/**
 * Accept full proxy URLs or bare `host:port` (assumed http).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return isSupportedProxy(withScheme) ? withScheme : '';
}

export function parseProxyLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\n,\r]+/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const line = normalizeProxyUrl(trimmed);
    if (!line) continue;
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

async function writeWorkingProxies(cfg, list) {
  await atomicWrite(workingPath(cfg), list);
}

export async function recordWorkingProxy(cfg, { url, exitIp = '', country = '' } = {}) {
  if (!url || !isSupportedProxy(url)) return;
  const list = await readWorkingProxies(cfg);
  const now = new Date().toISOString();
  const idx = list.findIndex((e) => e.url === url);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      exitIp: exitIp || list[idx].exitIp || '',
      country: country || list[idx].country || '',
      lastOkAt: now,
      fails: 0
    };
  } else {
    list.unshift({
      url,
      exitIp: exitIp || '',
      country: country || '',
      verifiedAt: now,
      lastOkAt: now,
      fails: 0
    });
  }
  // Cap stored winners so the file stays small.
  await writeWorkingProxies(cfg, list.slice(0, 200));
}

export async function markProxyFailed(cfg, url) {
  if (!url) return;
  const list = await readWorkingProxies(cfg);
  const idx = list.findIndex((e) => e.url === url);
  if (idx < 0) return;
  const fails = (list[idx].fails || 0) + 1;
  if (fails >= 3) list.splice(idx, 1);
  else list[idx] = { ...list[idx], fails };
  await writeWorkingProxies(cfg, list);
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
 * Exclusive pin mode ignores the admin attempts/random file so we never log
 * "attempts=5, order=random" while only one exit is allowed.
 */
export async function applyProxySettings(cfg) {
  const only =
    cfg.cloakProxyOnly !== undefined
      ? Boolean(cfg.cloakProxyOnly)
      : !/^(0|false|no|off)$/i.test(process.env.AIM4_CLOAK_PROXY_ONLY || 'true');
  if (only) {
    cfg.cloakProxyAttempts = 1;
    cfg.cloakProxyRandom = false;
    return {
      cfg,
      settings: { attempts: 1, random: false, updatedAt: null, fromFile: false, pinned: true }
    };
  }
  const settings = await readProxySettings(cfg);
  cfg.cloakProxyAttempts = settings.attempts;
  cfg.cloakProxyRandom = settings.random;
  return { cfg, settings };
}

/**
 * Pool order: working winners, optional AIM4_CLOAK_PROXY, last fetch cache, file.
 * When cloakProxyOnly is set (default), return only the office pin.
 */
export async function loadProxyPool(cfg = {}) {
  const only =
    cfg.cloakProxyOnly !== undefined
      ? Boolean(cfg.cloakProxyOnly)
      : !/^(0|false|no|off)$/i.test(process.env.AIM4_CLOAK_PROXY_ONLY || 'true');
  if (only) {
    const pin =
      normalizeProxyUrl(
        cfg.cloakPinProxy ||
          process.env.AIM4_CLOAK_PIN_PROXY ||
          DEFAULT_FALLBACK_PROXY
      ) || DEFAULT_FALLBACK_PROXY;
    return [pin];
  }

  const single = normalizeProxyUrl(cfg.cloakProxy || process.env.AIM4_CLOAK_PROXY || '');

  const chunks = [];
  const working = await readWorkingProxies(cfg);
  chunks.push(...working.map((e) => e.url));

  if (single) chunks.push(single);
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
  return parseProxyLines(chunks.join('\n'));
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
    const byUrl = new Map(existing.map((e) => [e.url, e]));
    for (const w of winners) {
      const prev = byUrl.get(w.url);
      byUrl.set(w.url, prev ? { ...prev, ...w, fails: 0 } : w);
    }
    const merged = [...byUrl.values()].sort((a, b) =>
      String(b.lastOkAt || '').localeCompare(String(a.lastOkAt || ''))
    );
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
  const [settings, working, cache, refresh] = await Promise.all([
    readProxySettings(cfg),
    readWorkingProxies(cfg),
    readCache(cfg),
    readRefreshState(cfg)
  ]);
  return {
    settings,
    workingCount: working.length,
    working: working.slice(0, 40).map((e) => ({
      host: redactProxy(e.url),
      country: e.country || '',
      exitIp: e.exitIp || '',
      lastOkAt: e.lastOkAt || e.verifiedAt || null
    })),
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
