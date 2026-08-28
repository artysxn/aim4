// ---------------------------------------------------------------------------
// server/ingest/gdrive/queue.js
// A queue of Google Drive folders to pull demos from.
//
// HLTV ingest goes quiet when it is fully synced; the demos that exist and
// are not on HLTV live in shared Drive folders — small tournaments hand their
// demos around that way. An admin pastes a folder link, and this queue walks
// it: every subfolder, every archive, download, unpack, parse, import into
// the shared library as @admin, exactly what the probe does for one URL.
//
// It runs IN the API server process (the probe's pattern), not as a detached
// ingester: a Drive folder is a bounded errand, not an overnight crawl. What
// survives a restart is the state file — jobs found mid-run revert to queued,
// and nothing resumes on boot on its own, for the same reason the ingester's
// switch is forced Off on deploy: a restart must never quietly start pulling
// from the internet.
//
// Re-scanning is the normal case ("grab this folder again next week"), so
// every Drive file ever processed is remembered by its file id — stable
// across renames and re-uploads-in-place — and skipped the next time.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACCEPTED_EXTS, rarSupport } from '../../replays/archive.js';
import { SHARED_LIBRARY } from '../../replays/auth.js';
import { INGEST_UPLOADER } from '../../replays/identity.js';
import { importReplayPackage } from '../../replays/importPackage.js';
import { loadConfig } from '../hltv/config.js';
import { sniffMagic } from '../hltv/probe.js';
import { unpackArchive } from '../hltv/process.js';
import { createDriveClient, parseDriveLink } from './drive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARSE_WORKER = path.join(HERE, '..', 'hltv', 'probeParseWorker.js');
const WORKER_HEAP_MB = Number(process.env.AIM4_PARSE_HEAP_MB || 1024);
const PARSE_STALL_MS = Number(process.env.AIM4_PARSE_STALL_MS || 15 * 60 * 1000);

/** Walk limits: a pasted link must stay an errand, whatever it points at. */
const MAX_DEPTH = 8;
const MAX_FILES = 4000;
const MAX_FOLDERS = 600;
/** Log lines kept per job; older ones scroll off the state file. */
const MAX_LOG = 400;

// ---------------------------------------------------------------------------
// State: one file, one in-memory worker.
// ---------------------------------------------------------------------------

const state = {
  /** Loaded queue document, or null before first read. */
  doc: null,
  running: false,
  currentJobId: null,
  abort: null,
  child: null
};

const queueFile = (c) => path.join(c.stateDir, 'gdrive-queue.json');

function emptyDoc() {
  return { jobs: [], seen: {} };
}

async function loadDoc(c) {
  if (state.doc) return state.doc;
  try {
    state.doc = JSON.parse(await fsp.readFile(queueFile(c), 'utf8'));
  } catch {
    state.doc = emptyDoc();
  }
  if (!Array.isArray(state.doc.jobs)) state.doc.jobs = [];
  if (!state.doc.seen || typeof state.doc.seen !== 'object') state.doc.seen = {};
  // Jobs that say "running" with no worker in memory were interrupted by a
  // restart. Back to queued: the seen set makes re-running them cheap.
  for (const job of state.doc.jobs) {
    if (job.status === 'running') {
      job.status = 'queued';
      job.log.push(line('warn', 'Interrupted by a server restart; queued again.'));
    }
  }
  return state.doc;
}

/**
 * Writes are serialized through one chain: the logger persists fire-and-forget
 * on every line while the job loop persists awaited, and two writers renaming
 * the same tmp file is a race the loser loses with ENOENT.
 */
let persistChain = Promise.resolve();
let persistSeq = 0;

function persist(c) {
  if (!state.doc) return Promise.resolve();
  const doc = state.doc;
  persistChain = persistChain
    .then(async () => {
      await fsp.mkdir(c.stateDir, { recursive: true });
      const tmp = `${queueFile(c)}.tmp-${persistSeq++}`;
      await fsp.writeFile(tmp, JSON.stringify(doc, null, 2));
      await fsp.rename(tmp, queueFile(c));
    })
    .catch((err) => {
      console.warn('[gdrive] state write failed:', err?.message || err);
    });
  return persistChain;
}

function line(level, text) {
  return { at: new Date().toISOString(), level, text };
}

function jobLogger(c, job) {
  return (level, text) => {
    job.log.push(line(level, text));
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
    console.log(`[gdrive] ${level === 'info' ? '' : `${level.toUpperCase()} `}${text}`);
    persist(c).catch(() => {});
  };
}

function apiKey() {
  return process.env.GOOGLE_DRIVE_API_KEY || '';
}

// ---------------------------------------------------------------------------
// The public surface the admin routes call.
// ---------------------------------------------------------------------------

/** What the admin panel polls. */
export async function queueState() {
  const c = loadConfig({});
  const doc = await loadDoc(c);
  return {
    running: state.running,
    currentJobId: state.currentJobId,
    transport: apiKey() ? 'api' : 'scrape',
    seenCount: Object.keys(doc.seen).length,
    jobs: doc.jobs.map((j) => ({ ...j, log: j.log.slice(-60) }))
  };
}

/**
 * Add a Drive link to the queue and start the pump.
 * Also accepts a single-file link: one file is a folder of one.
 */
export async function addJob(url, hooks = {}) {
  const target = parseDriveLink(url);
  if (!target) {
    return { invalid: true, error: 'That is not a Google Drive folder or file link.' };
  }
  const c = loadConfig({});
  const doc = await loadDoc(c);

  const existing = doc.jobs.find(
    (j) => j.targetId === target.id && (j.status === 'queued' || j.status === 'running')
  );
  if (existing) return { duplicate: true, job: existing };

  const job = {
    id: `gd-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    url: String(url).trim(),
    targetId: target.id,
    targetKind: target.kind,
    name: '',
    status: 'queued',
    addedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    counts: { folders: 0, files: 0, matched: 0, skippedSeen: 0, downloaded: 0, parsed: 0, imported: 0, failed: 0 },
    live: null,
    log: [line('info', `Queued ${target.kind} ${target.id}`)]
  };
  doc.jobs.push(job);
  await persist(c);
  startPump(hooks);
  return { added: true, job };
}

/** Resume queued jobs (after a restart, or after Stop). */
export async function startQueue(hooks = {}) {
  const c = loadConfig({});
  const doc = await loadDoc(c);
  const pending = doc.jobs.some((j) => j.status === 'queued');
  if (!pending) return { started: false, reason: 'nothing queued' };
  startPump(hooks);
  return { started: true };
}

/** Stop after aborting the current job. Queued jobs stay queued. */
export async function stopQueue() {
  if (!state.running) return { stopped: false, reason: 'not running' };
  state.stopRequested = true;
  state.abort?.abort(new Error('Stopped by the operator'));
  state.child?.kill('SIGKILL');
  return { stopped: true };
}

/** Remove one job. The running one must be stopped first. */
export async function removeJob(id) {
  const c = loadConfig({});
  const doc = await loadDoc(c);
  if (state.currentJobId === id) return { removed: false, reason: 'running' };
  const before = doc.jobs.length;
  doc.jobs = doc.jobs.filter((j) => j.id !== id);
  await persist(c);
  return { removed: doc.jobs.length < before };
}

/**
 * Forget every processed Drive file id, so the next run of a folder imports
 * everything again. The admin's reset lever for "I deleted those demos and
 * want them back".
 */
export async function clearSeen() {
  const c = loadConfig({});
  const doc = await loadDoc(c);
  const count = Object.keys(doc.seen).length;
  doc.seen = {};
  await persist(c);
  return { cleared: count };
}

/** Only for tests: fresh module-level state. */
export function _resetQueueState() {
  state.doc = null;
  state.running = false;
  state.currentJobId = null;
  state.stopRequested = false;
  state.abort = null;
  state.child = null;
}

// ---------------------------------------------------------------------------
// The pump: one job at a time, one file at a time.
// ---------------------------------------------------------------------------

function startPump(hooks) {
  if (state.running) return;
  state.running = true;
  state.stopRequested = false;
  void pump(hooks)
    .catch((err) => console.error('[gdrive] pump crashed:', err))
    .finally(() => {
      state.running = false;
      state.currentJobId = null;
    });
}

async function pump(hooks = {}) {
  const c = loadConfig({});
  const doc = await loadDoc(c);
  for (;;) {
    if (state.stopRequested) return;
    const job = doc.jobs.find((j) => j.status === 'queued');
    if (!job) return;
    state.currentJobId = job.id;
    state.abort = new AbortController();
    await runJob(c, doc, job, hooks);
    state.currentJobId = null;
    state.abort = null;
  }
}

/** Case-blind "is this something the pipeline can eat". */
export function acceptsName(name) {
  const n = String(name || '').toLowerCase();
  return ACCEPTED_EXTS.some((ext) => n.endsWith(ext));
}

async function runJob(c, doc, job, hooks) {
  const log = jobLogger(c, job);
  const drive = hooks.driveClient || createDriveClient({ apiKey: apiKey() });
  const packageDemo = hooks.packageDemo || packageDemoForked;
  const importPackage = hooks.importPackage || defaultImport;
  const workDir = path.join(c.workDir, job.id);

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.error = null;
  await persist(c);

  const finish = async (status, error = null) => {
    job.status = status;
    job.error = error;
    job.live = null;
    job.finishedAt = new Date().toISOString();
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await persist(c);
  };

  try {
    log('info', `Job ${job.id} starting (${drive.transport} transport)`);
    if (drive.transport === 'scrape') {
      log(
        'warn',
        'No GOOGLE_DRIVE_API_KEY set: using the embedded folder view. Works, but the API key path is the reliable one.'
      );
    }

    // -- name the job -----------------------------------------------------
    const meta = await drive.describe(job.targetId).catch(() => null);
    job.name = meta?.name || job.targetId;
    log('info', `Target: "${job.name}"`);

    // -- walk -------------------------------------------------------------
    // Breadth-first with the folder path carried along: the path is the only
    // context a loose "map1.dem" has, and it ends up in the log and the
    // import filename.
    const files = [];
    if (job.targetKind === 'file') {
      files.push({ file: meta || { id: job.targetId, name: job.targetId }, dir: '' });
    } else {
      const stack = [{ id: job.targetId, dir: '', depth: 0 }];
      while (stack.length) {
        if (state.stopRequested) throw new Error('Stopped by the operator');
        const folder = stack.shift();
        job.counts.folders++;
        job.live = { stage: 'scan', detail: folder.dir || job.name };
        const entries = await drive.listFolder(folder.id);
        for (const e of entries) {
          if (e.isFolder) {
            if (folder.depth + 1 > MAX_DEPTH) {
              log('warn', `Skipping "${e.name}": deeper than ${MAX_DEPTH} levels`);
              continue;
            }
            if (job.counts.folders + stack.length >= MAX_FOLDERS) {
              log('warn', `Folder limit (${MAX_FOLDERS}) reached; not descending into "${e.name}"`);
              continue;
            }
            stack.push({ id: e.id, dir: path.posix.join(folder.dir, e.name), depth: folder.depth + 1 });
          } else {
            job.counts.files++;
            if (!acceptsName(e.name)) continue;
            if (files.length >= MAX_FILES) continue;
            files.push({ file: e, dir: folder.dir });
          }
        }
        await persist(c);
      }
    }
    job.counts.matched = files.length;
    log(
      'info',
      `Found ${files.length} demo file${files.length === 1 ? '' : 's'} across ${job.counts.folders} folder${job.counts.folders === 1 ? '' : 's'}`
    );

    // -- process ----------------------------------------------------------
    for (const { file, dir } of files) {
      if (state.stopRequested) throw new Error('Stopped by the operator');
      if (doc.seen[file.id]) {
        job.counts.skippedSeen++;
        continue;
      }
      const label = dir ? `${dir}/${file.name}` : file.name;
      try {
        const outcome = await processFile(c, doc, job, { file, dir, label }, { drive, packageDemo, importPackage, log, workDir });
        doc.seen[file.id] = { name: label, at: new Date().toISOString(), ...outcome };
      } catch (err) {
        if (state.stopRequested) throw err;
        job.counts.failed++;
        log('error', `${label}: ${err?.message || err}`);
        // Not marked seen: a transient failure deserves another chance on the
        // next run of this folder.
      }
      await persist(c);
    }

    job.live = null;
    const { imported, parsed, skippedSeen, failed } = job.counts;
    log(
      imported || !files.length ? 'ok' : 'warn',
      `DONE. Imported ${imported} demo${imported === 1 ? '' : 's'} (${parsed} parsed, ${skippedSeen} already known, ${failed} failed).`
    );
    await finish('done');
  } catch (err) {
    const stopped = state.stopRequested;
    log(stopped ? 'warn' : 'error', stopped ? 'Stopped by the operator.' : `FAILED: ${err?.message || err}`);
    await finish(stopped ? 'cancelled' : 'failed', stopped ? null : String(err?.message || err));
  }
}

/** One Drive file: download, unpack if needed, parse each demo, import. */
async function processFile(c, doc, job, { file, dir, label }, { drive, packageDemo, importPackage, log, workDir }) {
  const fileDir = path.join(workDir, file.id);
  await fsp.mkdir(fileDir, { recursive: true });

  try {
    // -- download ---------------------------------------------------------
    job.live = { stage: 'download', detail: label, received: 0, total: file.sizeBytes || 0 };
    let lastPersist = 0;
    const dest = path.join(fileDir, file.name.replace(/[/\\]/g, '_'));
    const got = await drive.download(file, dest, {
      maxBytes: c.maxArchiveBytes,
      signal: state.abort?.signal,
      onProgress: (p) => {
        job.live = { stage: 'download', detail: label, ...p };
        if (Date.now() - lastPersist > 2000) {
          lastPersist = Date.now();
          persist(c).catch(() => {});
        }
      }
    });
    job.counts.downloaded++;
    log('info', `Downloaded ${label} (${Math.round(got.bytes / 1024 / 1024)} MB)`);

    // -- classify by bytes, never by name ---------------------------------
    const head = Buffer.alloc(512);
    const fh = await fsp.open(got.path, 'r');
    const { bytesRead } = await fh.read(head, 0, 512, 0);
    await fh.close();
    const magic = sniffMagic(head.subarray(0, bytesRead));
    if (magic.kind === 'html' || magic.kind === 'unknown') {
      throw new Error(`not a demo or archive (${magic.kind} by magic bytes)`);
    }
    let archivePath = got.path;
    if (magic.ext && !archivePath.toLowerCase().endsWith(magic.ext)) {
      const renamed = `${archivePath}${magic.ext}`;
      await fsp.rename(archivePath, renamed);
      archivePath = renamed;
    }

    // -- unpack -----------------------------------------------------------
    let demos;
    if (magic.kind === 'dem') {
      const stat = await fsp.stat(archivePath);
      demos = [{ name: path.basename(archivePath), path: archivePath, sizeBytes: stat.size }];
    } else {
      if (magic.kind === 'rar' && !rarSupport().available) {
        throw new Error('RAR archive and this host has no extractor (install unar / libarchive-tools)');
      }
      job.live = { stage: 'unpack', detail: label };
      demos = await unpackArchive(archivePath, path.join(fileDir, 'extract'), {
        allowedBytes: c.maxExtractBytes || c.maxArchiveBytes * 4
      });
      if (!demos.length) throw new Error('archive contained no .dem files');
    }

    // -- parse + import ---------------------------------------------------
    let parsed = 0;
    let imported = 0;
    for (const demo of demos) {
      if (state.stopRequested) throw new Error('Stopped by the operator');
      const stem = path.basename(demo.name, path.extname(demo.name));
      const outPath = path.join(fileDir, `${stem}.aim4replay`);
      job.live = { stage: 'parse', detail: `${label} → ${demo.name}` };
      try {
        const summary = await packageDemo(demo.path, outPath, { filename: demo.name, sizeBytes: demo.sizeBytes });
        parsed++;
        job.counts.parsed++;
        const buf = await fsp.readFile(outPath);
        // The Drive folder path is the only event context these demos have;
        // it rides in the import filename, which the library displays.
        const importName = dir ? `${dir.replace(/\//g, ' - ')} - ${path.basename(outPath)}` : path.basename(outPath);
        await importPackage(buf, importName);
        imported++;
        job.counts.imported++;
        log(
          'ok',
          `Imported ${demo.name}: ${summary.mapName || summary.map || '?'} ` +
            `${summary.score?.team1 ?? '?'}:${summary.score?.team2 ?? '?'} (${summary.team1 || '?'} vs ${summary.team2 || '?'})`
        );
      } catch (err) {
        if (state.stopRequested) throw err;
        job.counts.failed++;
        log('error', `Parse failed for ${label} → ${demo.name}: ${err?.message || err}`);
      }
    }
    return { parsed, imported };
  } finally {
    // Downloads, extracted demos, and packages are all scratch by now.
    await fsp.rm(fileDir, { recursive: true, force: true }).catch(() => {});
  }
}

function defaultImport(buf, filename) {
  return importReplayPackage(SHARED_LIBRARY, buf, {
    filename,
    uploaderId: INGEST_UPLOADER.id,
    uploaderName: INGEST_UPLOADER.username,
    visibility: 'public',
    source: 'gdrive'
  });
}

/** The probe's forked parse, with the child tracked for Stop. */
function packageDemoForked(demoFile, outPath, meta) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ file: demoFile, outPath, meta });
    const child = fork(PARSE_WORKER, [payload], {
      execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    state.child = child;

    let settled = false;
    let stallTimer = null;
    const touch = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(new Error(`Parse made no progress for ${Math.round(PARSE_STALL_MS / 60000)} minutes`));
      }, PARSE_STALL_MS);
      stallTimer.unref?.();
    };
    const settle = (err, summary) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      state.child = null;
      if (!child.killed) child.kill('SIGKILL');
      err ? reject(err) : resolve(summary);
    };

    touch();
    child.on('message', (msg) => {
      if (msg.type === 'progress') touch();
      else if (msg.type === 'done') settle(null, msg.summary);
      else if (msg.type === 'error') settle(new Error(msg.error));
    });
    child.on('error', (err) => settle(err));
    child.on('exit', (code, signal) => {
      if (settled) return;
      settle(
        new Error(
          signal === 'SIGKILL' || code === null
            ? `Parse process was killed (${signal || 'no exit code'}), most likely out of memory`
            : `Parse process exited with code ${code}`
        )
      );
    });
  });
}
