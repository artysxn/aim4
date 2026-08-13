#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-pipeline.mjs
// Train a sim brain on THIS machine, in one command: collect, train, eval, install.
//
// SIM-PLAN 9.2 puts the gradient steps on the 4090 and the control surface in
// the /sim panel, joined by a thin FILE seam: Node writes a dataset, Python
// writes weights, a model file lands in a directory the site reads, and the
// product keeps zero Python at runtime. The panel is the remote control for
// that seam. This is the local one, and it drives the exact same three scripts
// that already exist:
//
//   scripts/sim-collect-bc.mjs   self-play -> dataset JSONL   (node)
//   scripts/sim-train-bc.py      dataset -> model JSON        (python + numpy)
//   scripts/sim-eval-bc.mjs      model vs baseline, paired    (node)
//
// Nothing here reimplements a stage. It orders them, carries the paths between
// them, and stops on the first failure — because the thing that actually costs
// an evening is not the arithmetic, it is running collect for ninety seconds
// and only then discovering that this box's `python3` is the Microsoft Store
// advert. So the interpreter is resolved BEFORE the first stage runs, never
// lazily at train time.
//
// TWO MODEL DIRECTORIES, the same two-source convention server/sim/bakes.js
// documents for bakes:
//
//   <AIM4_REPLAY_DIR|server/data/replays>/sim/models/<name>.json   local, wins, what a running site loads
//   simdata/models/<name>.json                                     shipped, committed, the fallback
//
// The install stage writes the LOCAL one only. Shipping is a deliberate human
// act: it is a commit, it changes what every visitor plays against, and a
// script that copied into simdata/ as a side effect of a good val accuracy
// would eventually ship a bad brain at 3am with nobody in the loop.
//
// Every stage is a CHILD PROCESS with inherited stdio, so an overnight run
// shows live progress rather than a frozen cursor, and every stage is timed,
// because the summary block at the end is the only part of a four-hour log
// anybody reads in the morning.
//
// Usage:
//   node scripts/sim-pipeline.mjs
//   node scripts/sim-pipeline.mjs --map INF --matches 6 --rounds 12 --epochs 60 --name bc0
//   node scripts/sim-pipeline.mjs --skip collect --epochs 120     # re-train on the last dataset
//   node scripts/sim-pipeline.mjs --dataset /path/bc.jsonl --skip eval
//   node scripts/sim-pipeline.mjs --dry-run
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { loadPolicy } from '../shared/sim/policy.js';
import { REPO_ROOT, describePython, findPython } from './lib/simPython.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAP = String(flag('map', 'INF')).toUpperCase();
const MATCHES = Number(flag('matches', 6));
const ROUNDS = Number(flag('rounds', 12));
const SEED = Number(flag('seed', 40));
const EPOCHS = Number(flag('epochs', 60));
const EMBED_DIM = Number(flag('embed-dim', 16));
const NAME = String(flag('name', 'bc0'));
const EVAL_MATCHES = Number(flag('eval-matches', 10));
const EVAL_ROUNDS = Number(flag('eval-rounds', 12));
const DATASET_IN = flag('dataset', null);
const DRY_RUN = args.includes('--dry-run');

const STAGES = ['collect', 'train', 'eval', 'install'];
const SKIP = new Set(
  String(flag('skip', ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function die(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

for (const s of SKIP) {
  if (!STAGES.includes(s)) die(`--skip: no stage called "${s}" (stages: ${STAGES.join(', ')})`);
}
// The model name becomes a filename the site loads by name; keep it a name.
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(NAME)) {
  die(`--name ${NAME}: model names are letters, digits, dot, dash, underscore`);
}
for (const [label, n] of [
  ['matches', MATCHES],
  ['rounds', ROUNDS],
  ['seed', SEED],
  ['epochs', EPOCHS],
  ['eval-matches', EVAL_MATCHES],
  ['eval-rounds', EVAL_ROUNDS]
]) {
  if (!Number.isFinite(n) || n < 0) die(`--${label} must be a number, got "${n}"`);
}
if (!Number.isFinite(EMBED_DIM) || EMBED_DIM < 0) die('--embed-dim must be 0 or more (0 disables)');

// An explicit dataset is a statement that collection already happened.
if (DATASET_IN) SKIP.add('collect');
const runs = (stage) => !SKIP.has(stage);

const SIM_DIR = path.join(REPLAY_ROOT, 'sim');
// The same name sim-collect-bc.mjs would choose for itself, computed here so
// train and the summary know the path without parsing a child's stdout — and
// so `--skip collect` lands on the dataset the identical flags produced.
const DATASET = DATASET_IN
  ? path.resolve(DATASET_IN)
  : path.join(SIM_DIR, 'datasets', `bc-${MAP.toLowerCase()}-s${SEED}x${MATCHES}.jsonl`);
// Freshly trained weights land in a staging directory, NOT in models/. A model
// under models/ is live to any running site the moment it appears; a candidate
// that has not passed eval yet has no business being loadable.
const STAGED_MODEL = path.join(SIM_DIR, 'train', `${NAME}.json`);
const LOCAL_MODEL = path.join(SIM_DIR, 'models', `${NAME}.json`);
const SHIPPED_MODEL = path.join(REPO_ROOT, 'simdata', 'models', `${NAME}.json`);

const COLLECT = path.join(REPO_ROOT, 'scripts', 'sim-collect-bc.mjs');
const TRAIN = path.join(REPO_ROOT, 'scripts', 'sim-train-bc.py');
const EVAL = path.join(REPO_ROOT, 'scripts', 'sim-eval-bc.mjs');

const dur = (ms) => {
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
};
const quote = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);
const line = (cmd, argv) => [cmd, ...argv].map(quote).join(' ');

/**
 * The dataset's meta record: line 1 of the JSONL. Read as a head slice rather
 * than a whole file — these run to megabytes and all that is wanted is a count.
 */
async function datasetMeta(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const first = text.split('\n')[0];
    return JSON.parse(first);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Run one stage as a child process.
 *
 * `capture` tees stdout: the user still sees it live, and the pipeline keeps
 * the tail so the summary can quote eval's verdict instead of asking the user
 * to scroll back through four hours of dots.
 */
function run(cmd, argv, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      cwd: REPO_ROOT,
      stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true
    });
    let tail = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        tail = (tail + chunk).slice(-8000);
      });
    }
    child.on('error', (error) => resolve({ code: -1, error, tail }));
    child.on('close', (code) => resolve({ code: code ?? -1, tail }));
  });
}

async function main() {
  const timings = [];
  const t00 = Date.now();

  // Python first, even though it is the second stage: discovering after a
  // ninety-second collect that no interpreter here has numpy is precisely the
  // failure this ordering exists to prevent. A run that never trains does not
  // need one, and is not blocked on having one.
  let python = null;
  if (runs('train')) {
    try {
      python = findPython();
    } catch (err) {
      die('', err.message, '', 'or run with --skip train if you only wanted the other stages.');
    }
  }

  const plan = [];
  if (runs('collect')) {
    plan.push({
      stage: 'collect',
      cmd: process.execPath,
      argv: [COLLECT, '--map', MAP, '--matches', String(MATCHES), '--rounds', String(ROUNDS), '--seed', String(SEED), '--out', DATASET]
    });
  }
  if (runs('train')) {
    plan.push({
      stage: 'train',
      // The trainer's own --seed stays at its default: the pipeline's --seed is
      // the SELF-PLAY seed, and quietly reusing it for weight init would tie two
      // unrelated sources of randomness together.
      cmd: python.command,
      argv: [TRAIN, DATASET, '--out', STAGED_MODEL, '--epochs', String(EPOCHS), '--embed-dim', String(EMBED_DIM)]
    });
  }
  // What eval grades: this run's candidate when there is one, otherwise the
  // model already installed under that name (so `--skip collect,train` re-grades
  // what the site is actually loading).
  const evalTarget = runs('train') || fsSync.existsSync(STAGED_MODEL) ? STAGED_MODEL : LOCAL_MODEL;
  if (runs('eval')) {
    plan.push({
      stage: 'eval',
      // Eval keeps sim-eval-bc's own seed default (100), disjoint from the
      // collect seeds: grading a clone on the very rounds it was cloned from
      // measures memorisation, not play.
      cmd: process.execPath,
      argv: [EVAL, '--model', evalTarget, '--maps', MAP, '--matches', String(EVAL_MATCHES), '--rounds', String(EVAL_ROUNDS)],
      capture: true
    });
  }

  console.log(`sim-pipeline: map ${MAP}, seed ${SEED}, model "${NAME}"`);
  console.log(`  python   ${python ? describePython(python) : 'not needed (train skipped)'}`);
  console.log(`  dataset  ${DATASET}${runs('collect') ? '' : ' (existing)'}`);
  console.log(`  stages   ${STAGES.map((s) => (runs(s) ? s : `~${s}`)).join(' -> ')}${SKIP.size ? '   (~ = skipped)' : ''}`);

  if (DRY_RUN) {
    console.log('\nplan:');
    for (const [i, step] of plan.entries()) {
      console.log(`  ${i + 1}. ${step.stage.padEnd(8)} ${line(step.cmd, step.argv)}`);
    }
    if (runs('install')) {
      console.log(`  ${plan.length + 1}. install  ${STAGED_MODEL}  ->  ${LOCAL_MODEL}`);
    }
    console.log('\nnothing was run (--dry-run).');
    return;
  }

  for (const step of plan) {
    console.log(`\n--- ${step.stage} ---`);
    console.log(`$ ${line(step.cmd, step.argv)}`);
    const t0 = Date.now();
    const result = await run(step.cmd, step.argv, { capture: step.capture });
    timings.push({ stage: step.stage, ms: Date.now() - t0 });
    if (result.code !== 0) {
      console.error(`\nstage "${step.stage}" failed with exit code ${result.code}.`);
      if (result.error) console.error(`  ${result.error.message}`);
      console.error(`  command: ${line(step.cmd, step.argv)}`);
      console.error(`  stages that did run: ${timings.map((t) => `${t.stage} ${dur(t.ms)}`).join(', ') || 'none'}`);
      process.exit(1);
    }
    if (step.capture) step.tail = result.tail;
  }

  // ---- install: the only stage that is file work rather than a child --------
  let installed = null;
  let valAccuracy = null;
  if (runs('install')) {
    const t0 = Date.now();
    let json;
    try {
      json = JSON.parse(await fs.readFile(STAGED_MODEL, 'utf8'));
    } catch (err) {
      die(
        `install: no trained model at ${STAGED_MODEL}`,
        `  ${err.message}`,
        '  run the train stage (drop --skip train) or point --name at a model that exists.'
      );
    }
    // Validate before it lands: models/ is live, and loadPolicy is the exact
    // gate the site will apply, so a shape error surfaces here rather than as a
    // broken bot in somebody's browser.
    try {
      loadPolicy(json);
    } catch (err) {
      die(`install: ${STAGED_MODEL} is not a loadable policy`, `  ${err.message}`);
    }
    await fs.mkdir(path.dirname(LOCAL_MODEL), { recursive: true });
    await fs.copyFile(STAGED_MODEL, LOCAL_MODEL);
    installed = LOCAL_MODEL;
    valAccuracy = JSON.parse(await fs.readFile(LOCAL_MODEL, 'utf8')).valAccuracy ?? null;
    timings.push({ stage: 'install', ms: Date.now() - t0 });

    console.log(`\n--- install ---`);
    console.log(`installed ${installed}`);
    console.log(`val accuracy ${valAccuracy === null ? 'not recorded in the model' : valAccuracy}`);
    console.log(`to ship this model with the site, copy it to simdata/models/${NAME}.json and commit`);
    console.log(`  ${SHIPPED_MODEL}`);
  } else if (fsSync.existsSync(STAGED_MODEL)) {
    valAccuracy = (await fs.readFile(STAGED_MODEL, 'utf8').then(JSON.parse).catch(() => ({}))).valAccuracy ?? null;
  }

  // ---- the morning-after block ---------------------------------------------
  const meta = await datasetMeta(DATASET);
  const evalStep = plan.find((s) => s.stage === 'eval');
  // sim-eval-bc names the candidate by whatever --model it was handed, which
  // here is an absolute staging path; in the summary that is 90 columns of
  // directory in front of the only number that matters.
  const shorten = (l) => l.split(STAGED_MODEL).join(`"${NAME}"`).split(LOCAL_MODEL).join(`"${NAME}"`);
  const verdict = (evalStep?.tail || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('overall:') || l.startsWith('gate ('))
    .map(shorten);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`sim-pipeline summary: map ${MAP}, model "${NAME}"`);
  if (python) console.log(`  python    ${describePython(python)}`);
  for (const stage of STAGES) {
    const t = timings.find((x) => x.stage === stage);
    console.log(`  ${stage.padEnd(9)} ${t ? dur(t.ms).padStart(7) : 'skipped'}`);
  }
  console.log(`  ${'total'.padEnd(9)} ${dur(Date.now() - t00).padStart(7)}`);
  console.log(`  dataset   ${DATASET}`);
  console.log(`            ${meta ? `${meta.samples} samples, teacher ${meta.teacher}, obs v${meta.obsVersion}` : 'meta unreadable'}`);
  console.log(`  model     ${installed || `${STAGED_MODEL} (not installed)`}`);
  console.log(`            val accuracy ${valAccuracy === null ? 'unknown' : valAccuracy}`);
  if (verdict.length) for (const l of verdict) console.log(`  eval      ${l}`);
  else if (runs('eval')) console.log('  eval      no verdict line captured');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
