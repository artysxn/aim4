// ---------------------------------------------------------------------------
// server/ingest/hltv/cloakBrowser.js
// Shared CloakBrowser transport for discovery pages and demo downloads.
//
// The admin probe and the live ingester use this same layer so a successful
// probe measures the transport the pipeline will actually use.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { ensureBinary, launchContext, launchPersistentContext } from 'cloakbrowser';
import {
  applyProxySettings,
  DEFAULT_FALLBACK_PROXY,
  loadProxyPool,
  markProxyFailed,
  normalizeProxyUrl,
  readWorkingProxies,
  recordWorkingProxy,
  redactProxy
} from './proxyPool.js';
import { looksLikeMissingPage, pageTitle } from './classify.js';

export { parseProxyLines, loadProxyPool } from './proxyPool.js';

/** After this many consecutive pool failures, force the default fallback proxy. */
const FALLBACK_AFTER_CONSECUTIVE_FAILURES = 3;

const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_DEADLINE_MS = 30 * 60_000;
const DEFAULT_STALL_MS = 60_000;
let displayPromise = null;
let displayStarting = false;
let xvfbProcess = null;

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
};

const downloadsPathFor = (cfg) =>
  cfg.cloakDownloadsDir || (cfg.workDir ? path.join(cfg.workDir, '.cloakbrowser-downloads') : '');

const profilePathFor = (cfg) =>
  cfg.cloakProfileDir
    ? path.join(cfg.cloakProfileDir, cfg.cloakSessionName || 'default')
    : '';

function isDisplayError(err) {
  return /Missing X server|without having a XServer|ozone_platform_x11|\$DISPLAY/i.test(
    String(err?.message || err || '')
  );
}

function resetHeadedDisplay() {
  delete process.env.DISPLAY;
  displayPromise = null;
  displayStarting = false;
  try {
    xvfbProcess?.kill?.('SIGKILL');
  } catch {
    /* already gone */
  }
  xvfbProcess = null;
}

async function ensureHeadedDisplay() {
  if (process.platform !== 'linux') return;
  const displayNumber = 99;
  const display = `:${displayNumber}`;
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  if (await fsp.access(socket).then(() => true, () => false)) {
    process.env.DISPLAY = display;
    return;
  }
  // Prior Xvfb died (common after SIGKILL of a sibling ingest). Do not trust
  // a cached resolved promise or a stale DISPLAY value.
  delete process.env.DISPLAY;

  if (!displayStarting) {
    displayStarting = true;
    displayPromise = (async () => {
      try {
        try {
          xvfbProcess?.kill?.('SIGKILL');
        } catch {
          /* ignore */
        }
        xvfbProcess = spawn(
          'Xvfb',
          [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
          { stdio: 'ignore' }
        );
        xvfbProcess.unref();
        let launchError = null;
        xvfbProcess.once('error', (err) => {
          launchError = err;
        });
        process.once('exit', () => xvfbProcess?.kill());

        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (launchError) {
            throw new Error(
              `Could not start Xvfb for headed CloakBrowser: ${launchError.message}. Rebuild the Docker image so the xvfb package is installed.`
            );
          }
          if (await fsp.access(socket).then(() => true, () => false)) {
            process.env.DISPLAY = display;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Xvfb did not create a display within 5 seconds');
      } finally {
        displayStarting = false;
      }
    })();
  }
  return displayPromise;
}

function isProxyRetryable(err) {
  if (!err) return false;
  // Display/Xvfb failures are host setup, not a bad proxy. Burning the pool
  // on "Missing X server" is how ingest looked dead after a hard kill.
  if (isDisplayError(err)) return false;
  if (err.blocked || err.proxyRetryable) return true;
  const msg = String(err.message || err);
  return /proxy|SOCKS|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ERR_TUNNEL|ERR_PROXY|tunnel|socket hang up|net::ERR_/i.test(
    msg
  );
}

/**
 * Launch options are environment-driven because the same code runs locally
 * and in the Linux deployment.
 *
 * Proxy is allowed with validateUrl: SSRF is enforced by the Playwright route
 * guard on every request, not by refusing the exit IP.
 */
function launchOptions(cfg = {}, proxy) {
  const downloadsPath = downloadsPathFor(cfg);
  const humanize = bool(cfg.cloakHumanize ?? process.env.AIM4_CLOAK_HUMANIZE, true);
  const humanPreset = cfg.cloakHumanPreset === 'default' ? 'default' : 'careful';
  return {
    headless: bool(cfg.cloakHeadless ?? process.env.AIM4_CLOAK_HEADLESS, false),
    humanize,
    ...(humanize ? { humanPreset } : {}),
    ...(cfg.cloakLicenseKey ? { licenseKey: cfg.cloakLicenseKey } : {}),
    geoip: bool(cfg.cloakGeoip ?? process.env.AIM4_CLOAK_GEOIP, true),
    ...(proxy ? { proxy } : {}),
    ...(downloadsPath ? { launchOptions: { downloadsPath } } : {}),
    contextOptions: {
      acceptDownloads: true,
      serviceWorkers: 'block'
    }
  };
}

function safeName(value, fallback = 'download.bin') {
  const base = path.basename(String(value || '').trim());
  if (!base || base === '.' || base === path.sep) return fallback;
  return base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
}

function abortError(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(reason ? String(reason) : 'Cancelled');
}

const isChallengeHtml = (html) =>
  /cdn-cgi\/challenge-platform|<title>\s*Just a moment|_cf_chl_opt|verify you are human/i.test(
    html || ''
  );

async function interactWithManagedChallenge(page) {
  await page.mouse
    .move(300 + Math.random() * 500, 200 + Math.random() * 300, { steps: 12 })
    .catch(() => {});
  await page.mouse.wheel(0, 80 + Math.random() * 160).catch(() => {});
  for (const frame of page.frames()) {
    const checkbox = frame.locator('input[type="checkbox"], [role="checkbox"]').first();
    if (await checkbox.isVisible().catch(() => false)) {
      await checkbox.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function downloadFiles(directory) {
  if (!directory) return [];
  const names = await fsp.readdir(directory).catch(() => []);
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat?.isFile()) files.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

async function persistentFingerprintSeed(profilePath, configured) {
  if (configured) return String(configured);
  const file = path.join(profilePath, '.fingerprint-seed');
  const saved = await fsp.readFile(file, 'utf8').catch(() => '');
  if (/^\d{6,12}$/.test(saved.trim())) return saved.trim();
  const seed = String(Math.floor(100_000_000 + Math.random() * 900_000_000));
  await fsp.writeFile(file, seed);
  return seed;
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function clearStaleProfileLock(profilePath) {
  const lock = path.join(profilePath, 'SingletonLock');
  const target = await fsp.readlink(lock).catch(() => '');
  const match = /^(.*)-(\d+)$/.exec(target);
  const lockHost = match?.[1] || '';
  const lockPid = Number(match?.[2]) || 0;
  if (lockHost === os.hostname() && processIsAlive(lockPid)) {
    throw new Error(`CloakBrowser profile is already in use by process ${lockPid}`);
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await fsp.rm(path.join(profilePath, name), { force: true }).catch(() => {});
  }
}

async function prepareLicensedProfile(profilePath, binaryPath, licensed) {
  if (!profilePath || !licensed) return;
  const marker = path.join(profilePath, '.licensed-browser');
  if (await fsp.access(marker).then(() => true, () => false)) return;
  const entries = await fsp.readdir(profilePath).catch(() => []);
  // Keep a seeded probe profile (CF cookies). Only wipe empty / free-tier leftovers.
  const hasBrowserData = entries.some((e) => e === 'Default' || e === 'Local State');
  if (!hasBrowserData) {
    for (const entry of entries) {
      if (entry === '.fingerprint-seed') continue;
      await fsp.rm(path.join(profilePath, entry), { recursive: true, force: true }).catch(() => {});
    }
  }
  await fsp.writeFile(marker, path.basename(path.dirname(binaryPath)));
}

/**
 * One-time copy of an older probe profile into the shared `hltv` profile so a
 * successful admin probe is not thrown away when ingest starts cold.
 */
async function seedProfileFromProbe(profilePath, cfg, log) {
  if (!profilePath || !cfg.cloakProfileDir) return;
  const session = path.basename(profilePath);
  if (session !== 'hltv') return;
  const useful = (await fsp.readdir(profilePath).catch(() => [])).filter(
    (e) => e !== '.fingerprint-seed' && e !== '.licensed-browser'
  );
  if (useful.length) return;
  const probePath = path.join(cfg.cloakProfileDir, 'probe');
  const probeUseful = (await fsp.readdir(probePath).catch(() => [])).filter(
    (e) => e !== '.fingerprint-seed' && e !== '.licensed-browser'
  );
  if (!probeUseful.length) return;
  await fsp.cp(probePath, profilePath, { recursive: true });
  log?.('Seeded CloakBrowser profile from successful probe session');
}

/**
 * @param {{
 *   cloakHeadless?: boolean,
 *   cloakHumanize?: boolean,
 *   cloakHumanPreset?: string,
 *   cloakDisableHttp2?: boolean,
 *   cloakFingerprintSeed?: string,
 *   cloakLicenseKey?: string,
 *   cloakGeoip?: boolean,
 *   cloakProxy?: string,
 *   cloakProxyFile?: string,
 *   cloakProxies?: string[],
 *   cloakProxyAttempts?: number,
 *   cloakProxyRandom?: boolean,
 *   cloakSettleMs?: number,
 *   cloakProfileDir?: string,
 *   cloakSessionName?: string,
 *   validateUrl?: (url: string) => Promise<void>,
 *   onLog?: (message: string) => void
 * }} [cfg]
 */
export function createCloakSession(cfg = {}) {
  let contextPromise = null;
  let closed = false;
  let poolPromise = null;
  let settingsPromise = null;
  let activeProxy = undefined;
  let proxyCursor = 0;
  let preferredProxyCount = 0;
  let binaryLogged = false;

  const log = (message) => {
    const line = String(message || '');
    // Always surface transport steps in ingest.log / admin console. Callers can
    // still attach onLog for structured sinks without silencing stdout.
    console.log(`[cloak] ${line}`);
    try {
      cfg.onLog?.(line);
    } catch {
      /* logging must not break a browser operation */
    }
  };

  async function ensureSettings() {
    if (!settingsPromise) {
      settingsPromise = applyProxySettings(cfg).then(({ settings }) => {
        log(
          `Proxy settings: attempts=${settings.attempts}, ` +
            `order=${settings.random ? 'random' : 'sequential'}`
        );
        return settings;
      });
    }
    return settingsPromise;
  }

  async function ensurePool() {
    if (!poolPromise) {
      poolPromise = (async () => {
        const working = await readWorkingProxies(cfg);
        preferredProxyCount = working.length;
        const pool = await loadProxyPool(cfg);
        if (pool.length) {
          log(
            `Proxy pool: ${pool.length} endpoint(s)` +
              (preferredProxyCount ? `, ${preferredProxyCount} preferred` : '')
          );
        } else log('Proxy pool: empty (direct exit IP)');
        return pool;
      })();
    }
    return poolPromise;
  }

  async function resetContext() {
    if (!contextPromise) return;
    const pending = contextPromise;
    contextPromise = null;
    const ctx = await pending.catch(() => null);
    await ctx?.close().catch(() => {});
  }

  async function context() {
    if (closed) throw new Error('CloakBrowser session is closed');
    if (!contextPromise) {
      log('Launching CloakBrowser');
      const downloadsPath = downloadsPathFor(cfg);
      const profilePath = profilePathFor(cfg);
      if (downloadsPath) await fsp.mkdir(downloadsPath, { recursive: true });
      if (profilePath) {
        await fsp.mkdir(profilePath, { recursive: true });
        await seedProfileFromProbe(profilePath, cfg, log);
        await clearStaleProfileLock(profilePath);
      }
      const options = launchOptions(cfg, activeProxy);
      if (options.proxy) log(`Transport proxy: ${redactProxy(options.proxy)}`);
      else log('Transport proxy: none (direct exit IP)');
      log(`Resolving CloakBrowser binary (${options.licenseKey ? 'licensed' : 'unlicensed'})`);
      const binaryPath = await ensureBinary(
        options.licenseKey,
        options.browserVersion,
        options.releaseChannel
      );
      if (!binaryLogged) {
        log(`CloakBrowser binary: ${path.basename(path.dirname(binaryPath))}`);
        binaryLogged = true;
      }
      await prepareLicensedProfile(profilePath, binaryPath, Boolean(options.licenseKey));
      if (options.headless === false) {
        log('Ensuring headed display (Xvfb)');
        await ensureHeadedDisplay();
        log(`DISPLAY=${process.env.DISPLAY || '(unset)'}`);
      }
      const args = ['--fingerprint-windows-font-metrics'];
      if (bool(cfg.cloakDisableHttp2, true)) args.push('--disable-http2');
      if (profilePath) {
        const seed = await persistentFingerprintSeed(profilePath, cfg.cloakFingerprintSeed);
        args.push(`--fingerprint=${seed}`);
      }
      options.args = [...(options.args || []), ...args];
      log(
        profilePath
          ? `launchPersistentContext headless=${options.headless}`
          : `launchContext headless=${options.headless}`
      );
      contextPromise = (
        profilePath
          ? launchPersistentContext({ ...options, userDataDir: profilePath })
          : launchContext(options)
      )
        .then(async (ctx) => {
          log('CloakBrowser context ready');
          // Guard every browser request, not just the first URL. An admin-supplied
          // public page must not redirect or embed its way into private services.
          if (typeof cfg.validateUrl === 'function') {
            await ctx.route('**/*', async (route) => {
              const url = route.request().url();
              if (!/^https?:/i.test(url)) {
                await route.continue();
                return;
              }
              try {
                await cfg.validateUrl(url);
                await route.continue();
              } catch {
                await route.abort('blockedbyclient');
              }
            });
          }
          return ctx;
        })
        .catch((err) => {
          contextPromise = null;
          log(`Launch failed: ${err?.message || err}`);
          throw err;
        });
    }
    return contextPromise;
  }

  function pickProxy(pool, used, random) {
    if (!pool.length) return undefined;
    // Always drain preferred (working) proxies in order first. Random among
    // unproven cache entries only after those are exhausted. Sticky order is
    // what makes a successful probe's exit IP get reused by ingest.
    for (let i = 0; i < preferredProxyCount; i++) {
      const candidate = pool[i];
      if (candidate && !used.has(candidate)) return candidate;
    }
    if (!random) {
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[(proxyCursor + i) % pool.length];
        if (!used.has(candidate)) return candidate;
      }
      return pool[proxyCursor % pool.length];
    }
    const unused = pool.filter((p) => !used.has(p) && pool.indexOf(p) >= preferredProxyCount);
    const choices = unused.length ? unused : pool.filter((p) => !used.has(p));
    if (!choices.length) return pool[0];
    return choices[Math.floor(Math.random() * choices.length)];
  }

  async function withProxyFailover(opts, fn) {
    await ensureSettings();
    const pool = await ensurePool();
    const random = Boolean(cfg.cloakProxyRandom);
    const maxAttempts = Math.max(
      1,
      Math.min(Number(cfg.cloakProxyAttempts) || 5, pool.length || 1)
    );
    const fallbackProxy = normalizeProxyUrl(
      cfg.cloakFallbackProxy === undefined
        ? DEFAULT_FALLBACK_PROXY
        : cfg.cloakFallbackProxy
    );
    // One bonus slot so the default exit can still run after a full 5-attempt
    // pool burn when every public proxy is challenged.
    const hardMax = maxAttempts + (fallbackProxy ? 1 : 0);
    const used = new Set();
    let lastErr;
    let displayRetries = 0;
    let consecutiveFails = 0;
    for (let i = 0; i < hardMax; i++) {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      const wantFallback =
        Boolean(fallbackProxy) &&
        consecutiveFails >= FALLBACK_AFTER_CONSECUTIVE_FAILURES &&
        !used.has(fallbackProxy);
      if (!wantFallback && i >= maxAttempts) break;
      const proxy = wantFallback ? fallbackProxy : pickProxy(pool, used, random);
      if (wantFallback) {
        log(
          `${consecutiveFails} proxies failed in a row; trying default fallback ` +
            `${redactProxy(fallbackProxy)}`
        );
      }
      if (proxy) used.add(proxy);
      if (proxy !== activeProxy || !contextPromise) {
        if (contextPromise) await resetContext();
        activeProxy = proxy;
      }
      try {
        // Enough rounds to clear a soft CF interstitial; not so many that one
        // bad proxy burns two minutes before failover (probe feels "instant"
        // because it usually hits a good exit on the first try).
        const result = await fn({
          challengeRounds: pool.length > 1 ? 10 : 24
        });
        if (proxy) {
          if (!random) proxyCursor = Math.max(0, pool.indexOf(proxy));
          await recordWorkingProxy(cfg, { url: proxy }).catch(() => {});
        }
        return result;
      } catch (err) {
        lastErr = err;
        if (opts.signal?.aborted) throw abortError(opts.signal);
        if (isDisplayError(err) && displayRetries < 2) {
          displayRetries += 1;
          log(
            `Display/Xvfb error: ${err.message}. Restarting Xvfb and retrying ` +
              `(${displayRetries}/2)`
          );
          resetHeadedDisplay();
          await resetContext();
          if (proxy) used.delete(proxy);
          i -= 1;
          continue;
        }
        if (proxy) await markProxyFailed(cfg, proxy).catch(() => {});
        consecutiveFails += 1;
        const fallbackPending =
          Boolean(fallbackProxy) &&
          consecutiveFails >= FALLBACK_AFTER_CONSECUTIVE_FAILURES &&
          !used.has(fallbackProxy);
        const canRetry =
          isProxyRetryable(err) && (i < maxAttempts - 1 || fallbackPending);
        if (!canRetry) {
          // Leave blocked/proxyRetryable for the pipeline to back off on the
          // same demo id. fatal here used to kill the whole ingester.
          throw err;
        }
        log(
          `Proxy ${redactProxy(proxy) || 'direct'} failed: ${err.message}. ` +
            `Trying next (${Math.min(i + 2, hardMax)}/${hardMax})`
        );
        await resetContext();
      }
    }
    throw lastErr;
  }

  /**
   * Load one page through CloakBrowser and return its rendered HTML.
   */
  async function getText(url, opts = {}) {
    return withProxyFailover(opts, async () => {
      await cfg.validateUrl?.(url);
      const ctx = await context();
      const page = await ctx.newPage();
      const timeout = Number(opts.timeoutMs) || DEFAULT_NAVIGATION_TIMEOUT_MS;
      const onAbort = () => void page.close().catch(() => {});
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        log(`Opening ${url}`);
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout
        });
        if (opts.signal?.aborted) throw abortError(opts.signal);
        // Native sleep, not page.waitForTimeout(): give redirects and browser
        // challenges time to settle without adding a detectable CDP wait call.
        const settleMs = Number(opts.settleMs ?? cfg.cloakSettleMs) || 0;
        if (settleMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, settleMs));
        }
        if (opts.signal?.aborted) throw abortError(opts.signal);
        const text = await page.content();
        if (isChallengeHtml(text)) {
          const err = new Error('CloakBrowser received a Cloudflare challenge page');
          err.blocked = true;
          err.proxyRetryable = true;
          throw err;
        }
        return {
          text,
          url: page.url(),
          status: response?.status() || 200,
          headers: response ? await response.allHeaders() : {}
        };
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
        await page.close().catch(() => {});
      }
    });
  }

  /**
   * Open a URL and save the first browser download it starts.
   *
   * @param {string} url
   * @param {string} directory
   * @param {{
   *   fallbackName?: string,
   *   maxBytes?: number,
   *   timeoutMs?: number,
   *   deadlineMs?: number,
   *   stallMs?: number,
   *   signal?: AbortSignal,
   *   onProgress?: (p: {
   *     received: number,
   *     total: number,
   *     phase?: string,
   *     elapsedMs?: number
   *   }) => void
   * }} [opts]
   */
  async function download(url, directory, opts = {}) {
    return withProxyFailover(opts, async ({ challengeRounds }) => {
    await cfg.validateUrl?.(url);
    const ctx = await context();
    const page = await ctx.newPage();
    const timeout = Number(opts.timeoutMs) || DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const deadlineMs =
      Number(opts.deadlineMs ?? cfg.cloakDownloadDeadlineMs) || DEFAULT_DOWNLOAD_DEADLINE_MS;
    const stallMs = Number(opts.stallMs) || DEFAULT_STALL_MS;
    const maxBytes = Number(opts.maxBytes) || Infinity;
    let rejectPendingDownload = null;
    let activeDownload = null;
    let activeStream = null;
    let target = null;
    let completed = false;
    let deadlineTimer = null;
    let progressTimer = null;
    const onAbort = () => {
      const err = abortError(opts.signal);
      rejectPendingDownload?.(err);
      activeStream?.destroy(err);
      void activeDownload?.cancel().catch(() => {});
      void page.close().catch(() => {});
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await fsp.mkdir(directory, { recursive: true });
      const browserDownloadsPath = downloadsPathFor(cfg);
      const baselineFiles = new Set(
        (await downloadFiles(browserDownloadsPath)).map((entry) => entry.name)
      );
      log(`Opening download URL ${url}`);
      deadlineTimer = setTimeout(() => {
        const err = new Error(
          `CloakBrowser download exceeded the ${Math.round(deadlineMs / 60000)} minute deadline`
        );
        rejectPendingDownload?.(err);
        activeStream?.destroy(err);
        void activeDownload?.cancel().catch(() => {});
        void page.close().catch(() => {});
      }, deadlineMs);
      deadlineTimer.unref?.();

      // Listen on this page and popups opened by this page. Do not listen on
      // the whole shared context: ingestion can download several matches at
      // once, and context-wide listeners could claim another match's file.
      let downloadTimer = null;
      let settleDownload;
      let downloadStarted = false;
      const attached = new Set();
      const downloadPromise = new Promise((resolve, reject) => {
        rejectPendingDownload = reject;
        settleDownload = (item) => {
          downloadStarted = true;
          clearTimeout(downloadTimer);
          rejectPendingDownload = null;
          resolve(item);
        };
        downloadTimer = setTimeout(
          () => reject(new Error(`No browser download started within ${Math.round(timeout / 1000)}s`)),
          timeout
        );
        downloadTimer.unref?.();
      });
      const attach = (candidate) => {
        if (!candidate || attached.has(candidate)) return;
        attached.add(candidate);
        candidate.once('download', settleDownload);
      };
      const onPopup = (popup) => attach(popup);
      attach(page);
      page.on('popup', onPopup);
      const responses = new Map();
      const onResponse = (response) => responses.set(response.url(), response);
      page.on('response', onResponse);
      const waitingStartedAt = Date.now();
      let waitPhase = 'navigating';
      let waitDetail = 'opening page';
      let navStatus = 0;
      let settledHtml = false;
      const reportWaiting = () =>
        opts.onProgress?.({
          received: 0,
          total: 0,
          phase: waitPhase,
          detail: waitDetail,
          elapsedMs: Date.now() - waitingStartedAt
        });
      reportWaiting();
      progressTimer = setInterval(reportWaiting, 1000);
      progressTimer.unref?.();

      const navigationPromise = page
        .goto(url, { waitUntil: 'domcontentloaded', timeout })
        .catch((err) => {
          // Chromium aborts navigation when the response becomes a download.
          // The download event is the authoritative result in that case.
          if (/download is starting|ERR_ABORTED/i.test(String(err?.message || err))) {
            waitPhase = 'download';
            waitDetail = 'browser started a file transfer';
            reportWaiting();
            return null;
          }
          throw err;
        });

      // Inspect the page while we wait for a download event. Without this the
      // console only said "waiting" for up to 2 minutes with no explanation.
      const pageWatch = (async () => {
        const rounds = Number(challengeRounds) || 30;
        let challengeAttempts = 0;
        let htmlStableSince = 0;
        while (!downloadStarted && !opts.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (downloadStarted) return;
          let html = '';
          let title = '';
          let href = '';
          try {
            html = await page.content();
            title = pageTitle(html) || (await page.title().catch(() => ''));
            href = page.url();
          } catch {
            waitPhase = 'navigating';
            waitDetail = 'browser still loading';
            reportWaiting();
            continue;
          }
          settledHtml = Boolean(html);
          if (isChallengeHtml(html)) {
            waitPhase = 'challenge';
            waitDetail = title || 'Cloudflare challenge';
            reportWaiting();
            if (challengeAttempts < rounds) {
              challengeAttempts++;
              log(`Challenge (${challengeAttempts}/${rounds}) on ${href || url}`);
              await interactWithManagedChallenge(page);
              continue;
            }
            // Probe succeeds by moving on; sitting here for the full download
            // timeout on one dead proxy is why ingest looked "stuck".
            log(`Challenge uncleared after ${rounds} rounds; trying next proxy`);
            const err = new Error('CloakBrowser received a Cloudflare challenge page');
            err.blocked = true;
            err.proxyRetryable = true;
            rejectPendingDownload?.(err);
            return;
          }
          if (looksLikeMissingPage(html) || /\/404\b/i.test(href)) {
            waitPhase = 'missing';
            waitDetail = title || 'Page not found';
            reportWaiting();
            const err = new Error(`HLTV page not found (${title || '404'})`);
            err.missing = true;
            rejectPendingDownload?.(err);
            return;
          }
          // HTML page loaded but no download: give redirects a short window,
          // then fail instead of sitting on "waiting" until the 120s timer.
          if (html && /<html/i.test(html)) {
            if (!htmlStableSince) htmlStableSince = Date.now();
            const stableFor = Date.now() - htmlStableSince;
            waitPhase = 'page';
            waitDetail = title
              ? `"${title}" (no file yet)`
              : `HTML page, no file yet (${Math.round(stableFor / 1000)}s)`;
            reportWaiting();
            if (stableFor >= 12_000) {
              const err = new Error(
                `No archive download after page load` +
                  `${title ? ` (title "${title}")` : ''}` +
                  `${navStatus ? ` HTTP ${navStatus}` : ''}`
              );
              err.proxyRetryable = true;
              rejectPendingDownload?.(err);
              return;
            }
            continue;
          }
          waitPhase = 'waiting';
          waitDetail = title || href || 'waiting for file';
          reportWaiting();
        }
      })().catch((err) => {
        log(`Page watch ended: ${err?.message || err}`);
      });

      const challengeTask = navigationPromise
        .then(async (response) => {
          if (!response) return;
          navStatus = response.status?.() || 0;
          const initialHeaders = await response.allHeaders().catch(() => ({}));
          waitPhase = downloadStarted ? 'download' : 'waiting';
          waitDetail = `HTTP ${navStatus}` +
            (initialHeaders['cf-mitigated'] === 'challenge' ? ' (cf challenge header)' : '');
          reportWaiting();
          log(`Navigated ${url} -> HTTP ${navStatus}`);
        })
        .catch((err) => {
          log(`Navigation error: ${err?.message || err}`);
        });

      const [downloadResult, navigationResult] = await Promise.allSettled([
        downloadPromise,
        navigationPromise
      ]);
      page.off('popup', onPopup);
      page.off('response', onResponse);
      clearInterval(progressTimer);
      progressTimer = null;
      clearTimeout(downloadTimer);
      rejectPendingDownload = null;
      for (const candidate of attached) candidate.off('download', settleDownload);
      await pageWatch.catch(() => {});
      if (opts.signal?.aborted) throw abortError(opts.signal);
      if (downloadResult.status === 'rejected') {
        if (navigationResult.status === 'rejected') throw navigationResult.reason;
        const html = await page.content().catch(() => '');
        if (downloadResult.reason?.missing || looksLikeMissingPage(html)) {
          const err = new Error(
            downloadResult.reason?.message ||
              `HLTV page not found (${pageTitle(html) || '404'})`
          );
          err.missing = true;
          throw err;
        }
        if (isChallengeHtml(html) || /challenge/i.test(String(downloadResult.reason?.message || ''))) {
          const err = new Error('CloakBrowser received a Cloudflare challenge page');
          err.blocked = true;
          err.proxyRetryable = true;
          throw err;
        }
        const response = navigationResult.value;
        const status = response?.status?.() || navStatus;
        if (status && (status < 200 || status >= 400) && !settledHtml) {
          throw new Error(`CloakBrowser navigation returned HTTP ${status} without a download`);
        }
        throw downloadResult.reason;
      }
      await challengeTask;

      const item = downloadResult.value;
      activeDownload = item;
      const filename = safeName(item.suggestedFilename(), opts.fallbackName);
      target = path.join(directory, filename);
      const response = responses.get(item.url());
      const headers = response ? await response.allHeaders().catch(() => ({})) : {};
      const declaredBytes = Number(headers['content-length']) || 0;
      if (declaredBytes && declaredBytes > maxBytes) {
        await item.cancel().catch(() => {});
        throw new Error(`Download is ${declaredBytes} bytes, over the ${maxBytes} byte cap`);
      }

      // Playwright exposes the readable stream only after Chromium finishes
      // its managed download. Poll that managed directory in the meantime so
      // the admin UI still receives live bytes instead of appearing frozen.
      const progressStartedAt = Date.now();
      let progressFile = null;
      let progressBusy = false;
      let browserReceived = 0;
      const reportBrowserProgress = async () => {
        if (progressBusy) return;
        progressBusy = true;
        try {
          const files = await downloadFiles(browserDownloadsPath);
          let current = progressFile
            ? files.find((entry) => entry.name === progressFile)
            : null;
          if (!current) {
            current = files
              .filter((entry) => !baselineFiles.has(entry.name))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
            progressFile = current?.name || null;
          }
          browserReceived = Math.max(browserReceived, current?.size || 0);
          opts.onProgress?.({
            received: browserReceived,
            total: declaredBytes,
            phase: 'browser',
            elapsedMs: Date.now() - progressStartedAt
          });
        } finally {
          progressBusy = false;
        }
      };
      await reportBrowserProgress();
      progressTimer = setInterval(() => void reportBrowserProgress(), 1000);
      progressTimer.unref?.();

      const stream = await item.createReadStream();
      if (!stream) throw new Error('CloakBrowser download produced no readable stream');
      activeStream = stream;
      clearInterval(progressTimer);
      progressTimer = null;
      await reportBrowserProgress();

      let received = 0;
      let stallTimer = null;
      const touch = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stream.destroy(new Error(`No bytes for ${Math.round(stallMs / 1000)}s, download is dead`));
        }, stallMs);
        stallTimer.unref?.();
      };
      touch();
      stream.on('data', (chunk) => {
        received += chunk.length;
        touch();
        if (received > maxBytes) {
          stream.destroy(new Error(`Download exceeded the ${maxBytes} byte cap`));
          void item.cancel().catch(() => {});
          return;
        }
        opts.onProgress?.({
          received: Math.max(browserReceived, received),
          total: declaredBytes,
          phase: 'copy',
          elapsedMs: Date.now() - progressStartedAt
        });
      });

      try {
        await pipeline(stream, fs.createWriteStream(target));
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }

      const failure = await item.failure();
      if (failure) throw new Error(`CloakBrowser download failed: ${failure}`);
      const stat = await fsp.stat(target);
      if (!stat.size) throw new Error('Downloaded file is empty');
      completed = true;
      return {
        path: target,
        filename,
        bytes: stat.size,
        finalUrl: item.url()
      };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (progressTimer) clearInterval(progressTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      await activeDownload?.delete().catch(() => {});
      if (target && !completed) await fsp.rm(target, { force: true }).catch(() => {});
      await page.close().catch(() => {});
    }
    });
  }

  async function close() {
    closed = true;
    await resetContext();
  }

  return { getText, download, close };
}
