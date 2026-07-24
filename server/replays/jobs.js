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
    }
  });

  const finish = async (patch) => {
    Object.assign(job, patch, { finishedAt: Date.now() });
    running = null;
    worker.terminate().catch(() => {});
    pump();
  };

  worker.on('message', async (msg) => {
    if (msg.type === 'progress') {
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
    const message = err?.message || String(err);
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
