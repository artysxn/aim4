// ---------------------------------------------------------------------------
// scripts/lib/simPython.mjs
// Find the python that will run the trainer, before anything expensive starts.
//
// SIM-PLAN 9.2 joins the two trainer hosts with a thin FILE seam: Node collects
// the dataset, Python does the gradient steps, and the artefact between them is
// JSON on disk. The seam is only as good as the interpreter on this side of it,
// and "the interpreter" is not one thing. On the 4090 box it is a Windows
// python313 on PATH; on a Linux host it is `python3`; in a checkout that has a
// project venv it must be the venv's python rather than either of those, or the
// trainer imports a numpy nobody installed on purpose.
//
// Worse, on Windows `python3` usually EXISTS and is not python: the App
// Execution Alias in WindowsApps prints a Microsoft Store advert and exits 49.
// So "the command ran" is evidence of nothing. Every candidate is probed by
// making it print a sentinel line naming its version and whether numpy imports,
// and only that line counts as identification.
//
// numpy is the hard requirement — scripts/sim-train-bc.py is numpy and the
// standard library, nothing else — so a python WITHOUT numpy loses to a python
// with it, and when nobody has it the error names every interpreter that was
// found and the single command that fixes the situation. Discovery that fails
// vaguely is worse than no discovery: it sends you to the wrong python.
//
// Never through a shell. The venv path on Windows sits under
// C:\Users\...\AppData\Local\Programs\... and one space in a path is a mangled
// command line; every spawn here is execFile-style with an argv array.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: scripts/lib -> scripts -> here. */
export const REPO_ROOT = path.join(__dirname, '..', '..');

/** A probe is a spawn; a hung candidate must not hang the pipeline. */
const PROBE_TIMEOUT_MS = 8000;

/** The one string that means "this really was python". */
const SENTINEL = 'AIM4PY';

// A real import, not importlib.find_spec: a numpy that is installed but broken
// (wrong architecture, half-deleted) passes a spec lookup and then fails inside
// the trainer, which is the failure this module exists to move earlier.
const PROBE_SOURCE = [
  'import sys',
  'try:',
  '    import numpy',
  '    n = numpy.__version__',
  'except Exception:',
  "    n = '-'",
  `print('${SENTINEL}', sys.version.split()[0], n)`
].join('\n');

/** One line, short enough to sit in a table. */
function whyItFailed(err) {
  if (err?.code === 'ENOENT') return 'not found';
  if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM') {
    return `no answer in ${PROBE_TIMEOUT_MS}ms`;
  }
  if (err?.code === 'EACCES') return 'not executable';
  const stderr = String(err?.stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  const status = Number.isInteger(err?.status) ? `exited ${err.status}` : 'did not run';
  const detail = stderr ? `: ${stderr.slice(0, 90)}` : '';
  return `${status}${detail}`;
}

/**
 * Probe one candidate interpreter.
 *
 * Always returns a result, never throws: the whole point is that a candidate
 * which is missing, is a Store stub, or is some unrelated binary reports as a
 * plain "no" so the search can move on.
 *
 * @param {string} command absolute path or a name to resolve on PATH
 * @returns {{command: string, ok: boolean, version: string|null, numpy: string|null, error: string|null}}
 *   `ok` means it identified itself as python; `numpy` is its numpy version.
 */
export function pythonProbe(command) {
  const out = { command: String(command || ''), ok: false, version: null, numpy: null, error: null };
  if (!out.command) {
    out.error = 'no command given';
    return out;
  }

  let stdout = '';
  try {
    stdout = execFileSync(out.command, ['-c', PROBE_SOURCE], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      // stderr must be captured, not inherited: the Store stub's advert would
      // otherwise print itself into the middle of a training run's output.
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    // A non-zero exit still gets its stdout read. Exit codes do not identify
    // python; the sentinel does.
    stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    out.error = whyItFailed(err);
  }

  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(`${SENTINEL} `));
  if (!line) {
    out.error = out.error || 'ran, but did not print a python version';
    return out;
  }

  const [, version, numpy] = line.trim().split(/\s+/);
  out.ok = true;
  out.version = version || null;
  out.numpy = numpy && numpy !== '-' ? numpy : null;
  out.error = out.numpy ? null : 'numpy is not importable';
  return out;
}

/**
 * The search order, most specific first. Exported so a caller (and the dry-run
 * print) can show what WOULD be tried without spawning anything.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function pythonCandidates(env = process.env) {
  const list = [];
  if (env.AIM4_PYTHON) list.push({ command: env.AIM4_PYTHON, source: 'AIM4_PYTHON' });
  // Both venv layouts, unconditionally: probing a path that does not exist
  // costs one failed spawn and buys a line in the error table saying so.
  list.push({ command: path.join(REPO_ROOT, '.venv-sim', 'Scripts', 'python.exe'), source: '.venv-sim (windows)' });
  list.push({ command: path.join(REPO_ROOT, '.venv-sim', 'bin', 'python'), source: '.venv-sim (posix)' });
  list.push({ command: 'python3', source: 'PATH' });
  list.push({ command: 'python', source: 'PATH' });
  return list;
}

function report(tried, overrideFailed) {
  const width = Math.max(...tried.map((t) => t.command.length), 10);
  const rows = tried.map((t) => {
    const status = t.ok
      ? `Python ${t.version}, ${t.numpy ? `numpy ${t.numpy}` : 'numpy MISSING'}`
      : t.error || 'no';
    return `  ${t.command.padEnd(width)}  ${status}   [${t.source}]`;
  });

  const found = tried.find((t) => t.ok);
  const head = overrideFailed
    ? `AIM4_PYTHON is set to "${overrideFailed}", and that interpreter cannot run the trainer.`
    : 'no numpy-capable python found for the sim trainer.';
  const fix = found
    ? `fix: python -m pip install numpy   (into that interpreter: "${found.command}" -m pip install numpy)`
    : 'fix: install Python 3, then: python -m pip install numpy';

  return [
    head,
    'tried, in order:',
    ...rows,
    fix,
    'or set AIM4_PYTHON to an interpreter that already has numpy.'
  ].join('\n');
}

/**
 * Resolve the interpreter to train with.
 *
 * Order: AIM4_PYTHON, .venv-sim (both layouts), python3, python. The first
 * candidate that is python AND has numpy wins.
 *
 * AIM4_PYTHON is honored rather than second-guessed — no heuristics about what
 * an interpreter should be called or where it should live — but it is still
 * probed, and if the override cannot run the trainer this throws instead of
 * quietly falling through to some other python. A pointer that is silently
 * ignored trains the wrong thing and never tells you.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{command: string, version: string, numpy: string, source: string}}
 * @throws {Error} with the full table of what was tried and how to fix it
 */
export function findPython(env = process.env) {
  const tried = [];
  for (const candidate of pythonCandidates(env)) {
    const result = { ...candidate, ...pythonProbe(candidate.command) };
    tried.push(result);
    if (result.ok && result.numpy) {
      return {
        command: result.command,
        version: result.version,
        numpy: result.numpy,
        source: candidate.source
      };
    }
    if (candidate.source === 'AIM4_PYTHON') throw new Error(report(tried, candidate.command));
  }
  throw new Error(report(tried, null));
}

/** One line for a banner: what was resolved and where it came from. */
export function describePython(py) {
  return `${py.command}  (Python ${py.version}, numpy ${py.numpy})  [${py.source}]`;
}
