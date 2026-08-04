#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One server-side training run, start to finish.
//
// Spawned detached by server/training/service.js and never invoked by a request
// thread. Two stages:
//
//   1. Extract. Incremental, so the demos already cached from previous runs are
//      skipped and only what the ingester has added since costs anything.
//   2. Fit. N generations on one seed, reporting every generation into the
//      status file, then offering the result to the champion slot, which keeps
//      it only if the held-out loss improved.
//
// Both stages are child processes rather than imports. The extractors and
// trainers are large CLI programs with their own argument handling and their
// own memory profile, and re-entering them as libraries would mean maintaining
// two ways to run the same code. Spawning is what the ingest pipeline does with
// its own CLI, for the same reason.
//
// Usage (normally only the service calls this):
//   node scripts/train-model-server.mjs --kind round --generations 30 --seed 7
// ---------------------------------------------------------------------------

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { paths } from '../server/training/config.js';
import { patchStatus, readStatus, writeStatus } from '../server/training/status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const kind = arg('--kind', 'round');
const generations = Number(arg('--generations', '30'));
const seed = Number(arg('--seed', '12345'));
const workers = Number(arg('--workers', '4'));
const force = has('--force');

const SCRIPTS = {
  round: {
    extract: 'extract-round-snapshots.mjs',
    train: 'train-round-model.mjs'
  },
  duel: {
    extract: 'extract-duel-episodes.mjs',
    train: 'train-duel-model.mjs'
  }
};

const p = paths(kind);

/** Run a child to completion, inheriting stdio into this run's log. */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      stdio: 'inherit',
      env: process.env
    });
    // A stop request must reach the stage that is actually working.
    const forward = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    child.on('exit', (code, signal) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      resolve({ code, signal });
    });
    child.on('error', () => resolve({ code: 1, signal: null }));
  });
}

async function main() {
  const cfg = SCRIPTS[kind];
  if (!cfg) throw new Error(`unknown model kind: ${kind}`);

  await patchStatus(p.status, { stage: 'extracting', pid: process.pid }, kind);

  // The library is the point of training here, but a developer running the
  // server locally has an empty one, so the source can be overridden to the
  // sample folder for a real end-to-end check without a populated volume.
  const source = process.env.AIM4_TRAIN_SOURCE === 'samples' ? 'samples' : 'library';
  const extractArgs = ['--source', source];
  if (force) extractArgs.push('--force');
  const extracted = await run(cfg.extract, extractArgs);
  if (extracted.signal === 'SIGTERM') {
    await patchStatus(
      p.status,
      { running: false, finished: true, finishedAt: new Date().toISOString(), stage: 'stopped' },
      kind
    );
    return;
  }
  if (extracted.code !== 0) {
    throw new Error(`extraction failed with code ${extracted.code}`);
  }

  await patchStatus(p.status, { stage: 'fitting', demosDone: 0 }, kind);

  const trained = await run(cfg.train, [
    '--generations',
    String(generations),
    '--seed',
    String(seed),
    '--workers',
    String(workers),
    '--status-file',
    p.status,
    '--champion',
    kind
  ]);

  const stopped = trained.signal === 'SIGTERM';
  if (!stopped && trained.code !== 0) {
    throw new Error(`training failed with code ${trained.code}`);
  }

  await patchStatus(
    p.status,
    {
      running: false,
      finished: true,
      finishedAt: new Date().toISOString(),
      stage: stopped ? 'stopped' : 'done'
    },
    kind
  );
}

main()
  .catch(async (err) => {
    const current = await readStatus(p.status, kind);
    await writeStatus(p.status, {
      ...current,
      running: false,
      finished: true,
      finishedAt: new Date().toISOString(),
      stage: 'failed',
      error: err.message || String(err)
    });
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The lock is this process's claim on the model; releasing it here means a
    // crash that skips this still resolves, because the service reconciles the
    // pid against the operating system rather than trusting the file.
    const fs = await import('node:fs/promises');
    await fs.rm(p.lock, { force: true }).catch(() => {});
  });
