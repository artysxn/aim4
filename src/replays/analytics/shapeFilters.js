// ---------------------------------------------------------------------------
// Analytics geography: user-drawn shapes + feature predicates (localStorage).
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchRoundPacks, fetchRoundTicks } from '../api.js';
import { COARSE_STRIDE } from '../tickStore.js';
import { phaseAtTick, phaseBounds } from '../coach/roundPhases.js';
import { readHeader, readRecord } from '../shared/tickFormat.js';
import { P } from '../shared/statsMath.js';
import { pointInPiece } from '../zones/zoneGeom.js';

/**
 * @typedef {'player_in'|'kill_from'|'death_from'|'first_duel_in'|'grenade_in'
 *   |'map_control'} ShapeFeature
 */

export const SHAPE_FEATURES = [
  { key: 'player_in', label: 'Player in' },
  { key: 'kill_from', label: 'Kill from' },
  { key: 'death_from', label: 'Died in' },
  { key: 'first_duel_in', label: 'First duel in' },
  { key: 'grenade_in', label: 'Grenade in' },
  // The odd one out, and deliberately so: it keeps every round it is given and
  // reports how they split by who held the ground. See analytics/zoneControl.js.
  { key: 'map_control', label: 'Map control in' }
];

/** The live round on the clock: 1:55. Shape windows are elapsed seconds. */
export const SHAPE_WINDOW_MAX_SECONDS = 115;

/** Utility toggles used by Pattern Finder (and grenade_in matching). */
export const UTIL_KEYS = ['smoke', 'molotov', 'flash', 'he'];

const UTIL_KEY = {
  smokegrenade: 'smoke',
  molotov: 'molotov',
  incgrenade: 'molotov',
  firebomb: 'molotov',
  inferno: 'molotov',
  flashbang: 'flash',
  hegrenade: 'he'
};

const STORAGE_PREFIX = 'aim4.an.shapes.';

/** ≥1 sample at ~1 Hz inside the shape during the phase window. */
const PLAYER_IN_MIN_SAMPLES = 1;

/** @param {string|undefined} type */
export function utilKeyForType(type) {
  const t = String(type || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  return UTIL_KEY[t] || null;
}

/** Optional global / per-shape clock window. Full span ⇒ null. */
export function sanitizeTimeWindow(raw) {
  return sanitizeWindow(raw);
}

export function hasNarrowTimeWindow(filter) {
  return Boolean(sanitizeWindow(filter?.timeWindow));
}

/** True when at least one util type is turned off. */
export function hasNarrowUtility(filter) {
  const u = filter?.utility;
  if (!u || typeof u !== 'object') return false;
  return UTIL_KEYS.some((k) => u[k] === false);
}

function storageKey(map) {
  return `${STORAGE_PREFIX}${String(map || '').toUpperCase()}`;
}

export function newShapeId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * @param {string} map
 * @returns {Array<object>}
 */
export function loadShapes(map) {
  if (!map || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(storageKey(map));
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .map(sanitizeShape)
      .filter(Boolean)
      .map((s) => ({ ...s, map: String(map).toUpperCase() }));
  } catch {
    return [];
  }
}

/** @param {string} map @param {Array<object>} shapes */
export function saveShapes(map, shapes) {
  if (!map || typeof localStorage === 'undefined') return;
  try {
    const list = (shapes || []).map(sanitizeShape).filter(Boolean);
    localStorage.setItem(storageKey(map), JSON.stringify(list));
  } catch {
    /* quota / private mode */
  }
}

/**
 * Optional per-shape time window, in seconds since the round went live.
 * Absent means the whole round; a full-span window is stored as absent so
 * "cleared the slider" and "never touched it" are the same shape.
 */
function sanitizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = Number(raw.from);
  const to = Number(raw.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const lo = Math.max(0, Math.min(SHAPE_WINDOW_MAX_SECONDS, Math.min(from, to)));
  const hi = Math.max(0, Math.min(SHAPE_WINDOW_MAX_SECONDS, Math.max(from, to)));
  if (hi <= lo) return null;
  if (lo === 0 && hi === SHAPE_WINDOW_MAX_SECONDS) return null;
  return { from: lo, to: hi };
}

/**
 * The utility types one grenade selection is about.
 *
 * The four utility buttons used to be a single global switch that every
 * grenade selection read at search time, so two boxes could not ask different
 * questions — turning smokes off to draw a molotov box retroactively changed
 * the smoke box drawn a minute earlier. They are now a snapshot: whatever is
 * enabled when the box is drawn is what that box means, forever, and the
 * buttons go back to being what you arm the next box with.
 *
 * All four on means "any grenade", and it is stored that way rather than as an
 * absent field: absent is reserved for a selection drawn before this existed,
 * which is the only kind that should still follow the live switches. None on
 * is coerced to all on — a selection that can never match is a footgun, not a
 * query.
 *
 * @returns {Record<string, boolean>|null} null ⇒ this selection has no
 *   utility of its own (not a grenade selection, or drawn before snapshots).
 */
function sanitizeShapeUtility(raw, feature) {
  if (feature !== 'grenade_in' || !raw || typeof raw !== 'object') return null;
  let on = UTIL_KEYS.filter((k) => raw[k] === true);
  if (!on.length) on = [...UTIL_KEYS];
  const out = {};
  for (const k of UTIL_KEYS) out[k] = on.includes(k);
  return out;
}

/**
 * The utility keys a grenade selection names, or null when it names none in
 * particular — all four, or a selection drawn before selections carried them.
 * @returns {string[]|null}
 */
export function shapeUtilityKeys(shape) {
  const u = sanitizeShapeUtility(shape?.utility, shape?.feature || 'player_in');
  if (!u) return null;
  const on = UTIL_KEYS.filter((k) => u[k]);
  return on.length === UTIL_KEYS.length ? null : on;
}

function sanitizeShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim() || newShapeId();
  const feature = SHAPE_FEATURES.some((f) => f.key === raw.feature)
    ? raw.feature
    : 'player_in';
  const geom = sanitizeGeometry(raw.geometry);
  if (!geom) return null;
  const window = sanitizeWindow(raw.window);
  const utility = sanitizeShapeUtility(raw.utility, feature);
  return {
    id,
    name: String(raw.name || '').trim(),
    feature,
    geometry: geom,
    ...(window ? { window } : {}),
    ...(utility ? { utility } : {}),
    enabled: raw.enabled !== false
  };
}

function sanitizeGeometry(g) {
  if (!g || typeof g !== 'object') return null;
  if (g.type === 'rect') {
    const x = Number(g.x);
    const y = Number(g.y);
    const w = Number(g.w);
    const h = Number(g.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { type: 'rect', x, y, w, h };
  }
  if (g.type === 'poly' && Array.isArray(g.ring) && g.ring.length >= 3) {
    const ring = [];
    for (const p of g.ring.slice(0, 64)) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const px = Number(p[0]);
      const py = Number(p[1]);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      ring.push([px, py]);
    }
    if (ring.length < 3) return null;
    return { type: 'poly', ring };
  }
  return null;
}

/** @param {number} x @param {number} y @param {object} geometry */
export function pointInShape(x, y, geometry) {
  if (!geometry) return false;
  return pointInPiece(x, y, geometry);
}

function asView(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function samplePlayerAt(view, header, slot, tick, scratch) {
  if (slot == null || slot < 0) return null;
  const raw = (tick - header.firstTick) / Math.max(1, header.stride);
  const row = Math.max(0, Math.min(header.tickCount - 1, Math.floor(raw)));
  readRecord(view, row, slot, scratch);
  if (!scratch.alive) return null;
  return { x: scratch.x, y: scratch.y };
}

function slotOf(meta, playerId) {
  const p = (meta.players || []).find((x) => x.id === playerId);
  return p?.slot;
}

function openingKill(meta, teamOf) {
  const kills = [...(meta.events?.kills || [])].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  for (const k of kills) {
    const at = teamOf.get(k.attacker);
    const vt = teamOf.get(k.victim);
    if (!at || !vt || at === vt) continue;
    return k;
  }
  return null;
}

function phaseTickRange(bounds, phase) {
  const from =
    phase === 'early'
      ? bounds.freezeEndTick
      : phase === 'mid'
        ? bounds.midStartTick
        : bounds.lateStartTick;
  const to =
    phase === 'early'
      ? bounds.midStartTick
      : phase === 'mid'
        ? bounds.lateStartTick
        : bounds.endTick;
  return { from, to };
}

/** Does the phase's elapsed span overlap a global clock window? */
function phaseOverlapsTime(meta, phase, timeWin) {
  if (!timeWin) return true;
  const bounds = phaseBounds(meta);
  const tickRate = Math.max(1, meta.tickRate || 64);
  const { from, to } = phaseTickRange(bounds, phase);
  const fromE = (from - bounds.freezeEndTick) / tickRate;
  const toE = (to - bounds.freezeEndTick) / tickRate;
  return fromE < timeWin.to && toE > timeWin.from;
}

/** Player threw an allowed util type in this phase (and optional clock window). */
function playerThrewUtil(meta, playerId, phase, utility, timeWin) {
  if (!utility) return true;
  const bounds = phaseBounds(meta);
  const tickRate = Math.max(1, meta.tickRate || 64);
  for (const g of meta.events?.grenades || []) {
    if (g.player !== playerId) continue;
    const key = utilKeyForType(g.type);
    if (!key || utility[key] === false) continue;
    const tick = Number(g.detonateTick ?? g.throwTick);
    if (!Number.isFinite(tick)) continue;
    if (phaseAtTick(tick, bounds) !== phase) continue;
    if (timeWin) {
      const elapsed = (tick - bounds.freezeEndTick) / tickRate;
      if (elapsed < timeWin.from || elapsed > timeWin.to) continue;
    }
    return true;
  }
  return false;
}

/**
 * Does this phase window satisfy one shape selection?
 * @param {{
 *   meta: object,
 *   tickBuffer: ArrayBuffer|null,
 *   playerId: string,
 *   phase: string,
 *   shape: object,
 *   timeWindow?: { from: number, to: number }|null,
 *   utility?: Record<string, boolean>|null
 * }} args
 */
export function shapePassesWindow({
  meta,
  tickBuffer,
  playerId,
  phase,
  shape,
  timeWindow = null,
  utility = null
}) {
  if (!meta || !playerId || !shape?.geometry || shape.enabled === false) return true;
  const feature = shape.feature || 'player_in';
  // Map control asks a question about the round, not about a player, and it
  // answers it beside the search rather than inside it. Every round passes.
  if (feature === 'map_control') return true;
  const bounds = phaseBounds(meta);
  const teamOf = new Map((meta.players || []).map((p) => [p.id, p.team]));
  const scratch = {};
  const globalWin = sanitizeWindow(timeWindow);

  // Shape window AND the finder's global clock window. Phases pick the coarse
  // stretch; these narrow within it.
  const tickRateOf = () => meta.tickRate || 64;
  const inClockWindow = (tick) => {
    const elapsed = ((tick || 0) - bounds.freezeEndTick) / Math.max(1, tickRateOf());
    if (shape.window && (elapsed < shape.window.from || elapsed > shape.window.to)) return false;
    if (globalWin && (elapsed < globalWin.from || elapsed > globalWin.to)) return false;
    return true;
  };
  const eventTickPasses = (tick) =>
    phaseAtTick(tick || 0, bounds) === phase && inClockWindow(tick);

  if (feature === 'player_in') {
    if (!tickBuffer) return false;
    let header;
    try {
      header = readHeader(tickBuffer);
    } catch {
      return false;
    }
    const view = asView(tickBuffer);
    const slot = slotOf(meta, playerId);
    if (slot == null) return false;
    const tickRate = header.tickRate || meta.tickRate || 64;
    const step = Math.max(1, tickRate);
    let { from, to } = phaseTickRange(bounds, phase);
    const clampWin = (win) => {
      if (!win) return;
      from = Math.max(from, bounds.freezeEndTick + Math.round(win.from * tickRate));
      to = Math.min(to, bounds.freezeEndTick + Math.round(win.to * tickRate));
    };
    clampWin(shape.window);
    clampWin(globalWin);
    if (to <= from) return false;
    let hits = 0;
    for (let tick = from; tick < to; tick += step) {
      const pos = samplePlayerAt(view, header, slot, tick, scratch);
      if (pos && pointInShape(pos.x, pos.y, shape.geometry)) {
        hits++;
        if (hits >= PLAYER_IN_MIN_SAMPLES) return true;
      }
    }
    return false;
  }

  if (feature === 'grenade_in') {
    // A grenade this player threw that landed inside the shape during the
    // window. Landing point and detonation tick come off the event, so no
    // tick buffer is needed.
    // This selection's own types when it has them, the global switches only
    // for one drawn before selections carried their own.
    const want = sanitizeShapeUtility(shape.utility, feature) || utility;
    for (const g of meta.events?.grenades || []) {
      if (g.player !== playerId) continue;
      const key = utilKeyForType(g.type);
      if (want && key && want[key] === false) continue;
      const x = Number(g.at?.x);
      const y = Number(g.at?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const tick = Number(g.detonateTick ?? g.throwTick);
      if (!Number.isFinite(tick)) continue;
      if (!eventTickPasses(tick)) continue;
      if (pointInShape(x, y, shape.geometry)) return true;
    }
    return false;
  }

  const kills = meta.events?.kills || [];

  if (feature === 'kill_from' || feature === 'death_from') {
    const wantAttacker = feature === 'kill_from';
    const relevant = kills.filter((k) => {
      if (!eventTickPasses(k.tick)) return false;
      return wantAttacker ? k.attacker === playerId : k.victim === playerId;
    });
    if (!relevant.length) return false;

    // Prefer death position on the kill event when present (victim).
    for (const k of relevant) {
      if (
        !wantAttacker &&
        Number.isFinite(k.x) &&
        Number.isFinite(k.y) &&
        pointInShape(k.x, k.y, shape.geometry)
      ) {
        return true;
      }
    }

    if (!tickBuffer) return false;
    let header;
    try {
      header = readHeader(tickBuffer);
    } catch {
      return false;
    }
    const view = asView(tickBuffer);
    const slot = slotOf(meta, playerId);
    if (slot == null) return false;
    for (const k of relevant) {
      const pos = samplePlayerAt(view, header, slot, k.tick || 0, scratch);
      if (pos && pointInShape(pos.x, pos.y, shape.geometry)) return true;
    }
    return false;
  }

  if (feature === 'first_duel_in') {
    const open = openingKill(meta, teamOf);
    if (!open) return false;
    if (open.attacker !== playerId && open.victim !== playerId) return false;
    if (!eventTickPasses(open.tick)) return false;

    if (
      open.victim === playerId &&
      Number.isFinite(open.x) &&
      Number.isFinite(open.y) &&
      pointInShape(open.x, open.y, shape.geometry)
    ) {
      return true;
    }

    if (!tickBuffer) return false;
    let header;
    try {
      header = readHeader(tickBuffer);
    } catch {
      return false;
    }
    const view = asView(tickBuffer);
    const slot = slotOf(meta, playerId);
    if (slot == null) return false;
    const pos = samplePlayerAt(view, header, slot, open.tick || 0, scratch);
    return Boolean(pos && pointInShape(pos.x, pos.y, shape.geometry));
  }

  return true;
}

/**
 * Could this window satisfy this shape, judging only by what is already in
 * memory? `false` is a promise; `true` only means "the round has to be read".
 *
 * This is the cheap half of the search, and it runs before a single request.
 * A `kill_from` selection can only ever match a player who got a kill in that
 * phase, and the per-phase kill count is sitting in the round row the page
 * already downloaded — `row.ph[player][phase].p`, filled by the same
 * `phaseCombatFromMeta` off the same events that `shapePassesWindow` will
 * re-read. Same for a death, and `first_duel_in` can only be the two players
 * the row already names in `ok` / `od`.
 *
 * So the filters on the left compose into the scan instead of running after
 * it: pick a side and a phase and the search stops fetching the rounds where
 * nobody on that side did anything in that phase, which is most of them.
 *
 * `grenade_in` has no counterpart here — the index carries no per-round
 * grenade tally, so a grenade search still has to open every round. It at
 * least opens them cheaply: `searchNeedsTicks` keeps it to the meta.
 */
export function windowCanMatchShape(w, shape) {
  if (!shape || shape.enabled === false || !shape.geometry) return true;
  const feature = shape.feature || 'player_in';
  const line = w?.window?.p;

  if (feature === 'kill_from') return !line || (Number(line[P.KILLS]) || 0) > 0;
  if (feature === 'death_from') return !line || (Number(line[P.DEATHS]) || 0) > 0;
  if (feature === 'first_duel_in') {
    const row = w?.row;
    // An old payload without the opening columns: no opinion, read the round.
    if (!row || (row.ok === undefined && row.od === undefined)) return true;
    // A round whose opening duel is nobody's (no cross-team kill) has none.
    return w.playerId === row.ok || w.playerId === row.od;
  }
  return true;
}

/** Shape features that read positions out of the tick buffer. */
const TICK_FEATURES = new Set([
  'player_in',
  'kill_from',
  'death_from',
  'first_duel_in',
  // Possession is walked from the same buffer, one sample a second.
  'map_control'
]);

/**
 * Does this search need tick buffers at all?
 *
 * `grenade_in` answers off the round's own grenade events and says so in as
 * many words; a clock-only or utility-only filter never calls
 * `shapePassesWindow`. Both used to pay for a tick buffer per round regardless
 * — and ticks are the expensive half, a second request per round for a body
 * the meta already answered without.
 */
export function searchNeedsTicks(activeShapes) {
  return (activeShapes || []).some((s) => TICK_FEATURES.has(s?.feature || 'player_in'));
}

/** Round packs fetched at once. Enough to fill a link, few enough to stay polite. */
export const PACK_CONCURRENCY = 8;

/**
 * Rounds per batched /rounds/packs request, and how many such requests run at
 * once. One request for ~150 rounds replaces ~300 per-round GETs; two in
 * flight keep the link busy while the server reads the next chunk's files.
 */
export const PACK_BATCH_FILES = 150;
const PACK_BATCH_CONCURRENCY = 2;

/**
 * Load the round packs a set of windows needs, in parallel, reporting progress.
 *
 * This replaces a loop that awaited `fetchRoundMeta` and then `fetchRoundTicks`
 * inline, one window at a time. Two things were wrong with that and both are
 * felt rather than seen:
 *
 *   · **Serial.** Every distinct round file cost two round-trips end to end
 *     before the next one started. A map with twenty thousand rounds is forty
 *     thousand requests in a queue of one, and the whole phase is network
 *     latency with an idle CPU behind it.
 *   · **Silent.** The caller could only say "Matching selections…" because the
 *     loop had no idea how many files it was going to touch. `onProgress` here
 *     is what lets it count.
 *
 * Files already in `cache` are not refetched, so changing one shape and
 * searching again pays only for what it has not seen.
 */
export async function loadRoundPacks(
  files,
  cache,
  {
    ticks = true,
    onProgress = null,
    concurrency = PACK_CONCURRENCY,
    // Injected so a test can drive the pool without a network. Production
    // callers never pass these.
    fetchMeta = fetchRoundMeta,
    fetchTicks = fetchRoundTicks,
    // The batched transport. Tests that inject per-round fetchers get the
    // per-round pool unless they inject this too; production gets batching.
    fetchPacks = undefined
  } = {}
) {
  const missing = files.filter((f) => {
    if (!f) return false;
    const pack = cache.get(f);
    if (!pack) return true;
    // Its ticks were dropped to stay under the retained-bytes budget (see
    // `releaseTicks`), and this search reads positions. A miss, not a hit.
    return Boolean(ticks && pack.ticksReleased);
  });
  const total = missing.length;
  if (!total) {
    onProgress?.({ done: 0, total: 0 });
    return cache;
  }
  let done = 0;
  onProgress?.({ done: 0, total });

  const batcher =
    fetchPacks !== undefined
      ? fetchPacks
      : fetchMeta === fetchRoundMeta && fetchTicks === fetchRoundTicks
        ? fetchRoundPacks
        : null;

  // Files the batch could not answer (endpoint unavailable, or a round the
  // batch reported as missing/denied) fall back to the per-round pool below,
  // which still knows about the sample-demo mirrors.
  let queue = missing;
  if (batcher) {
    queue = [];
    const chunks = [];
    for (let i = 0; i < missing.length; i += PACK_BATCH_FILES) {
      chunks.push(missing.slice(i, i + PACK_BATCH_FILES));
    }
    let nextChunk = 0;
    const batchWorker = async () => {
      while (nextChunk < chunks.length) {
        const chunk = chunks[nextChunk++];
        let got = null;
        try {
          got = await batcher(chunk, { stride: COARSE_STRIDE, ticks });
        } catch {
          got = null;
        }
        if (!got) {
          queue.push(...chunk);
          continue;
        }
        for (const file of chunk) {
          const entry = got.get(file);
          // A released pack still has its meta; the batch's copy wins when
          // both exist, but either serves.
          const meta = entry?.meta || cache.get(file)?.meta || null;
          if (!meta) {
            queue.push(file);
            continue;
          }
          cache.set(file, { meta, ticks: ticks ? entry?.ticks || null : null });
          done += 1;
          onProgress?.({ done, total });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PACK_BATCH_CONCURRENCY, chunks.length) }, batchWorker)
    );
    if (!queue.length) return cache;
  }

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const file = queue[next++];
      // A released pack still has its meta; only its ticks were dropped, so
      // re-reading it costs one request rather than two.
      const pack = { meta: cache.get(file)?.meta || null, ticks: null };
      if (!pack.meta) {
        try {
          pack.meta = await fetchMeta(file);
        } catch {
          pack.meta = null;
        }
      }
      if (pack.meta && ticks) {
        try {
          // COARSE_STRIDE, not a stride of this search's own choosing.
          //
          // The server precomputes exactly one thinned pass per round, the
          // `.c100.bin` the timeline's coarse pass reads, and serves it as a
          // plain file read. Any other stride misses that file and falls
          // through to `decodeTickzStride`, which zstd-decompresses and
          // columnar-unpacks the WHOLE 1.1 MB round to hand back 18 KB —
          // measured at 4.2 ms of synchronous CPU per round, on Node's only
          // thread, so concurrent requests do not overlap and every meta
          // request queues behind them. This asked for 64 and paid that on
          // every round of every position search.
          //
          // Nothing above needs the finer grid: `shapePassesWindow` samples
          // `player_in` once a second, and the event features read one row at
          // a kill tick. `samplePlayerAt` divides by the buffer's own header
          // stride, so the coarser buffer is read correctly without a change.
          pack.ticks = await fetchTicks(file, COARSE_STRIDE);
        } catch {
          pack.ticks = null;
        }
      }
      cache.set(file, pack);
      done += 1;
      onProgress?.({ done, total });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return cache;
}

/**
 * Round files loaded, and evaluated, before the next batch starts.
 *
 * The load used to be one call for every file the search touched. That was
 * fine while a whole-map search only ever looked at a handful of rounds; it is
 * not fine now that it looks at all of them, because every tick buffer would
 * be resident at once before the first one was read. Batching bounds the peak
 * without changing the answer — files are independent of each other.
 */
export const PACK_CHUNK_FILES = 300;

/**
 * Tick bytes kept in the cache between searches.
 *
 * Ticks are the expensive half to fetch — a whole-map search is two requests
 * per round and the browser will only run six at a time — so keeping them is
 * what makes editing a shape and searching again nearly free rather than
 * another few minutes. A stride-100 round is ~11.6 KB (74 samples x 10 slots
 * x 16 bytes), so this holds a little over 11,000 rounds: a full Dust2 library
 * fits, and a map several times that size is capped rather than allowed to
 * grow without limit. Past the budget the oldest buffers are dropped and
 * refetched if a later search wants them. Meta is kept either way — it is the
 * small half and every search needs it.
 */
export const TICK_CACHE_BYTES = 128 * 1024 * 1024;

/**
 * Drop the oldest tick buffers until the cache is back under `budget`.
 * Insertion order is load order, so the front of the map is the least recently
 * fetched. Meta stays; `ticksReleased` marks the pack so `loadRoundPacks`
 * knows to re-read it rather than treating it as a hit.
 */
export function releaseTicks(cache, budget = TICK_CACHE_BYTES) {
  let held = 0;
  for (const pack of cache.values()) held += pack?.ticks?.byteLength || 0;
  if (held <= budget) return held;
  for (const pack of cache.values()) {
    if (!pack?.ticks) continue;
    held -= pack.ticks.byteLength || 0;
    pack.ticks = null;
    pack.ticksReleased = true;
    if (held <= budget) break;
  }
  return held;
}

/**
 * Filter phase windows by drawn shapes and/or global clock / utility filters.
 * `matchMode`: `'all'` (AND, default) or `'any'` (OR). Empty shapes + open
 * clock + all util types on ⇒ pass-through.
 *
 * Round packs are fetched for the DISTINCT files the windows name — there are
 * typically thirty windows per file (a player per phase), and the old loop
 * walked windows rather than files — in batches of `PACK_CHUNK_FILES`, each
 * batch evaluated before the next is fetched.
 *
 * @param {Array<{ file: string, phase: string, playerId: string, [k: string]: any }>} windows
 * @param {Array<object>} shapes
 * @param {Map<string, { meta: object|null, ticks: ArrayBuffer|null }>} [cache]
 * @param {'all'|'any'} [matchMode]
 * @param {{ timeWindow?: object, utility?: Record<string, boolean> }|null} [filter]
 * @param {{
 *   onProgress?: (p: { done: number, total: number }) => void,
 *   onPack?: (file: string, pack: object) => void,
 *   concurrency?: number,
 *   chunk?: number,
 *   tickBudget?: number,
 *   fetchMeta?: Function,
 *   fetchTicks?: Function
 * }} [opts]
 */
export async function filterWindowsByShapes(
  windows,
  shapes,
  cache = new Map(),
  matchMode = 'all',
  filter = null,
  opts = {}
) {
  const active = (shapes || []).filter((s) => s && s.enabled !== false && s.geometry);
  const timeWin = sanitizeWindow(filter?.timeWindow);
  const utilNarrow = hasNarrowUtility(filter);
  const utility = utilNarrow ? filter.utility : null;
  if (!active.length && !timeWin && !utilNarrow) return windows;
  const requireAll = matchMode !== 'any';
  const needTicks = searchNeedsTicks(active);

  /** Does one window survive the active shapes / clock / utility filters? */
  const windowPasses = (w, pack) => {
    if (active.length) {
      for (const shape of active) {
        const pass = shapePassesWindow({
          meta: pack.meta,
          tickBuffer: pack.ticks,
          playerId: w.playerId,
          phase: w.phase,
          shape,
          timeWindow: timeWin,
          utility
        });
        if (requireAll) {
          if (!pass) return false;
        } else if (pass) {
          return true;
        }
      }
      // AND ran out of shapes to fail on; OR ran out of shapes to pass on.
      return requireAll;
    }
    if (timeWin && !phaseOverlapsTime(pack.meta, w.phase, timeWin)) return false;
    if (utilNarrow && !playerThrewUtil(pack.meta, w.playerId, w.phase, utility, timeWin)) {
      return false;
    }
    return true;
  };

  // What the payload can already rule out, ruled out before anything is
  // fetched. AND needs every shape to still be possible; OR needs one.
  const canMatch = (w) => {
    if (!active.length) return true;
    return requireAll
      ? active.every((shape) => windowCanMatchShape(w, shape))
      : active.some((shape) => windowCanMatchShape(w, shape));
  };

  // Windows grouped by the file they need, so a batch can be evaluated the
  // moment it lands and its buffers let go of. A file none of whose windows
  // survived the precondition is never opened at all — that is the difference
  // between "matching 6,881 rounds" and matching the ones that could match.
  /** @type {Map<string, Array<object>>} */
  const byFile = new Map();
  for (const w of windows) {
    if (!w?.file || !canMatch(w)) continue;
    const list = byFile.get(w.file);
    if (list) list.push(w);
    else byFile.set(w.file, [w]);
  }
  const files = [...byFile.keys()];
  const chunk = Math.max(1, opts.chunk || PACK_CHUNK_FILES);
  const budget = Number.isFinite(opts.tickBudget) ? opts.tickBudget : TICK_CACHE_BYTES;

  /** @type {Set<object>} */
  const passed = new Set();
  for (let i = 0; i < files.length; i += chunk) {
    const slice = files.slice(i, i + chunk);
    // Progress counts files over the WHOLE search, not within a batch: the
    // batching is an implementation detail and a counter that restarted at
    // zero every 300 rounds would read as the loop it is not.
    const cached = slice.filter((f) => {
      const pack = cache.get(f);
      return pack && !(needTicks && pack.ticksReleased);
    }).length;
    await loadRoundPacks(slice, cache, {
      ticks: needTicks,
      concurrency: opts.concurrency,
      fetchMeta: opts.fetchMeta,
      fetchTicks: opts.fetchTicks,
      onProgress: opts.onProgress
        ? ({ done }) => opts.onProgress({ done: i + cached + done, total: files.length })
        : null
    });
    opts.onProgress?.({ done: Math.min(i + slice.length, files.length), total: files.length });

    for (const file of slice) {
      const pack = cache.get(file);
      if (!pack?.meta) continue;
      // Handed out while the pack is still whole: anything a caller wants to
      // measure per round has to happen before the batch's ticks are let go.
      opts.onPack?.(file, pack);
      for (const w of byFile.get(file) || []) {
        if (windowPasses(w, pack)) passed.add(w);
      }
    }
    if (needTicks) releaseTicks(cache, budget);
  }

  // Returned in window order, not file order: this is grouped by file only so
  // a batch can be let go of, and a caller that pairs windows with rows must
  // not see the same search come back reshuffled.
  return windows.filter((w) => passed.has(w));
}
