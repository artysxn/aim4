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
/**
 * After this many unique exits have a measured HLTV download speed (ok or slow),
 * rotate among the PROXY_BEST_ROTATION fastest non-CF winners only.
 */
export const PROXY_TEST_TARGET = 40;
/** Final rotation size once PROXY_TEST_TARGET exits are scored. */
export const PROXY_BEST_ROTATION = 5;
/** @deprecated Use PROXY_BEST_ROTATION. Kept for older imports. */
export const CONFIRMED_ROTATION_SIZE = PROXY_BEST_ROTATION;
/** Abort + try another exit when sustained download rate is below this. */
export const MIN_DOWNLOAD_SPEED_BPS = 20 * 1024 * 1024;
/**
 * A confirmed HLTV download at/above this speed with no CF becomes the sticky
 * exit: reuse it for every following demo until it fails.
 */
export const STICKY_MIN_MBPS = 25;
/** Max slow-proxy aborts per download before giving up on speed failover. */
export const PROXY_SPEED_ATTEMPTS = 3;
/** Wait this long into the transfer phase before judging download speed. */
export const SPEED_WARMUP_MS = 5_000;

const settingsPath = (cfg) => path.join(cfg.stateDir, 'proxy-settings.json');
const workingPath = (cfg) => path.join(cfg.stateDir, 'working-proxies.json');
const cachePath = (cfg) => path.join(cfg.stateDir, 'proxy-cache.json');
const refreshPath = (cfg) => path.join(cfg.stateDir, 'proxy-refresh.json');
const blacklistPath = (cfg) => path.join(cfg.stateDir, 'proxy-blacklist.json');
const graylistPath = (cfg) => path.join(cfg.stateDir, 'proxy-graylist.json');

export function downloadSpeedBps(bytes, elapsedMs) {
  const b = Number(bytes) || 0;
  const ms = Number(elapsedMs) || 0;
  if (b <= 0 || ms <= 0) return 0;
  return (b * 1000) / ms;
}

export function mbpsFromBps(bps) {
  return (Number(bps) || 0) / (1024 * 1024);
}

/**
 * Rolling MB/s from progress samples (same data as ingest log lines
 * `29s · 200.0 MB` → `30s · 205.0 MB` → ~5 MB/s deltas).
 *
 * Does not touch CloakBrowser internals; callers feed download-progress events.
 */
export function createProgressSpeedMonitor({
  minMbps = MIN_DOWNLOAD_SPEED_BPS / (1024 * 1024),
  minSamples = 3,
  minElapsedMs = SPEED_WARMUP_MS,
  maxSamples = 12
} = {}) {
  /** @type {{ t: number, bytes: number }[]} */
  const samples = [];

  function ratesMbps() {
    const rates = [];
    for (let i = 1; i < samples.length; i++) {
      const dtSec = (samples[i].t - samples[i - 1].t) / 1000;
      const dBytes = samples[i].bytes - samples[i - 1].bytes;
      if (dtSec <= 0 || dBytes < 0) continue;
      rates.push(dBytes / dtSec / (1024 * 1024));
    }
    return rates;
  }

  function averageMbps() {
    const rates = ratesMbps();
    if (!rates.length) {
      if (samples.length < 2) return null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dtSec = (last.t - first.t) / 1000;
      if (dtSec <= 0) return null;
      return (last.bytes - first.bytes) / dtSec / (1024 * 1024);
    }
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  return {
    sample(p = {}) {
      const phase = String(p.phase || '');
      if (phase && phase !== 'browser' && phase !== 'copy') return null;
      const bytes = Number(p.received) || 0;
      const t = Number(p.elapsedMs) || 0;
      if (bytes <= 0 || t <= 0) return null;
      const last = samples[samples.length - 1];
      if (last && last.t === t && last.bytes === bytes) return null;
      samples.push({ t, bytes });
      if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);

      const rates = ratesMbps();
      if (rates.length < minSamples) return null;
      if (samples[samples.length - 1].t < minElapsedMs) return null;
      const mbps = rates.reduce((a, b) => a + b, 0) / rates.length;
      return { tooSlow: mbps < minMbps, mbps };
    },
    averageMbps,
    sampleCount: () => samples.length
  };
}

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
 * Exits that completed a real HLTV download without Cloudflare (speed-ranked).
 * Blacklisted urls are omitted.
 */
export async function readConfirmedProxies(cfg) {
  const blocked = await readProxyBlacklist(cfg);
  const list = await readWorkingProxies(cfg);
  return list
    .filter((e) => e.confirmed && !blocked.has(e.url))
    .sort((a, b) => (Number(b.mbps) || 0) - (Number(a.mbps) || 0));
}

/** Unique exits that have a measured HLTV download speed (ok or slow abort). */
export async function readTestedProxies(cfg) {
  const blocked = await readProxyBlacklist(cfg);
  const list = await readWorkingProxies(cfg);
  return list
    .filter((e) => e.tested && !blocked.has(e.url))
    .sort((a, b) => (Number(b.mbps) || 0) - (Number(a.mbps) || 0));
}

/**
 * Best non-CF download winners by measured MB/s.
 * Prefers `confirmed` (full archive) over slow-only measurements.
 */
export function rankBestProxies(list, { limit = PROXY_BEST_ROTATION, confirmedOnly = false } = {}) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((e) => e?.url && isSupportedProxy(e.url))
    .filter((e) => (confirmedOnly ? e.confirmed : e.tested || e.confirmed))
    .slice()
    .sort((a, b) => {
      const conf = Number(Boolean(b.confirmed)) - Number(Boolean(a.confirmed));
      if (conf) return conf;
      return (Number(b.mbps) || 0) - (Number(a.mbps) || 0);
    });
  return rows.slice(0, Math.max(0, limit));
}

export async function readBestProxies(cfg, limit = PROXY_BEST_ROTATION) {
  const blocked = await readProxyBlacklist(cfg);
  const list = (await readWorkingProxies(cfg)).filter((e) => !blocked.has(e.url));
  return rankBestProxies(list, { limit, confirmedOnly: true });
}

async function writeWorkingProxies(cfg, list) {
  await atomicWrite(workingPath(cfg), list);
}

/**
 * Once enough exits are scored, keep only the top PROXY_BEST_ROTATION as
 * `confirmed` for rotation. Before that, leave all confirmed flags alone.
 */
function applyBestRotation(list, { testTarget = PROXY_TEST_TARGET, bestSize = PROXY_BEST_ROTATION } = {}) {
  const tested = list.filter((e) => e.tested || e.confirmed);
  if (tested.length < testTarget) return list;
  const keep = new Set(
    rankBestProxies(list, { limit: bestSize, confirmedOnly: true }).map((e) => e.url)
  );
  // Sticky fast exits always stay in the rotation set.
  for (const e of list) {
    if (e.sticky) keep.add(e.url);
  }
  // If fewer than `bestSize` full successes, fill from speed-tested rows.
  if (keep.size < bestSize) {
    for (const e of rankBestProxies(list, { limit: bestSize, confirmedOnly: false })) {
      keep.add(e.url);
      if (keep.size >= bestSize) break;
    }
  }
  return list.map((e) => ({
    ...e,
    confirmed: keep.has(e.url),
    rotation: keep.has(e.url)
  }));
}

export function isStickySpeed(mbps, min = STICKY_MIN_MBPS) {
  return (Number(mbps) || 0) >= min;
}

/** Current sticky fast exit, if any (not blacklisted). */
export async function readStickyProxy(cfg) {
  const blocked = await readProxyBlacklist(cfg);
  const list = await readWorkingProxies(cfg);
  return (
    list.find(
      (e) =>
        e.sticky &&
        e.confirmed &&
        !blocked.has(e.url) &&
        isStickySpeed(e.mbps)
    ) || null
  );
}

export async function clearStickyProxy(cfg, url = null) {
  const list = await readWorkingProxies(cfg);
  let dirty = false;
  const next = list.map((e) => {
    if (!e.sticky) return e;
    if (url && e.url !== url) return e;
    dirty = true;
    return { ...e, sticky: false };
  });
  if (dirty) await writeWorkingProxies(cfg, next);
}

function normalizeMbps(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Record a proxy after an HLTV download attempt with a measured speed.
 * Successful archives set confirmed; slow aborts set tested + graylist separately.
 */
export async function recordWorkingProxy(
  cfg,
  { url, exitIp = '', country = '', confirmed = true, mbps = null, tested = true } = {}
) {
  if (!url || !isSupportedProxy(url)) return null;
  // A just-successful exit must not stay blacklisted or graylisted.
  await clearProxyBlacklist(cfg, url).catch(() => {});
  if (confirmed) await clearProxyGraylist(cfg, url).catch(() => {});
  const list = await readWorkingProxies(cfg);
  const now = new Date().toISOString();
  const speed = normalizeMbps(mbps);
  const idx = list.findIndex((e) => e.url === url);
  const effectiveMbps =
    speed != null
      ? Math.max(speed, idx >= 0 ? Number(list[idx].mbps) || 0 : 0)
      : idx >= 0
        ? list[idx].mbps || null
        : null;
  const makeSticky = Boolean(confirmed && isStickySpeed(effectiveMbps));

  if (idx >= 0) {
    const prev = list[idx];
    list[idx] = {
      ...prev,
      exitIp: exitIp || prev.exitIp || '',
      country: country || prev.country || '',
      lastOkAt: confirmed ? now : prev.lastOkAt || now,
      fails: confirmed ? 0 : prev.fails || 0,
      confirmed: Boolean(confirmed || prev.confirmed),
      tested: Boolean(tested || prev.tested || speed != null),
      testedAt: tested || speed != null ? now : prev.testedAt || null,
      mbps: effectiveMbps,
      sticky: makeSticky ? true : confirmed ? false : Boolean(prev.sticky)
    };
  } else {
    list.push({
      url,
      exitIp: exitIp || '',
      country: country || '',
      verifiedAt: now,
      lastOkAt: confirmed ? now : null,
      fails: 0,
      confirmed: Boolean(confirmed),
      tested: Boolean(tested || speed != null),
      testedAt: now,
      mbps: speed,
      sticky: makeSticky
    });
  }
  // Only one sticky exit at a time.
  if (makeSticky) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].url !== url && list[i].sticky) list[i] = { ...list[i], sticky: false };
    }
  }
  const next = applyBestRotation(list);
  await writeWorkingProxies(cfg, next.slice(0, 200));
  const sticky = next.find((e) => e.sticky) || null;
  return {
    testedCount: next.filter((e) => e.tested || e.confirmed).length,
    best: rankBestProxies(next, { limit: PROXY_BEST_ROTATION, confirmedOnly: true }),
    sticky
  };
}

/**
 * Gray-list: skip while untested exits remain; reusable once discovery is exhausted.
 * @returns {Promise<Map<string, { mbps: number|null, at: string, reason: string }>>}
 */
export async function readProxyGraylist(cfg) {
  try {
    const parsed = JSON.parse(await fsp.readFile(graylistPath(cfg), 'utf8'));
    const raw = Array.isArray(parsed?.entries) ? parsed.entries : Array.isArray(parsed) ? parsed : [];
    const map = new Map();
    for (const entry of raw) {
      const url = String(entry?.url || '');
      if (!url || !isSupportedProxy(url)) continue;
      map.set(url, {
        mbps: normalizeMbps(entry.mbps),
        at: entry.at || null,
        reason: entry.reason || 'slow'
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function writeProxyGraylist(cfg, map) {
  const entries = [...map.entries()]
    .map(([url, meta]) => ({
      url,
      mbps: meta?.mbps ?? null,
      at: meta?.at || null,
      reason: meta?.reason || 'slow'
    }))
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  await atomicWrite(graylistPath(cfg), {
    updatedAt: new Date().toISOString(),
    entries
  });
}

export async function clearProxyGraylist(cfg, url) {
  if (!url) return;
  const map = await readProxyGraylist(cfg);
  if (!map.delete(url)) return;
  await writeProxyGraylist(cfg, map);
}

/**
 * Mark a slow-but-valid exit. Skipped while untested proxies remain in the pool.
 */
export async function graylistProxy(cfg, url, { mbps = null, reason = 'slow' } = {}) {
  if (!url || !isSupportedProxy(url)) return null;
  const map = await readProxyGraylist(cfg);
  const at = new Date().toISOString();
  const speed = normalizeMbps(mbps);
  map.set(url, { mbps: speed, at, reason: reason || 'slow' });
  await writeProxyGraylist(cfg, map);
  // Persist the measurement so it counts toward the 40-tested target.
  await recordWorkingProxy(cfg, {
    url,
    confirmed: false,
    tested: true,
    mbps: speed
  }).catch(() => {});
  return { url, mbps: speed, at, reason: reason || 'slow' };
}

/**
 * Pick order for discovery vs locked top-N rotation.
 * Gray-listed urls are omitted while any non-gray untested candidate exists.
 */
export function filterPoolForPick(pool, {
  used = new Set(),
  gray = new Set(),
  tested = new Set(),
  best = [],
  sticky = null,
  rotationOnly = false
} = {}) {
  const available = (Array.isArray(pool) ? pool : []).filter((p) => p && !used.has(p));
  if (!available.length) return [];

  // Fast clean exit: pin to it until it fails (CF / slow / dead).
  if (sticky && available.includes(sticky)) return [sticky];

  if (rotationOnly && best.length) {
    const avail = new Set(available);
    const fromBest = best.filter((p) => avail.has(p));
    if (fromBest.length) return fromBest;
    return available.filter((p) => tested.has(p));
  }

  const fresh = available.filter((p) => !gray.has(p) && !tested.has(p));
  if (fresh.length) return fresh;
  const ungayed = available.filter((p) => !gray.has(p));
  if (ungayed.length) return ungayed;
  // Nothing better left: return to the gray list.
  return available;
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
 * Pool order: best confirmed winners, other working, optional AIM4_CLOAK_PROXY,
 * last fetch cache, file. Blacklisted exits (24h) are omitted entirely.
 *
 * When `testedCount >= PROXY_TEST_TARGET`, callers should rotate among the top
 * PROXY_BEST_ROTATION by MB/s only.
 */
export async function loadProxyPool(cfg = {}) {
  const blocked = await readProxyBlacklist(cfg);
  const working = await readWorkingProxies(cfg);
  const sticky = working.find(
    (e) => e.sticky && e.confirmed && !blocked.has(e.url) && isStickySpeed(e.mbps)
  );
  const best = rankBestProxies(
    working.filter((e) => !blocked.has(e.url) && e.url !== sticky?.url),
    { limit: PROXY_BEST_ROTATION, confirmedOnly: true }
  );
  const bestSet = new Set(best.map((e) => e.url));
  if (sticky) bestSet.add(sticky.url);
  const otherWorking = working.filter((e) => !blocked.has(e.url) && !bestSet.has(e.url));

  const chunks = [];
  if (sticky) chunks.push(sticky.url);
  chunks.push(...best.map((e) => e.url));
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

/** How many confirmed best exits are currently eligible for the rotation set. */
export async function confirmedRotationCount(cfg) {
  return (await readBestProxies(cfg, PROXY_BEST_ROTATION)).length;
}

export async function testedProxyCount(cfg) {
  return (await readTestedProxies(cfg)).length;
}

/** Format a short leaderboard for ingest.log. */
export function formatBestProxyLog(best, { testedCount = 0, target = PROXY_TEST_TARGET } = {}) {
  const lines = [
    `Best proxies (no CF, by MB/s): tested ${testedCount}/${target}` +
      (testedCount >= target ? ` · rotating top ${PROXY_BEST_ROTATION}` : '')
  ];
  if (!best?.length) {
    lines.push('  (none yet)');
    return lines.join('\n');
  }
  best.forEach((e, i) => {
    const speed = Number(e.mbps);
    const speedText = Number.isFinite(speed) ? `${speed.toFixed(1)} MB/s` : '? MB/s';
    lines.push(`  ${i + 1}. ${redactProxy(e.url)} ${speedText}`);
  });
  return lines.join('\n');
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
  const [settings, working, cache, refresh, blacklist, graylist, tested] = await Promise.all([
    readProxySettings(cfg),
    readWorkingProxies(cfg),
    readCache(cfg),
    readRefreshState(cfg),
    readProxyBlacklist(cfg),
    readProxyGraylist(cfg),
    readTestedProxies(cfg)
  ]);
  const blacklisted = [...blacklist.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 40)
    .map(([url, untilMs]) => ({
      host: redactProxy(url),
      untilAt: new Date(untilMs).toISOString()
    }));
  const eligible = working.filter((e) => !blacklist.has(e.url));
  const rotation = rankBestProxies(eligible, {
    limit: PROXY_BEST_ROTATION,
    confirmedOnly: true
  });
  const testedCount = tested.length;
  const rotationOnly = testedCount >= PROXY_TEST_TARGET;
  const sticky = eligible.find((e) => e.sticky && isStickySpeed(e.mbps)) || null;
  return {
    settings,
    workingCount: working.length,
    confirmedCount: rotation.length,
    testedCount,
    testTarget: PROXY_TEST_TARGET,
    rotationSize: PROXY_BEST_ROTATION,
    rotationOnly,
    minSpeedMbps: MIN_DOWNLOAD_SPEED_BPS / (1024 * 1024),
    stickyMinMbps: STICKY_MIN_MBPS,
    sticky: sticky
      ? {
          host: redactProxy(sticky.url),
          mbps: sticky.mbps ?? null,
          lastOkAt: sticky.lastOkAt || sticky.verifiedAt || null
        }
      : null,
    confirmed: rotation.map((e) => ({
      host: redactProxy(e.url),
      country: e.country || '',
      exitIp: e.exitIp || '',
      mbps: e.mbps ?? null,
      sticky: Boolean(e.sticky),
      lastOkAt: e.lastOkAt || e.verifiedAt || null
    })),
    best: rankBestProxies(eligible, { limit: 10, confirmedOnly: false }).map((e) => ({
      host: redactProxy(e.url),
      mbps: e.mbps ?? null,
      confirmed: Boolean(e.confirmed),
      tested: Boolean(e.tested)
    })),
    working: working.slice(0, 40).map((e) => ({
      host: redactProxy(e.url),
      country: e.country || '',
      exitIp: e.exitIp || '',
      mbps: e.mbps ?? null,
      lastOkAt: e.lastOkAt || e.verifiedAt || null,
      confirmed: Boolean(e.confirmed),
      tested: Boolean(e.tested)
    })),
    blacklistCount: blacklist.size,
    blacklistTtlMs: blacklistTtlMs(cfg),
    blacklisted,
    graylistCount: graylist.size,
    graylisted: [...graylist.entries()].slice(0, 40).map(([url, meta]) => ({
      host: redactProxy(url),
      mbps: meta?.mbps ?? null,
      at: meta?.at || null
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
