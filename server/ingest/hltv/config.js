// ---------------------------------------------------------------------------
// server/ingest/hltv/config.js
// Every knob the ingester has, resolved in one place.
//
// Env first (that is what Coolify sets), flags override (that is what the local
// test run uses). Read at call time rather than at import, so a test can set
// process.env and get a fresh answer.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {Record<string, any>} [overrides]  parsed CLI flags
 */
export function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    /** Where the ledger and lock file live. Must survive restarts. */
    stateDir: env.AIM4_INGEST_STATE_DIR || path.join(ROOT, 'server', 'data', 'hltv-ingest'),
    /** Scratch space for archives and extracted demos. Emptied every batch. */
    workDir: env.AIM4_INGEST_WORK_DIR || path.join(ROOT, 'server', 'data', 'hltv-work'),
    /** Library to write into. `scratch` keeps a test run out of the real one. */
    library: env.AIM4_INGEST_LIBRARY || '',

    /** Matches downloaded and processed per batch. The headline constraint. */
    batchSize: num(env.AIM4_INGEST_BATCH_SIZE, 3),
    /** Parses at once. Lower than batchSize on purpose: parsing is the OOM risk. */
    parseConcurrency: num(env.AIM4_INGEST_PARSE_CONCURRENCY, 1),

    /** Discovery floor. Nothing older than this is ever queued. */
    since: env.AIM4_INGEST_SINCE || '2025-01-01',
    until: env.AIM4_INGEST_UNTIL || '',

    /** Politeness. See section 5 of HLTV-INGEST-PLAN.md. */
    minDelayMs: num(env.AIM4_INGEST_MIN_DELAY_MS, 20000),
    maxDelayMs: num(env.AIM4_INGEST_MAX_DELAY_MS, 40000),
    batchCooldownMs: num(env.AIM4_INGEST_BATCH_COOLDOWN_MS, 60000),
    userAgent:
      env.AIM4_INGEST_USER_AGENT || 'Mozilla/5.0',
    maxArchiveBytes: num(env.AIM4_INGEST_MAX_ARCHIVE_BYTES, 2 * 1024 ** 3),
    /** CloakBrowser transport shared by discovery, downloads, and the probe. */
    cloakHeadless: /^(1|true|yes|on)$/i.test(env.AIM4_CLOAK_HEADLESS || ''),
    cloakHumanize: !/^(0|false|no|off)$/i.test(env.AIM4_CLOAK_HUMANIZE || 'true'),
    cloakHumanPreset: env.AIM4_CLOAK_HUMAN_PRESET || 'careful',
    cloakDisableHttp2: !/^(0|false|no|off)$/i.test(env.AIM4_CLOAK_DISABLE_HTTP2 || 'true'),
    cloakFingerprintSeed: env.AIM4_CLOAK_FINGERPRINT_SEED || '',
    cloakLicenseKey: env.AIM4_CLOAK_LICENSE_KEY || env.CLOAKBROWSER_LICENSE_KEY || '',
    cloakGeoip: !/^(0|false|no|off)$/i.test(env.AIM4_CLOAK_GEOIP || 'true'),
    /** Single proxy URL, tried first before the file pool. */
    cloakProxy: env.AIM4_CLOAK_PROXY || '',
    /**
     * Newline-separated proxy list (http:// and socks5://). Default sits next
     * to the ingest state dir (gitignored / volume-mounted). Override with
     * AIM4_CLOAK_PROXY_FILE. Not baked into the Docker image.
     */
    cloakProxyFile: env.AIM4_CLOAK_PROXY_FILE || '',
    /** How many proxies to try per download/page before giving up. */
    cloakProxyAttempts: num(env.AIM4_CLOAK_PROXY_ATTEMPTS, 5),
    /** Random pick (default) vs sequential cursor through the pool. */
    cloakProxyRandom: !/^(0|false|no|off)$/i.test(env.AIM4_CLOAK_PROXY_RANDOM || 'true'),
    cloakSettleMs: num(env.AIM4_CLOAK_SETTLE_MS, 5000),
    /** How long one page may take to answer before the attempt is abandoned. */
    cloakNavigationTimeoutMs: num(env.AIM4_CLOAK_NAV_TIMEOUT_MS, 30_000),
    cloakDownloadDeadlineMs: num(env.AIM4_CLOAK_DOWNLOAD_DEADLINE_MS, 30 * 60_000),

    /** How often the continuous runner looks for newly finished matches. */
    pollIntervalMs: num(env.AIM4_INGEST_POLL_MS, 5 * 60 * 1000),

    /** First HLTV /download/demo/{id} to walk when source=hltv. */
    demoStart: num(env.AIM4_INGEST_DEMO_START, 109575),
    /**
     * Estimated newest working id for catch-up progress until a real frontier
     * 404 is observed. Does not stop the walker; only affects the progress bar.
     */
    demoHint: num(env.AIM4_INGEST_DEMO_HINT, 110206),
    /**
     * When set (>0), the runner seeks the cursor to this id once at process
     * start. Use after a successful probe (e.g. 110101) instead of grinding
     * cold ids. Prefer the admin Seek control for one-shots.
     */
    demoSeek: num(env.AIM4_INGEST_DEMO_SEEK, 0),
    /** Wait between retries when the next demo id is not published yet. */
    frontierWaitMs: num(env.AIM4_INGEST_FRONTIER_WAIT_MS, 10 * 60 * 1000),

    /** Refuse to start a batch below this much free disk. */
    minFreeBytes: num(env.AIM4_INGEST_MIN_FREE_BYTES, 10 * 1024 ** 3),

    /** Give up on a match after this many failed attempts. */
    maxAttempts: num(env.AIM4_INGEST_MAX_ATTEMPTS, 3),

    /**
     * Where archives come from. `local` watches a directory, `hltv` walks
     * sequential /download/demo/{id} URLs. See sources/ for what each needs.
     */
    source: env.AIM4_INGEST_SOURCE || 'hltv',
    /** For source=local: the directory holding .rar / .zip archives. */
    inbox: env.AIM4_INGEST_INBOX || '',

    /** Keep sources after a successful parse. Debugging only. */
    keepSources: env.AIM4_INGEST_KEEP_SOURCES === '1',
    verbose: false
  };

  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null) cfg[k] = v;
  }

  cfg.source = String(cfg.source || 'hltv').trim().toLowerCase() || 'hltv';
  cfg.inbox = String(cfg.inbox || '').trim();

  // Local mode requires an inbox. Coolify often still has AIM4_INGEST_SOURCE=local
  // with no AIM4_INGEST_INBOX from an older setup; that used to crash-loop the
  // supervisor. Fall back to sequential HLTV demo ids.
  if (cfg.source === 'local' && !cfg.inbox) cfg.source = 'hltv';

  cfg.ledgerPath = path.join(cfg.stateDir, 'ledger.json');
  cfg.lockPath = path.join(cfg.stateDir, 'ingest.lock');
  cfg.statusPath = path.join(cfg.stateDir, 'status.json');
  if (!cfg.cloakProxyFile) {
    cfg.cloakProxyFile = path.join(path.dirname(cfg.stateDir), 'cloak-proxies.txt');
  }
  cfg.cloakDownloadsDir =
    env.AIM4_CLOAK_DOWNLOADS_DIR || path.join(cfg.workDir, '.cloakbrowser-downloads');
  cfg.cloakProfileDir =
    env.AIM4_CLOAK_PROFILE_DIR || path.join(cfg.stateDir, 'cloakbrowser-profile');
  return cfg;
}
