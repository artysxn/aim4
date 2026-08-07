// ---------------------------------------------------------------------------
// replays/coach/coachSmokes.js
// Match demo detonations against the private Autocoach utility database.
// Ids look like ancient_t_window_smoke / ancient_both_heaven_flash.
// ---------------------------------------------------------------------------

import { fetchCoachSmokes } from '../api.js';

/** Default match radius in game units. */
export const COACH_SMOKE_MATCH_UNITS = 180;

const cache = new Map();

function normalizeArchive(map, archive) {
  const list = Array.isArray(archive?.utilities)
    ? archive.utilities
    : Array.isArray(archive?.smokes)
      ? archive.smokes
      : [];
  return { map, utilities: list, smokes: list };
}

/**
 * @param {string} mapCode
 * @returns {Promise<{ map: string, utilities: Array, smokes: Array }>}
 */
export async function loadCoachSmokes(mapCode) {
  const map = String(mapCode || '').toUpperCase();
  if (!map) return { map: '', utilities: [], smokes: [] };
  if (cache.has(map)) return cache.get(map);
  try {
    const archive = await fetchCoachSmokes(map);
    const normalized = normalizeArchive(map, archive);
    cache.set(map, normalized);
    return normalized;
  } catch {
    const empty = { map, utilities: [], smokes: [] };
    cache.set(map, empty);
    return empty;
  }
}

/** Drop cached archives (e.g. after admin edits in another tab). */
export function clearCoachSmokesCache() {
  cache.clear();
}

/**
 * Nearest utility landing to a detonation point, or null.
 * @param {Array<{ id: string, name: string, type?: string, detonate: {x:number,y:number} }>} list
 * @param {number} x
 * @param {number} y
 * @param {number} [radius]
 * @param {string} [type]  optional weapon type filter (smokegrenade, …)
 */
export function matchCoachSmoke(list, x, y, radius = COACH_SMOKE_MATCH_UNITS, type = '') {
  if (!list?.length || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const want = type ? String(type).toLowerCase().replace(/^weapon_/, '') : '';
  const r2 = radius * radius;
  let best = null;
  let bestD = r2;
  for (const s of list) {
    if (want && s.type && s.type !== want && !(want === 'incgrenade' && s.type === 'molotov')) {
      continue;
    }
    const dx = (s.detonate?.x || 0) - x;
    const dy = (s.detonate?.y || 0) - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
