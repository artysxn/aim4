// ---------------------------------------------------------------------------
// replays/zones/bombSites.js
// Rough A/B bomb-site rectangles on the zone network (not positions).
// Drawn in the Position Editor; used by site-execute coach notes.
// ---------------------------------------------------------------------------

import { pointInPiece } from './zoneGeom.js';

/**
 * @typedef {{ type: 'rect', x: number, y: number, w: number, h: number }} BombSiteRect
 * @typedef {{ a: BombSiteRect | null, b: BombSiteRect | null }} BombSites
 */

/** World-unit pad around a site rect that still counts as "near" for T cores. */
export const BOMB_SITE_NEAR_PAD = 280;

/** @returns {BombSites} */
export function emptyBombSites() {
  return { a: null, b: null };
}

/** @param {unknown} raw @returns {BombSiteRect | null} */
function sanitizeBombRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { type: 'rect', x, y, w, h };
}

/** @param {unknown} raw @returns {BombSites} */
export function sanitizeBombSites(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    a: sanitizeBombRect(/** @type {object} */ (src).a),
    b: sanitizeBombRect(/** @type {object} */ (src).b)
  };
}

/** @param {object | null | undefined} network */
export function ensureBombSites(network) {
  if (!network || typeof network !== 'object') return network;
  network.bombSites = sanitizeBombSites(network.bombSites);
  return network;
}

/** True when at least one A/B bomb-site rectangle is defined. */
export function hasBombSites(network) {
  const sites = sanitizeBombSites(network?.bombSites);
  return Boolean(sites.a || sites.b);
}

/** @param {BombSiteRect} rect @param {number} pad */
export function expandBombRect(rect, pad) {
  const p = Math.max(0, Number(pad) || 0);
  return {
    type: 'rect',
    x: rect.x - p,
    y: rect.y - p,
    w: rect.w + 2 * p,
    h: rect.h + 2 * p
  };
}

function rectCenter(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * @param {number} x world
 * @param {number} y world
 * @param {object | null | undefined} network
 * @returns {'a' | 'b' | null}
 */
export function bombSiteAtPoint(x, y, network) {
  const sites = sanitizeBombSites(network?.bombSites);
  if (sites.a && pointInPiece(x, y, sites.a)) return 'a';
  if (sites.b && pointInPiece(x, y, sites.b)) return 'b';
  return null;
}

/**
 * Site containing the point, or the nearer site within BOMB_SITE_NEAR_PAD.
 * Exact containment wins over near; overlapping near pads pick closer center.
 *
 * @param {number} x world
 * @param {number} y world
 * @param {object | null | undefined} network
 * @param {number} [pad]
 * @returns {'a' | 'b' | null}
 */
export function bombSiteNearPoint(x, y, network, pad = BOMB_SITE_NEAR_PAD) {
  const exact = bombSiteAtPoint(x, y, network);
  if (exact) return exact;
  const sites = sanitizeBombSites(network?.bombSites);
  const nearA = sites.a && pointInPiece(x, y, expandBombRect(sites.a, pad));
  const nearB = sites.b && pointInPiece(x, y, expandBombRect(sites.b, pad));
  if (nearA && !nearB) return 'a';
  if (nearB && !nearA) return 'b';
  if (nearA && nearB && sites.a && sites.b) {
    const ca = rectCenter(sites.a);
    const cb = rectCenter(sites.b);
    const da = (x - ca.x) ** 2 + (y - ca.y) ** 2;
    const db = (x - cb.x) ** 2 + (y - cb.y) ** 2;
    return da <= db ? 'a' : 'b';
  }
  return null;
}
