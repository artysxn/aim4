// ---------------------------------------------------------------------------
// server/sim/jobs.js
// The sim job runner: bounded, preemptible, resumable work started from a
// browser and finished whether or not anyone is still watching.
//
// SIM-PLAN 9.2b, whose contract is one sentence: the constraint is no longer
// "prod never trains", it is "PROD NEVER STARVES". Everything below exists to
// make that true rather than aspirational.
//
//   Event loop   Jobs are child processes. A 24-round match took 30 seconds of
//                solid CPU inside the API process before this file existed,
//                which is 30 seconds of every other request waiting, and the
//                browser holding a request open for all of it with no way to
//                see progress or stop it. 14.29 already made this rule for the
//                parser; the sim gets no exemption.
//   Priority     A queued parse preempts sim work. Demos ingesting is the site
//                working; a sim job is a thing one admin asked for.
//   Concurrency  One sim job at a time. The pool of 9.2's rollout workers is a
//                later phase; this is the single slot it will schedule into.
//   Budget       Every job declares a wall-clock ceiling up front and is killed
//                at it. An unbounded overnight grind is exactly what the prod
//                box must not host.
//   Resumability A job is a DIRECTORY, written as it goes. Restarting the
//                server loses the process, never the record of what ran.
//   Gradients    Never here. A `train` job needs a Python with numpy and says
//                so plainly when there is none, instead of pretending.
//
// Jobs live at AIM4_REPLAY_DIR/sim/jobs/<id>/ (12.1: under the one directory
// that is isolated from everything users can see):
//
//   job.json     the record: kind, params, state, timings, exit, budget
//   log.txt      the child's stdout and stderr, tailed by the panel
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ROOT } from '../replays/demoStore.js';
import { loadBake } from './bakes.js';
import { isBrain, LOCAL_DIR, SHIPPED_DIR } from './models.js';
import { findPython } from '../../scripts/lib/simPython.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const JOBS_DIR = path.join(ROOT, 'sim', 'jobs');

/**
 * Heavy jobs are opt-in per deployment: 0 means this host runs matches (which
 * are seconds of one core) and refuses collection and training (which are
 * minutes to hours of it). The PC sets this; prod is not expected to.
 */
const HEAVY_ENABLED = Number(process.env.AIM4_SIM_WORKERS || 0) > 0;

/** Wall-clock ceilings, seconds. A job that hits one is killed, not warned. */
const BUDGETS = Object.freeze({
  match: Number(process.env.AIM4_SIM_BUDGET_MATCH || 600),
  collect: Number(process.env.AIM4_SIM_BUDGET_COLLECT || 3600),
  extract: Number(process.env.AIM4_SIM_BUDGET_EXTRACT || 3600),
  train: Number(process.env.AIM4_SIM_BUDGET_TRAIN || 3600),
  eval: Number(process.env.AIM4_SIM_BUDGET_EVAL || 1800),
  rollout: Number(process.env.AIM4_SIM_BUDGET_ROLLOUT || 3600),
  'rl-train': Number(process.env.AIM4_SIM_BUDGET_RLTRAIN || 3600)
});

/** Which kinds this host will accept at all. */
export const JOB_KINDS = Object.freeze(['match', 'collect', 'extract', 'train', 'eval', 'rollout', 'rl-train']);
const HEAVY_KINDS = new Set(['collect', 'extract', 'train', 'eval', 'rollout', 'rl-train']);

/** How much log a job keeps in memory for the panel's tail. */
const LOG_TAIL_LINES = 200;

const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
/**
 * Names that become file lookups (models, brains, maps) get the stricter rule
 * the registry itself uses: no dots, so nothing shaped like a path survives
 * long enough to be one.
 */
const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');
const num = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** id -> job record (the live view; job.json is the durable one). */
const jobs = new Map();
/** Waiting jobs, oldest first. */
const queue = [];
/** The one running job, or null. */
let active = null;

/**
 * Whether demo parsing wants the box right now. Wired by server/index.js so
 * this module does not import the parse queue (and so tests can drive it).
 * @type {() => boolean}
 */
let parserBusy = () => false;

/** SIM-PLAN 9.2b's preemption rail, injected rather than imported. */
export function setParserBusyProbe(fn) {
  if (typeof fn === 'function') parserBusy = fn;
}

// ---------------------------------------------------------------------------

function jobDir(id) {
  return path.join(JOBS_DIR, safe(id));
}

/** The record as the panel sees it: never the raw child handle. */
function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    state: job.state,
    params: job.params,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    elapsedMs: job.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : 0,
    budgetSeconds: job.budgetSeconds,
    progress: job.progress || null,
    error: job.error || null,
    exitCode: job.exitCode ?? null,
    result: job.result || null,
    artifacts: job.artifacts || {}
  };
}

/**
 * What a stage produced, picked out of its output as it streams.
 *
 * Reading the tail instead would be wrong in a way that is easy to miss: the
 * collector prints the file it wrote and THEN its label histogram, so the path
 * is not in the last few lines. Chaining collect into train from the panel
 * depends on this, so it watches every line rather than the end.
 */
function noteArtifacts(job, line) {
  const dataset = /->\s*(\S+\.jsonl)\s*$/.exec(line);
  if (dataset) job.artifacts.dataset = dataset[1];
  const model = /^wrote\s+(\S+\.json)\s*$/.exec(line);
  if (model) job.artifacts.model = model[1];
}

async function persist(job) {
  try {
    await fsp.mkdir(jobDir(job.id), { recursive: true });
    await fsp.writeFile(
      path.join(jobDir(job.id), 'job.json'),
      JSON.stringify(publicJob(job), null, 2)
    );
  } catch {
    /* a job that cannot write its record still runs; the panel has the live copy */
  }
}

/**
 * The command a job kind runs. Every one of these is a script that already
 * works from a terminal, which is the point: the panel and the CLI run the
 * SAME code path, so a run that behaves in one behaves in the other.
 */
function commandFor(job, python) {
  const p = job.params;
  switch (job.kind) {
    case 'match':
      return {
        cmd: process.execPath,
        args: [
          path.join(REPO, 'scripts', 'sim-run-match.mjs'),
          '--map', p.map,
          '--seed', String(p.seed),
          '--rounds', String(p.rounds),
          '--skill-a', p.skillA,
          '--skill-b', p.skillB,
          '--brain-a', p.brainA,
          '--brain-b', p.brainB,
          '--record-every', String(p.recordEvery)
        ]
      };
    case 'collect':
      return {
        cmd: process.execPath,
        args: [
          path.join(REPO, 'scripts', 'sim-collect-bc.mjs'),
          '--map', p.map,
          '--matches', String(p.matches),
          '--rounds', String(p.rounds),
          '--seed', String(p.seed)
        ]
      };
    case 'extract': {
      const dir = jobDir(job.id);
      fs.mkdirSync(dir, { recursive: true });
      const listFile = path.join(dir, 'demos.txt');
      fs.writeFileSync(
        listFile,
        String(p.demos || '')
          .split(',')
          .filter(Boolean)
          .join('\n') + '\n'
      );
      return {
        cmd: process.execPath,
        args: [
          path.join(REPO, 'scripts', 'sim-extract-demos.mjs'),
          '--demos-file', listFile,
          '--out', path.join(ROOT, 'sim', 'datasets', `bc-demos-${safe(p.name)}.jsonl`)
        ]
      };
    }
    case 'train':
      return {
        cmd: python,
        args: [
          path.join(REPO, 'scripts', 'sim-train-bc.py'),
          p.dataset,
          '--epochs', String(p.epochs),
          '--embed-dim', String(p.embedDim),
          '--out', path.join(ROOT, 'sim', 'models', `${safe(p.name)}.json`)
        ]
      };
    case 'eval':
      return {
        cmd: process.execPath,
        args: [
          path.join(REPO, 'scripts', 'sim-eval.mjs'),
          '--model', p.model,
          '--baseline', p.baseline,
          '--maps', p.maps,
          '--matches', String(p.matches),
          '--rounds', String(p.rounds)
        ]
      };
    case 'rl-train': {
      const initName = p.init || 'bc0';
      const initFile = /[\\/]/.test(initName)
        ? initName
        : [path.join(LOCAL_DIR, `${safeName(initName)}.json`), path.join(SHIPPED_DIR, `${safeName(initName)}.json`)].find(
            (f) => fs.existsSync(f)
          ) || path.join(SHIPPED_DIR, 'bc0.json');
      return {
        cmd: python,
        args: [
          path.join(REPO, 'scripts', 'sim-train-rl.py'),
          p.dataset,
          '--init', initFile,
          '--epochs', String(p.epochs),
          '--out', path.join(ROOT, 'sim', 'models', `${safe(p.name)}.json`),
          ...(p.aux ? ['--aux'] : [])
        ]
      };
    }
    case 'rollout':
      return {
        cmd: process.execPath,
        args: [
          path.join(REPO, 'server', 'sim', 'rollout.js'),
          '--map', p.map,
          '--matches', String(p.matches),
          '--rounds', String(p.rounds),
          '--seed', String(p.seed),
          '--tau', String(p.tau)
        ]
      };
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

/** Per-kind parameter clamps. A budget typed into a browser is a suggestion. */
function normalizeParams(kind, raw = {}) {
  switch (kind) {
    case 'match':
      return {
        map: safeName(raw.map || 'INF').toUpperCase(),
        seed: num(raw.seed, 1, 0, 1e9),
        rounds: num(raw.rounds, 24, 1, 60),
        skillA: safeName(raw.skillA || 'average'),
        skillB: safeName(raw.skillB || 'average'),
        brainA: safeName(raw.brainA || 'scripted'),
        brainB: safeName(raw.brainB || 'scripted'),
        recordEvery: num(raw.recordEvery, 1, 1, 100000)
      };
    case 'collect':
      return {
        map: safeName(raw.map || 'INF').toUpperCase(),
        matches: num(raw.matches, 6, 1, 200),
        rounds: num(raw.rounds, 12, 1, 30),
        seed: num(raw.seed, 40, 0, 1e9)
      };
    case 'extract': {
      // Local lab select-all can be hundreds of ids. The argv is a file so
      // Windows' 8k command-line cap is not the limit; 2000 is a sanity lid.
      const ids = String(raw.demos || '')
        .split(',')
        .map((s) => safeName(s))
        .filter(Boolean)
        .slice(0, 2000);
      return { demos: ids.join(','), name: safeName(raw.name || 'demos') };
    }
    case 'train':
      return {
        dataset: String(raw.dataset || ''),
        epochs: num(raw.epochs, 60, 1, 500),
        embedDim: num(raw.embedDim, 16, 0, 64),
        name: safeName(raw.name || 'bc0')
      };
    case 'eval':
      return {
        model: safeName(raw.model || 'bc0'),
        baseline: safeName(raw.baseline || 'scripted'),
        maps: String(raw.maps || 'INF').replace(/[^A-Za-z0-9,]/g, ''),
        matches: num(raw.matches, 2, 1, 200),
        rounds: num(raw.rounds, 12, 1, 30)
      };
    case 'rl-train':
      return {
        dataset: String(raw.dataset || ''),
        init: safeName(raw.init || 'bc0'),
        epochs: num(raw.epochs, 8, 1, 200),
        name: safeName(raw.name || 'gen1'),
        aux: Boolean(raw.aux)
      };
    case 'rollout':
      return {
        map: safeName(raw.map || 'INF').toUpperCase(),
        matches: num(raw.matches, 6, 1, 200),
        rounds: num(raw.rounds, 12, 1, 30),
        seed: num(raw.seed, 40, 0, 1e9),
        tau: num(raw.tau, 0.3, 0, 1)
      };
    default:
      return {};
  }
}

function labelFor(kind, p) {
  switch (kind) {
    case 'match':
      return `${p.map} ${p.brainA} vs ${p.brainB}, ${p.rounds} rounds`;
    case 'collect':
      return `${p.map} ${p.matches}x${p.rounds} rounds`;
    case 'extract':
      return `demos ${p.demos || '(none)'}`;
    case 'train':
      return `${p.name}, ${p.epochs} epochs${p.embedDim ? `, ${p.embedDim}d embed` : ''}`;
    case 'eval':
      return `${p.model} vs ${p.baseline} on ${p.maps}`;
    case 'rl-train':
      return `${p.name} from ${path.basename(p.init || 'scratch')}, ${p.epochs} epochs`;
    case 'rollout':
      return `${p.map} rl ${p.matches}x${p.rounds} tau=${p.tau}`;
    default:
      return kind;
  }
}

/**
 * Queue a job. Returns the record immediately: the browser's job is to start
 * work and then watch it, never to hold a request open for its duration.
 */
export async function startJob(kind, rawParams = {}) {
  if (!JOB_KINDS.includes(kind)) return { error: `unknown job kind ${kind}` };
  if (HEAVY_KINDS.has(kind) && !HEAVY_ENABLED) {
    return {
      error:
        `${kind} jobs are off on this host. Set AIM4_SIM_WORKERS=1 to enable them ` +
        '(SIM-PLAN 9.2b: heavy work is opt-in per deployment).'
    };
  }

  const params = normalizeParams(kind, rawParams);

  // Everything knowable before the fork is checked before the fork. A typo in
  // a map code or a brain name should come back as an answer to the click that
  // caused it, not as a job that starts, runs, and dies thirty seconds later
  // in a log the operator has to go and find.
  if (kind === 'extract' && !params.demos) {
    return { error: 'extract: no demos selected' };
  }
  if (kind === 'match' || kind === 'collect' || kind === 'rollout') {
    if (!(await loadBake('navcache', params.map))) {
      return { error: `no nav bake for ${params.map}` };
    }
    if (!(await loadBake('angles', params.map))) {
      return { error: `no angle catalogue for ${params.map}` };
    }
  }
  if (kind === 'match') {
    for (const brain of [params.brainA, params.brainB]) {
      if (!(await isBrain(brain))) return { error: `model ${brain}: not on this host` };
    }
  }

  if (kind === 'train' || kind === 'rl-train') {
    if (!params.dataset) return { error: `${kind}: no dataset` };
    try {
      await fsp.access(params.dataset);
    } catch {
      return { error: `${kind}: no dataset at ${params.dataset}` };
    }
    try {
      findPython();
    } catch (err) {
      return { error: err.message };
    }
  }

  const id = `${kind}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const job = {
    id,
    kind,
    params,
    label: labelFor(kind, params),
    state: 'queued',
    queuedAt: Date.now(),
    budgetSeconds: BUDGETS[kind],
    log: [],
    progress: null,
    artifacts: {}
  };
  jobs.set(id, job);
  queue.push(job);
  await persist(job);
  pump();
  return { ok: true, job: publicJob(job) };
}

/**
 * Start the next job if the box is free. Re-entered on every finish and on a
 * timer while the parser holds the box, because "preempted" has to mean
 * "resumes on its own", not "needs another button press".
 */
function pump() {
  if (active || !queue.length) return;
  if (parserBusy()) {
    // Demo parsing outranks everything here. Look again shortly; the timer is
    // unref'd so it never keeps the process alive on its own.
    const t = setTimeout(pump, 5000);
    if (t.unref) t.unref();
    return;
  }

  const job = queue.shift();
  active = job;
  job.state = 'running';
  job.startedAt = Date.now();

  let python = null;
  if (job.kind === 'train' || job.kind === 'rl-train') {
    try {
      python = findPython().command;
    } catch (err) {
      finish(job, { state: 'error', error: err.message });
      return;
    }
  }

  let cmd;
  try {
    cmd = commandFor(job, python);
  } catch (err) {
    finish(job, { state: 'error', error: err.message });
    return;
  }

  const child = spawn(cmd.cmd, cmd.args, {
    cwd: REPO,
    env: { ...process.env, AIM4_SIM_JOB: job.id },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows has no niceness knob worth using from node, so the rails that
    // matter here are the budget and the parse preemption above.
    windowsHide: true
  });
  job.child = child;

  const logFile = path.join(jobDir(job.id), 'log.txt');
  fsp.mkdir(jobDir(job.id), { recursive: true }).then(
    () => {
      job.logStream = fs.createWriteStream(logFile, { flags: 'a' });
    },
    () => {}
  );

  const onChunk = (buf) => {
    const text = buf.toString();
    job.logStream?.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.log.push(line);
      noteArtifacts(job, line.trim());
      if (job.log.length > LOG_TAIL_LINES) job.log.shift();
      // The last non-trivial line is the progress the panel shows. Scripts
      // print human sentences, so this needs no protocol on either side.
      job.progress = line.slice(0, 200);
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  const killAt = setTimeout(() => {
    job.error = `stopped at its ${job.budgetSeconds}s budget`;
    child.kill('SIGKILL');
  }, job.budgetSeconds * 1000);
  if (killAt.unref) killAt.unref();

  child.on('error', (err) => {
    clearTimeout(killAt);
    finish(job, { state: 'error', error: err.message });
  });

  child.on('exit', (code, signal) => {
    clearTimeout(killAt);
    const ok = code === 0 && !job.stopping;
    finish(job, {
      state: ok ? 'done' : 'error',
      exitCode: code,
      error: ok
        ? null
        : job.error || (job.stopping ? 'stopped' : `exited ${code}${signal ? ` (${signal})` : ''}`)
    });
  });
}

function finish(job, patch) {
  if (job.finishedAt) return;
  Object.assign(job, patch, { finishedAt: Date.now() });
  job.logStream?.end();
  job.logStream = null;
  job.child = null;
  if (active === job) active = null;
  // The result the panel wants is the last few lines: a match's score, a
  // trainer's val accuracy, an eval's verdict. They are already in the log.
  job.result = job.log.slice(-6).join('\n') || null;
  persist(job).catch(() => {});
  pump();
}

/** Stop a running or queued job. Stopping is always safe (9.2b). */
export function stopJob(id) {
  const job = jobs.get(safe(id));
  if (!job) return { error: 'no such job' };
  if (job.finishedAt) return { ok: true, job: publicJob(job) };
  job.stopping = true;
  if (job.child) {
    job.child.kill('SIGKILL');
  } else {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    finish(job, { state: 'error', error: 'stopped before it started' });
  }
  return { ok: true, job: publicJob(job) };
}

export function getJob(id) {
  const job = jobs.get(safe(id));
  if (!job) return null;
  return { ...publicJob(job), log: job.log.slice(-LOG_TAIL_LINES) };
}

/** Everything this process knows about, newest first, plus the host's state. */
export function listJobs() {
  const all = [...jobs.values()].sort((a, b) => b.queuedAt - a.queuedAt);
  return {
    jobs: all.slice(0, 40).map(publicJob),
    host: hostStatus()
  };
}

/**
 * What the panel needs to explain itself: whether this box will do heavy work,
 * whether a trainer is attached, and what is holding the queue up right now.
 * SIM-PLAN 9.2b: "without those, a run started from a browser is a run nobody
 * can find again".
 */
export function hostStatus() {
  let python = null;
  try {
    const found = findPython();
    python = { ok: true, version: found.version, numpy: found.numpy, source: found.source };
  } catch (err) {
    python = { ok: false, error: err.message };
  }
  return {
    heavyJobs: HEAVY_ENABLED,
    workers: Number(process.env.AIM4_SIM_WORKERS || 0),
    cpus: os.cpus().length,
    trainer: python,
    parserBusy: parserBusy(),
    queued: queue.length,
    running: active ? publicJob(active) : null,
    budgets: BUDGETS
  };
}

/** Jobs written by earlier processes, for the panel's history. */
export async function loadJobHistory() {
  let dirs;
  try {
    dirs = await fsp.readdir(JOBS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(JOBS_DIR, d, 'job.json'), 'utf8'));
      // A job recorded as running by a process that is gone is not running.
      if (rec.state === 'running' || rec.state === 'queued') {
        if (!jobs.has(rec.id)) {
          rec.state = 'error';
          rec.error = 'interrupted by a server restart';
        }
      }
      out.push(rec);
    } catch {
      /* a job killed mid-write leaves an unreadable record; skip it */
    }
  }
  out.sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0));
  return out;
}

/** Tests need a clean runner. */
export function _reset() {
  jobs.clear();
  queue.length = 0;
  active = null;
  parserBusy = () => false;
}
