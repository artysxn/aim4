// ---------------------------------------------------------------------------
// server/ingest/hltv/pipeline.js
// The loop: download a batch, parse it, clear the shelf, repeat.
//
// Stages run as barriers rather than as a continuous stream. All three archives
// finish downloading before any of them is parsed, and all three are parsed
// before any is deleted. That is slightly less efficient than a rolling
// pipeline and dramatically easier to resume, because at any instant every row
// in the batch is in the same state and the ledger says which one.
//
// Every transition is written to the ledger BEFORE the work it describes, so a
// process killed at any point leaves a row that says what it was in the middle
// of. Startup resets those rows and deletes their scratch files.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fsp from 'node:fs/promises';
import { STATES } from './ledger.js';
import { cleanMatch, freeBytes, sweepOrphans } from './cleanup.js';
import { parseAndIngest, unpackArchive } from './process.js';

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
  /** What the admin page reports as "currently at". */
  let current = null;

  const emit = (type, data = {}) => onEvent({ type, at: Date.now(), ...data });

  function requestStop() {
    stopping = true;
  }

  /** Files for a row are needed while it is anything but finished-and-clean. */
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

  /** Once at startup: reset interrupted rows and bin their leftovers. */
  async function recover() {
    const recovered = ledger.recoverInterrupted();
    for (const row of recovered) {
      await cleanMatch(cfg.workDir, row.matchId).catch(() => {});
    }
    await fsp.mkdir(cfg.workDir, { recursive: true });
    const swept = await sweepOrphans(cfg.workDir, isLive);
    await ledger.save();
    if (recovered.length || swept.removed.length) {
      emit('recovered', { requeued: recovered.length, orphansRemoved: swept.removed.length, freed: swept.freed });
    }
    return { recovered: recovered.length, ...swept };
  }

  /** Ask the source what exists and fold it into the ledger. */
  async function discover() {
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

  // ---- stage 1: download --------------------------------------------------

  async function downloadBatch(rows) {
    const done = [];
    await Promise.all(
      rows.map(async (row) => {
        const dir = path.join(cfg.workDir, String(row.matchId));
        const dest = path.join(dir, row.archiveName || `${row.matchId}.rar`);
        // State first: a crash here leaves `downloading`, which startup resets.
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
          if (err?.fatal) throw err; // a challenge stops everything
          ledger.fail(row.matchId, err, cfg.maxAttempts);
          await cleanMatch(cfg.workDir, row.matchId).catch(() => {});
          emit('download-failed', { matchId: row.matchId, error: String(err?.message || err) });
        }
        await ledger.save();
      })
    );
    return done;
  }

  // ---- stage 2 + 3: parse, then clear the shelf ---------------------------

  async function processMatch(row) {
    const dir = path.join(cfg.workDir, String(row.matchId));
    ledger.setState(row.matchId, STATES.PARSING);
    await ledger.save();

    current = {
      matchId: row.matchId,
      label: row.archiveName || row.matchId,
      event: row.event || '',
      playedAt: row.playedAt || null,
      stage: 'unpack',
      map: null
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
      const unnamed = ok.filter((r) => !r.naming?.applied);
      if (!ok.length) {
        throw new Error(results.map((r) => r.error).filter(Boolean).join('; ') || 'no maps parsed');
      }

      ledger.setState(row.matchId, STATES.INGESTED, {
        demoIds: ok.map((r) => r.demoId),
        event: described.event || row.event || '',
        teams: described.teams,
        mapsParsed: ok.length,
        mapsFailed: results.length - ok.length,
        needsReview: unnamed.length > 0,
        lastError: results.find((r) => !r.ok)?.error || null
      });
      await ledger.save();
      emit('match-ingested', {
        matchId: row.matchId,
        maps: ok.length,
        failed: results.length - ok.length,
        teams: described.teams.map((t) => t.name),
        naming: ok.map((r) => r.naming?.confidence)
      });

      // Stage 4, immediately. This is what keeps disk use flat.
      if (!cfg.keepSources) {
        const { freed } = await cleanMatch(cfg.workDir, row.matchId);
        emit('match-cleaned', { matchId: row.matchId, freed });
      }
      ledger.setState(row.matchId, unnamed.length ? STATES.NEEDS_REVIEW : STATES.CLEANED);
      await ledger.save();
      return { ok: true, maps: ok.length };
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

  /** One full batch: download N, parse them, clean them. */
  async function runBatch() {
    const rows = ledger.nextBatch(cfg.batchSize);
    if (!rows.length) return { done: 0, empty: true };

    const free = await freeBytes(cfg.workDir);
    if (free < cfg.minFreeBytes) {
      throw new Error(
        `Only ${(free / 1024 ** 3).toFixed(1)} GB free on the work volume, ` +
          `need ${(cfg.minFreeBytes / 1024 ** 3).toFixed(1)} GB. ` +
          'If the library is not full, cleanup is failing and archives are piling up.'
      );
    }

    emit('batch-start', { size: rows.length, matchIds: rows.map((r) => r.matchId) });
    const downloaded = await downloadBatch(rows);

    let done = 0;
    for (const row of downloaded) {
      // A stop prevents another batch. Finish every archive already downloaded
      // so no row is left stranded in DOWNLOADED across the restart.
      const res = await processMatch(row);
      if (res.ok) done++;
    }
    emit('batch-end', { done });
    return { done, empty: false };
  }

  /**
   * Run until the queue empties or `stop()` is called.
   *
   * `continuous` keeps the process alive on an empty queue and re-runs
   * discovery on the poll interval, which is how newly finished matches get
   * picked up without a restart.
   */
  async function run({ continuous = false, maxBatches = Infinity } = {}) {
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

  /** Sleep that wakes early when stop() lands, so the UI stays responsive. */
  async function sleepInterruptible(ms) {
    const step = 500;
    for (let waited = 0; waited < ms && !stopping; waited += step) {
      await sleep(Math.min(step, ms - waited));
    }
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
    get stopping() {
      return stopping;
    }
  };
}
