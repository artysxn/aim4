// ---------------------------------------------------------------------------
// replays/zones/keyZones.js
// Per-bombsite key rectangles (up to 4 each for A and B). Drawn in the Sites
// editor for later coach / analytics use — not claim tiles.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ type: 'rect', x: number, y: number, w: number, h: number }} KeyZoneRect
 * @typedef {{ a: KeyZoneRect[], b: KeyZoneRect[] }} KeyZones
 */

export const KEY_ZONES_MAX = 4;

/** @returns {KeyZones} */
export function emptyKeyZones() {
  return { a: [], b: [] };
}

/** @param {unknown} raw @returns {KeyZoneRect | null} */
function sanitizeKeyRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { type: 'rect', x, y, w, h };
}

/**
 * @param {unknown} raw
 * @returns {KeyZones}
 */
export function sanitizeKeyZones(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const one = (list) => {
    if (!Array.isArray(list)) return [];
    /** @type {KeyZoneRect[]} */
    const out = [];
    for (const item of list.slice(0, KEY_ZONES_MAX)) {
      const r = sanitizeKeyRect(item);
      if (r) out.push(r);
    }
    return out;
  };
  return {
    a: one(/** @type {object} */ (src).a),
    b: one(/** @type {object} */ (src).b)
  };
}

/** @param {object | null | undefined} network */
export function ensureKeyZones(network) {
  if (!network || typeof network !== 'object') return network;
  network.keyZones = sanitizeKeyZones(network.keyZones);
  return network;
}

/** @param {object | null | undefined} network @param {'a'|'b'} site */
export function keyZonesFor(network, site) {
  const kz = sanitizeKeyZones(network?.keyZones);
  return site === 'b' ? kz.b : kz.a;
}

/**
 * Push a rect onto a site list (max KEY_ZONES_MAX). Returns false if full.
 * @param {object} network
 * @param {'a'|'b'} site
 * @param {KeyZoneRect} rect
 */
export function addKeyZone(network, site, rect) {
  ensureKeyZones(network);
  const clean = sanitizeKeyRect(rect);
  if (!clean) return false;
  const list = site === 'b' ? network.keyZones.b : network.keyZones.a;
  if (list.length >= KEY_ZONES_MAX) return false;
  list.push(clean);
  return true;
}

/**
 * @param {object} network
 * @param {'a'|'b'} site
 * @param {number} [index]  omit to clear all for that site
 */
export function clearKeyZones(network, site, index = -1) {
  ensureKeyZones(network);
  const list = site === 'b' ? network.keyZones.b : network.keyZones.a;
  if (index < 0) {
    if (site === 'b') network.keyZones.b = [];
    else network.keyZones.a = [];
    return;
  }
  if (index >= 0 && index < list.length) list.splice(index, 1);
}
