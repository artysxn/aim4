// ---------------------------------------------------------------------------
// replays/jobs.js
// Parse queue. Demos are parsed one at a time in a worker thread: the native
// parser saturates a core and a 300 MB demo takes a while, so running two at
// once on a small host just makes both slower and risks the heap.
//
// Job state lives in memory. A parse that is interrupted by a restart leaves
// its demo record in "parsing"; the library shows it as failed and offers a
// retry rather than pretending it is still running.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readRecord, writeRecord, demoFilePath, discardSourceFile } from './demoStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'parseWorker.js');

/** Drop the .dem after a successful parse. Rounds are what the viewer reads. */
const KEEP_SOURCE = process.env.AIM4_REPLAY_KEEP_DEM !== '0';

/**
 * Heap ceiling for the parse worker, in MB.
 *
 * This is a blast radius control, not a tuning knob. Without it a worker that
 * runs out of memory takes the whole process down with it, which means one
 * oversized demo also kills every live multiplayer match. With it, the worker
 * dies alone, the job reports a real error, and the server keeps serving.
 * Leave headroom: this must fit inside the host's RAM next to everything else.
 */
const WORKER_HEAP_MB = Number(process.env.AIM4_PARSE_HEAP_MB || 1536);

/** Give up on a parse that has made no progress for this long. */
const STALL_MS = Number(process.env.AIM4_PARSE_STALL_MS || 15 * 60 * 1000);

const jobs = new Map(); // demoId -> job
const queue = [];
let running = null;

function jobKey(user, demoId) {
  return `${user}/${demoId}`;
}

export function jobStatus(user, demoId) {
  return jobs.get(jobKey(user, demoId)) || null;
}

export function allJobs(user) {
  const prefix = `${user}/`;
  return [...jobs.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
}

/**
 * Queue a demo for parsing. Returns the job immediately; poll
 * GET /api/replays/demos/:id for progress.
 */
export function enqueueParse({ user, demoId, filename, sizeBytes }) {
  const key = jobKey(user, demoId);
  const existing = jobs.get(key);
  if (existing && (existing.state === 'queued' || existing.state === 'running')) return existing;

  const job = {
    user,
    demoId,
    filename,
    sizeBytes,
    state: 'queued',
    stage: 'queued',
    round: 0,
    total: 0,
    error: null,
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null
  };
  jobs.set(key, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  job.state = 'running';
  job.stage = 'starting';
  job.startedAt = Date.now();

  const file = demoFilePath(job.user, job.demoId);
  const worker = new Worker(WORKER, {
    workerData: {
      user: job.user,
      demoId: job.demoId,
      file,
      meta: {
        filename: job.filename,
        sizeBytes: job.sizeBytes,
        uploadedAt: job.queuedAt
      }
    },
    resourceLimits: {
      maxOldGenerationSizeMb: WORKER_HEAP_MB,
      maxYoungGenerationSizeMb: 64
    }
  });

  // A parse that stops reporting progress is hung. Killing it frees the queue
  // and surfaces a real error, instead of leaving the demo on "Parsing" until
  // someone restarts the server.
  let stallTimer = null;
  const touch = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      worker.terminate().catch(() => {});
      const message = `Parsing stalled with no progress for ${Math.round(STALL_MS / 60000)} minutes.`;
      markFailed(job, message).catch(() => {});
      finish({ state: 'error', stage: 'error', error: message });
    }, STALL_MS);
    if (stallTimer.unref) stallTimer.unref();
  };

  const finish = async (patch) => {
    if (job.finishedAt) return; // terminate() and exit can both land here
    if (stallTimer) clearTimeout(stallTimer);
    Object.assign(job, patch, { finishedAt: Date.now() });
    running = null;
    worker.terminate().catch(() => {});
    pump();
  };

  touch();

  worker.on('message', async (msg) => {
    if (msg.type === 'progress') {
      touch();
      job.stage = msg.stage || job.stage;
      if (msg.round !== undefined) job.round = msg.round;
      if (msg.total !== undefined) job.total = msg.total;
      return;
    }
    if (msg.type === 'done') {
      if (!KEEP_SOURCE) await discardSourceFile(job.user, job.demoId).catch(() => {});
      await finish({ state: 'done', stage: 'done', record: msg.record });
      return;
    }
    if (msg.type === 'error') {
      await markFailed(job, msg.error);
      await finish({ state: 'error', stage: 'error', error: msg.error });
    }
  });

  worker.on('error', async (err) => {
    // An out-of-memory worker is the common failure on a small host, and the
    // raw V8 message does not say what to do about it.
    const oom = err?.code === 'ERR_WORKER_OUT_OF_MEMORY';
    const message = oom
      ? `Parsing ran out of memory (worker limit ${WORKER_HEAP_MB} MB). Raise ` +
        'AIM4_PARSE_HEAP_MB if the host has spare RAM, or lower ' +
        'AIM4_PARSE_BATCH_TICKS to hold fewer ticks at once.'
      : err?.message || String(err);
    console.error(`[replays] parse failed for ${job.filename}:`, message);
    await markFailed(job, message);
    await finish({ state: 'error', stage: 'error', error: message });
  });

  worker.on('exit', (code) => {
    if (running === job && code !== 0) {
      const message = `Parser worker exited with code ${code}`;
      markFailed(job, message).catch(() => {});
      finish({ state: 'error', stage: 'error', error: message });
    }
  });
}

async function markFailed(job, error) {
  try {
    const record = (await readRecord(job.user, job.demoId)) || { id: job.demoId };
    await writeRecord(job.user, {
      ...record,
      status: 'error',
      error,
      filename: job.filename ?? record.filename,
      sizeBytes: job.sizeBytes ?? record.sizeBytes
    });
  } catch {
    /* the record may be gone if the user deleted the demo mid-parse */
  }
}
