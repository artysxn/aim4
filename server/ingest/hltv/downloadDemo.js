// ---------------------------------------------------------------------------
// server/ingest/hltv/downloadDemo.js
// The probe download tool.
//
// Admin Probe and continuous Ingest both call createProbeTool(). Ingest only
// adds "which URL next" and ledger/cursor counting; it must not open its own
// CloakBrowser path.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns/promises';
import { createCloakSession } from './cloakBrowser.js';

export const DEMO_DOWNLOAD_STALL_MS = 60_000;

function isPrivateV4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
  if (o[0] >= 224) return true;
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateV4(mapped[1]);
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(v6)) return true;
  return false;
}

/**
 * Resolve a hostname and refuse anything that lands in private space.
 * `allowPrivate` exists so the test suite can point a probe at a stub server
 * on loopback; nothing in production passes it.
 */
export async function checkTarget(urlObj, allowPrivate = false) {
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be probed, got ${urlObj.protocol}`);
  }
  const host = urlObj.hostname;
  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host)) {
      throw new Error(`${host} is a private address, refusing`);
    }
    return [host];
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`DNS lookup for ${host} failed: ${err?.code || err?.message || err}`);
  }
  const ips = addrs.map((a) => a.address);
  const bad = ips.find((ip) => isPrivateAddress(ip));
  if (!allowPrivate && bad) {
    throw new Error(`${host} resolves to private address ${bad}, refusing`);
  }
  return ips;
}

export function openDemoBrowser(cfg, sessionName = 'hltv', extra = {}) {
  return createCloakSession({
    ...cfg,
    cloakSessionName: cfg.cloakSessionName || sessionName,
    ...extra
  });
}

export function downloadDemoArchive(browser, url, directory, opts = {}) {
  return browser.download(url, directory, {
    fallbackName: opts.fallbackName || 'download.bin',
    maxBytes: opts.maxBytes,
    stallMs: opts.stallMs ?? DEMO_DOWNLOAD_STALL_MS,
    signal: opts.signal,
    onProgress: opts.onProgress
  });
}

/**
 * The tool Probe uses. Ingest must call this for every demo URL.
 *
 * @param {object} cfg
 * @param {{
 *   allowPrivate?: boolean,
 *   onLog?: (message: string) => void,
 *   createBrowser?: (opts: object) => object,
 *   sessionName?: string
 * }} [options]
 */
export function createProbeTool(cfg, options = {}) {
  const allowPrivate = Boolean(options.allowPrivate);
  const onLog = options.onLog;
  const sessionName = options.sessionName || 'hltv';
  let browser = null;

  async function ensureBrowser() {
    if (browser) return browser;
    const validateUrl = async (target) => {
      await checkTarget(new URL(target), allowPrivate);
    };
    if (typeof options.createBrowser === 'function') {
      browser = options.createBrowser({
        ...cfg,
        cloakSessionName: cfg.cloakSessionName || sessionName,
        validateUrl,
        onLog
      });
    } else {
      browser = openDemoBrowser(cfg, sessionName, { validateUrl, onLog });
    }
    return browser;
  }

  return {
    /**
     * Download one URL the way the admin probe does.
     * @returns {Promise<{ path: string, filename: string, bytes: number, finalUrl: string }>}
     */
    async download(url, directory, opts = {}) {
      const urlObj = typeof url === 'string' ? new URL(url) : url;
      await checkTarget(urlObj, allowPrivate);
      await fsp.mkdir(directory, { recursive: true });
      const b = await ensureBrowser();
      return downloadDemoArchive(b, urlObj.href, directory, {
        fallbackName: opts.fallbackName || 'download.bin',
        maxBytes: opts.maxBytes ?? cfg.maxArchiveBytes,
        stallMs: opts.stallMs ?? DEMO_DOWNLOAD_STALL_MS,
        signal: opts.signal,
        onProgress: opts.onProgress
      });
    },

    async close() {
      const pending = browser;
      browser = null;
      await pending?.close?.().catch(() => {});
    }
  };
}
