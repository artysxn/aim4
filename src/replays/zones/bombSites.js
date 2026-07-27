// ---------------------------------------------------------------------------
// replays/zones/bombSites.js
// Rough A/B bomb-site regions on the zone network (not positions).
// Drawn in the Sites editor as rectangles or polygons; used by site-execute
// coach notes and pre-plant bombsite stack win%.
// ---------------------------------------------------------------------------

import { pieceBounds, pointInPiece } from './zoneGeom.js';

/**
 * @typedef {{ type: 'rect', x: number, y: number, w: number, h: number }} BombSiteRect
 * @typedef {{ type: 'poly', ring: [number, number][] }} BombSitePoly
 * @typedef {BombSiteRect | BombSitePoly} BombSitePiece
 * @typedef {{ a: BombSitePiece | null, b: BombSitePiece | null }} BombSites
 */

/** World-unit pad around a site that still counts as "near" for T cores. */
export const BOMB_SITE_NEAR_PAD = 280;

/** @returns {BombSites} */
export function emptyBombSites() {
  return { a: null, b: null };
}

/** @param {unknown} raw @returns {BombSitePiece | null} */
export function sanitizeBombPiece(raw) {
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

/** @param {unknown} raw @returns {BombSites} */
export function sanitizeBombSites(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    a: sanitizeBombPiece(/** @type {object} */ (src).a),
    b: sanitizeBombPiece(/** @type {object} */ (src).b)
  };
}

/** @param {object | null | undefined} network */
export function ensureBombSites(network) {
  if (!network || typeof network !== 'object') return network;
  network.bombSites = sanitizeBombSites(network.bombSites);
  return network;
}

/** True when at least one A/B bomb-site region is defined. */
export function hasBombSites(network) {
  const sites = sanitizeBombSites(network?.bombSites);
  return Boolean(sites.a || sites.b);
}

/**
 * Axis-aligned pad around a site piece (poly → padded bounds rect).
 * @param {BombSitePiece} piece
 * @param {number} pad
 */
export function expandBombRect(piece, pad) {
  const p = Math.max(0, Number(pad) || 0);
  if (piece?.type === 'poly' && piece.ring?.length) {
    const b = pieceBounds(piece);
    return {
      type: 'rect',
      x: b.minX - p,
      y: b.minY - p,
      w: b.maxX - b.minX + 2 * p,
      h: b.maxY - b.minY + 2 * p
    };
  }
  return {
    type: 'rect',
    x: piece.x - p,
    y: piece.y - p,
    w: piece.w + 2 * p,
    h: piece.h + 2 * p
  };
}

function pieceCenter(piece) {
  if (piece?.type === 'poly' && piece.ring?.length) {
    const b = pieceBounds(piece);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  return { x: piece.x + piece.w / 2, y: piece.y + piece.h / 2 };
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
    const ca = pieceCenter(sites.a);
    const cb = pieceCenter(sites.b);
    const da = (x - ca.x) ** 2 + (y - ca.y) ** 2;
    const db = (x - cb.x) ** 2 + (y - cb.y) ** 2;
    return da <= db ? 'a' : 'b';
  }
  return null;
}
