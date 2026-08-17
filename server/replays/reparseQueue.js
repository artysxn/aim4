// ---------------------------------------------------------------------------
// server/replays/reparseQueue.js
// The upgrade queue: re-fetch a demo's original .dem from HLTV, parse it at
// the current PARSER_REVISION, and swap the result in UNDER THE EXISTING
// DEMO ID.
//
// Why this exists: revisions 1-2 asked demoparser2 for `is_ducking` and
// `in_air`, which it silently omits, so every round they produced has zeros
// where jump and crouch should be. That cannot be repaired from the stored
// tick buffer — a stationary crouch leaves no trace in a row — so the only
// repair is a reparse, and a reparse needs the .dem the server does not keep.
// The ingest ledger is what makes it possible at all: for HLTV-sourced demos
// the row is keyed by the HLTV demo id and carries the download URL.
//
// Two rules, both easy to get wrong and both expensive at 4200x scale:
//
//   1. REUSE the demo id. tools and pipeline mint a fresh id per parse
//      (newDemoId()); doing that here would leave the old package in place
//      and add a second copy beside it, so a full backfill would double the
//      library instead of upgrading it. The id is the thing users' links,
//      notes and stats hang off.
//   2. Write the new files only after the parse succeeds. A half-finished
//      upgrade must leave the old, working package untouched — a round the
//      viewer can open with no crouch beats a round it cannot open at all.
//
// Ordering is the user-visible part: one job runs at a time (HLTV is rate
// limited and Cloudflare-gated), and a request made while something is
// downloading lands at position 2, behind the active job and ahead of
// whatever was requested after it.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { MOVEMENT_REVISION, PARSER_REVISION } from '../demoparser/schema.js';
import { readRecord as readDemoRecord, writeMaterialized, listDemos, invalidateDemoList } from './demoStore.js';

/** Job states, forward-only except a retry which returns to `queued`. */
export const JOB = Object.freeze({
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  PARSING: 'parsing',
  DONE: 'done',
  FAILED: 'failed'
});

/** Kept in memory: a queue that does not survive a restart is fine here, */
/** because the work is idempotent and the library records what succeeded. */
const jobs = new Map(); // key `${user}/${demoId}` -> job
let order = []; // keys, in service order
let running = false;
let seq = 0;

const keyOf = (user, demoId) => `${user}/${demoId}`;

/**
 * Which HLTV archive produced this demo, or null when nothing can fetch it.
 * Reads the ingest ledger, whose rows are keyed by the HLTV demo id and list
 * the aim4 demo ids each archive produced.
 */
export async function hltvHandleFor(demoId, { ledgerPath } = {}) {
  let file = ledgerPath;
  if (!file) {
    const { loadConfig } = await import('../ingest/hltv/config.js');
    file = (await loadConfig()).ledgerPath;
  }
  let ledger;
  try {
    ledger = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const want = String(demoId);
  for (const row of ledger.matches || []) {
    if (!(row.demoIds || []).some((id) => String(id) === want)) continue;
    const handle = row.hltvDemoId ?? (row.source === 'hltv' ? Number(row.matchId) : NaN);
    if (Number.isFinite(handle) && handle > 0) {
      return { hltvDemoId: handle, matchUrl: row.matchUrl || `https://www.hltv.org/download/demo/${handle}`, matchId: row.matchId };
    }
    return null; // found it, but it came from somewhere unfetchable
  }
  return null;
}

/**
 * What the client needs to decide what to show: is this demo already current,
 * can it be upgraded at all, and if it is queued, where.
 */
export async function statusFor(user, demoId) {
  const record = await readDemoRecord(user, demoId).catch(() => null);
  if (!record) return { ok: false, error: 'No such demo.' };
  const revision = record.parser?.revision ?? 1;
  const current = revision >= PARSER_REVISION;
  const job = jobs.get(keyOf(user, demoId)) || null;
  const handle = current ? null : await hltvHandleFor(demoId);
  return {
    ok: true,
    demoId,
    map: record.map || '',
    revision,
    targetRevision: PARSER_REVISION,
    current,
    // Jump/crouch landed at 3. Later revisions (grenade Z, …) are quality,
    // not a reason to hide the 3D viewer.
    movementReady: revision >= MOVEMENT_REVISION,
    // Upgradeable only when a source exists. Uploads and locally-ingested
    // demos have no handle and are frozen at whatever revision made them.
    upgradeable: !current && !!handle,
    job: job ? publicJob(job) : null
  };
}

function publicJob(job) {
  const idx = order.indexOf(job.key);
  return {
    state: job.state,
    // 1 is the job actually running; a fresh request lands at 2.
    position: idx >= 0 ? idx + 1 : job.state === JOB.DONE || job.state === JOB.FAILED ? 0 : 1,
    error: job.error || null,
    requestedAt: job.requestedAt,
    progress: job.progress || null
  };
}

/**
 * Put a demo in line. Idempotent: asking twice returns the existing place
 * rather than queueing it again.
 */
export async function requestUpgrade(user, demoId, deps = {}) {
  const status = await statusFor(user, demoId);
  if (!status.ok) return status;
  if (status.current) return { ok: true, alreadyCurrent: true, ...status };
  if (!status.upgradeable) {
    return {
      ok: false,
      error: 'This demo has no HLTV source on file, so it cannot be re-fetched.',
      ...status
    };
  }
  const key = keyOf(user, demoId);
  const existing = jobs.get(key);
  if (existing && existing.state !== JOB.FAILED) {
    return { ok: true, queued: true, ...status, job: publicJob(existing) };
  }
  const job = {
    key,
    user,
    demoId,
    state: JOB.QUEUED,
    error: null,
    progress: null,
    requestedAt: new Date().toISOString(),
    seq: ++seq
  };
  jobs.set(key, job);
  order.push(key);
  drain(deps).catch((err) => console.error('[reparse] drain failed', err));
  return { ok: true, queued: true, ...status, job: publicJob(job) };
}

/** Everything currently known, newest requests last. */
export function queueSnapshot() {
  return {
    running,
    targetRevision: PARSER_REVISION,
    jobs: order.map((k) => {
      const j = jobs.get(k);
      return { demoId: j.demoId, ...publicJob(j) };
    })
  };
}

/** Serial worker. One download at a time; HLTV will not tolerate more. */
async function drain(deps) {
  if (running) return;
  running = true;
  try {
    while (order.length) {
      const key = order[0];
      const job = jobs.get(key);
      if (!job) {
        order.shift();
        continue;
      }
      try {
        await runJob(job, deps);
        job.state = JOB.DONE;
      } catch (err) {
        job.state = JOB.FAILED;
        job.error = String(err?.message || err).slice(0, 200);
        console.error(`[reparse] ${job.demoId} failed:`, job.error);
      }
      order = order.filter((k) => k !== key);
    }
  } finally {
    running = false;
  }
}

/**
 * Fetch, parse, swap. Injectable so the test can drive it without HLTV:
 *   deps.fetchDemo(handle, destPath) -> path to a .dem on disk
 *   deps.parseDemo(file) -> normalized demo (server/demoparser)
 */
async function runJob(job, deps = {}) {
  const handle = await hltvHandleFor(job.demoId);
  if (!handle) throw new Error('no HLTV source on file');

  const workRoot = process.env.AIM4_REPARSE_DIR || path.join(process.cwd(), 'server', 'data', 'reparse');
  const dir = path.join(workRoot, String(job.demoId));
  await fsp.mkdir(dir, { recursive: true });

  const before = await readDemoRecord(job.user, job.demoId);
  try {
    job.state = JOB.DOWNLOADING;
    const fetchDemo = deps.fetchDemo || defaultFetchDemo;
    const demPath = await fetchDemo(
      handle,
      dir,
      (p) => {
        job.progress = p;
      },
      before?.mapName || before?.map || ''
    );

    job.state = JOB.PARSING;
    job.progress = null;
    const parseDemo = deps.parseDemo || (await import('../demoparser/index.js')).parseDemo;
    const demo = await parseDemo(demPath, { onProgress: (p) => (job.progress = p) });

    const previous = before;
    // The archive is a whole series; refuse to overwrite a demo with a
    // different map's rounds if the filename match picked wrong.
    if (previous?.map && demo?.map && String(demo.map).toUpperCase() !== String(previous.map).toUpperCase()) {
      throw new Error(`archive gave ${demo.map}, expected ${previous.map} — refusing to overwrite`);
    }
    const { materializeDemo, compactMaterializedFiles } = await import('./materialize.js');
    // Rule 1: the id is inherited, never minted. Everything the user attached
    // to this demo — notes, tags, visibility, view counts, and every link
    // anyone has shared — hangs off it.
    const { record: fresh, files: plain } = materializeDemo(demo, job.demoId, {
      filename: previous.filename,
      sizeBytes: previous.sizeBytes,
      uploadedAt: previous.uploadedAt ? Date.parse(previous.uploadedAt) || Date.now() : Date.now(),
      source: previous.source || 'hltv'
    });
    // Carry over everything the parse cannot know, so an upgrade is invisible
    // apart from the movement data appearing.
    const record = {
      ...fresh,
      visibility: previous.visibility ?? fresh.visibility,
      tags: previous.tags ?? fresh.tags,
      views: previous.views ?? fresh.views,
      topPlayer: previous.topPlayer ?? fresh.topPlayer,
      reparsedAt: new Date().toISOString()
    };
    // Rule 2: this is the first destructive step, and it only runs once the
    // parse above has fully succeeded.
    await writeMaterialized(job.user, record, compactMaterializedFiles(plain));
    invalidateDemoList(job.user);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pull one archive through the ingest transport and hand back a .dem path.
 * Deliberately the same transport the continuous ingester uses — one gated,
 * sequential download — so a backfill cannot race the crawler into HLTV's
 * rate limiter.
 *
 * A match archive holds one .dem per map of the series, and the demo id we
 * are upgrading came from exactly one of them. `map` on the stored record is
 * what picks the right file back out.
 */
async function defaultFetchDemo(handle, dir, onProgress, wantMap = '') {
  const [{ loadConfig }, { createHltvSource }, { unpackArchive }] = await Promise.all([
    import('../ingest/hltv/config.js'),
    import('../ingest/hltv/sources/hltv.js'),
    import('../ingest/hltv/process.js')
  ]);
  const cfg = await loadConfig();
  const source = createHltvSource(cfg);
  const dest = path.join(dir, `${handle.hltvDemoId}.rar`);
  const got = await source.fetchDemoById(handle.hltvDemoId, dest, { onProgress });
  const archive = got?.path || dest;

  const extracted = await unpackArchive(archive, dir, {
    allowedBytes: cfg.maxExtractBytes || cfg.maxArchiveBytes * 4
  });
  const demos = extracted.filter((f) => String(f.name || '').toLowerCase().endsWith('.dem'));
  if (!demos.length) throw new Error('archive contained no .dem');
  // Prefer the file whose name carries the map we are upgrading; a series
  // archive has three, and parsing the wrong one would overwrite this demo
  // with a different map entirely.
  const slug = String(wantMap || '').toLowerCase();
  const hit = slug && demos.find((f) => String(f.name).toLowerCase().includes(slug));
  const chosen = hit || demos[0];
  return chosen.path || path.join(dir, chosen.name);
}

/** Test seam. */
export function _resetQueue() {
  jobs.clear();
  order = [];
  running = false;
  seq = 0;
}
