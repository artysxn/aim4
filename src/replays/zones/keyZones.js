// ---------------------------------------------------------------------------
// replays/zones/keyZones.js
// Per-bombsite key regions (up to 4 each for A and B). Drawn in the Sites
// editor as rectangles or polygons for later coach / analytics use.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ type: 'rect', x: number, y: number, w: number, h: number }} KeyZoneRect
 * @typedef {{ type: 'poly', ring: [number, number][] }} KeyZonePoly
 * @typedef {KeyZoneRect | KeyZonePoly} KeyZonePiece
 * @typedef {{ a: KeyZonePiece[], b: KeyZonePiece[] }} KeyZones
 */

export const KEY_ZONES_MAX = 4;

/** @returns {KeyZones} */
export function emptyKeyZones() {
  return { a: [], b: [] };
}

/** @param {unknown} raw @returns {KeyZonePiece | null} */
function sanitizeKeyPiece(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'poly' || Array.isArray(raw.ring)) {
    const ring = [];
    for (const p of (raw.ring || []).slice(0, 64)) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const px = Number(p[0]);
      const py = Number(p[1]);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      ring.push(/** @type {[number, number]} */ ([px, py]));
    }
    if (ring.length < 3) return null;
    return { type: 'poly', ring };
  }
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
    /** @type {KeyZonePiece[]} */
    const out = [];
    for (const item of list.slice(0, KEY_ZONES_MAX)) {
      const r = sanitizeKeyPiece(item);
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
 * Push a piece onto a site list (max KEY_ZONES_MAX). Returns false if full.
 * @param {object} network
 * @param {'a'|'b'} site
 * @param {KeyZonePiece} piece
 */
export function addKeyZone(network, site, piece) {
  ensureKeyZones(network);
  const clean = sanitizeKeyPiece(piece);
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
