// ---------------------------------------------------------------------------
// server/replays/parseGate.js
// Cross-process rule: user parses outrank ingest parses.
//
// jobs.js keeps its own "one parse at a time" invariant, but only inside the
// API process. HLTV ingest parses in a DETACHED process (ingest/hltv/process.js)
// and cannot see the queue's memory, so with ingest on the box was running two
// 1 GB parse children plus Chromium at once — which is exactly when user
// uploads started failing halfway. The two sides need one signal that crosses
// the process boundary, and the only thing they already share is the replay
// volume, so the signal is a marker file on it.
//
// Direction matters and is deliberately one-way: a user upload is the site
// doing its job, ingest is a background errand (the same ranking SIM-PLAN 9.2b
// gives sim work). The API process marks the file while its queue runs; ingest
// waits for it before STARTING a parse and never the other way around. An
// ingest parse already in flight is left to finish — killing it would waste
// the download — so the worst overlap is one map.
//
// The marker carries liveness in its mtime. A heartbeat refreshes it while the
// queue runs, and a reader treats anything older than STALE_MS as a crashed
// writer rather than a busy one; a kill -9 of the API must not park ingest
// forever behind a file nobody owns.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './demoStore.js';

const MARKER = path.join(ROOT, '.user-parse-active');
/** Older than this and the writer is presumed dead, not busy. */
const STALE_MS = 90 * 1000;
/** Refresh cadence while the queue runs. Well inside STALE_MS on purpose. */
const HEARTBEAT_MS = 30 * 1000;

let heartbeat = null;

/** The API's parse queue has work. Idempotent; cheap to call per job. */
export function markUserParseActive() {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(MARKER, `${process.pid}\n`);
  } catch {
    /* a failed marker must never fail the parse it describes */
  }
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      const now = new Date();
      fsp.utimes(MARKER, now, now).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }
}

/** The queue drained. Remove the marker so ingest can carry on. */
export function clearUserParseActive() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  try {
    fs.rmSync(MARKER, { force: true });
  } catch {
    /* stale-mtime handling covers a marker that would not delete */
  }
}

/** Is the API process parsing right now (per a live marker)? */
export async function userParseActive() {
  try {
    const st = await fsp.stat(MARKER);
    return Date.now() - st.mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Block until the API's parse queue is idle. Ingest calls this before every
 * parse it starts.
 *
 * @param {{pollMs?: number, onWait?: () => void}} [opts] `onWait` fires once,
 *   on the first wait, so the ingest log says why it is holding without
 *   repeating itself every poll.
 * @returns {Promise<number>} how long it waited, in ms
 */
export async function waitForUserParseIdle({ pollMs = 5000, onWait } = {}) {
  let waited = 0;
  while (await userParseActive()) {
    if (waited === 0) onWait?.();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    waited += pollMs;
  }
  return waited;
}
