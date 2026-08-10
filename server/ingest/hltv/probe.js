// ---------------------------------------------------------------------------
// server/ingest/hltv/probe.js
// One admin-triggered check: can this host download a demo archive from a
// given URL, parse it, and keep only the .aim4replay packages?
//
// This is a measurement tool, not a crawler. It opens exactly one admin-supplied
// URL in CloakBrowser and captures the first automatic download. The same
// browser transport is used by the live ingestion source, so a successful
// probe is representative of the pipeline rather than a separate fetch test.
//
// What a successful run leaves behind:
//   <stateDir>/probe/<runId>/<map>.aim4replay     the kept packages
//   <stateDir>/probe.json                         full state + step log
// The downloaded archive and every extracted .dem are deleted at the end,
// success or failure, so a probe can never fill the volume.
//
// Parsing happens in a forked probeParseWorker.js with its own heap cap, for
// the same reason jobs.js forks parseWorker.js: a parser OOM must not take
// the API server down with it. One probe at a time, enforced here.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { looksLikeChallenge } from './fetcher.js';
import { createCloakSession } from './cloakBrowser.js';
import { unpackArchive } from './process.js';
import { rarSupport } from '../../replays/archive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'probeParseWorker.js');

/** Mirrors jobs.js: the parse child gets a bounded heap of its own. */
const WORKER_HEAP_MB = Number(process.env.AIM4_PARSE_HEAP_MB || 1024);
/** A parse that reports nothing for this long is hung, not slow. */
const PARSE_STALL_MS = Number(process.env.AIM4_PARSE_STALL_MS || 15 * 60 * 1000);
/** A download that moves no bytes for this long is dead. */
const DOWNLOAD_STALL_MS = 60_000;
/** Per-request budget for headers to arrive. */
const HEADERS_TIMEOUT_MS = 30_000;
const MAX_HOPS = 6;
/** How much of a non-archive body is worth reading to say what it was. */
const BODY_PEEK_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// State. One run at a time; the last run's log survives restarts as a file.
// ---------------------------------------------------------------------------

const state = {
  current: null, // the in-flight run object, or null
  child: null, // in-flight parse child, killed on cancel
  abort: null // AbortController for the network half
};

const probeFile = (c) => path.join(c.stateDir, 'probe.json');

function emptyRun(url, runId) {
  return {
    running: true,
    runId,
    url,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    verdict: null, // 'ok' | 'blocked' | 'failed' | 'cancelled'
    summary: null,
    live: null, // { stage, detail, received, total } for the UI, not logged
    packages: [],
    keptDir: null,
    log: []
  };
}

async function persist(c, run) {
  await fsp.mkdir(c.stateDir, { recursive: true });
  const tmp = `${probeFile(c)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(run, null, 2));
  await fsp.rename(tmp, probeFile(c));
}

/** The admin page polls this. */
export async function probeState() {
  if (state.current) return { ...state.current };
  const c = loadConfig({});
  try {
    const saved = JSON.parse(await fsp.readFile(probeFile(c), 'utf8'));
    // A file that says "running" with no run in memory means the server
    // restarted mid-probe. Say so once rather than showing a live run forever.
    if (saved.running) {
      saved.running = false;
      saved.verdict = saved.verdict || 'failed';
      saved.summary = saved.summary || 'Interrupted by a server restart before finishing.';
      saved.log.push(line('error', 'Interrupted by a server restart before finishing.'));
      await persist(c, saved).catch(() => {});
    }
    return saved;
  } catch {
    return { running: false, runId: null, url: null, log: [], verdict: null, summary: null };
  }
}

// ---------------------------------------------------------------------------
// Log helpers.
// ---------------------------------------------------------------------------

function line(level, text) {
  return { at: new Date().toISOString(), level, text };
}

const mb = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
};

function makeLogger(c, run) {
  return (level, text) => {
    run.log.push(line(level, text));
    console.log(`[probe] ${level === 'info' ? '' : `${level.toUpperCase()} `}${text}`);
    // The log is small and each line is an event worth surviving a crash.
    persist(c, run).catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Address hygiene. The URL is admin-supplied, but "admin panel can make the
// server GET anything" should still not reach loopback or the private LAN.
// ---------------------------------------------------------------------------

function isPrivateV4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  if (o[0] >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateV4(mapped[1]);
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(v6)) return true; // fe80::/10
  return false;
}

/** Resolve a hostname and refuse anything that lands in private space.
 * `allowPrivate` exists so the test suite can point a probe at a stub server
 * on loopback; nothing in production passes it. */
async function checkTarget(urlObj, allowPrivate = false) {
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

// ---------------------------------------------------------------------------
// The request chain. Manual redirects so every hop lands in the log, with any
// cookies a hop sets carried to the next, which is ordinary browser behaviour
// and nothing more.
// ---------------------------------------------------------------------------

const HEADER_NOTES = [
  'server',
  'cf-mitigated',
  'cf-cache-status',
  'content-type',
  'content-length',
  'content-disposition'
];

function describeHeaders(res) {
  const parts = [];
  for (const name of HEADER_NOTES) {
    const v = res.headers.get(name);
    if (v) parts.push(`${name}: ${v}`);
  }
  return parts.join(', ');
}

async function peekBody(res) {
  try {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let got = 0;
    while (got < BODY_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

function pageTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim().slice(0, 120) : '';
}

class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
    this.blocked = true;
  }
}

/**
 * One GET whose timeout covers the HEADERS only. A plain AbortSignal.timeout
 * would keep ticking through the body and kill any download longer than the
 * budget, so the timer is cleared the moment fetch() resolves; a dead body
 * stream is the download stall watchdog's job.
 */
async function timedFetch(url, headers, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`No response headers within ${HEADERS_TIMEOUT_MS / 1000}s`)),
    HEADERS_TIMEOUT_MS
  );
  signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    return await fetch(url, { method: 'GET', redirect: 'manual', headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow the chain and hand back the final downloadable response.
 * Every hop is logged; a challenge anywhere ends the probe.
 */
async function follow(startUrl, { userAgent, signal, log, allowPrivate }) {
  let current = new URL(startUrl);
  const cookies = new Map();

  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    const ips = await checkTarget(current, allowPrivate);
    log('info', `Resolved ${current.hostname} to ${ips.join(', ')}`);

    const headers = {
      'User-Agent': userAgent,
      Accept: '*/*',
      'Accept-Encoding': 'identity'
    };
    if (cookies.size) {
      headers.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const res = await timedFetch(current, headers, signal);

    const noted = describeHeaders(res);
    log('info', `GET ${current} -> HTTP ${res.status}${noted ? ` (${noted})` : ''}`);

    for (const raw of res.headers.getSetCookie?.() || []) {
      const eq = raw.indexOf('=');
      const semi = raw.indexOf(';');
      if (eq > 0) cookies.set(raw.slice(0, eq).trim(), raw.slice(eq + 1, semi > eq ? semi : undefined).trim());
    }

    if (res.headers.get('cf-mitigated') === 'challenge') {
      await res.body?.cancel().catch(() => {});
      throw new BlockedError(
        `Cloudflare answered with a managed challenge (cf-mitigated: challenge) at hop ${hop}. ` +
          'Automated download is not possible from this host, and this probe does not attempt to defeat challenges.'
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new Error(`HTTP ${res.status} redirect with no Location header`);
      current = new URL(loc, current);
      continue;
    }

    if (res.status === 403) {
      const body = await peekBody(res);
      if (looksLikeChallenge(body)) {
        throw new BlockedError(
          'HTTP 403 carrying a Cloudflare challenge page. Automated download is not possible ' +
            'from this host, and this probe does not attempt to defeat challenges.'
        );
      }
      const title = pageTitle(body);
      throw new Error(`HTTP 403 (not a Cloudflare challenge${title ? `; page title "${title}"` : ''})`);
    }

    if (!res.ok) {
      const body = await peekBody(res);
      const title = pageTitle(body);
      throw new Error(`HTTP ${res.status}${title ? ` (page title "${title}")` : ''}`);
    }

    return { res, finalUrl: current };
  }
  throw new Error(`More than ${MAX_HOPS} redirects, giving up`);
}

// ---------------------------------------------------------------------------
// Classification. Trust the bytes, not the filename: an HTML error page saved
// as .rar is the classic failure and it must be named for what it is.
// ---------------------------------------------------------------------------

const MAGIC = [
  { kind: 'rar', ext: '.rar', test: (b) => b.slice(0, 4).toString('latin1') === 'Rar!' },
  { kind: 'zip', ext: '.zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { kind: 'gz', ext: '.gz', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  {
    kind: 'zst',
    ext: '.zst',
    test: (b) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd
  },
  { kind: 'dem', ext: '.dem', test: (b) => b.slice(0, 7).toString('latin1') === 'PBDEMS2' },
  { kind: 'dem', ext: '.dem', test: (b) => b.slice(0, 7).toString('latin1') === 'HL2DEMO' }
];

export function sniffMagic(buf) {
  for (const m of MAGIC) {
    if (buf.length >= 4 && m.test(buf)) return { kind: m.kind, ext: m.ext };
  }
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<') || head.includes('<!doctype') || head.includes('<html')) {
    return { kind: 'html', ext: null };
  }
  return { kind: 'unknown', ext: null };
}

export function filenameFromResponse(res, finalUrl) {
  const disposition = res.headers.get('content-disposition') || '';
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (named) {
    try {
      return path.basename(decodeURIComponent(named[1]));
    } catch {
      return path.basename(named[1]);
    }
  }
  const fromPath = path.basename(new URL(finalUrl).pathname);
  return fromPath || 'download.bin';
}

// ---------------------------------------------------------------------------
// The parse half: fork the worker, relay progress, enforce the stall timer.
// ---------------------------------------------------------------------------

function packageDemoForked(demoFile, outPath, meta, onProgress) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ file: demoFile, outPath, meta });
    const child = fork(WORKER, [payload], {
      execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    state.child = child;

    let settled = false;
    let stallTimer = null;
    const touch = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(new Error(`Parse made no progress for ${Math.round(PARSE_STALL_MS / 60000)} minutes`));
      }, PARSE_STALL_MS);
      stallTimer.unref?.();
    };
    const settle = (err, summary) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      state.child = null;
      if (!child.killed) child.kill('SIGKILL');
      err ? reject(err) : resolve(summary);
    };

    touch();
    child.on('message', (msg) => {
      if (msg.type === 'progress') {
        touch();
        onProgress?.(msg);
      } else if (msg.type === 'done') {
        settle(null, msg.summary);
      } else if (msg.type === 'error') {
        settle(new Error(msg.error));
      }
    });
    child.on('error', (err) => settle(err));
    child.on('exit', (code, signal) => {
      if (settled) return;
      settle(
        new Error(
          signal === 'SIGKILL' || code === null
            ? `Parse process was killed (${signal || 'no exit code'}), most likely out of memory (heap cap ${WORKER_HEAP_MB} MB)`
            : `Parse process exited with code ${code}`
        )
      );
    });
  });
}

// ---------------------------------------------------------------------------
// The run itself.
// ---------------------------------------------------------------------------

/**
 * Start a probe. Returns the initial state, or { busy: true } when one is
 * already running. Hooks exist for isolated tests; production passes none.
 */
export async function startProbe(url, hooks = {}) {
  if (state.current?.running) return { busy: true, ...state.current };

  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return { invalid: true, error: 'That is not a URL.' };
  }

  const c = loadConfig({});
  const runId = `probe-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`;
  const run = emptyRun(parsed.href, runId);
  state.current = run;
  state.abort = new AbortController();

  // Fire and forget; the admin page polls probeState() for the story.
  void executeProbe(c, run, parsed, hooks).catch(() => {});
  return { ...run };
}

export async function cancelProbe() {
  const run = state.current;
  if (!run?.running) return { cancelled: false, reason: 'not running' };
  run.cancelled = true;
  state.abort?.abort();
  state.child?.kill('SIGKILL');
  return { cancelled: true };
}

async function executeProbe(c, run, urlObj, hooks) {
  const log = makeLogger(c, run);
  const workDir = path.join(c.workDir, run.runId);
  const outDir = path.join(c.stateDir, 'probe', run.runId);
  const packageDemo = hooks.packageDemo || packageDemoForked;
  let archivePath = null;
  let browser = null;

  const finish = async (verdict, summary) => {
    run.running = false;
    run.live = null;
    run.verdict = run.cancelled ? 'cancelled' : verdict;
    run.summary = run.cancelled ? 'Cancelled by the operator.' : summary;
    run.finishedAt = new Date().toISOString();
    log(verdict === 'ok' ? 'ok' : 'error', `RESULT: ${run.summary}`);
    await persist(c, run).catch(() => {});
    state.current = null;
    state.abort = null;
  };

  try {
    log('info', `Probe ${run.runId} starting on this server`);
    log('info', `Target: ${urlObj.href}`);
    log('info', 'Transport: CloakBrowser (the same transport used by ingestion)');

    // -- browser + download ----------------------------------------------
    const t0 = Date.now();
    await checkTarget(urlObj, Boolean(hooks.allowPrivate));
    const makeBrowser = hooks.createBrowser || createCloakSession;
    browser = makeBrowser({
      ...c,
      validateUrl: async (target) => {
        const next = new URL(target);
        await checkTarget(next, Boolean(hooks.allowPrivate));
      },
      onLog: (message) => log('info', message)
    });
    await fsp.mkdir(workDir, { recursive: true });
    let lastPersist = 0;
    run.live = { stage: 'browser', detail: 'Opening URL in CloakBrowser' };
    const got = await browser.download(urlObj.href, workDir, {
      fallbackName: 'download.bin',
      maxBytes: c.maxArchiveBytes,
      stallMs: DOWNLOAD_STALL_MS,
      signal: state.abort.signal,
      onProgress: (progress) => {
        run.live = { stage: 'download', ...progress };
        if (Date.now() - lastPersist > 2000) {
          lastPersist = Date.now();
          persist(c, run).catch(() => {});
        }
      }
    });
    archivePath = got.path;
    const filename = got.filename;
    log('ok', `CloakBrowser started download "${filename}" from ${got.finalUrl}`);

    const dlMs = Date.now() - t0;
    const stat = await fsp.stat(archivePath);
    if (!stat.size) throw new Error('Downloaded file is empty');
    const rate = stat.size / 1024 / 1024 / Math.max(0.001, dlMs / 1000);
    log('ok', `Downloaded ${mb(stat.size)} in ${(dlMs / 1000).toFixed(1)}s (${rate.toFixed(1)} MB/s)`);

    // -- classify ---------------------------------------------------------
    const head = Buffer.alloc(512);
    const fh = await fsp.open(archivePath, 'r');
    const { bytesRead } = await fh.read(head, 0, 512, 0);
    await fh.close();
    const magic = sniffMagic(head.subarray(0, bytesRead));

    if (magic.kind === 'html') {
      // Peek, never readFile: "HTML" is only known from the first bytes, and
      // the file behind them could still be huge.
      const peek = Buffer.alloc(BODY_PEEK_BYTES);
      const ph = await fsp.open(archivePath, 'r');
      const got = await ph.read(peek, 0, BODY_PEEK_BYTES, 0);
      await ph.close();
      const snippet = peek.subarray(0, got.bytesRead).toString('utf8');
      if (looksLikeChallenge(snippet)) {
        throw new BlockedError(
          'CloakBrowser received a Cloudflare challenge page instead of the requested archive.'
        );
      }
      const title = pageTitle(snippet);
      throw new Error(`The download was an HTML page, not an archive${title ? ` (title "${title}")` : ''}`);
    }
    if (magic.kind === 'unknown') {
      throw new Error(
        `Downloaded bytes match no known format (first bytes ${JSON.stringify(head.subarray(0, 8).toString('latin1'))})`
      );
    }
    log('ok', `File is a real ${magic.kind === 'dem' ? 'CS2 demo' : magic.kind} (magic bytes check out)`);

    // unpackUpload dispatches on the filename, so make the name agree with
    // the bytes when the URL gave us something unhelpful.
    if (magic.ext && !archivePath.toLowerCase().endsWith(magic.ext)) {
      const renamed = `${archivePath}${magic.ext}`;
      await fsp.rename(archivePath, renamed);
      archivePath = renamed;
      log('info', `Renamed to ${path.basename(archivePath)} to match its magic bytes`);
    }

    // -- unpack -----------------------------------------------------------
    let demos;
    if (magic.kind === 'dem') {
      demos = [{ name: path.basename(archivePath), path: archivePath, sizeBytes: stat.size }];
    } else {
      if (magic.kind === 'rar') {
        const rar = rarSupport();
        if (!rar) {
          throw new Error(
            'The archive is RAR and this host has no extractor (unar or bsdtar). ' +
              'The Docker image installs both, so this points at a broken deploy.'
          );
        }
        log('info', `RAR extractor on this host: ${rar}`);
      }
      const extractDir = path.join(workDir, 'extract');
      run.live = { stage: 'unpack' };
      demos = await unpackArchive(archivePath, extractDir, {
        allowedBytes: c.maxArchiveBytes * 4
      });
      if (!demos.length) throw new Error('The archive unpacked but contained no .dem files');
      for (const d of demos) log('ok', `Extracted ${d.name} (${mb(d.sizeBytes)})`);
    }

    // -- parse + package ---------------------------------------------------
    await fsp.mkdir(outDir, { recursive: true });
    let parsedOk = 0;
    for (const demo of demos) {
      const stem = path.basename(demo.name, path.extname(demo.name));
      const outPath = path.join(outDir, `${stem}.aim4replay`);
      log('info', `Parsing ${demo.name} (${mb(demo.sizeBytes)}) in a capped child process`);
      const p0 = Date.now();
      try {
        const summary = await packageDemo(
          demo.path,
          outPath,
          { filename: demo.name, sizeBytes: demo.sizeBytes },
          (msg) => {
            run.live = {
              stage: 'parse',
              detail: demo.name,
              round: msg.round,
              total: msg.total,
              parseStage: msg.stage
            };
          }
        );
        parsedOk++;
        run.packages.push({ name: path.basename(outPath), path: outPath, ...summary });
        log(
          'ok',
          `Parsed ${demo.name} in ${((Date.now() - p0) / 1000).toFixed(0)}s: ` +
            `${summary.mapName || summary.map} ${summary.score?.team1 ?? '?'}:${summary.score?.team2 ?? '?'} ` +
            `(${summary.team1} vs ${summary.team2}, ${summary.roundCount} rounds) -> ` +
            `${path.basename(outPath)} (${mb(summary.packageBytes)})`
        );
      } catch (err) {
        if (run.cancelled) throw err;
        log('error', `Parse failed for ${demo.name}: ${err?.message || err}`);
      }
      // The .dem has served its purpose either way; a probe keeps only packages.
      if (demo.path !== archivePath) {
        await fsp.rm(demo.path, { force: true }).catch(() => {});
        log('info', `Deleted ${demo.name}`);
      }
    }
    run.live = null;
    run.keptDir = parsedOk ? outDir : null;

    // -- cleanup ----------------------------------------------------------
    await fsp.rm(workDir, { recursive: true, force: true });
    archivePath = null;
    log('ok', 'Deleted the downloaded archive and every extracted .dem');
    if (!parsedOk) {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Download and unpack worked, but 0 of ${demos.length} demos parsed`);
    }

    const keptBytes = run.packages.reduce((s, p) => s + (p.packageBytes || 0), 0);
    for (const p of run.packages) log('info', `Kept ${p.path}`);
    await finish(
      'ok',
      `PASS. Downloaded ${mb(stat.size)} without a challenge, parsed ${parsedOk} of ${demos.length} ` +
        `demo${demos.length === 1 ? '' : 's'}, kept ${parsedOk} .aim4replay package${parsedOk === 1 ? '' : 's'} ` +
        `(${mb(keptBytes)}). Sources deleted.`
    );
  } catch (err) {
    // Whatever got half-made goes, except the packages already finished.
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    const blocked = err instanceof BlockedError || err?.blocked;
    await finish(blocked ? 'blocked' : 'failed', err?.message || String(err));
  } finally {
    await browser?.close().catch(() => {});
  }
}
