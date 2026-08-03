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
import { loadConfig } from './config.js';
import { openLedger } from './ledger.js';
import { createPipeline } from './pipeline.js';
import { createLocalSource } from './sources/local.js';
import { createHltvSource } from './sources/hltv.js';
import { rarSupport } from '../../replays/archive.js';
import { SHARED_LIBRARY } from '../../replays/auth.js';
import { emptyStatus, foldEvent, writeStatus } from './status.js';

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
  if (cfg.source === 'hltv') return createHltvSource(cfg);
  if (cfg.source === 'local') return createLocalSource(cfg);
  throw new Error(`Unknown --source ${cfg.source}. Use "local" or "hltv".`);
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`;

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
    case 'match-progress':
      if (verbose && e.stage === 'parse' && e.round) {
        process.stdout.write(`\r     ${e.map} round ${e.round}/${e.total || '?'}   `);
      }
      break;
    case 'match-ingested':
      console.log(
        `\n     ingested ${e.maps} map(s)${e.failed ? `, ${e.failed} failed` : ''} ` +
          `as ${e.teams.join(' vs ')} [${e.naming.join(',')}]`
      );
      break;
    case 'match-cleaned':
      console.log(`     cleaned, freed ${mb(e.freed)}`);
      break;
    case 'match-failed':
      console.log(`\n     FAILED: ${e.error}`);
      break;
    case 'download-failed':
      console.log(`     download failed for ${e.matchId}: ${e.error}`);
      break;
    case 'idle':
      console.log(`idle; next poll in ${Math.round(e.nextPollInMs / 1000)}s`);
      break;
    default:
      if (verbose) console.log(e.type, JSON.stringify(e));
  }
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(opts);
  if (!cfg.library) cfg.library = SHARED_LIBRARY;

  if (cmd === 'help' || opts.help) {
    console.log(`aim4 HLTV ingester

  check      preflight: extractor, source reachability, paths
  discover   populate the ledger, download nothing
  run        download -> parse -> name -> ingest -> delete, in batches
  status     counts from the ledger

Flags: ${Object.keys(FLAGS).concat(Object.keys(BOOLS)).join(' ')}`);
    return;
  }

  const ledger = await openLedger(cfg.ledgerPath);

  if (cmd === 'status') {
    const counts = ledger.counts();
    const next = ledger.oldestPending();
    console.log(JSON.stringify({ counts, next: next?.archiveName || null }, null, 2));
    return;
  }

  const source = makeSource(cfg);

  if (cmd === 'check') {
    const checks = [];
    checks.push(['rar extractor (bsdtar)', rarSupport() ? 'ok' : 'MISSING']);
    try {
      const r = await source.check();
      checks.push([`source: ${source.name}`, r.detail || 'ok']);
    } catch (err) {
      checks.push([`source: ${source.name}`, `FAILED: ${err.message}`]);
    }
    checks.push(['library', cfg.library]);
    checks.push(['state dir', cfg.stateDir]);
    checks.push(['work dir', cfg.workDir]);
    for (const [k, v] of checks) console.log(`${k.padEnd(24)} ${v}`);
    return;
  }

  await fsp.mkdir(cfg.stateDir, { recursive: true });
  await fsp.mkdir(cfg.workDir, { recursive: true });
  await source.check();

  // Status is written on every event so the admin page has something to read.
  // Best-effort: a failed status write must never stop an ingest.
  let status = { ...emptyStatus(), running: true, pid: process.pid, startedAt: new Date().toISOString() };
  let statusQueue = Promise.resolve();
  const pushStatus = () => {
    statusQueue = statusQueue
      .then(() => writeStatus(cfg.statusPath, status))
      .catch(() => {});
  };

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

  const onSignal = () => {
    console.log('\nstopping after the current match...');
    pipe.requestStop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // --limit N is expressed in matches; the loop works in batches.
  const maxBatches = opts.limit ? Math.ceil(opts.limit / cfg.batchSize) : Infinity;
  const started = Date.now();
  await pipe.run({ continuous: Boolean(opts.continuous), maxBatches });

  const counts = ledger.counts();
  console.log(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s  ` +
      `cleaned=${counts.cleaned} review=${counts.needs_review} failed=${counts.failed_permanent} ` +
      `remaining=${counts.remaining}`
  );
}

main().catch((err) => {
  console.error(`\n${err?.stack || err}`);
  process.exit(1);
});
