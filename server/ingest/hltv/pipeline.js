// ---------------------------------------------------------------------------
// server/ingest/hltv/pipeline.js
// Sequential HLTV demo-id loop (and the older local batch path).
//
// HLTV mode walks /download/demo/{N} one at a time: download → unpack → parse →
// library → delete remains → N+1. A 404 frontier waits 10 minutes and retries
// the same id. Local mode keeps the discover + batch barrier for inbox drops.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fsp from 'node:fs/promises';
import { STATES } from './ledger.js';
import { cleanMatch, freeBytes, sweepOrphans } from './cleanup.js';
import { parseAndIngest, unpackArchive } from './process.js';
import {
  advanceCursor,
  cursorProgress,
  noteFrontierMiss,
  readCursor
} from './cursor.js';
import { MissingDemoError } from './classify.js';
import { isTransientDownloadError } from './transient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {import('./ledger.js').Ledger} deps.ledger
 * @param {object} deps.source
 * @param {(e: object) => void} [deps.onEvent]
 */
export function createPipeline({ cfg, ledger, source, onEvent = () => {} }) {
  const library = cfg.library;
  let stopping = false;
  /** Cancels the in-flight CloakBrowser download (same as probe Cancel). */
  let abort = new AbortController();
  /** What the admin page reports as "currently at". */
  let current = null;
  let cursorSnapshot = null;

  const emit = (type, data = {}) => onEvent({ type, at: Date.now(), ...data });

  function requestStop() {
    stopping = true;
    try {
      abort.abort(new Error('Ingest stop requested'));
    } catch {
      /* already aborted */
    }
  }

  function freshAbort() {
    abort = new AbortController();
    return abort.signal;
  }

  const isLive = (matchId) => {
    if (
      cfg.cloakDownloadsDir &&
      path.resolve(cfg.workDir, String(matchId)) === path.resolve(cfg.cloakDownloadsDir)
    ) {
      return true;
    }
    const row = ledger.get(matchId);
    if (!row) return false;
    return row.state !== STATES.CLEANED && row.state !== STATES.FILTERED_OUT;
  };

  async function recover() {
    const recovered = ledger.recoverInterrupted();
    for (const row of recovered) {
      await cleanMatch(cfg.workDir, row.matchId).catch(() => {});
    }
    await fsp.mkdir(cfg.workDir, { recursive: true });
    const swept = await sweepOrphans(cfg.workDir, isLive);
    await ledger.save();
    if (recovered.length || swept.removed.length) {
      emit('recovered', {
        requeued: recovered.length,
        orphansRemoved: swept.removed.length,
        freed: swept.freed
      });
    }
    return { recovered: recovered.length, ...swept };
  }

  async function sleepInterruptible(ms) {
    const step = 500;
    for (let waited = 0; waited < ms && !stopping; waited += step) {
      await sleep(Math.min(step, ms - waited));
    }
  }

  async function emitCursor(extra = {}) {
    cursorSnapshot = await readCursor(cfg);
    const progress = cursorProgress(cursorSnapshot);
    emit('cursor', { ...progress, ...extra });
    return progress;
  }

  // ---- sequential HLTV path ----------------------------------------------

  async function processDownloadedRow(row) {
    const dir = path.join(cfg.workDir, String(row.matchId));
    ledger.setState(row.matchId, STATES.PARSING);
    await ledger.save();

    current = {
      matchId: row.matchId,
      label: row.archiveName || `demo/${row.matchId}`,
      event: row.event || '',
      playedAt: row.playedAt || null,
      stage: 'unpack',
      map: null,
      demoId: Number(row.hltvDemoId || row.matchId)
    };
    emit('match-start', { ...current });

    try {
      const extracted = await unpackArchive(row.workPath, dir, {
        allowedBytes: cfg.maxArchiveBytes
      });
      const demos = extracted.filter((f) => f.name.toLowerCase().endsWith('.dem'));
      if (!demos.length) throw new Error('Archive contained no .dem files');

      const { described, results } = await parseAndIngest({
        library,
        row,
        demos,
        concurrency: cfg.parseConcurrency,
        onProgress: (p) => {
          if (current) {
            current.stage = p.stage || current.stage;
            current.map = p.map || current.map;
          }
          emit('match-progress', { matchId: row.matchId, ...p });
        }
      });

      const ok = results.filter((r) => r.ok);
      const dupes = ok.filter((r) => r.duplicate);
      const stored = ok.filter((r) => !r.duplicate);
      const unnamed = stored.filter((r) => !r.naming?.applied);
      if (!ok.length) {
        throw new Error(
          results.map((r) => r.error).filter(Boolean).join('; ') || 'no maps parsed'
        );
      }

      const allDuplicate = stored.length === 0 && dupes.length > 0;
      ledger.setState(row.matchId, allDuplicate ? STATES.FILTERED_OUT : STATES.INGESTED, {
        demoIds: stored.map((r) => r.demoId),
        event: described.event || row.event || '',
        teams: described.teams,
        mapsParsed: stored.length,
        mapsDuplicate: dupes.length,
        mapsFailed: results.length - ok.length,
        needsReview: unnamed.length > 0,
        lastError: results.find((r) => !r.ok)?.error || null
      });
      await ledger.save();

      if (allDuplicate) {
        emit('match-duplicate', {
          matchId: row.matchId,
          maps: dupes.length,
          duplicateOf: dupes.map((d) => d.duplicateOf)
        });
      } else {
        emit('match-ingested', {
          matchId: row.matchId,
          maps: stored.length,
          duplicates: dupes.length,
          failed: results.length - ok.length,
          teams: described.teams.map((t) => t.name),
          naming: stored.map((r) => r.naming?.confidence)
        });
      }

      if (!cfg.keepSources) {
        const { freed } = await cleanMatch(cfg.workDir, row.matchId);
        emit('match-cleaned', { matchId: row.matchId, freed });
      }
      if (!allDuplicate) {
        ledger.setState(row.matchId, unnamed.length ? STATES.NEEDS_REVIEW : STATES.CLEANED);
        await ledger.save();
      }
      return { ok: true, duplicate: allDuplicate, maps: stored.length };
    } catch (err) {
      ledger.fail(row.matchId, err, cfg.maxAttempts);
      await cleanMatch(cfg.workDir, row.matchId).catch(() => {});
      await ledger.save();
      emit('match-failed', { matchId: row.matchId, error: String(err?.message || err) });
      return { ok: false, error: String(err?.message || err) };
    } finally {
      current = null;
    }
  }

  /**
   * One demo id: download → unpack → parse → store → clean → advance.
   * Returns { advanced, missing, blocked }.
   */
  async function runOneDemo(demoId) {
    const id = Number(demoId);
    const matchId = String(id);
    const url = `https://www.hltv.org/download/demo/${id}`;

    if (!ledger.has(matchId)) {
      ledger.upsertDiscovered({
        matchId,
        source: 'hltv',
        hltvDemoId: id,
        matchUrl: url,
        playedAt: null,
        event: '',
        teams: []
      });
      await ledger.save();
    } else if (ledger.isTerminal(matchId)) {
      // Already finished this id in a prior run; skip download and advance.
      cursorSnapshot = await advanceCursor(cfg, cursorSnapshot || (await readCursor(cfg)), {
        success: true
      });
      await emitCursor();
      return { advanced: true, skipped: true };
    }

    const free = await freeBytes(cfg.workDir);
    if (free < cfg.minFreeBytes) {
      throw new Error(
        `Only ${(free / 1024 ** 3).toFixed(1)} GB free on the work volume, ` +
          `need ${(cfg.minFreeBytes / 1024 ** 3).toFixed(1)} GB.`
      );
    }

    const dir = path.join(cfg.workDir, matchId);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${id}.rar`);

    ledger.setState(matchId, STATES.DOWNLOADING);
    await ledger.save();
    current = {
      matchId,
      label: `demo/${id}`,
      demoId: id,
      stage: 'download',
      received: 0,
      totalBytes: 0
    };
    emit('download-start', {
      matchId,
      label: `demo/${id}`,
      event: '',
      playedAt: null,
      demoId: id
    });

    try {
      const got = await source.fetchDemoById(id, dest, {
        signal: abort.signal,
        onProgress: (p) => emit('download-progress', { matchId, ...p })
      });
      const row = ledger.setState(matchId, STATES.DOWNLOADED, {
        archiveBytes: got.bytes,
        workPath: got.path,
        archiveName: got.filename,
        event: got.event || '',
        bestOf: got.bestOf || null
      });
      await ledger.save();
      emit('download-complete', {
        matchId,
        bytes: got.bytes,
        label: got.filename || `demo/${id}`
      });

      const result = await processDownloadedRow(row);
      cursorSnapshot = await advanceCursor(cfg, cursorSnapshot || (await readCursor(cfg)), {
        success: Boolean(result.ok)
      });
      await emitCursor({ lastOutcome: result.duplicate ? 'duplicate' : result.ok ? 'ok' : 'failed' });
      return { advanced: true, missing: false, ...result };
    } catch (err) {
      await cleanMatch(cfg.workDir, matchId).catch(() => {});

      if (err instanceof MissingDemoError || err?.missing) {
        ledger.setState(matchId, STATES.DISCOVERED, {
          lastError: err.message,
          lastAttemptAt: new Date().toISOString()
        });
        await ledger.save();
        cursorSnapshot = await noteFrontierMiss(
          cfg,
          cursorSnapshot || (await readCursor(cfg))
        );
        const progress = await emitCursor({ lastOutcome: 'missing' });
        emit('frontier', {
          demoId: id,
          lastSuccessId: progress.lastSuccessId,
          nextCheckInMs: cfg.frontierWaitMs,
          frontierMisses: progress.frontierMisses
        });
        current = {
          matchId,
          label: `demo/${id}`,
          demoId: id,
          stage: 'waiting',
          lastSuccessId: progress.lastSuccessId
        };
        emit('download-failed', { matchId, error: err.message, missing: true });
        return { advanced: false, missing: true };
      }

      if (stopping || abort.signal.aborted) {
        emit('download-failed', { matchId, error: 'stopped', blocked: true });
        return { advanced: false, missing: false, blocked: true, waitMs: 0, stopped: true };
      }

      if (isTransientDownloadError(err)) {
        // Timeouts / CF / proxy weather are NOT proof the id is gone. Probe can
        // clear the same URL a minute later; never skip ahead on these.
        ledger.setState(matchId, STATES.DISCOVERED, {
          lastError: String(err.message || err),
          lastAttemptAt: new Date().toISOString()
        });
        await ledger.save();
        const waitMs = Math.max(
          cfg.minDelayMs || 20_000,
          Math.min(Number(cfg.challengeWaitMs) || 45_000, cfg.frontierWaitMs || 600_000)
        );
        emit('download-failed', {
          matchId,
          error: String(err.message || err),
          blocked: true,
          nextCheckInMs: waitMs
        });
        emit('challenge', { demoId: id, nextCheckInMs: waitMs, error: String(err.message || err) });
        current = {
          matchId,
          label: `demo/${id}`,
          demoId: id,
          stage: 'waiting',
          reason: 'challenge'
        };
        return { advanced: false, missing: false, blocked: true, waitMs };
      }

      if (err?.fatal) {
        ledger.fail(matchId, err, cfg.maxAttempts);
        await ledger.save();
        emit('download-failed', { matchId, error: String(err.message || err) });
        throw err;
      }

      // Permanent-ish failure: do not stall the sequence on one bad id.
      ledger.fail(matchId, err, 1);
      await ledger.save();
      emit('download-failed', { matchId, error: String(err?.message || err) });
      cursorSnapshot = await advanceCursor(cfg, cursorSnapshot || (await readCursor(cfg)), {
        success: false
      });
      await emitCursor({ lastOutcome: 'failed' });
      return { advanced: true, missing: false, ok: false, error: String(err?.message || err) };
    } finally {
      if (current?.stage !== 'waiting') current = null;
    }
  }

  async function runSequential({ continuous = false, maxLoops = Infinity } = {}) {
    stopping = false;
    freshAbort();
    await recover();
    cursorSnapshot = await readCursor(cfg);
    await emitCursor();

    let loops = 0;
    while (!stopping && loops < maxLoops) {
      if (abort.signal.aborted) freshAbort();
      const id = Number(cursorSnapshot.nextId);
      const outcome = await runOneDemo(id);
      if (stopping) break;

      if (outcome.missing) {
        if (!continuous) break;
        emit('idle', {
          nextPollInMs: cfg.frontierWaitMs,
          reason: 'frontier',
          demoId: id,
          lastSuccessId: cursorSnapshot.lastSuccessId
        });
        await sleepInterruptible(cfg.frontierWaitMs);
        cursorSnapshot = await readCursor(cfg);
        continue;
      }

      if (outcome.stopped || stopping) break;

      if (outcome.blocked) {
        if (!continuous) break;
        const waitMs = outcome.waitMs || 45_000;
        emit('idle', {
          nextPollInMs: waitMs,
          reason: 'challenge',
          demoId: id
        });
        await sleepInterruptible(waitMs);
        cursorSnapshot = await readCursor(cfg);
        continue;
      }

      loops++;
      cursorSnapshot = await readCursor(cfg);
      if (!continuous && loops >= maxLoops) break;
      // Brief politeness gap between successful ids (reuse min delay).
      if (!stopping) await sleepInterruptible(cfg.minDelayMs || 0);
    }

    emit('run-end', { batches: loops, stopped: stopping });
    return { batches: loops };
  }

  // ---- local inbox batch path (unchanged shape) --------------------------

  async function discover() {
    if (typeof source.discover !== 'function') {
      return { found: 0, added: 0 };
    }
    const found = await source.discover({ since: cfg.since, until: cfg.until });
    let added = 0;
    for (const match of found) {
      if (!ledger.has(match.matchId)) added++;
      ledger.upsertDiscovered(match);
    }
    await ledger.save();
    emit('discovered', { found: found.length, added });
    return { found: found.length, added };
  }

  async function downloadBatch(rows) {
    const done = [];
    await Promise.all(
      rows.map(async (row) => {
        const dir = path.join(cfg.workDir, String(row.matchId));
        const dest = path.join(dir, row.archiveName || `${row.matchId}.rar`);
        ledger.setState(row.matchId, STATES.DOWNLOADING);
        await ledger.save();
        try {
          emit('download-start', {
            matchId: row.matchId,
            label: row.archiveName || row.matchId,
            event: row.event || '',
            playedAt: row.playedAt || null
          });
          const got = await source.fetchArchive(row, dest, {
            onProgress: (p) => emit('download-progress', { matchId: row.matchId, ...p })
          });
          if (!got?.bytes) throw new Error('Downloaded archive is empty');
          if (got.bytes > cfg.maxArchiveBytes) {
            throw new Error(`Archive is ${got.bytes} bytes, over the ${cfg.maxArchiveBytes} cap`);
          }
          ledger.setState(row.matchId, STATES.DOWNLOADED, {
            archiveBytes: got.bytes,
            workPath: got.path
          });
          emit('download-complete', {
            matchId: row.matchId,
            bytes: got.bytes,
            label: row.archiveName || row.matchId
          });
          done.push(ledger.get(row.matchId));
        } catch (err) {
          if (err?.fatal) throw err;
          ledger.fail(row.matchId, err, cfg.maxAttempts);
          await cleanMatch(cfg.workDir, row.matchId).catch(() => {});
          emit('download-failed', { matchId: row.matchId, error: String(err?.message || err) });
        }
        await ledger.save();
      })
    );
    return done;
  }

  async function processMatch(row) {
    return processDownloadedRow(row);
  }

  async function runBatch() {
    const rows = ledger.nextBatch(cfg.batchSize);
    if (!rows.length) return { done: 0, empty: true };

    const free = await freeBytes(cfg.workDir);
    if (free < cfg.minFreeBytes) {
      throw new Error(
        `Only ${(free / 1024 ** 3).toFixed(1)} GB free on the work volume, ` +
          `need ${(cfg.minFreeBytes / 1024 ** 3).toFixed(1)} GB.`
      );
    }

    emit('batch-start', { size: rows.length, matchIds: rows.map((r) => r.matchId) });
    const downloaded = await downloadBatch(rows);
    let done = 0;
    for (const row of downloaded) {
      const res = await processMatch(row);
      if (res.ok) done++;
    }
    emit('batch-end', { done });
    return { done, empty: false };
  }

  async function runLocal({ continuous = false, maxBatches = Infinity } = {}) {
    stopping = false;
    await recover();
    let batches = 0;
    while (!stopping && batches < maxBatches) {
      await discover();
      const { empty } = await runBatch();
      if (empty) {
        if (!continuous) break;
        emit('idle', { nextPollInMs: cfg.pollIntervalMs });
        await sleepInterruptible(cfg.pollIntervalMs);
        continue;
      }
      batches++;
      if (stopping || batches >= maxBatches) break;
      await sleepInterruptible(cfg.batchCooldownMs);
    }
    emit('run-end', { batches, stopped: stopping });
    return { batches };
  }

  async function run(opts = {}) {
    if (source.sequential && typeof source.fetchDemoById === 'function') {
      return runSequential({
        continuous: opts.continuous,
        maxLoops: opts.maxBatches ?? Infinity
      });
    }
    return runLocal(opts);
  }

  return {
    run,
    runBatch,
    discover,
    recover,
    requestStop,
    get current() {
      return current;
    },
    get cursor() {
      return cursorSnapshot;
    },
    get stopping() {
      return stopping;
    }
  };
}
