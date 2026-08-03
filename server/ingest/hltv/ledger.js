// ---------------------------------------------------------------------------
// server/ingest/hltv/ledger.js
// The only state the ingester has.
//
// One row per match. Everything else in the program is a worker that moves rows
// between states, which is what makes the whole run resumable: kill the process
// at any point, start it again, and it picks up from the ledger with no
// reconciliation step.
//
// Two rules make that work, and both are easy to break by accident:
//
//   1. The state transition is written BEFORE the work it describes, never
//      after. A row found in `downloading` at startup means the process died
//      mid-download, so the partial file is discarded and the row is reset.
//   2. Rows are only ever advanced by the worker that owns them. Nothing scans
//      the work directory and infers state from files on disk; files are
//      derived from the ledger, not the other way round.
//
// Writes are atomic (temp file + rename) because a half-written ledger is the
// one failure this design cannot recover from.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Forward-only, except retries which go back to `discovered`. */
export const STATES = Object.freeze({
  DISCOVERED: 'discovered',
  FILTERED_OUT: 'filtered_out',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  PARSING: 'parsing',
  INGESTED: 'ingested',
  CLEANED: 'cleaned',
  NEEDS_REVIEW: 'needs_review',
  FAILED: 'failed_permanent'
});

/** States a run is finished with. Never picked up again. */
const TERMINAL = new Set([STATES.CLEANED, STATES.FILTERED_OUT, STATES.FAILED]);

/** States that mean "a process was working on this when it died". */
const INTERRUPTED = new Set([STATES.DOWNLOADING, STATES.PARSING]);

export class Ledger {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, object>} */
    this.rows = new Map();
    this._writing = null;
    this._dirty = false;
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      for (const row of raw.matches || []) this.rows.set(String(row.matchId), row);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  /**
   * Reset anything a crash left mid-flight.
   *
   * Called once at startup, before any worker runs. Returns the rows it touched
   * so the caller can delete their scratch files.
   */
  recoverInterrupted() {
    const recovered = [];
    for (const row of this.rows.values()) {
      if (!INTERRUPTED.has(row.state)) continue;
      row.state = STATES.DISCOVERED;
      row.lastError = 'Interrupted by a restart; requeued.';
      row.updatedAt = new Date().toISOString();
      recovered.push(row);
    }
    if (recovered.length) this._dirty = true;
    return recovered;
  }

  get(matchId) {
    return this.rows.get(String(matchId)) || null;
  }

  has(matchId) {
    return this.rows.has(String(matchId));
  }

  /**
   * Add a discovered match, or refresh the metadata of one already known.
   *
   * Idempotent by design: re-running discovery over a window that was already
   * crawled must not reset progress, so an existing row keeps its state and
   * only its metadata is updated.
   */
  upsertDiscovered(match) {
    const key = String(match.matchId);
    const existing = this.rows.get(key);
    if (existing) {
      Object.assign(existing, match, {
        state: existing.state,
        attempts: existing.attempts,
        demoIds: existing.demoIds,
        updatedAt: new Date().toISOString()
      });
      this._dirty = true;
      return existing;
    }
    const row = {
      ...match,
      matchId: key,
      state: STATES.DISCOVERED,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      archiveBytes: null,
      demoIds: [],
      needsReview: false,
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.rows.set(key, row);
    this._dirty = true;
    return row;
  }

  /** Move a row to a new state, merging any extra fields. */
  setState(matchId, state, patch = {}) {
    const row = this.get(matchId);
    if (!row) throw new Error(`Unknown match ${matchId}`);
    row.state = state;
    Object.assign(row, patch);
    row.updatedAt = new Date().toISOString();
    this._dirty = true;
    return row;
  }

  /**
   * Record a failed attempt. Rows that have used up their attempts become
   * terminal so they can never block the queue by being retried forever.
   */
  fail(matchId, error, maxAttempts = 3) {
    const row = this.get(matchId);
    if (!row) throw new Error(`Unknown match ${matchId}`);
    row.attempts = (row.attempts || 0) + 1;
    row.lastError = String(error?.message || error).slice(0, 500);
    row.lastAttemptAt = new Date().toISOString();
    row.state = row.attempts >= maxAttempts ? STATES.FAILED : STATES.DISCOVERED;
    row.updatedAt = row.lastAttemptAt;
    this._dirty = true;
    return row;
  }

  /**
   * The next N matches to work on, oldest first.
   *
   * Chronological because the admin page shows "which demo are we at", and a
   * run that jumps around has no meaningful progress to report.
   */
  nextBatch(size) {
    return [...this.rows.values()]
      .filter((r) => r.state === STATES.DISCOVERED)
      .sort((a, b) => String(a.playedAt || '').localeCompare(String(b.playedAt || '')))
      .slice(0, size);
  }

  counts() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const state of Object.values(STATES)) out[state] = 0;
    for (const row of this.rows.values()) out[row.state] = (out[row.state] || 0) + 1;
    out.total = this.rows.size;
    out.done = out[STATES.CLEANED] + out[STATES.FILTERED_OUT] + out[STATES.FAILED];
    out.remaining = out.total - out.done;
    return out;
  }

  /** Oldest unprocessed match, for "currently at" in the UI. */
  oldestPending() {
    return this.nextBatch(1)[0] || null;
  }

  isTerminal(matchId) {
    const row = this.get(matchId);
    return Boolean(row && TERMINAL.has(row.state));
  }

  /**
   * Persist. Serialised through a single promise so two concurrent workers
   * cannot interleave writes to the same file.
   */
  async save() {
    if (this._writing) {
      await this._writing;
      if (!this._dirty) return;
    }
    this._writing = (async () => {
      this._dirty = false;
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        matches: [...this.rows.values()]
      };
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2));
      await fsp.rename(tmp, this.file);
    })();
    try {
      await this._writing;
    } finally {
      this._writing = null;
    }
  }
}

export async function openLedger(file) {
  return new Ledger(file).load();
}
