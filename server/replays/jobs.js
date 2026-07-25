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
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRecord, writeRecord, demoFilePath, discardSourceFile } from './demoStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'parseWorker.js');

/** Drop the .dem after a successful parse. Rounds are what the viewer reads. */
const KEEP_SOURCE = process.env.AIM4_REPLAY_KEEP_DEM !== '0';

/**
 * Heap ceiling for the parse process, in MB, passed as --max-old-space-size.
 *
 * This is a blast radius control, not a tuning knob. It bounds V8's heap so a
 * runaway parse hits a catchable JavaScript error before the kernel notices.
 * It does NOT bound the native parser's own allocations, which is exactly why
 * the parse runs as a separate process: if the kernel does step in, it kills
 * that process and the HTTP server keeps running.
 */
const WORKER_HEAP_MB = Number(process.env.AIM4_PARSE_HEAP_MB || 1024);

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
  const payload = JSON.stringify({
    user: job.user,
    demoId: job.demoId,
    file,
    meta: {
      filename: job.filename,
      sizeBytes: job.sizeBytes,
      uploadedAt: job.queuedAt
    }
  });

  const worker = fork(WORKER, [payload], {
    execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
    // The child's own stdio is forwarded so a native crash still reaches the
    // container log rather than vanishing.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });

  // A parse that stops reporting progress is hung. Killing it frees the queue
  // and surfaces a real error, instead of leaving the demo on "Parsing" until
  // someone restarts the server.
  let stallTimer = null;
  const touch = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      worker.kill('SIGKILL');
      const message = `Parsing stalled with no progress for ${Math.round(STALL_MS / 60000)} minutes.`;
      markFailed(job, message).catch(() => {});
      finish({ state: 'error', stage: 'error', error: message });
    }, STALL_MS);
    if (stallTimer.unref) stallTimer.unref();
  };

  const finish = async (patch) => {
    if (job.finishedAt) return; // kill() and exit can both land here
    if (stallTimer) clearTimeout(stallTimer);
    Object.assign(job, patch, { finishedAt: Date.now() });
    running = null;
    if (!worker.killed) worker.kill('SIGKILL');
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
    const message = err?.message || String(err);
    console.error(`[replays] parse failed for ${job.filename}:`, message);
    await markFailed(job, message);
    await finish({ state: 'error', stage: 'error', error: message });
  });

  worker.on('exit', (code, signal) => {
    if (running !== job) return;
    if (code === 0) return;

    // SIGKILL with no exit code is the kernel's out-of-memory killer. The
    // process gets no chance to report anything, so name it here rather than
    // leaving a bare signal number for someone to decode.
    const killed = signal === 'SIGKILL' || signal === 'SIGABRT';
    const message = killed
      ? `The parser was killed by the system, which almost always means the ` +
        `host ran out of memory. The demo is likely too large for this server ` +
        `(heap limit ${WORKER_HEAP_MB} MB). Check /api/replays/diag for how far it got.`
      : `Parser exited with code ${code}${signal ? ` (${signal})` : ''}`;
    console.error(`[replays] ${message}`);
    markFailed(job, message).catch(() => {});
    finish({ state: 'error', stage: 'error', error: message });
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
