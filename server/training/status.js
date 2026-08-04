// ---------------------------------------------------------------------------
// server/training/status.js
// The training run's progress file.
//
// Written by the training child, read by the API server. They are separate
// processes, so every write is tmp-then-rename: a reader must never be able to
// observe a half-written object, and on every platform a rename within one
// directory is atomic. Same idiom as the ingest pipeline's status file, for the
// same reason.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

/** @returns {object} the shape the admin panel renders before anything has run */
export function emptyStatus(kind = '') {
  return {
    kind,
    running: false,
    finished: false,
    startedAt: null,
    finishedAt: null,
    startedBy: null,
    pid: null,
    stage: 'idle',
    // Extraction
    demosDone: 0,
    demosTotal: 0,
    // Fitting
    generation: 0,
    generations: 0,
    seed: null,
    trainLoss: null,
    validLoss: null,
    bestValidLoss: null,
    bestGeneration: 0,
    exams: null,
    rounds: 0,
    // Outcome
    promoted: null,
    improvement: null,
    error: null
  };
}

export async function readStatus(file, kind = '') {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyStatus(kind), ...parsed };
  } catch {
    return emptyStatus(kind);
  }
}

/**
 * Replace the status file atomically.
 *
 * The tmp name carries the pid so two writers can never collide on it, which
 * matters when a stale run is being torn down as a new one starts.
 */
export async function writeStatus(file, status) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(status, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** Merge a patch into the file. Only the training child calls this. */
export async function patchStatus(file, patch, kind = '') {
  const current = await readStatus(file, kind);
  const next = { ...current, ...patch };
  await writeStatus(file, next);
  return next;
}
