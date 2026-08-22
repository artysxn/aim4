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
  demoPassesDate,
  derivePlayers
} from '../../src/replays/shared/statsMath.js';
import { CARD_METRICS } from '../../src/replays/performance/performanceMath.js';
import { loadStoredEntry } from './statsIndex.js';

/** Matches PEER_MIN_ROUNDS in performanceMath: enough rounds to be a data point. */
const PEER_MIN_ROUNDS = 20;

const CACHE_TTL_MS = 10 * 60_000;

/**
 * Cap on distinct (map, date-window, library) results held at once.
 *
 * The date filters come from a UI with free-form dates, so the key space is
 * effectively unbounded: without a cap this map grows for the life of the
 * process, since the TTL is only consulted on a read of that same key.
 */
const CACHE_MAX = 64;

/** @type {Map<string, { at: number, stamp: string, value: object }>} */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();

/**
 * A short, order-independent digest of which demos a caller can read. Cheap to
 * compute over a few thousand ids and enough to tell two access levels apart.
 */
function setStamp(records) {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (const r of records) {
    const id = String(r.id || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // XOR and sum both: order-independent, and less collision-prone than either.
    h1 ^= h;
    h2 = (h2 + h) >>> 0;
  }
  return `${records.length}:${h1.toString(36)}:${h2.toString(36)}`;
}

function mean(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function cacheKey(user, filter, stamp) {
  return ['v2', user, filter.map || '', filter.dateFrom || '', filter.dateTo || '', stamp].join('|');
}

/** Drop expired entries, then the oldest, until the cache is within its cap. */
function evict() {
  const now = Date.now();
  for (const [k, v] of cache) if (v.at <= now - CACHE_TTL_MS) cache.delete(k);
  if (cache.size <= CACHE_MAX) return;
  // Map iterates in insertion order, so the front is the oldest.
  const excess = cache.size - CACHE_MAX;
  let i = 0;
  for (const k of cache.keys()) {
    if (i++ >= excess) break;
    cache.delete(k);
  }
}

/**
 * @param {object} io
 * @param {string} user
 * @param {object[]} records  ready demos the caller may read
 * @param {{ map?: string, dateFrom?: string, dateTo?: string }} [filter]
 * @param {{ stamp?: string, onProgress?: (p: object) => void }} [opts]
 */
export async function peerAverages(io, user, records, filter = {}, opts = {}) {
  // Identity of the record set, not merely its size. Two callers seeing the
  // same *number* of demos do not necessarily see the same demos, and keying on
  // the count alone would serve one of them the other's averages.
  const stamp = opts.stamp || setStamp(records);
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
    /** @type {Record<string, { T: { r: number, w: number }, CT: { r: number, w: number } }>} */
    const mapSides = {};
    const bumpSide = (code, side, won) => {
      if (!code || (side !== 'T' && side !== 'CT')) return;
      if (!mapSides[code]) mapSides[code] = { T: { r: 0, w: 0 }, CT: { r: 0, w: 0 } };
      const bag = mapSides[code][side];
      bag.r += 1;
      if (won) bag.w += 1;
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
      const wantMap = filter.map ? String(filter.map).toUpperCase() : '';
      if (demoPassesDate(entry, active)) {
        for (const row of entry.rounds) {
          const code = String(row.m || entry.map || '').toUpperCase();
          if (wantMap && code !== wantMap) continue;
          const tTeam = (row.s1 || 'T') === 'T' ? 1 : 2;
          bumpSide(code, 'T', row.w === tTeam);
          bumpSide(code, 'CT', row.w === (tTeam === 1 ? 2 : 1));
        }
      }
      demos.delete(entry.id);
      for (const p of entry.players || []) players.delete(`${entry.id}:${p.id}`);
    }

    const list = derivePlayers(acc).filter((p) => p.rounds >= PEER_MIN_ROUNDS);
    const out = { sample: list.length, metrics: {}, mapSides: {} };
    for (const m of CARD_METRICS) out.metrics[m.key] = mean(list.map(m.read));
    for (const [code, sides] of Object.entries(mapSides)) {
      out.mapSides[code] = {
        T: sides.T.r ? (sides.T.w / sides.T.r) * 100 : null,
        CT: sides.CT.r ? (sides.CT.w / sides.CT.r) * 100 : null
      };
    }
    cache.set(key, { at: Date.now(), stamp, value: out });
    evict();
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
