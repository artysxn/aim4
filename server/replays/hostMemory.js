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
 * How much can be allocated right now without pushing the box into swap.
 *
 * `os.freemem()` is MemFree on Linux, which counts only pages nobody is using
 * at all — it excludes the page cache, even though the kernel will happily
 * reclaim that on demand. On a host that has just streamed a 400 MB demo
 * through several read passes, MemFree is small and MemAvailable is large, and
 * MemAvailable is the one that answers "can I hold this file in memory".
 *
 * @returns {number} MB
 */
export function freeMemoryMb() {
  const meminfo = readCgroup('/proc/meminfo');
  if (meminfo) {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
    if (m) return Math.round(Number(m[1]) / 1024);
  }
  // A cgroup with a limit: what is left of it, which can be far less than the
  // host has free.
  const limit = containerLimitMb();
  const used = containerUsedMb();
  if (limit != null && used != null) return Math.max(0, limit - used);
  return Math.round(os.freemem() / MB);
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

// ---- what is actually limiting this host -------------------------------------
// os.cpus() reports the HOST's cores, so a container restricted to a fraction of
// a CPU looks identical to one with two full cores and simply runs slower. That
// is invisible from the inside unless the cgroup is read directly, and it is the
// difference between "the parser is slow" and "the parser is being given a
// quarter of a core". The same goes for the volume: a parse that spends its time
// stalled on reads looks exactly like a parse that is compute-bound, unless
// something counts the stalls.

/**
 * CPU the container is actually allowed, from the cgroup quota.
 * @returns {{cpus: number|null, quota: string|null}}
 */
export function cpuAllowance() {
  // v2: "<quota> <period>", or "max <period>" for unrestricted.
  const v2 = readCgroup('/sys/fs/cgroup/cpu.max');
  if (v2) {
    const [quota, period] = v2.split(/\s+/);
    if (quota && quota !== 'max') {
      const q = Number(quota);
      const p = Number(period) || 100000;
      if (Number.isFinite(q) && q > 0) {
        return { cpus: Math.round((q / p) * 100) / 100, quota: v2 };
      }
    }
    return { cpus: null, quota: v2 };
  }
  const q = Number(readCgroup('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const p = Number(readCgroup('/sys/fs/cgroup/cpu/cpu.cfs_period_us')) || 100000;
  if (Number.isFinite(q) && q > 0) {
    return { cpus: Math.round((q / p) * 100) / 100, quota: `${q} ${p}` };
  }
  return { cpus: null, quota: null };
}

/**
 * How often the scheduler has taken the CPU away because the quota ran out.
 *
 * `nr_throttled` climbing during a parse is direct proof the container is CPU
 * capped rather than the work being slow.
 */
export function cpuThrottling() {
  const stat = readCgroup('/sys/fs/cgroup/cpu.stat') || readCgroup('/sys/fs/cgroup/cpu/cpu.stat');
  if (!stat) return null;
  const out = {};
  for (const line of stat.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Pressure Stall Information: the share of the last 10/60/300 seconds that tasks
 * spent stalled waiting for cpu, io or memory. This is the one number that says
 * WHICH resource is the constraint rather than leaving it to be inferred.
 *
 * `some avg10=45.00` on io means nearly half the time something was blocked on
 * the disk. On cpu it means runnable-but-not-scheduled, i.e. contention or quota.
 */
export function pressure() {
  const out = {};
  for (const res of ['cpu', 'io', 'memory']) {
    const raw =
      readCgroup(`/sys/fs/cgroup/${res}.pressure`) || readCgroup(`/proc/pressure/${res}`);
    if (!raw) continue;
    const some = /some\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/.exec(raw);
    const full = /full\s+avg10=([\d.]+)\s+avg60=([\d.]+)/.exec(raw);
    if (some) {
      out[res] = { avg10: Number(some[1]), avg60: Number(some[2]), avg300: Number(some[3]) };
      if (full) out[res].fullAvg10 = Number(full[1]);
    }
  }
  return Object.keys(out).length ? out : null;
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
    // MemAvailable when the kernel offers it, which is the figure the parser's
    // buffering decision is made against.
    availableMb: freeMemoryMb(),
    cpus: os.cpus().length,
    // os.cpus() is the HOST's core count. This is what the container may use.
    cpuQuota: cpuAllowance(),
    cpuThrottling: cpuThrottling(),
    // Which resource tasks are actually stalling on. See pressure().
    pressure: pressure(),
    ...extra
  };
}
