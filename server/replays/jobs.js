// ---------------------------------------------------------------------------
// replays/jobs.js
// Parse queue, and the ingest pipeline that feeds it.
//
// Demos are parsed one at a time in a separate process: the native parser
// saturates a core and a 300 MB demo takes a while, so running two at once on a
// small host just makes both slower and risks the heap.
//
// One upload can carry several demos (a .zip), so an upload is tracked as a
// BATCH and each demo inside it walks four phases:
//
//   uploaded -> unpacked -> parsed -> analyzed
//
// The batch is what the progress bar reads. Only the last two are queued work;
// unpacking happens once, up front, and the source archive is deleted as soon
// as it has given up its demos.
//
// Job and batch state live in memory. A parse interrupted by a restart leaves
// its demo record in "parsing"; the library shows it as failed and offers a
// retry rather than pretending it is still running.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readRecord,
  writeRecord,
  demoFilePath,
  discardSourceFile,
  ensureLibraryDirs,
  hasSourceFile,
  listDemos,
  listLibraryUsers,
  newDemoId,
  readRoundMeta,
  readRoundTicks,
  uploadsDir,
  userDir
} from './demoStore.js';
import { unpackUpload } from './archive.js';
import { getZones } from '../zonesStore.js';
import { deriveBatchTicks } from './hostMemory.js';
import { scheduleStatsIndex } from './statsIndex.js';

const statsIo = { userDir, readRoundMeta, readRoundTicks, getZones };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'parseWorker.js');

/**
 * Drop the .dem once parsing ends, win or lose. Rounds are what the viewer
 * reads, and a 450 MB source kept "just in case" is larger than the entire
 * parsed library it came from. Set AIM4_REPLAY_KEEP_DEM=1 to keep it, which is
 * worth doing while debugging a parser change and not otherwise.
 *
 * The consequence is that the library's Retry button only has something to work
 * with while the source is still there, i.e. during the automatic retries
 * below. After that a failed demo has to be re-uploaded.
 */
const KEEP_SOURCE = process.env.AIM4_REPLAY_KEEP_DEM === '1';

/**
 * How many times a killed parse is retried with half the batch size.
 *
 * A parse killed by the OOM killer will be killed again by an identical retry,
 * which is what turned a too-large demo into an endless loop of the same
 * failure. Halving the batch each time makes the retry meaningfully different:
 * it holds less in the heap at the cost of re-decoding the file once more.
 */
const MAX_ATTEMPTS = Number(process.env.AIM4_PARSE_ATTEMPTS || 3);
/**
 * Floor for the retry ladder, deliberately below hostMemory's derivation floor.
 * The derived batch now starts at 25 000 rather than 200 000, so halving twice
 * has to still land somewhere for the ladder to be worth having at all.
 */
const MIN_BATCH_TICKS = 5_000;

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
const batches = new Map(); // batchId -> batch
const queue = [];
let running = null;

/**
 * Finished batches are kept in memory so a client that polls a moment late
 * still sees the result rather than a 404, then dropped so a long-lived server
 * does not accumulate them. The on-disk snapshot outlives this window, so a
 * client that left and came back still finds its upload.
 */
const BATCH_TTL_MS = 30 * 60 * 1000;

/**
 * How long a batch snapshot stays on the volume. Long enough that closing the
 * tab and coming back the next day still explains what happened to an upload,
 * short enough that the folder does not become a log.
 */
const BATCH_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Smallest gap between snapshot writes for one batch, outside of settling. */
const PERSIST_EVERY_MS = 2000;

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

/** Drop an in-memory parse job so a deleted demo cannot reappear as a ghost. */
export function forgetJob(user, demoId) {
  return jobs.delete(jobKey(user, demoId));
}

// ---- upload batches ---------------------------------------------------------

/**
 * Phase order, so a file can only ever move forward.
 *
 * `phase` is the furthest point a file reached and failure is a separate flag,
 * not a phase. Collapsing the two would make a demo that unpacked and then
 * failed to parse stop counting as unpacked, and the bar would visibly run
 * backwards at the exact moment something went wrong.
 */
const PHASES = ['uploaded', 'unpacked', 'parsed', 'analyzed'];

function setPhase(entry, phase) {
  if (!entry) return;
  if (PHASES.indexOf(phase) > PHASES.indexOf(entry.phase)) entry.phase = phase;
}

function failEntry(entry, message) {
  if (!entry) return;
  entry.failed = true;
  entry.error = message || 'Parsing failed.';
}

function sweepBatches() {
  const cutoff = Date.now() - BATCH_TTL_MS;
  for (const [id, b] of batches) {
    if (b.finishedAt && b.finishedAt < cutoff) batches.delete(id);
  }
}

// ---- batch snapshots --------------------------------------------------------
// Parsing is detached from the request that started it, so it finishes whether
// or not anyone is watching. What used to be lost by leaving the page was the
// ABILITY TO WATCH: batch state lived only in this process's memory, so a
// reload — or a restart mid-parse — turned a running upload into "Lost track of
// it". A snapshot on the volume is what lets a returning client pick the same
// upload back up.

const batchFile = (user, id) => path.join(uploadsDir(user), `${sanitizeBatchId(id)}.json`);

function sanitizeBatchId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) throw new Error('Invalid batch id');
  return s;
}

async function persistBatch(batch, { force = false } = {}) {
  if (!batch) return;
  const now = Date.now();
  if (!force && batch._persistedAt && now - batch._persistedAt < PERSIST_EVERY_MS) return;
  batch._persistedAt = now;
  try {
    await mkdir(uploadsDir(batch.user), { recursive: true });
    await writeFile(
      batchFile(batch.user, batch.id),
      JSON.stringify({
        id: batch.id,
        user: batch.user,
        filename: batch.filename,
        sizeBytes: batch.sizeBytes,
        stage: batch.stage,
        error: batch.error,
        files: batch.files,
        createdAt: batch.createdAt,
        finishedAt: batch.finishedAt
      })
    );
  } catch {
    /* the in-memory copy still serves this process */
  }
}

/** Fire-and-forget snapshot, for the many call sites that are not async. */
const snapshot = (batch, opts) => {
  persistBatch(batch, opts).catch(() => {});
};

async function loadBatch(user, batchId) {
  try {
    const raw = JSON.parse(await readFile(batchFile(user, batchId), 'utf8'));
    if (!raw || raw.user !== user) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Every snapshot on the volume for one library. */
async function loadUserBatches(user) {
  const dir = uploadsDir(user);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (raw?.id) out.push(raw);
    } catch {
      /* unreadable snapshot is not worth failing over */
    }
  }
  return out;
}

/** Drop snapshots older than BATCH_FILE_TTL_MS, best-effort. */
export async function sweepBatchFiles() {
  const cutoff = Date.now() - BATCH_FILE_TTL_MS;
  for (const user of await listLibraryUsers()) {
    for (const raw of await loadUserBatches(user)) {
      const at = raw.finishedAt || raw.createdAt || 0;
      if (!at || at >= cutoff) continue;
      if (batches.has(raw.id)) batches.delete(raw.id);
      await rm(batchFile(user, raw.id), { force: true }).catch(() => {});
    }
  }
}

/**
 * The shape the progress bar reads. Counts are cumulative by phase.
 *
 * Per-file round progress is overlaid from the live job rather than taken from
 * the batch, so a snapshot loaded off disk after a reload still reports "round
 * 14 of 24" for whatever is parsing right now.
 */
export function batchStatus(batch) {
  if (!batch) return null;
  const count = (phase) => {
    const at = PHASES.indexOf(phase);
    return batch.files.filter((f) => PHASES.indexOf(f.phase) >= at).length;
  };
  return {
    id: batch.id,
    filename: batch.filename,
    stage: batch.stage,
    error: batch.error,
    totals: {
      files: batch.files.length,
      uploaded: count('uploaded'),
      unpacked: count('unpacked'),
      parsed: count('parsed'),
      analyzed: count('analyzed'),
      failed: batch.files.filter((f) => f.failed).length
    },
    files: batch.files.map((f) => {
      const job = jobs.get(jobKey(batch.user, f.demoId));
      return {
        name: f.name,
        demoId: f.demoId,
        phase: f.phase,
        failed: f.failed,
        round: job?.round ?? f.round,
        total: job?.total ?? f.total,
        error: f.error
      };
    }),
    finishedAt: batch.finishedAt
  };
}

/**
 * One upload's batch, from memory or from the volume.
 *
 * A disk-loaded batch is adopted back into memory so the rest of the pipeline
 * (which mutates batches in place) keeps working on it, and so a snapshot taken
 * mid-parse does not keep being re-read.
 */
export async function getBatch(user, batchId) {
  const id = String(batchId || '');
  const live = batches.get(id);
  if (live) return live.user === user ? live : null;
  const stored = await loadBatch(user, id);
  if (!stored) return null;
  batches.set(id, stored);
  return stored;
}

function batchEntry(batch, demoId) {
  return batch?.files.find((f) => f.demoId === demoId) || null;
}

function settleBatch(batch) {
  if (!batch || batch.finishedAt) return;
  const pending = batch.files.some((f) => !f.failed && f.phase !== 'analyzed');
  if (pending || batch.stage === 'unpacking') {
    snapshot(batch);
    return;
  }
  batch.stage = batch.files.every((f) => f.failed) ? 'error' : 'done';
  batch.finishedAt = Date.now();
  snapshot(batch, { force: true });
  sweepBatches();
}

/**
 * Take one upload from arrival to parsed rounds.
 *
 * Returns as soon as the batch exists: unpacking a 450 MB zip takes long enough
 * that holding the HTTP response open for it is how uploads die behind a proxy.
 * The client gets a batch id immediately and polls.
 */
export function startIngest({ user, filename, source, sizeBytes, allowedBytes }) {
  const batch = {
    id: crypto.randomBytes(8).toString('hex'),
    user,
    filename,
    sizeBytes,
    stage: 'unpacking',
    error: null,
    files: [],
    createdAt: Date.now(),
    finishedAt: null
  };
  batches.set(batch.id, batch);
  // Snapshot before unpacking starts: a client that reloads during a long
  // archive extraction has to find the batch it was handed.
  snapshot(batch, { force: true });

  (async () => {
    const idByPath = new Map();
    try {
      // Extraction writes straight to demo paths, before any record exists to
      // create the folders as a side effect.
      await ensureLibraryDirs(user);
      const extracted = await unpackUpload({
        source,
        filename,
        allowedBytes,
        targetFor: (name) => {
          const demoId = newDemoId();
          const target = demoFilePath(user, demoId);
          idByPath.set(target, demoId);
          return target;
        }
      });

      for (const file of extracted) {
        const demoId = idByPath.get(file.path);
        batch.files.push({
          name: file.name,
          demoId,
          sizeBytes: file.sizeBytes,
          phase: 'unpacked',
          failed: false,
          round: 0,
          total: 0,
          error: null
        });
        await writeRecord(user, {
          id: demoId,
          status: 'parsing',
          filename: file.name,
          sizeBytes: file.sizeBytes,
          uploadedAt: Date.now(),
          rounds: []
        });
      }

      batch.stage = 'parsing';
      for (const file of batch.files) {
        enqueueParse({
          user,
          demoId: file.demoId,
          filename: file.name,
          sizeBytes: file.sizeBytes,
          batchId: batch.id
        });
      }
      if (!batch.files.length) {
        batch.stage = 'error';
        batch.error = 'No .dem files were found in that upload.';
        batch.finishedAt = Date.now();
      }
      snapshot(batch, { force: true });
    } catch (err) {
      batch.stage = 'error';
      batch.error = err?.message || 'Could not unpack that upload.';
      batch.finishedAt = Date.now();
      snapshot(batch, { force: true });
      console.error(`[replays] unpack failed for ${filename}:`, batch.error);
    } finally {
      // The archive has given up everything it is going to. Whether that went
      // well or not, keeping it costs the same as the demos it contained.
      if (!KEEP_SOURCE) await rm(source, { force: true }).catch(() => {});
    }
  })();

  return batch;
}

/**
 * Queue a demo for parsing. Returns the job immediately; poll
 * GET /api/replays/demos/:id for progress.
 */
export function enqueueParse({ user, demoId, filename, sizeBytes, batchId = null }) {
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
    batchId,
    attempt: 1,
    // null means "let the parser derive it from the memory it can see".
    batchTicks: Number(process.env.AIM4_PARSE_BATCH_TICKS) || null,
    // null means "let the parser decide from the memory it can see". Set to
    // false by the retry path below, where holding the demo is a suspect.
    bufferDemo: null,
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

  const env = { ...process.env };
  if (job.batchTicks) env.AIM4_PARSE_BATCH_TICKS = String(job.batchTicks);
  if (job.bufferDemo === false) env.AIM4_PARSE_BUFFER = '0';

  const worker = fork(WORKER, [payload], {
    execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
    env,
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
    if (patch.state === 'error') {
      const batch = batches.get(job.batchId);
      failEntry(batchEntry(batch, job.demoId), patch.error);
      settleBatch(batch);
    }
    // Terminal either way, so the source goes. This is deliberately here and
    // not in the success handler: a demo that failed every retry is exactly the
    // one whose 450 MB would otherwise sit on the volume forever. Retries do
    // not pass through here, so they still have the file to work with.
    if (!KEEP_SOURCE) await discardSourceFile(job.user, job.demoId).catch(() => {});
    pump();
  };

  touch();

  worker.on('message', async (msg) => {
    if (msg.type === 'progress') {
      touch();
      job.stage = msg.stage || job.stage;
      if (msg.round !== undefined) job.round = msg.round;
      if (msg.total !== undefined) job.total = msg.total;
      // Mirror onto the batch so the bar can show round N of M within the file
      // it is currently working through.
      const batch = batches.get(job.batchId);
      const entry = batchEntry(batch, job.demoId);
      if (entry) {
        entry.round = job.round;
        entry.total = job.total;
      }
      // Throttled: a snapshot per round would be a write every few hundred ms,
      // and batchStatus overlays live job progress anyway.
      snapshot(batch);
      return;
    }
    if (msg.type === 'done') {
      const batch = batches.get(job.batchId);
      const entry = batchEntry(batch, job.demoId);
      setPhase(entry, 'parsed');
      snapshot(batch, { force: true });
      // Build stats (+ zone positions when the map network is ready) from the
      // freshly written round files. Never needs a second parse.
      const ready = msg.record || (await readRecord(job.user, job.demoId).catch(() => null));
      // "analyzed" is the last phase the bar shows, so the batch is not settled
      // until the index lands rather than when the parse does.
      scheduleStatsIndex(statsIo, job.user, ready, () => {
        setPhase(entry, 'analyzed');
        settleBatch(batch);
      });
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

    // A kill is the one failure worth retrying, because it is about how much
    // the parse tried to hold rather than anything wrong with the demo. Retry
    // with half the batch so the attempt is actually different; an identical
    // retry just reproduces the kill, which is what made this loop forever.
    //
    // Holding the demo in memory (openDemo) is the other thing the attempt can
    // give up, and it is given up FIRST: it is a pure speed optimisation, worth
    // less than the parse completing, and it is the larger single allocation of
    // the two. Only then does the batch start halving.
    if (killed && job.attempt < MAX_ATTEMPTS) {
      const current = job.batchTicks || deriveBatchTicks();
      const dropBuffer = job.bufferDemo !== false;
      const next = dropBuffer ? current : Math.floor(current / 2);
      if (dropBuffer || next >= MIN_BATCH_TICKS) {
        if (stallTimer) clearTimeout(stallTimer);
        if (!worker.killed) worker.kill('SIGKILL');
        console.warn(
          `[replays] parse of ${job.filename} was killed; retrying ` +
            (dropBuffer
              ? 'without holding the demo in memory'
              : `at batch ${next} (was ${current})`) +
            ` (attempt ${job.attempt + 1}/${MAX_ATTEMPTS})`
        );
        job.attempt += 1;
        job.bufferDemo = false;
        job.batchTicks = next;
        job.state = 'queued';
        job.stage = 'retrying';
        running = null;
        queue.unshift(job); // it has already waited once
        pump();
        return;
      }
    }

    const message = killed
      ? `The parser was killed by the system, which almost always means the ` +
        `host ran out of memory. This was attempt ${job.attempt} of ${MAX_ATTEMPTS}, ` +
        `down to a batch of ${job.batchTicks || deriveBatchTicks()} ticks (heap limit ` +
        `${WORKER_HEAP_MB} MB). The demo is likely too large for this server. ` +
        `Check /api/replays/diag for how far it got.`
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

/**
 * Pick up parses that a restart interrupted.
 *
 * The queue lives in memory, so a demo whose record says "parsing" when the
 * process starts is one nothing is working on. Its .dem is still on the volume
 * (the source is only discarded once a parse reaches a terminal state), which
 * is exactly what a retry needs — so requeue it rather than making the user
 * upload hundreds of megabytes again. A record with no source left cannot be
 * resumed and is marked failed, which is what the library already showed for it.
 *
 * Called once at boot. Deliberately not awaited by the listener: a library with
 * several interrupted parses should not hold the port closed.
 */
export async function resumeInterruptedParses() {
  let resumed = 0;
  let abandoned = 0;
  for (const user of await listLibraryUsers()) {
    let records = [];
    try {
      records = await listDemos(user);
    } catch {
      continue;
    }

    // Reattach resumed jobs to the batch they came from, and adopt those
    // batches back into memory. Without this the upload a returning client is
    // polling would never reach "analyzed", so its progress bar would sit at
    // "parsed" forever while the parse itself quietly succeeded.
    const batchOfDemo = new Map();
    const adopted = [];
    for (const raw of await loadUserBatches(user)) {
      if (raw.finishedAt) continue;
      const batch = batches.get(raw.id) || raw;
      if (!batches.has(raw.id)) batches.set(raw.id, batch);
      adopted.push(batch);
      for (const f of batch.files || []) {
        if (f?.demoId) batchOfDemo.set(f.demoId, raw.id);
      }
    }

    for (const record of records) {
      if (record.status !== 'parsing') continue;
      if (jobs.get(jobKey(user, record.id))) continue;
      if (await hasSourceFile(user, record.id)) {
        enqueueParse({
          user,
          demoId: record.id,
          filename: record.filename,
          sizeBytes: record.sizeBytes,
          batchId: batchOfDemo.get(record.id) || null
        });
        resumed++;
      } else {
        const message =
          'Parsing was interrupted before it finished and the uploaded demo is no longer on ' +
          'the server. Upload it again to retry.';
        await markFailed(
          { user, demoId: record.id, filename: record.filename, sizeBytes: record.sizeBytes },
          message
        );
        // Fail it on the batch too, or the batch it belonged to would never
        // settle and a returning client would poll a dead upload forever.
        const batch = batches.get(batchOfDemo.get(record.id));
        if (batch) {
          failEntry(batchEntry(batch, record.id), message);
          settleBatch(batch);
        }
        abandoned++;
      }
    }

    // Finally, reconcile every adopted batch against the records.
    //
    // A parse can finish and the process can die before the stats index lands
    // and settles its batch — a window of a few hundred milliseconds, but one
    // where the record says "ready" while the snapshot still says "parsing".
    // Nothing above catches that (the record is not parsing, so it is not
    // resumed), and the result would be a client polling a batch that can never
    // settle. Marking each file from what its record actually says closes it.
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const batch of adopted) {
      for (const f of batch.files || []) {
        if (f.failed || f.phase === 'analyzed') continue;
        const rec = byId.get(f.demoId);
        // No record at all: the demo was deleted while the batch was in flight.
        if (!rec) {
          failEntry(f, 'That demo was removed before parsing finished.');
        } else if (rec.status === 'ready') {
          setPhase(f, 'analyzed');
        } else if (rec.status === 'error') {
          failEntry(f, rec.error);
        }
        // status 'parsing' means a job is on it now; leave it to finish.
      }
      settleBatch(batch);
    }
  }
  if (resumed || abandoned) {
    console.log(
      `[replays] interrupted parses: ${resumed} requeued, ${abandoned} unrecoverable`
    );
  }
  return { resumed, abandoned };
}
