// ---------------------------------------------------------------------------
// server/training/service.js
// Start, stop and report on a training run.
//
// The run is a detached child process, not a worker thread and not an inline
// setImmediate. Three reasons, all learned from the code already here:
//
//   - It is long. Minutes at least, and it wants an 8 GB heap. The parse worker
//     is a separate process for exactly this reason: when the OOM killer
//     arrives it should take the trainer, not the API server.
//   - It must survive a deploy. The stats rebuild keeps its job object in
//     module memory and loses the whole thing on restart; a training run is far
//     too long to treat that way, so state lives in a file and liveness is a
//     pid check.
//   - It is CPU-hungry. Detaching it means the scheduler can be told about it
//     independently, and the worker count is capped well below the core count.
//
// One run per model at a time, and one run per press: no supervisor, no
// automatic restart. An admin asked for N generations on a seed; when that
// finishes, it is finished.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

import {
  DEFAULT_GENERATIONS,
  DEFAULT_WORKERS,
  MAX_GENERATIONS,
  TRAINER_CLI,
  WORKER_HEAP_MB,
  isModelKind,
  paths
} from './config.js';
import { emptyStatus, patchStatus, readStatus, writeStatus } from './status.js';
import { readChampion, totalImprovement } from './champion.js';

/** Is a pid still alive? Signal 0 tests without delivering anything. */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return err.code === 'EPERM';
  }
}

async function readPid(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const pid = Number(String(raw).trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Everything the admin panel needs for one model.
 *
 * `running` is reconciled against the operating system rather than trusted from
 * the file: a child killed by the OOM killer never gets to write "finished", and
 * a status that claims to be running forever is worse than no status at all.
 */
export async function status(kind) {
  if (!isModelKind(kind)) return null;
  const p = paths(kind);
  const stored = await readStatus(p.status, kind);
  const pid = await readPid(p.lock);
  const live = alive(pid);

  const champion = await readChampion(kind);
  const out = {
    ...stored,
    kind,
    pid: live ? pid : null,
    running: live,
    // The file said running but nothing is alive: the run died without a chance
    // to record why.
    crashed: Boolean(stored.running && !live && !stored.finished),
    champion: champion
      ? {
          specHash: champion.specHash,
          validLoss: champion.validLoss,
          exams: champion.exams,
          generation: champion.generation,
          seed: champion.seed,
          trainedOn: champion.trainedOn,
          updatedAt: champion.updatedAt,
          promotions: champion.promotions,
          baselineLoss: champion.baselineLoss,
          totalImprovement: totalImprovement(champion),
          history: champion.history || []
        }
      : null
  };
  if (out.crashed) out.stage = 'crashed';
  return out;
}

/**
 * Begin a run. Rejects rather than queues when one is already going.
 *
 * @returns {Promise<{ ok: boolean, error?: string, status?: object }>}
 */
export async function start(kind, options = {}) {
  if (!isModelKind(kind)) return { ok: false, error: 'unknown model' };
  const p = paths(kind);

  if (alive(await readPid(p.lock))) {
    return { ok: false, error: 'already running', status: await status(kind) };
  }

  const generations = Math.max(
    1,
    Math.min(MAX_GENERATIONS, Number(options.generations) || DEFAULT_GENERATIONS)
  );
  // An unspecified seed is randomised, because the whole point of pressing the
  // button again is to search a different corner of the space.
  const seed = Number.isFinite(Number(options.seed))
    ? Number(options.seed)
    : Math.floor(Math.random() * 2 ** 31);
  const workers = Math.max(1, Math.min(32, Number(options.workers) || DEFAULT_WORKERS));

  await fsp.mkdir(p.dir, { recursive: true });
  await writeStatus(p.status, {
    ...emptyStatus(kind),
    running: true,
    startedAt: new Date().toISOString(),
    startedBy: options.startedBy || null,
    stage: 'starting',
    generations,
    seed
  });

  const args = [
    `--max-old-space-size=${WORKER_HEAP_MB}`,
    TRAINER_CLI,
    '--kind',
    kind,
    '--generations',
    String(generations),
    '--seed',
    String(seed),
    '--workers',
    String(workers)
  ];
  if (options.force) args.push('--force');

  // Raw descriptors rather than pipes: a detached child logging through a pipe
  // to its parent dies when the parent does.
  const logFd = fs.openSync(p.log, 'a');
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env
    });
  } catch (err) {
    fs.closeSync(logFd);
    await writeStatus(p.status, {
      ...emptyStatus(kind),
      finished: true,
      finishedAt: new Date().toISOString(),
      stage: 'failed',
      error: err.message
    });
    return { ok: false, error: err.message };
  }
  fs.closeSync(logFd);
  child.unref();

  await fsp.writeFile(p.lock, String(child.pid));
  return { ok: true, status: await status(kind) };
}

/**
 * Ask a run to stop.
 *
 * SIGTERM rather than SIGKILL so the child can finish the generation it is in
 * and still offer its best model to the champion slot. A run that has already
 * found an improvement should not lose it because someone pressed stop.
 */
export async function stop(kind) {
  if (!isModelKind(kind)) return { ok: false, error: 'unknown model' };
  const p = paths(kind);
  const pid = await readPid(p.lock);

  if (!alive(pid)) {
    // Nothing to signal. That is not an error worth refusing: the run has
    // already ended, possibly by dying without writing a finish, and the useful
    // thing to do is tidy up so the panel stops claiming it is running. Anything
    // else leaves an admin pressing a button that always fails.
    await fsp.rm(p.lock, { force: true }).catch(() => {});
    const stored = await readStatus(p.status, kind);
    if (stored.running && !stored.finished) {
      await writeStatus(p.status, {
        ...stored,
        running: false,
        finished: true,
        finishedAt: new Date().toISOString(),
        stage: 'stopped',
        error: stored.error || 'the run ended without reporting a result'
      });
    }
    return { ok: true, note: 'was not running', status: await status(kind) };
  }

  // The child spawns the extractor and the trainer as its own children, and it
  // was started detached, which makes it a process group leader. Signalling the
  // group reaches whichever stage is actually working even if the parent is
  // wedged; the single-pid signal is the fallback where groups are not a thing.
  let signalled = false;
  try {
    process.kill(-pid, 'SIGTERM');
    signalled = true;
  } catch {
    /* not a group leader, or not supported here */
  }
  if (!signalled) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      return { ok: false, error: err.message, status: await status(kind) };
    }
  }

  await patchStatus(p.status, { stage: 'stopping' }, kind).catch(() => {});
  return { ok: true, status: await status(kind) };
}
