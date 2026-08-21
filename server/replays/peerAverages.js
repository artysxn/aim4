// ---------------------------------------------------------------------------
// replays/peerAverages.js
// Library-wide peer averages for the Performance summary cards.
//
// This is the one number on that page that genuinely needs every demo: the
// cards compare a player against every peer with enough rounds. Scoping the
// page to the player's own matches — which is the whole point of the roster
// catalogue — would quietly turn "vs. the library" into "vs. the nine other
// people in my games", and the cards would keep rendering as if nothing
// changed. So it moves here.
//
// Memory is bounded by the player count, not the demo count: entries are
// accumulated one at a time and released, so a 4100-demo library never exists
// in the heap at once.
// ---------------------------------------------------------------------------

import {
  accumulatePlayers,
  createPlayerAccumulator,
  derivePlayers
} from '../../src/replays/shared/statsMath.js';
import { CARD_METRICS } from '../../src/replays/performance/performanceMath.js';
import { loadStoredEntry } from './statsIndex.js';

/** Matches PEER_MIN_ROUNDS in performanceMath: enough rounds to be a data point. */
const PEER_MIN_ROUNDS = 20;

const CACHE_TTL_MS = 10 * 60_000;

/** @type {Map<string, { at: number, stamp: string, value: object }>} */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();

function mean(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function cacheKey(user, filter, stamp) {
  return [user, filter.map || '', filter.dateFrom || '', filter.dateTo || '', stamp].join('|');
}

/**
 * @param {object} io
 * @param {string} user
 * @param {object[]} records  ready demos the caller may read
 * @param {{ map?: string, dateFrom?: string, dateTo?: string }} [filter]
 * @param {{ stamp?: string, onProgress?: (p: object) => void }} [opts]
 */
export async function peerAverages(io, user, records, filter = {}, opts = {}) {
  const stamp = opts.stamp || String(records.length);
  const key = cacheKey(user, filter, stamp);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_TTL_MS) return hit.value;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    const acc = createPlayerAccumulator();
    /** Seat lookup and demo identity, both keyed the way statsMath expects. */
    const players = new Map();
    const demos = new Map();
    const active = {
      maps: filter.map ? [filter.map] : [],
      side: '',
      econ: null,
      dateFrom: filter.dateFrom || '',
      dateTo: filter.dateTo || ''
    };

    let done = 0;
    for (const record of records) {
      const entry = await loadStoredEntry(io, user, record.id);
      done += 1;
      opts.onProgress?.({ done, total: records.length, phase: 'peers' });
      if (!entry?.rounds?.length) continue;
      // Only this demo's seats are added, and both maps are cleared below —
      // holding every seat for 4100 demos is itself tens of MB.
      demos.set(entry.id, entry);
      for (const p of entry.players || []) {
        players.set(`${entry.id}:${p.id}`, { name: p.name, team: p.team });
      }
      accumulatePlayers(acc, entry.rounds, players, active, demos);
      demos.delete(entry.id);
      for (const p of entry.players || []) players.delete(`${entry.id}:${p.id}`);
    }

    const list = derivePlayers(acc).filter((p) => p.rounds >= PEER_MIN_ROUNDS);
    const out = { sample: list.length, metrics: {} };
    for (const m of CARD_METRICS) out.metrics[m.key] = mean(list.map(m.read));
    cache.set(key, { at: Date.now(), stamp, value: out });
    return out;
  })().finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });

  inflight.set(key, job);
  return job;
}

export function invalidatePeerAverages() {
  cache.clear();
}
