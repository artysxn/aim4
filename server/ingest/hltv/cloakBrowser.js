// ---------------------------------------------------------------------------
// server/ingest/hltv/cloakBrowser.js
// Shared CloakBrowser transport for discovery pages and demo downloads.
//
// The admin probe and the live ingester use this same layer so a successful
// probe measures the transport the pipeline will actually use.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { launchContext } from 'cloakbrowser';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_DEADLINE_MS = 30 * 60_000;
const DEFAULT_STALL_MS = 60_000;

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
};

/**
 * Launch options are environment-driven because the same code runs locally
 * and in the Linux deployment.
 */
function launchOptions(cfg = {}) {
  const proxy = cfg.cloakProxy || process.env.AIM4_CLOAK_PROXY || undefined;
  if (proxy && typeof cfg.validateUrl === 'function') {
    throw new Error('A proxy cannot be used for an SSRF-guarded CloakBrowser session');
  }
  const downloadsPath =
    cfg.cloakDownloadsDir || (cfg.workDir ? path.join(cfg.workDir, '.cloakbrowser-downloads') : '');
  return {
    headless: bool(cfg.cloakHeadless ?? process.env.AIM4_CLOAK_HEADLESS, true),
    humanize: bool(cfg.cloakHumanize ?? process.env.AIM4_CLOAK_HUMANIZE, true),
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

/**
 * @param {{
 *   cloakHeadless?: boolean,
 *   cloakHumanize?: boolean,
 *   cloakProxy?: string,
 *   cloakSettleMs?: number,
 *   validateUrl?: (url: string) => Promise<void>,
 *   onLog?: (message: string) => void
 * }} [cfg]
 */
export function createCloakSession(cfg = {}) {
  let contextPromise = null;
  let closed = false;

  const log = (message) => {
    try {
      cfg.onLog?.(message);
    } catch {
      /* logging must not break a browser operation */
    }
  };

  async function context() {
    if (closed) throw new Error('CloakBrowser session is closed');
    if (!contextPromise) {
      log('Launching CloakBrowser');
      const downloadsPath =
        cfg.cloakDownloadsDir || (cfg.workDir ? path.join(cfg.workDir, '.cloakbrowser-downloads') : '');
      if (downloadsPath) await fsp.mkdir(downloadsPath, { recursive: true });
      contextPromise = launchContext(launchOptions(cfg)).then(async (ctx) => {
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
      });
    }
    return contextPromise;
  }

  /**
   * Load one page through CloakBrowser and return its rendered HTML.
   */
  async function getText(url, opts = {}) {
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
      return {
        text: await page.content(),
        url: page.url(),
        status: response?.status() || 200,
        headers: response ? await response.allHeaders() : {}
      };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await page.close().catch(() => {});
    }
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
   *   onProgress?: (p: {received: number, total: number}) => void
   * }} [opts]
   */
  async function download(url, directory, opts = {}) {
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
      const attached = new Set();
      const downloadPromise = new Promise((resolve, reject) => {
        rejectPendingDownload = reject;
        settleDownload = (item) => {
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

      const navigationPromise = page
        .goto(url, { waitUntil: 'domcontentloaded', timeout })
        .catch((err) => {
          // Chromium aborts navigation when the response becomes a download.
          // The download event is the authoritative result in that case.
          if (!/download is starting|ERR_ABORTED/i.test(String(err?.message || err))) throw err;
          return null;
        });

      const [downloadResult, navigationResult] = await Promise.allSettled([
        downloadPromise,
        navigationPromise
      ]);
      page.off('popup', onPopup);
      page.off('response', onResponse);
      clearTimeout(downloadTimer);
      rejectPendingDownload = null;
      for (const candidate of attached) candidate.off('download', settleDownload);
      if (opts.signal?.aborted) throw abortError(opts.signal);
      if (downloadResult.status === 'rejected') {
        if (navigationResult.status === 'rejected') throw navigationResult.reason;
        const html = await page.content().catch(() => '');
        if (
          /cdn-cgi\/challenge-platform|<title>\s*Just a moment|_cf_chl_opt/i.test(html)
        ) {
          const err = new Error('CloakBrowser received a Cloudflare challenge page');
          err.blocked = true;
          err.fatal = true;
          throw err;
        }
        const response = navigationResult.value;
        const status = response?.status?.();
        if (status && (status < 200 || status >= 400)) {
          throw new Error(`CloakBrowser navigation returned HTTP ${status} without a download`);
        }
        throw downloadResult.reason;
      }

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
      const stream = await item.createReadStream();
      if (!stream) throw new Error('CloakBrowser download produced no readable stream');
      activeStream = stream;

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
        opts.onProgress?.({ received, total: declaredBytes });
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
      opts.signal?.removeEventListener('abort', onAbort);
      await activeDownload?.delete().catch(() => {});
      if (target && !completed) await fsp.rm(target, { force: true }).catch(() => {});
      await page.close().catch(() => {});
    }
  }

  async function close() {
    closed = true;
    if (!contextPromise) return;
    const ctx = await contextPromise.catch(() => null);
    await ctx?.close().catch(() => {});
  }

  return { getText, download, close };
}
