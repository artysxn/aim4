#!/usr/bin/env node
// ---------------------------------------------------------------------------
// server/ingest/hltv/cli.js
// Command line entry point for the ingester.
//
//   node server/ingest/hltv/cli.js check
//   node server/ingest/hltv/cli.js discover  --source local --inbox ~/Downloads
//   node server/ingest/hltv/cli.js run       --source local --inbox ~/Downloads --limit 2
//   node server/ingest/hltv/cli.js run       --continuous
//   node server/ingest/hltv/cli.js status
//
// Local test runs should use --library scratch so nothing lands in the real
// demo library, and --state-dir so the test ledger is separate too.
// ---------------------------------------------------------------------------

import '../../env.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openLedger } from './ledger.js';
import { seekCursor } from './cursor.js';
import { createPipeline } from './pipeline.js';
import { createLocalSource } from './sources/local.js';
import { createHltvSource } from './sources/hltv.js';
import { rarSupport } from '../../replays/archive.js';
import { SHARED_LIBRARY } from '../../replays/auth.js';
import { emptyStatus, foldEvent, readStatus, writeStatus } from './status.js';

/** File-backed stdout/stderr is block-buffered; force lines into ingest.log promptly. */
try {
  process.stdout._handle?.setBlocking?.(true);
  process.stderr._handle?.setBlocking?.(true);
} catch {
  /* best-effort */
}

async function switchIsOn(cfg) {
  try {
    const raw = JSON.parse(
      await fsp.readFile(path.join(cfg.stateDir, 'desired.json'), 'utf8')
    );
    return Boolean(raw.enabled);
  } catch {
    return false;
  }
}

const FLAGS = {
  '--source': 'source',
  '--inbox': 'inbox',
  '--library': 'library',
  '--state-dir': 'stateDir',
  '--work-dir': 'workDir',
  '--since': 'since',
  '--until': 'until',
  '--batch-size': 'batchSize',
  '--parse-concurrency': 'parseConcurrency',
  '--limit': 'limit'
};
const BOOLS = {
  '--continuous': 'continuous',
  '--keep-sources': 'keepSources',
  '--verbose': 'verbose',
  '--dry-run': 'dryRun'
};

function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'run';
  const out = {};
  for (let i = cmd === argv[0] ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLS[a]) out[BOOLS[a]] = true;
    else if (FLAGS[a]) out[FLAGS[a]] = argv[++i];
  }
  for (const k of ['batchSize', 'parseConcurrency', 'limit']) {
    if (out[k] !== undefined) out[k] = Number(out[k]);
  }
  return { cmd, opts: out };
}

function makeSource(cfg) {
  // Belt-and-braces: never construct a local source with no inbox, even if a
  // caller skipped loadConfig's coerce (or an old binary is mid-deploy).
  if (cfg.source === 'local' && !cfg.inbox) {
    console.warn('[ingest] source=local with no inbox; using hltv');
    cfg.source = 'hltv';
  }
  if (cfg.source === 'hltv') return createHltvSource(cfg);
  if (cfg.source === 'local') return createLocalSource(cfg);
  throw new Error(`Unknown --source ${cfg.source}. Use "local" or "hltv".`);
}

function rarLabel() {
  const rar = rarSupport();
  return rar?.available ? rar.tool : 'MISSING';
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`;

let lastProgressLogAt = 0;
let lastProgressKey = '';

function logEvent(e, verbose) {
  switch (e.type) {
    case 'recovered':
      console.log(`recovered: ${e.requeued} requeued, ${e.orphansRemoved} orphan dirs (${mb(e.freed)})`);
      break;
    case 'discovered':
      console.log(`discovered: ${e.found} archives, ${e.added} new`);
      break;
    case 'batch-start':
      console.log(`\nbatch of ${e.size}: ${e.matchIds.join(', ')}`);
      break;
    case 'match-start':
      console.log(`  -> ${e.label}`);
      break;
    case 'match-progress': {
      const stage = e.stage || 'work';
      if (e.skipped) {
        console.log(`     skip ${e.map || ''}: ${e.skipped}`);
      } else if (e.round) {
        console.log(`     ${stage}: ${e.map || ''} round ${e.round}/${e.total || '?'}`);
      } else if (stage !== 'download') {
        console.log(`     ${stage}${e.map ? `: ${e.map}` : ''}`);
      }
      break;
    }
    case 'match-ingested':
      console.log(
        `\n     ingested ${e.maps} map(s)` +
          `${e.duplicates ? `, ${e.duplicates} duplicate` : ''}` +
          `${e.failed ? `, ${e.failed} failed` : ''}` +
          `${e.crashed ? ` (${e.crashed} crash)` : ''} ` +
          `as ${(e.teams || []).join(' vs ')} [${(e.naming || []).join(',')}]`
      );
      break;
    case 'match-duplicate':
      console.log(`\n     duplicate: skipped ${e.maps} map(s) already in library`);
      break;
    case 'match-skipped':
      console.log(
        `\n     skipped ${e.maps} map(s) (${e.reason || 'filtered'})` +
          `${e.names?.length ? `: ${e.names.join(', ')}` : ''}; next download`
      );
      break;
    case 'match-cleaned':
      console.log(`     cleaned, freed ${mb(e.freed)}`);
      break;
    case 'match-failed':
      console.log(
        e.retryable
          ? `\n     FAILED (will retry): ${e.error}`
          : `\n     FAILED (skipped demo): ${e.error}` +
              `${e.crashed ? ` [${e.crashed} map crash(es)]` : ''}`
      );
      break;
    case 'download-start':
      console.log(`\n-> demo/${e.demoId || e.matchId} download`);
      lastProgressLogAt = 0;
      lastProgressKey = '';
      break;
    case 'download-progress': {
      const phase = e.phase || 'download';
      const secs = e.elapsedMs != null ? Math.round(e.elapsedMs / 1000) : null;
      const key = `${phase}:${e.detail || ''}:${Math.floor((e.received || 0) / (5 * 1024 * 1024))}:${secs != null ? Math.floor(secs / 5) : 0}`;
      const now = Date.now();
      if (key === lastProgressKey && now - lastProgressLogAt < 4000) break;
      lastProgressKey = key;
      lastProgressLogAt = now;
      const size =
        e.received > 0
          ? `${mb(e.received)}${e.total ? ` / ${mb(e.total)}` : ''}`
          : '';
      const bits = [
        phase,
        secs != null ? `${secs}s` : null,
        e.detail || null,
        size || null
      ].filter(Boolean);
      console.log(`     ${bits.join(' · ')}`);
      break;
    }
    case 'download-complete':
      console.log(`     downloaded ${mb(e.bytes)} (${e.label || e.matchId})`);
      break;
    case 'download-failed':
      console.log(
        `     download ${e.missing ? 'missing' : e.blocked ? 'blocked' : 'failed'} for ${e.matchId}: ${e.error}`
      );
      break;
    case 'challenge':
      console.log(
        `${e.reason === 'infra' ? 'infra hold' : 'challenge'} on demo/${e.demoId}; ` +
          `retry in ${Math.round((e.nextCheckInMs || 0) / 1000)}s` +
          (e.reason === 'infra' && e.error ? ` (${String(e.error).split('\n')[0]})` : '')
      );
      break;
    case 'cursor':
      console.log(
        `cursor: demo/${e.nextId} · ${e.done}/${e.total} · ${e.loopsPerHour}/h · left ${e.left}`
      );
      break;
    case 'frontier-miss':
      console.log(
        `frontier: demo/${e.demoId} missing` +
          `${e.lastSuccessId != null ? ` (last ok ${e.lastSuccessId})` : ''}`
      );
      break;
    case 'frontier-lookahead-start':
      console.log(
        `frontier: checking demo/${e.baseId + 1}..demo/${e.throughId} before wait`
      );
      break;
    case 'frontier-lookahead':
      console.log(
        `frontier: trying demo/${e.demoId} (${e.attempt}/${e.of} ahead of ${e.baseId})`
      );
      break;
    case 'frontier-gap-jump':
      console.log(
        `frontier: gap jump demo/${e.fromId} -> demo/${e.toId} (skipped ${e.skipped})`
      );
      break;
    case 'gap-skipped':
      console.log(`     gap: demo/${e.demoId} marked missing`);
      break;
    case 'frontier':
      console.log(
        `frontier: demo/${e.demoId} missing` +
          `${e.lastSuccessId != null ? ` (last ok ${e.lastSuccessId})` : ''}` +
          `${e.lookedAheadTo != null ? ` through demo/${e.lookedAheadTo}` : ''}; ` +
          `retry in ${Math.round(e.nextCheckInMs / 60000)} min`
      );
      break;
    case 'idle':
      console.log(
        e.reason === 'frontier'
          ? `waiting for demo/${e.demoId}` +
              `${e.lookedAheadTo != null ? ` (checked through ${e.lookedAheadTo})` : ''}` +
              `; next check in ${Math.round(e.nextPollInMs / 1000)}s`
          : e.reason === 'challenge' || e.reason === 'infra' || e.reason === 'disk'
            ? `waiting after ${e.reason} on demo/${e.demoId}; next try in ${Math.round(e.nextPollInMs / 1000)}s`
            : `idle; next poll in ${Math.round(e.nextPollInMs / 1000)}s`
      );
      break;
    case 'run-end':
      console.log(`run end: loops=${e.batches || 0}${e.stopped ? ' (stopped)' : ''}`);
      break;
    default:
      if (verbose) console.log(e.type, JSON.stringify(e));
  }
}

/** Set once the HLTV source exists so crash handlers can release Pro seats. */
let emergencyClose = async () => {};

function isSessionLimitCrash(err) {
  return /session limit reached/i.test(String(err?.message || err || ''));
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(opts);
  if (!cfg.library) cfg.library = SHARED_LIBRARY;
  if (cfg.cloakBrowserCacheDir) {
    process.env.CLOAKBROWSER_CACHE_DIR = cfg.cloakBrowserCacheDir;
    await fsp.mkdir(cfg.cloakBrowserCacheDir, { recursive: true }).catch(() => {});
  }

  if (cmd === 'help' || opts.help) {
    console.log(`aim4 HLTV ingester

  check      preflight: extractor, source reachability, paths
  discover   populate the ledger, download nothing
  run        download -> unpack -> parse -> ingest -> delete (HLTV: sequential demo ids)
  status     counts from the ledger

Flags: ${Object.keys(FLAGS).concat(Object.keys(BOOLS)).join(' ')}
Env: AIM4_INGEST_DEMO_START=109575 AIM4_INGEST_FRONTIER_WAIT_MS=600000`);
    return;
  }

  const ledger = await openLedger(cfg.ledgerPath);

  if (cmd === 'status') {
    const counts = ledger.counts();
    const next = ledger.oldestPending();
    console.log(JSON.stringify({ counts, next: next?.archiveName || null }, null, 2));
    return;
  }

  let source = makeSource(cfg);
  emergencyClose = async () => {
    await source.close?.().catch(() => {});
  };
  try {
    if (cmd === 'check') {
      const checks = [];
      checks.push(['rar extractor', rarLabel()]);
      checks.push(['source mode', cfg.source]);
      try {
        const r = await source.check();
        checks.push([`source: ${source.name}`, r.detail || 'ok']);
      } catch (err) {
        checks.push([`source: ${source.name}`, `FAILED: ${err.message}`]);
      }
      checks.push(['library', cfg.library]);
      checks.push(['state dir', cfg.stateDir]);
      checks.push(['work dir', cfg.workDir]);
      checks.push(['demo start', String(cfg.demoStart)]);
      for (const [k, v] of checks) console.log(`${k.padEnd(24)} ${v}`);
      return;
    }

    await fsp.mkdir(cfg.stateDir, { recursive: true });
    await fsp.mkdir(cfg.workDir, { recursive: true });

    // Status is written on every event so the admin page has something to read.
    // Best-effort: a failed status write must never stop an ingest.
    let status = {
      ...emptyStatus(),
      running: true,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    let statusQueue = Promise.resolve();
    const pushStatus = () => {
      statusQueue = statusQueue
        .then(() => writeStatus(cfg.statusPath, status))
        .catch(() => {});
    };
    const failStatus = async (err) => {
      status = {
        ...status,
        running: false,
        stoppedAt: new Date().toISOString(),
        lastError: String(err?.message || err)
      };
      await writeStatus(cfg.statusPath, status).catch(() => {});
    };

    try {
      const preflight = await source.check();
      console.log(`[ingest] source check: ${preflight?.detail || 'ok'}`);
    } catch (err) {
      // Last resort if something still built a local source without inbox.
      if (/source=local needs --inbox/i.test(String(err?.message || ''))) {
        console.warn(`[ingest] ${err.message}; switching to hltv`);
        cfg.source = 'hltv';
        cfg.inbox = '';
        await source.close?.().catch(() => {});
        source = makeSource(cfg);
        const preflight = await source.check().catch((e) => ({ detail: e.message }));
        console.log(`[ingest] source check: ${preflight?.detail || 'ok'}`);
      } else {
        // Sequential HLTV can still try downloads even if a soft preflight fails.
        console.warn(`[ingest] source check failed (${err.message}); continuing`);
      }
    }

    const pipe = createPipeline({
      cfg,
      ledger,
      source,
      onEvent: (e) => {
        logEvent(e, cfg.verbose);
        status = foldEvent(status, e, ledger);
        pushStatus();
      }
    });
    pushStatus();

    if (cmd === 'discover') {
      const r = await pipe.discover();
      console.log(JSON.stringify({ ...r, counts: ledger.counts() }, null, 2));
      return;
    }

    if (cmd !== 'run') throw new Error(`Unknown command ${cmd}`);

    if (Number(cfg.demoSeek) > 0) {
      const sought = await seekCursor(cfg, cfg.demoSeek);
      console.log(`[ingest] seek cursor -> demo/${sought.nextId} (AIM4_INGEST_DEMO_SEEK)`);
    }

    console.log(
      `[ingest] run start pid=${process.pid} source=${cfg.source}` +
        ` continuous=${Boolean(opts.continuous)} demoStart=${cfg.demoStart}` +
        ` library=${cfg.library}`
    );

    let stopping = false;
    const onSignal = (sig) => {
      void (async () => {
        if (stopping) return;
        // Off/Hard Restart use SIGKILL. Spurious SIGTERM (deploy helpers,
        // process-group noise) used to end continuous ingest with code 0 and
        // leave the UI stuck on Starting until the 60s supervisor tick.
        if (opts.continuous && (await switchIsOn(cfg))) {
          console.log(`[ingest] ignoring ${sig} (switch is on; use Off / Hard Restart)`);
          return;
        }
        stopping = true;
        console.log(`\n[ingest] ${sig}: aborting download...`);
        pipe.requestStop();
        void source.close?.().catch(() => {});
      })();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // --limit N is expressed in matches; the loop works in batches / demo ids.
    const maxBatches = opts.limit ? Math.ceil(opts.limit / Math.max(1, cfg.batchSize)) : Infinity;
    const started = Date.now();
    await pipe.run({ continuous: Boolean(opts.continuous), maxBatches });

    if (opts.continuous && !stopping) {
      throw new Error('continuous ingest ended without stop request');
    }

    const counts = ledger.counts();
    console.log(
      `\ndone in ${Math.round((Date.now() - started) / 1000)}s  ` +
        `cleaned=${counts.cleaned} review=${counts.needs_review} failed=${counts.failed_permanent} ` +
        `remaining=${counts.remaining}`
    );
  } finally {
    await source.close?.().catch(() => {});
  }
}

let exiting = false;
async function crashExit(err, { uncaught = false } = {}) {
  if (exiting) return;
  exiting = true;
  if (uncaught) console.error(`\n[ingest] uncaught: ${err?.stack || err}`);
  else console.error(`\n${err?.stack || err}`);
  await emergencyClose().catch(() => {});
  const sessionLimit = isSessionLimitCrash(err);
  try {
    const cfg = loadConfig({});
    if (!cfg.library) cfg.library = SHARED_LIBRARY;
    const prev = await readStatus(cfg.statusPath).catch(() => emptyStatus());
    await writeStatus(cfg.statusPath, {
      ...prev,
      running: false,
      pid: null,
      stoppedAt: new Date().toISOString(),
      lastError: String(err?.message || err)
    });
  } catch {
    /* best-effort */
  }
  // 78 = session-limit: supervisor holds spawn so we do not burn more seats.
  process.exit(sessionLimit ? 78 : 1);
}

main().catch((err) => crashExit(err));

// Cloak license checks throw from Playwright route dispatch outside the
// download await chain. Close the browser so the Pro seat can drop.
process.on('uncaughtException', (err) => {
  void crashExit(err, { uncaught: true });
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (
    isSessionLimitCrash(err) ||
    /CloakBrowserLicenseError/i.test(String(err?.name || '')) ||
    /license/i.test(String(err?.message || ''))
  ) {
    void crashExit(err, { uncaught: true });
    return;
  }
  console.error(`[ingest] unhandledRejection: ${err?.stack || err}`);
});
