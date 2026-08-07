// ---------------------------------------------------------------------------
// replays/zones/bombSites.js
// Rough A/B bomb-site regions on the zone network (not positions).
// Drawn in the Sites editor as rectangles or polygons; used by site-execute
// coach notes and pre-plant bombsite stack win%.
//
// On stacked maps (Nuke) each site may have one piece per floor (`level`).
// Legacy single-piece `{ a, b }` values still load as upper (`default`).
// ---------------------------------------------------------------------------

import { pieceBounds, pointInPiece } from './zoneGeom.js';
import { cleanRegionLevel, filterPiecesByLevel, withPieceLevel } from './zoneLevel.js';

/**
 * @typedef {{ type: 'rect', x: number, y: number, w: number, h: number, level?: 'default'|'lower' }} BombSiteRect
 * @typedef {{ type: 'poly', ring: [number, number][], level?: 'default'|'lower' }} BombSitePoly
 * @typedef {BombSiteRect | BombSitePoly} BombSitePiece
 * @typedef {{ a: BombSitePiece[], b: BombSitePiece[] }} BombSites
 */

/** World-unit pad around a site that still counts as "near" for T cores. */
export const BOMB_SITE_NEAR_PAD = 280;

/** @returns {BombSites} */
export function emptyBombSites() {
  return { a: [], b: [] };
}

/** @param {unknown} raw @returns {BombSitePiece | null} */
export function sanitizeBombPiece(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const level = cleanRegionLevel(/** @type {object} */ (raw).level);
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
    return { type: 'poly', ring, level };
  }
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { type: 'rect', x, y, w, h, level };
}

/** Normalize legacy single piece or array into a piece list. */
function sanitizeSiteList(raw) {
  /** @type {BombSitePiece[]} */
  const out = [];
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, 4)) {
      const p = sanitizeBombPiece(item);
      if (p) out.push(p);
    }
    return out;
  }
  const one = sanitizeBombPiece(raw);
  if (one) out.push(one);
  return out;
}

/** @param {unknown} raw @returns {BombSites} */
export function sanitizeBombSites(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    a: sanitizeSiteList(/** @type {object} */ (src).a),
    b: sanitizeSiteList(/** @type {object} */ (src).b)
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
  return Boolean(sites.a.length || sites.b.length);
}

/**
 * Pieces for a site, optionally filtered to one floor.
 * @param {object | null | undefined} network
 * @param {'a'|'b'} site
 * @param {{ level?: string, mapCode?: string }} [opts]
 */
export function bombSitePieces(network, site, opts = {}) {
  const sites = sanitizeBombSites(network?.bombSites);
  const list = site === 'b' ? sites.b : sites.a;
  if (opts.level == null) return list;
  return filterPiecesByLevel(list, opts.level, opts.mapCode || '');
}

/**
 * Set / replace the piece for one site on one floor.
 * @param {object} network
 * @param {'a'|'b'} site
 * @param {BombSitePiece} piece
 * @param {'default'|'lower'} [level]
 */
export function setBombSitePiece(network, site, piece, level = 'default') {
  ensureBombSites(network);
  const clean = sanitizeBombPiece(withPieceLevel(piece, level));
  if (!clean) return false;
  const list = site === 'b' ? network.bombSites.b : network.bombSites.a;
  const lvl = clean.level;
  const idx = list.findIndex((p) => cleanRegionLevel(p.level) === lvl);
  if (idx >= 0) list[idx] = clean;
  else list.push(clean);
  return true;
}

/**
 * Clear one floor (or every floor when level omitted).
 * @param {object} network
 * @param {'a'|'b'} site
 * @param {'default'|'lower'|null} [level]
 */
export function clearBombSitePiece(network, site, level = null) {
  ensureBombSites(network);
  if (level == null) {
    if (site === 'b') network.bombSites.b = [];
    else network.bombSites.a = [];
    return;
  }
  const want = cleanRegionLevel(level);
  const list = site === 'b' ? network.bombSites.b : network.bombSites.a;
  const next = list.filter((p) => cleanRegionLevel(p.level) !== want);
  if (site === 'b') network.bombSites.b = next;
  else network.bombSites.a = next;
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

export function pieceCenter(piece) {
  if (piece?.type === 'poly' && piece.ring?.length) {
    const b = pieceBounds(piece);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  if (!piece || !Number.isFinite(piece.x)) return null;
  return { x: piece.x + piece.w / 2, y: piece.y + piece.h / 2 };
}

/**
 * Centers of A/B bombsite pieces (null when a site is missing on that floor).
 * When `level` is omitted, uses the first piece of each site (legacy).
 *
 * @param {object | null | undefined} network
 * @param {{ level?: string, mapCode?: string }} [opts]
 * @returns {{ a: {x:number,y:number}|null, b: {x:number,y:number}|null }}
 */
export function bombSiteCenters(network, opts = {}) {
  const aList = bombSitePieces(network, 'a', opts);
  const bList = bombSitePieces(network, 'b', opts);
  return {
    a: aList[0] ? pieceCenter(aList[0]) : null,
    b: bList[0] ? pieceCenter(bList[0]) : null
  };
}

/**
 * @param {number} x world
 * @param {number} y world
 * @param {object | null | undefined} network
 * @param {{ level?: string, mapCode?: string }} [opts]
 * @returns {'a' | 'b' | null}
 */
export function bombSiteAtPoint(x, y, network, opts = {}) {
  for (const piece of bombSitePieces(network, 'a', opts)) {
    if (pointInPiece(x, y, piece)) return 'a';
  }
  for (const piece of bombSitePieces(network, 'b', opts)) {
    if (pointInPiece(x, y, piece)) return 'b';
  }
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
 * @param {{ level?: string, mapCode?: string }} [opts]
 * @returns {'a' | 'b' | null}
 */
export function bombSiteNearPoint(x, y, network, pad = BOMB_SITE_NEAR_PAD, opts = {}) {
  const exact = bombSiteAtPoint(x, y, network, opts);
  if (exact) return exact;
  const aList = bombSitePieces(network, 'a', opts);
  const bList = bombSitePieces(network, 'b', opts);
  const nearA = aList.some((p) => pointInPiece(x, y, expandBombRect(p, pad)));
  const nearB = bList.some((p) => pointInPiece(x, y, expandBombRect(p, pad)));
  if (nearA && !nearB) return 'a';
  if (nearB && !nearA) return 'b';
  if (nearA && nearB && aList[0] && bList[0]) {
    const ca = pieceCenter(aList[0]);
    const cb = pieceCenter(bList[0]);
    const da = (x - ca.x) ** 2 + (y - ca.y) ** 2;
    const db = (x - cb.x) ** 2 + (y - cb.y) ** 2;
    return da <= db ? 'a' : 'b';
  }
  return null;
}
