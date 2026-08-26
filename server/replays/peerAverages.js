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
//
// TIME is bounded by nothing, which is the other half of the problem and the
// reason this file yields. Node has one thread; a walk of 4100 indexes that
// never lets go of it means every other request on the box — the listing, a
// round pack, the Database's own table — waits for the Performance page's six
// means. `await` alone does not help: loadStoredEntry answers from an
// in-memory LRU most of the time, and awaiting an already-resolved promise
// only drains microtasks. See yieldEventLoop below.
// ---------------------------------------------------------------------------

import {
  accumulatePlayers,
  createPlayerAccumulator,
  demoPassesDate,
  derivePlayers
} from '../../src/replays/shared/statsMath.js';
import { CARD_METRICS } from '../../src/replays/performance/performanceMath.js';
import { loadStoredEntry } from './statsIndex.js';
import { getHotStore, visibilityMask } from './statsHotService.js';
import { aggregateHot } from './statsHotAggregate.js';

/** Matches PEER_MIN_ROUNDS in performanceMath: enough rounds to be a data point. */
const PEER_MIN_ROUNDS = 20;
/** Same floor the Performance role grid uses for a position average. */
const ROLE_MIN_ROUNDS = 8;

const CACHE_TTL_MS = 10 * 60_000;

/**
 * Demos packed between releases of the thread.
 *
 * The same cadence statsHotService uses for the resident store, for the same
 * reason: one JSON.parse plus its accumulation is sync, so without a real
 * macrotask boundary the whole walk is one uninterruptible block.
 */
const YIELD_EVERY = 8;

/** Let other HTTP requests in between JSON.parse / accumulate bursts. */
function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  return ['v3', user, filter.map || '', filter.dateFrom || '', filter.dateTo || '', stamp].join('|');
}

function modeLabel(votes) {
  if (!votes?.size) return '';
  let best = '';
  let n = 0;
  for (const [k, c] of votes) {
    if (c > n || (c === n && k.localeCompare(best) < 0)) {
      best = k;
      n = c;
    }
  }
  return best;
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
 * @param {{
 *   stamp?: string,
 *   onProgress?: (p: object) => void,
 *   readEntry?: (user: string, id: string) => Promise<object|null>
 * }} [opts]
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
    // The same seam getRoster takes. In production it is loadStoredEntry, whose
    // answer comes from the in-memory LRU as often as not — which is precisely
    // the case the yield below exists for, and the one a test cannot reach
    // through the disk.
    const load = opts.readEntry || ((u, id) => loadStoredEntry(io, u, id));
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
    /** @type {Record<string, { T: Map, CT: Map }>} */
    const mapAcc = {};
    /** `${playerId}|${map}|${side}` → label → votes */
    const posVotes = new Map();
    const accOf = (code, side) => {
      if (!mapAcc[code]) {
        mapAcc[code] = { T: createPlayerAccumulator(), CT: createPlayerAccumulator() };
      }
      return mapAcc[code][side];
    };
    const votePos = (id, code, side, label) => {
      if (!id || !code || !label || (side !== 'T' && side !== 'CT')) return;
      const k = `${id}|${code}|${side}`;
      let votes = posVotes.get(k);
      if (!votes) {
        votes = new Map();
        posVotes.set(k, votes);
      }
      votes.set(label, (votes.get(label) || 0) + 1);
    };

    /**
     * One demo into the accumulators.
     *
     * Seats go in and come straight back out: holding every seat for 4100
     * demos is itself tens of MB. The `finally` is what guarantees that even
     * when the entry turns out to be unreadable partway through, so a bad
     * index cannot leave the next demo accumulating against stale seats.
     */
    const accumulateEntry = (entry) => {
      demos.set(entry.id, entry);
      for (const p of entry.players || []) {
        players.set(`${entry.id}:${p.id}`, { name: p.name, team: p.team });
      }
      try {
        accumulatePlayers(acc, entry.rounds, players, active, demos);
        const wantMap = filter.map ? String(filter.map).toUpperCase() : '';
        const code = String(entry.map || '').toUpperCase();
        if ((!wantMap || code === wantMap) && code) {
          accumulatePlayers(
            accOf(code, 'T'),
            entry.rounds,
            players,
            { ...active, maps: [code], side: 'T' },
            demos
          );
          accumulatePlayers(
            accOf(code, 'CT'),
            entry.rounds,
            players,
            { ...active, maps: [code], side: 'CT' },
            demos
          );
        }
        if (demoPassesDate(entry, active)) {
          for (const row of entry.rounds) {
            const rowMap = String(row.m || entry.map || '').toUpperCase();
            if (wantMap && rowMap !== wantMap) continue;
            const tTeam = (row.s1 || 'T') === 'T' ? 1 : 2;
            bumpSide(rowMap, 'T', row.w === tTeam);
            bumpSide(rowMap, 'CT', row.w === (tTeam === 1 ? 2 : 1));
          }
          for (const [map, sides] of Object.entries(entry.roles?.maps || {})) {
            const m = String(map).toUpperCase();
            if (wantMap && m !== wantMap) continue;
            for (const side of ['T', 'CT']) {
              for (const [id, role] of Object.entries(sides?.[side] || {})) {
                votePos(id, m, side, String(role?.label || '').trim());
              }
            }
          }
        }
      } finally {
        demos.delete(entry.id);
        for (const p of entry.players || []) players.delete(`${entry.id}:${p.id}`);
      }
    };

    let done = 0;
    let skipped = 0;
    for (const record of records) {
      const entry = await load(user, record.id);
      done += 1;
      opts.onProgress?.({ done, total: records.length, phase: 'peers' });
      if (entry?.rounds?.length) {
        // One unreadable index costs that demo its contribution to the means,
        // never the whole page. Everyone awaiting this key is parked on the
        // same promise, so a throw here used to leave the Performance cards
        // bare for every viewer at once — and the next request started the
        // entire 4100-demo walk over to fail the same way.
        try {
          accumulateEntry(entry);
        } catch (err) {
          skipped += 1;
          console.warn(`[peers] skipped ${record.id}: ${err?.message || err}`);
        }
      }
      // Hand the thread back. Without this the Performance page's comparison
      // line is paid for by every other request on the box: they queue behind
      // a walk that can run for tens of seconds and never once lets go.
      if (done % YIELD_EVERY === 0) await yieldEventLoop();
    }
    if (skipped) console.warn(`[peers] computed with ${skipped} demos skipped`);

    const list = derivePlayers(acc).filter((p) => p.rounds >= PEER_MIN_ROUNDS);
    const out = { sample: list.length, metrics: {}, mapSides: {}, roles: {} };
    for (const m of CARD_METRICS) out.metrics[m.key] = mean(list.map(m.read));
    for (const [mapCode, sides] of Object.entries(mapSides)) {
      out.mapSides[mapCode] = {
        T: sides.T.r ? (sides.T.w / sides.T.r) * 100 : null,
        CT: sides.CT.r ? (sides.CT.w / sides.CT.r) * 100 : null
      };
    }
    for (const [mapCode, sides] of Object.entries(mapAcc)) {
      out.roles[mapCode] = { T: {}, CT: {} };
      for (const side of ['T', 'CT']) {
        const bags = {};
        for (const p of derivePlayers(sides[side])) {
          if (p.rounds < ROLE_MIN_ROUNDS) continue;
          const pos = modeLabel(posVotes.get(`${p.id}|${mapCode}|${side}`));
          if (!pos) continue;
          if (!bags[pos]) bags[pos] = { r: [], s: [] };
          if (Number.isFinite(p.rating)) bags[pos].r.push(p.rating);
          if (Number.isFinite(p.prwSwing)) bags[pos].s.push(p.prwSwing);
        }
        for (const [pos, bag] of Object.entries(bags)) {
          out.roles[mapCode][side][pos] = { rating: mean(bag.r), swing: mean(bag.s) };
        }
      }
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

// ---------------------------------------------------------------------------
// The same answer from the resident store.
//
// The walk above reads every stats index to compute six means; the hot store
// already holds every one of those rounds as columns the /aggregate endpoint
// scans in milliseconds. When the store is warm, this produces the identical
// output from those columns; when it is cold, it answers null (kicking the
// background build, same contract as /aggregate) and the caller falls back to
// the walk. The walk therefore stays what it always was — the answer of last
// resort — instead of the price of every Performance page.
// ---------------------------------------------------------------------------

/**
 * Position label votes per (player, MAP, side), from the roles tables the
 * store's demos carry. Mirrors the walk's votePos over entry.roles.maps: one
 * vote per demo, only demos inside the date window, only readable demos.
 */
function hotPosVotes(store, filter, allowedIds, wantMap) {
  const votes = new Map();
  for (const demo of store.demos) {
    if (allowedIds && !allowedIds.has(demo.id)) continue;
    if (!demoPassesDate(demo, filter)) continue;
    for (const [map, sides] of Object.entries(demo.roles?.maps || {})) {
      const m = String(map).toUpperCase();
      if (wantMap && m !== wantMap) continue;
      for (const side of ['T', 'CT']) {
        for (const [id, role] of Object.entries(sides?.[side] || {})) {
          const label = String(role?.label || '').trim();
          if (!label) continue;
          const k = `${id}|${m}|${side}`;
          let bag = votes.get(k);
          if (!bag) votes.set(k, (bag = new Map()));
          bag.set(label, (bag.get(label) || 0) + 1);
        }
      }
    }
  }
  return votes;
}

/**
 * @param {object} io
 * @param {string} user
 * @param {object[]} records  the WHOLE ready library — store identity, like
 *   every other hot caller. Visibility comes in as `opts.allowedIds`.
 * @param {{ map?: string, dateFrom?: string, dateTo?: string }} [filter]
 * @param {{ allowedIds?: Set<string>|null }} [opts]
 * @returns {Promise<object|null>} null while the store is cold
 */
export async function peerAveragesHot(io, user, records, filter = {}, opts = {}) {
  const allowedIds = opts.allowedIds || null;
  const stamp = `hot|${setStamp(records)}|${allowedIds ? allowedIds.size : 'all'}`;
  const key = cacheKey(user, filter, stamp);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_TTL_MS) return hit.value;

  const store = await getHotStore(io, user, records, { requireWarm: true });
  if (!store) return null;
  const allow = visibilityMask(store, allowedIds);

  const dateWindow = { dateFrom: filter.dateFrom || '', dateTo: filter.dateTo || '' };
  const wantMap = filter.map ? String(filter.map).toUpperCase() : '';
  // The store keeps map codes verbatim; the walk compared them uppercased. A
  // wanted map resolves to every stored value that folds to it, and an
  // unmatched one forces the empty result rather than "no filter".
  const rawsFor = (code) => {
    const raws = store.maps.values.filter((v) => v && String(v).toUpperCase() === code);
    return raws.length ? raws : [code];
  };

  const rows = aggregateHot(
    store,
    { ...dateWindow, maps: wantMap ? rawsFor(wantMap) : [] },
    allow
  );
  const list = rows.filter((p) => (p.rounds || 0) >= PEER_MIN_ROUNDS);
  const out = { sample: list.length, metrics: {}, mapSides: {}, roles: {} };
  for (const m of CARD_METRICS) out.metrics[m.key] = mean(list.map(m.read));

  // Per-map side winrates, straight off the round columns. Same rule as the
  // walk: every round of a date-passing demo counts once for T and once for
  // CT, and T won when the winner is whichever team held the T side.
  {
    const { nRounds, rDemo, rMap, rSide1, rWinner } = store;
    const sideTId = store.sides.values.indexOf('T');
    // Date pass per demo, memoized: nRounds is millions, demos are thousands.
    const datePass = new Uint8Array(store.demos.length);
    for (let d = 0; d < store.demos.length; d++) {
      if (demoPassesDate(store.demos[d], dateWindow)) datePass[d] = 1;
    }
    const bags = new Map();
    for (let r = 0; r < nRounds; r++) {
      const d = rDemo[r];
      if (allow && !allow[d]) continue;
      if (!datePass[d]) continue;
      const code = String(store.maps.lookup(rMap[r]) || '').toUpperCase();
      if (!code || (wantMap && code !== wantMap)) continue;
      let bag = bags.get(code);
      if (!bag) bags.set(code, (bag = { T: { r: 0, w: 0 }, CT: { r: 0, w: 0 } }));
      const tTeam = rSide1[r] === sideTId ? 1 : 2;
      const w = rWinner[r];
      bag.T.r += 1;
      bag.CT.r += 1;
      if (w === tTeam) bag.T.w += 1;
      else bag.CT.w += 1;
    }
    for (const [code, bag] of bags) {
      out.mapSides[code] = {
        T: bag.T.r ? (bag.T.w / bag.T.r) * 100 : null,
        CT: bag.CT.r ? (bag.CT.w / bag.CT.r) * 100 : null
      };
    }
  }

  // Role averages: per (map, side), the same aggregation the walk ran through
  // its per-map accumulators, over the same rows, keyed by the same votes.
  {
    const votes = hotPosVotes(store, dateWindow, allowedIds, wantMap);
    // The walk emitted a key for every map an eligible demo carried, even when
    // no player cleared the bar — an empty {T:{},CT:{}} rather than absence.
    const mapCodes = new Set();
    for (const demo of store.demos) {
      if (allowedIds && !allowedIds.has(demo.id)) continue;
      const code = String(demo.map || '').toUpperCase();
      if (code && (!wantMap || code === wantMap)) mapCodes.add(code);
    }
    for (const code of mapCodes) {
      out.roles[code] = { T: {}, CT: {} };
      for (const side of ['T', 'CT']) {
        const sideRows = aggregateHot(
          store,
          { ...dateWindow, maps: rawsFor(code), side },
          allow
        );
        const bags = {};
        for (const p of sideRows) {
          if ((p.rounds || 0) < ROLE_MIN_ROUNDS) continue;
          const pos = modeLabel(votes.get(`${p.id}|${code}|${side}`));
          if (!pos) continue;
          if (!bags[pos]) bags[pos] = { r: [], s: [] };
          if (Number.isFinite(p.rating)) bags[pos].r.push(p.rating);
          if (Number.isFinite(p.prwSwing)) bags[pos].s.push(p.prwSwing);
        }
        for (const [pos, bag] of Object.entries(bags)) {
          out.roles[code][side][pos] = { rating: mean(bag.r), swing: mean(bag.s) };
        }
      }
    }
  }

  cache.set(key, { at: Date.now(), stamp, value: out });
  evict();
  return out;
}

export function invalidatePeerAverages() {
  cache.clear();
}
