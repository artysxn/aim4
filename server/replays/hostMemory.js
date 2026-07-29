// ---------------------------------------------------------------------------
// replays/hostMemory.js
// How much memory this process may actually use, and what the parser should
// size itself against.
//
// Inside a container os.totalmem() reports the HOST's RAM, not the container's
// limit, so sizing a parse off it on a 4 GB box with a 3.5 GB cgroup cap picks
// a batch that cannot fit. The cgroup limit is the number that matters and it
// is read first; os.totalmem() is only the fallback for running outside one.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';

const MB = 1024 * 1024;

function readCgroup(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/** cgroup v2 first, then v1, then nothing. @returns {number|null} MB */
export function containerLimitMb() {
  const v2 = readCgroup('/sys/fs/cgroup/memory.max');
  if (v2 && v2 !== 'max') {
    const n = Number(v2);
    if (Number.isFinite(n) && n > 0) return Math.round(n / MB);
  }
  const v1 = readCgroup('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (v1) {
    const n = Number(v1);
    // v1 reports "no limit" as a number near 2^63, which is not a limit.
    if (Number.isFinite(n) && n > 0 && n < os.totalmem() * 4) return Math.round(n / MB);
  }
  return null;
}

export function containerUsedMb() {
  const v2 = readCgroup('/sys/fs/cgroup/memory.current');
  if (v2) {
    const n = Number(v2);
    if (Number.isFinite(n)) return Math.round(n / MB);
  }
  return null;
}

/** The ceiling to plan against: the cgroup limit when there is one. */
export function availableMemoryMb() {
  return containerLimitMb() ?? Math.round(os.totalmem() / MB);
}

/**
 * How many demo ticks one parseTicks call may cover.
 *
 * Every call materializes `ticks x 10 players` rows of 16 props in the JS heap
 * at once, which is roughly 300 bytes a row once V8 overhead and the per-row
 * weapon name string are counted. So 20 ticks per available MB works out to
 * about 6% of the box spent on the rows themselves.
 *
 * Six percent looks paranoid until you count what else is live at that moment:
 * the native parser decoding a 300-450 MB demo holds its own working set well
 * outside the V8 heap, V8 needs roughly the live set again as GC headroom, and
 * the HTTP server shares the container.
 *
 * The ceiling is not only about memory. readBatchRows hands parseTicks an
 * explicit array of every tick in the batch, and the cost of the parser's
 * membership test against that array grows with the SQUARE of its length. A
 * whole match in one pass is therefore the SLOWEST setting as well as the one
 * most likely to be killed. Measured on two demos (519 MB / 24 rounds and
 * 412 MB / 23 rounds), for the tick stage alone:
 *
 *   200 000 ticks per batch   16.4 s / 11.9 s
 *    40 000                    9.9 s /  7.4 s
 *    25 000                    9.8 s /  7.0 s   <- MAX_BATCH_TICKS
 *    16 000                   11.0 s
 *    12 000                   11.8 s
 *
 * Below ~25 000 the redundant decoding of the demo prefix each call starts to
 * cost more than the membership test saves. The round files written are byte
 * for byte identical at every batch size, so this is purely a speed and memory
 * knob. AIM4_PARSE_BATCH_TICKS overrides it, and jobs.js still halves it and
 * retries if the kernel steps in anyway.
 */
export const TICKS_PER_AVAILABLE_MB = 20;
export const MIN_BATCH_TICKS = 15_000;
export const MAX_BATCH_TICKS = 25_000;

export function deriveBatchTicks(availableMb = availableMemoryMb()) {
  const ticks = Math.round(availableMb * TICKS_PER_AVAILABLE_MB);
  return Math.max(MIN_BATCH_TICKS, Math.min(MAX_BATCH_TICKS, ticks));
}

/** Everything the diagnostics endpoint reports, in one place. */
export function memorySnapshot(extra = {}) {
  const mem = process.memoryUsage();
  const limit = containerLimitMb();
  return {
    serverRssMb: Math.round(mem.rss / MB),
    heapLimitMb: Number(process.env.AIM4_PARSE_HEAP_MB || 1024),
    batchTicks: Number(process.env.AIM4_PARSE_BATCH_TICKS) || deriveBatchTicks(),
    batchTicksDerivedFromMb: availableMemoryMb(),
    containerLimitMb: limit ?? 'unlimited',
    containerUsedMb: containerUsedMb() ?? null,
    hostTotalMb: Math.round(os.totalmem() / MB),
    hostFreeMb: Math.round(os.freemem() / MB),
    cpus: os.cpus().length,
    ...extra
  };
}
