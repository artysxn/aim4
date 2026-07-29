// ---------------------------------------------------------------------------
// replays/tickStore.js
// Loading strategy for round tick data, and the sampler the renderer reads.
//
// Timeline mode loads one round at a time, at full detail:
//   - Opening the viewer loads the first selected round fully.
//   - Clicking another round loads that round fully (if not already cached).
//   - Loaded rounds stay in memory until the viewer closes or a different
//     selection is opened.
//
// Macro mode still needs every selected round: it loads them at full detail,
// one round at a time, in order. A coarse (stride-100) fetch helper remains
// available for other UIs that want a cheap preview.
// ---------------------------------------------------------------------------

import { fetchRoundTicks } from './api.js';
import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  readHeader,
  readRecord,
  lerpAngle
} from './shared/tickFormat.js';

export const COARSE_STRIDE = 100;

/** One decoded tick buffer, addressable by demo tick. */
export class TickTrack {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.header = readHeader(buffer);
    const { tickCount, stride, firstTick } = this.header;
    this.firstTick = firstTick;
    this.stride = stride;
    this.rows = tickCount;
    this.lastTick = firstTick + Math.max(0, tickCount - 1) * stride;
  }

  get byteLength() {
    return this.buffer.byteLength;
  }

  /** Fractional row for a demo tick, clamped into range. */
  rowAt(demoTick) {
    const raw = (demoTick - this.firstTick) / this.stride;
    return Math.max(0, Math.min(this.rows - 1, raw));
  }

  /**
   * Interpolated state for one player. Positions and view angles blend
   * between the two nearest rows so droplets glide instead of stepping;
   * discrete fields (weapon, health, flags) take the row already reached.
   */
  sample(slot, demoTick, out = {}) {
    const row = this.rowAt(demoTick);
    const i = Math.floor(row);
    const t = row - i;
    readRecord(this.view, i, slot, out);
    if (t <= 0 || i + 1 >= this.rows) return out;

    const next = readRecord(this.view, i + 1, slot, SCRATCH);
    // A player who is dead on one side of the gap should not slide toward the
    // other: interpolate only while the droplet exists on both rows.
    if (!out.alive || !next.alive) return out;
    out.x += (next.x - out.x) * t;
    out.y += (next.y - out.y) * t;
    out.z += (next.z - out.z) * t;
    out.yaw = lerpAngle(out.yaw, next.yaw, t);
    out.pitch += (next.pitch - out.pitch) * t;
    return out;
  }

  /** Fill an array of 10 states for one moment. */
  sampleAll(demoTick, out = []) {
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      out[s] = this.sample(s, demoTick, out[s] || {});
    }
    return out;
  }
}

const SCRATCH = {};

/**
 * Per-round cache. `coarse` arrives in the first pass, `full` when the round
 * is opened; `best` prefers full detail and falls back to coarse so playback
 * can start before the full download lands.
 */
class RoundEntry {
  constructor(file) {
    this.file = file;
    this.coarse = null;
    this.full = null;
    this.loadingFull = null;
  }

  get best() {
    return this.full || this.coarse;
  }

  get isFull() {
    return Boolean(this.full);
  }

  get bytes() {
    return (this.coarse?.byteLength || 0) + (this.full?.byteLength || 0);
  }
}

export class TickStore {
  constructor() {
    /** @type {Map<string, RoundEntry>} */
    this.rounds = new Map();
    this.listeners = new Set();
    this.cancelled = false;
    /** Bumped to retire the running background prefetch (see warm()). */
    this.warmPass = 0;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  entry(file) {
    let e = this.rounds.get(file);
    if (!e) {
      e = new RoundEntry(file);
      this.rounds.set(file, e);
    }
    return e;
  }

  get(file) {
    return this.rounds.get(file) || null;
  }

  track(file) {
    return this.rounds.get(file)?.best || null;
  }

  /** Total bytes held, for the viewer's memory readout. */
  get bytes() {
    let n = 0;
    for (const e of this.rounds.values()) n += e.bytes;
    return n;
  }

  /**
   * Pass one. Walks the selection in order, pulling every Nth tick of each
   * round before moving to the next.
   */
  async coarsePass(files, stride = COARSE_STRIDE) {
    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) return;
      const file = files[i];
      const e = this.entry(file);
      if (e.coarse || e.full) {
        this.emit({ type: 'coarse', file, index: i, total: files.length, cached: true });
        continue;
      }
      try {
        const buf = await fetchRoundTicks(file, stride);
        if (this.cancelled) return;
        e.coarse = new TickTrack(buf);
        this.emit({ type: 'coarse', file, index: i, total: files.length });
      } catch (err) {
        this.emit({ type: 'error', file, error: err.message });
      }
    }
    this.emit({ type: 'coarse-done', total: files.length });
  }

  /**
   * Pass two for a single round. Concurrent calls for the same round share
   * one request, so re-selecting a round mid-download does not refetch it.
   */
  loadFull(file) {
    const e = this.entry(file);
    if (e.full) return Promise.resolve(e.full);
    if (e.loadingFull) return e.loadingFull;

    e.loadingFull = (async () => {
      try {
        const buf = await fetchRoundTicks(file, 1);
        if (this.cancelled) return null;
        e.full = new TickTrack(buf);
        this.emit({ type: 'full', file });
        return e.full;
      } catch (err) {
        this.emit({ type: 'error', file, error: err.message });
        return null;
      } finally {
        e.loadingFull = null;
      }
    })();
    return e.loadingFull;
  }

  /**
   * Pass two for the rest of a selection: the watched round first, then the
   * others in order, so the round on screen is always the one being filled in.
   */
  async fullPass(files, startIndex = 0) {
    const ordered = [...files.slice(startIndex), ...files.slice(0, startIndex)];
    for (let i = 0; i < ordered.length; i++) {
      if (this.cancelled) return;
      await this.loadFull(ordered[i]);
      this.emit({ type: 'full-progress', index: i + 1, total: ordered.length });
    }
    this.emit({ type: 'full-done', total: ordered.length });
  }

  /**
   * Pull the rest of a selection in the background, nearest round first.
   *
   * Timeline mode used to fetch a round only when it was clicked, so every
   * first visit to a round paid a request, a decode and the download before
   * anything moved. A full-detail round is ~75 KB on the wire, which makes a
   * whole 24-round match under 2 MB: there is no reason to make the user wait
   * for one of them.
   *
   * Ordering spirals out from the round on screen, because the next thing
   * clicked is nearly always adjacent (or the next round arriving on its own
   * during playback). Calling it again supersedes the previous pass, so moving
   * around re-aims the prefetch at wherever the user now is rather than
   * queueing another whole match behind the first.
   *
   * Requests are shared with loadFull, so clicking a round that is mid-warm
   * waits on the same request instead of starting a second one.
   *
   * @param {string[]} files
   * @param {number} activeIndex
   * @param {number} [concurrency] kept low so a click is never stuck behind a
   *   queue of speculative fetches on a slow connection
   */
  warm(files, activeIndex = 0, concurrency = 2) {
    const pass = ++this.warmPass;
    const order = spiral(files.length, activeIndex);
    let next = 0;

    const worker = async () => {
      for (;;) {
        if (this.cancelled || pass !== this.warmPass) return;
        const i = next++;
        if (i >= order.length) return;
        const file = files[order[i]];
        if (!file || this.get(file)?.isFull) continue;
        try {
          await this.loadFull(file);
        } catch {
          /* one unreachable round must not stop the rest of the pass */
        }
        if (pass === this.warmPass) {
          this.emit({ type: 'warm-progress', file, done: i + 1, total: order.length });
        }
      }
    };

    const running = [];
    for (let n = 0; n < Math.max(1, concurrency); n++) running.push(worker());
    return Promise.all(running).then(() => {
      if (pass === this.warmPass && !this.cancelled) {
        this.emit({ type: 'warm-done', total: order.length });
      }
    });
  }

  /** Stop the background pass without touching what it already loaded. */
  stopWarm() {
    this.warmPass++;
  }

  /**
   * Macro mode: every tick of every round, one round at a time, in order.
   */
  async macroPass(files) {
    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) return;
      await this.loadFull(files[i]);
      this.emit({ type: 'macro-progress', file: files[i], index: i + 1, total: files.length });
    }
    this.emit({ type: 'macro-done', total: files.length });
  }

  /**
   * Drop everything. Called when the viewer closes or a different set of
   * rounds is opened, which are the only two moments the spec unloads at.
   */
  clear() {
    this.cancelled = true;
    this.warmPass++;
    this.rounds.clear();
    this.emit({ type: 'cleared' });
  }

  /** Reuse a store for a new selection. */
  reset() {
    this.rounds.clear();
    this.cancelled = false;
    this.warmPass++;
  }
}

/**
 * Indices of `length` ordered outward from `from`: the round on screen, then
 * the one after, the one before, and so on. Trailing rounds come first at a
 * tie because playback moves forward.
 */
function spiral(length, from) {
  const start = Math.max(0, Math.min(length - 1, from | 0));
  const out = [];
  for (let d = 0; out.length < length && d <= length; d++) {
    if (d === 0) {
      out.push(start);
      continue;
    }
    if (start + d < length) out.push(start + d);
    if (start - d >= 0) out.push(start - d);
  }
  return out;
}

/** Bytes -> "1.4 MB", for the loading readout. */
export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export { HEADER_BYTES, TICK_BYTES };
