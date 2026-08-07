// ---------------------------------------------------------------------------
// Stable Autocoach utility ids: mapname_side_name_utilitytype
// e.g. ancient_t_window_smoke, ancient_both_heaven_flash
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';

/** Weapon type → id suffix. */
export const UTIL_TYPE_SLUG = {
  smokegrenade: 'smoke',
  flashbang: 'flash',
  molotov: 'molly',
  incgrenade: 'molly',
  hegrenade: 'he'
};

export const UTIL_SLUG_TO_TYPE = {
  smoke: 'smokegrenade',
  flash: 'flashbang',
  molly: 'molotov',
  he: 'hegrenade'
};

export const COACH_UTIL_TOOLS = [
  { type: 'smokegrenade', slug: 'smoke', label: 'Smoke', icon: '/icons/equipment/smokegrenade.svg' },
  { type: 'flashbang', slug: 'flash', label: 'Flash', icon: '/icons/equipment/flashbang.svg' },
  { type: 'molotov', slug: 'molly', label: 'Molly', icon: '/icons/equipment/molotov.svg' },
  { type: 'hegrenade', slug: 'he', label: 'HE', icon: '/icons/equipment/hegrenade.svg' }
];

export const COACH_SIDES = [
  { value: 't', label: 'T' },
  { value: 'ct', label: 'CT' },
  { value: 'both', label: 'Both' }
];

/** Lowercase slug token: letters/digits, underscores between words. */
export function slugPart(raw, fallback = 'unnamed') {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 48);
  return s || fallback;
}

export function mapNameSlug(mapCode) {
  const code = String(mapCode || '').toUpperCase();
  return slugPart(MAPS[code]?.name || code, 'map');
}

export function normalizeCoachSide(side) {
  const s = String(side || '')
    .trim()
    .toLowerCase();
  if (s === 't' || s === 'terrorist' || s === 'terrorists') return 't';
  if (s === 'ct' || s === 'counter' || s === 'counterterrorist') return 'ct';
  return 'both';
}

export function normalizeUtilType(type) {
  const t = String(type || 'smokegrenade').toLowerCase().replace(/^weapon_/, '');
  if (UTIL_TYPE_SLUG[t]) return t;
  if (UTIL_SLUG_TO_TYPE[t]) return UTIL_SLUG_TO_TYPE[t];
  return 'smokegrenade';
}

export function utilTypeSlug(type) {
  return UTIL_TYPE_SLUG[normalizeUtilType(type)] || 'smoke';
}

/**
 * Build the canonical id from map + side + display name + util type.
 * @param {string} mapCode
 * @param {string} side  t | ct | both
 * @param {string} name
 * @param {string} type  weapon type or short slug
 */
export function coachUtilityId(mapCode, side, name, type) {
  return [
    mapNameSlug(mapCode),
    normalizeCoachSide(side),
    slugPart(name, 'unnamed'),
    utilTypeSlug(type)
  ].join('_');
}

/** Avoid collisions when two entries share the same name/side/type. */
export function uniqueCoachUtilityId(base, used) {
  const root = String(base || '').slice(0, 120) || 'unnamed';
  if (!used.has(root)) return root;
  for (let i = 2; i < 200; i++) {
    const id = `${root}_${i}`;
    if (!used.has(id)) return id;
  }
  return `${root}_${Date.now().toString(36)}`;
}
