// ---------------------------------------------------------------------------
// Analytics geography: user-drawn shapes + feature predicates (localStorage).
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchRoundTicks } from '../api.js';
import { phaseAtTick, phaseBounds } from '../coach/roundPhases.js';
import { readHeader, readRecord } from '../shared/tickFormat.js';
import { pointInPiece } from '../zones/zoneGeom.js';

/** @typedef {'player_in'|'kill_from'|'death_from'|'first_duel_in'|'grenade_in'} ShapeFeature */

export const SHAPE_FEATURES = [
  { key: 'player_in', label: 'Player in' },
  { key: 'kill_from', label: 'Kill from' },
  { key: 'death_from', label: 'Died in' },
  { key: 'first_duel_in', label: 'First duel in' },
  { key: 'grenade_in', label: 'Grenade in' }
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

function sanitizeShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim() || newShapeId();
  const feature = SHAPE_FEATURES.some((f) => f.key === raw.feature)
    ? raw.feature
    : 'player_in';
  const geom = sanitizeGeometry(raw.geometry);
  if (!geom) return null;
  const window = sanitizeWindow(raw.window);
  return {
    id,
    name: String(raw.name || '').trim(),
    feature,
    geometry: geom,
    ...(window ? { window } : {}),
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
    for (const g of meta.events?.grenades || []) {
      if (g.player !== playerId) continue;
      const key = utilKeyForType(g.type);
      if (utility && key && utility[key] === false) continue;
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
 * Filter phase windows by drawn shapes and/or global clock / utility filters.
 * `matchMode`: `'all'` (AND, default) or `'any'` (OR). Empty shapes + open
 * clock + all util types on ⇒ pass-through.
 * Loads meta + ticks per distinct round file (cached by caller).
 *
 * @param {Array<{ file: string, phase: string, playerId: string, [k: string]: any }>} windows
 * @param {Array<object>} shapes
 * @param {Map<string, { meta: object|null, ticks: ArrayBuffer|null }>} [cache]
 * @param {'all'|'any'} [matchMode]
 * @param {{ timeWindow?: object, utility?: Record<string, boolean> }|null} [filter]
 */
export async function filterWindowsByShapes(
  windows,
  shapes,
  cache = new Map(),
  matchMode = 'all',
  filter = null
) {
  const active = (shapes || []).filter((s) => s && s.enabled !== false && s.geometry);
  const timeWin = sanitizeWindow(filter?.timeWindow);
  const utilNarrow = hasNarrowUtility(filter);
  const utility = utilNarrow ? filter.utility : null;
  if (!active.length && !timeWin && !utilNarrow) return windows;
  const requireAll = matchMode !== 'any';

  const out = [];
  for (const w of windows) {
    const file = w.file;
    let pack = cache.get(file);
    if (!pack) {
      pack = { meta: null, ticks: null };
      try {
        pack.meta = await fetchRoundMeta(file);
      } catch {
        pack.meta = null;
      }
      if (pack.meta) {
        try {
          pack.ticks = await fetchRoundTicks(file, 64);
        } catch {
          pack.ticks = null;
        }
      }
      cache.set(file, pack);
    }
    if (!pack.meta) continue;

    let ok;
    if (active.length) {
      ok = requireAll;
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
          if (!pass) {
            ok = false;
            break;
          }
        } else if (pass) {
          ok = true;
          break;
        }
      }
    } else {
      ok = true;
      if (timeWin && !phaseOverlapsTime(pack.meta, w.phase, timeWin)) ok = false;
      if (ok && utilNarrow && !playerThrewUtil(pack.meta, w.playerId, w.phase, utility, timeWin)) {
        ok = false;
      }
    }
    if (ok) out.push(w);
  }
  return out;
}
