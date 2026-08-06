// ---------------------------------------------------------------------------
// replays/zones/regionHierarchy.js
// Painted Positions → Zones → Areas on a map network.
//
// Position: one geometric footprint (rect/poly), unique id, editable name,
//           optional Z level for dual-radar maps (Nuke).
// Zone:     named group of position ids.
// Area:     named group of zone ids.
//
// Same-name positions on different levels are allowed (a name can span floors).
// Overlap between positions on the same level is rejected.
// ---------------------------------------------------------------------------

import {
  boundsOverlap,
  pieceBounds,
  pieceToRing,
  pointInPiece,
  subtractPieceFromPiece,
  subtractPieceFromPieces
} from './zoneGeom.js';

const ID_RE = /^[A-Za-z0-9_-]{2,40}$/;
const NAME_MAX = 64;
const POSITIONS_MAX = 400;
const PIECES_MAX = 64;
const ZONES_MAX = 200;
const AREAS_MAX = 100;
const MEMBERS_MAX = 80;

/** @typedef {'default'|'lower'} RegionLevel */
/** @typedef {{ type: 'rect', x: number, y: number, w: number, h: number } | { type: 'poly', ring: [number, number][] }} Piece */

export function newRegionId(prefix = 'p') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}${Date.now().toString(36).slice(-4)}`;
}

function cleanId(raw, prefix) {
  const s = String(raw || '')
    .trim()
    .slice(0, 40);
  if (ID_RE.test(s)) return s;
  return newRegionId(prefix);
}

function cleanName(raw, fallback = 'Untitled') {
  const s = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, NAME_MAX);
  return s || fallback;
}

function cleanLevel(raw) {
  return raw === 'lower' ? 'lower' : 'default';
}

function validPiece(piece) {
  if (!piece || typeof piece !== 'object') return null;
  if (
    piece.type === 'rect' ||
    (piece.type == null &&
      Number.isFinite(Number(piece.x)) &&
      Number.isFinite(Number(piece.y)) &&
      Number.isFinite(Number(piece.w)) &&
      Number.isFinite(Number(piece.h)))
  ) {
    const x = Number(piece.x);
    const y = Number(piece.y);
    const w = Number(piece.w);
    const h = Number(piece.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { type: 'rect', x, y, w, h };
  }
  if (piece.type === 'poly' && Array.isArray(piece.ring) && piece.ring.length >= 3) {
    const ring = [];
    for (const p of piece.ring.slice(0, 64)) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ring.push([x, y]);
    }
    if (ring.length < 3) return null;
    return { type: 'poly', ring };
  }
  return null;
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

/** Pull a ring a hair toward its centre so shapes that only share an edge
 *  (what carving leaves behind) do not read as overlapping. */
function shrinkRing(ring) {
  if (!ring?.length) return [];
  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x;
    cy += y;
  }
  cx /= ring.length;
  cy /= ring.length;
  return ring.map(([x, y]) => [x + (cx - x) * 1e-3, y + (cy - y) * 1e-3]);
}

/** True when two pieces share interior (same-level positions must not). */
export function piecesOverlap(a, b) {
  if (!a || !b) return false;
  if (!boundsOverlap(pieceBounds(a), pieceBounds(b), -0.5)) return false;
  const ra = pieceToRing(a);
  const rb = pieceToRing(b);
  for (const [x, y] of shrinkRing(ra)) {
    if (pointInPiece(x, y, b)) return true;
  }
  for (const [x, y] of shrinkRing(rb)) {
    if (pointInPiece(x, y, a)) return true;
  }
  for (let i = 0; i < ra.length; i++) {
    const a0 = ra[i];
    const a1 = ra[(i + 1) % ra.length];
    for (let j = 0; j < rb.length; j++) {
      const b0 = rb[j];
      const b1 = rb[(j + 1) % rb.length];
      if (segmentsIntersect(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}

/**
 * Does `piece` overlap any other position on the same Z level?
 * @param {object} network
 * @param {Piece} piece
 * @param {RegionLevel} level
 * @param {string} [exceptId]
 */
export function positionOverlapsOthers(network, piece, level, exceptId = '') {
  const want = cleanLevel(level);
  for (const pos of network?.positions || []) {
    if (!pos || pos.id === exceptId) continue;
    if (cleanLevel(pos.level) !== want) continue;
    for (const p of pos.pieces || []) {
      if (piecesOverlap(piece, p)) return pos;
    }
  }
  return null;
}

export function ensureRegionHierarchy(network) {
  if (!network || typeof network !== 'object') return network;
  if (!Array.isArray(network.positions)) network.positions = [];
  if (!Array.isArray(network.zones)) network.zones = [];
  if (!Array.isArray(network.areas)) network.areas = [];
  return network;
}

/**
 * Sanitize Positions / Zones / Areas. Tolerates legacy keys:
 *   zones-as-positions, sections-as-zones (zoneIds → positionIds),
 *   areas.sectionIds → zoneIds.
 */
export function sanitizeRegionHierarchy(src) {
  const raw = src && typeof src === 'object' ? src : {};

  /** @type {Map<string, object>} */
  const positionsById = new Map();
  const rawPositions = Array.isArray(raw.positions)
    ? raw.positions
    : Array.isArray(raw.zones) && raw.zones[0]?.pieces
      ? raw.zones
      : [];

  for (const row of rawPositions.slice(0, POSITIONS_MAX)) {
    if (!row || typeof row !== 'object') continue;
    const id = cleanId(row.id, 'p');
    if (positionsById.has(id)) continue;
    const pieces = [];
    const list = Array.isArray(row.pieces) ? row.pieces : row.piece ? [row.piece] : [];
    for (const piece of list.slice(0, PIECES_MAX)) {
      const clean = validPiece(piece);
      if (clean) pieces.push(clean);
    }
    if (!pieces.length) continue;
    positionsById.set(id, {
      id,
      name: cleanName(row.name, `Position ${positionsById.size + 1}`),
      level: cleanLevel(row.level),
      pieces
    });
  }

  /** @type {Map<string, object>} */
  const zonesById = new Map();
  const rawZones = Array.isArray(raw.zones) && raw.zones[0] && !raw.zones[0].pieces
    ? raw.zones
    : Array.isArray(raw.sections)
      ? raw.sections
      : [];

  for (const row of rawZones.slice(0, ZONES_MAX)) {
    if (!row || typeof row !== 'object') continue;
    const id = cleanId(row.id, 'z');
    if (zonesById.has(id)) continue;
    const memberRaw = Array.isArray(row.positionIds)
      ? row.positionIds
      : Array.isArray(row.zoneIds)
        ? row.zoneIds
        : [];
    const positionIds = [];
    const seen = new Set();
    for (const mid of memberRaw.slice(0, MEMBERS_MAX)) {
      const pid = String(mid || '');
      if (!positionsById.has(pid) || seen.has(pid)) continue;
      seen.add(pid);
      positionIds.push(pid);
    }
    zonesById.set(id, {
      id,
      name: cleanName(row.name, `Zone ${zonesById.size + 1}`),
      positionIds
    });
  }

  /** @type {Map<string, object>} */
  const areasById = new Map();
  const rawAreas = Array.isArray(raw.areas) ? raw.areas : [];
  for (const row of rawAreas.slice(0, AREAS_MAX)) {
    if (!row || typeof row !== 'object') continue;
    const id = cleanId(row.id, 'a');
    if (areasById.has(id)) continue;
    const memberRaw = Array.isArray(row.zoneIds)
      ? row.zoneIds
      : Array.isArray(row.sectionIds)
        ? row.sectionIds
        : [];
    const zoneIds = [];
    const seen = new Set();
    for (const mid of memberRaw.slice(0, MEMBERS_MAX)) {
      const zid = String(mid || '');
      if (!zonesById.has(zid) || seen.has(zid)) continue;
      seen.add(zid);
      zoneIds.push(zid);
    }
    areasById.set(id, {
      id,
      name: cleanName(row.name, `Area ${areasById.size + 1}`),
      zoneIds
    });
  }

  return {
    positions: [...positionsById.values()],
    zones: [...zonesById.values()],
    areas: [...areasById.values()]
  };
}

/** Every same-level position whose footprint the piece runs into. */
export function positionsOverlapping(network, piece, level, exceptId = '') {
  const want = cleanLevel(level);
  const hits = [];
  for (const pos of network?.positions || []) {
    if (!pos || pos.id === exceptId) continue;
    if (cleanLevel(pos.level) !== want) continue;
    if ((pos.pieces || []).some((p) => piecesOverlap(piece, p))) hits.push(pos);
  }
  return hits;
}

/**
 * Cut `piece` out of every same-level position it overlaps (new shape on top).
 * Positions left with nothing are removed.
 * @returns {{ carved: object[], removed: object[] }}
 */
export function carvePositionsUnder(network, piece, level, exceptId = '') {
  ensureRegionHierarchy(network);
  const clean = validPiece(piece);
  const carved = [];
  const removed = [];
  if (!clean) return { carved, removed };
  for (const pos of positionsOverlapping(network, clean, level, exceptId)) {
    const next = subtractPieceFromPieces(pos.pieces || [], clean)
      .map(validPiece)
      .filter(Boolean)
      .slice(0, PIECES_MAX);
    if (next.length) {
      pos.pieces = next;
      carved.push(pos);
    } else {
      removed.push(pos);
    }
  }
  for (const pos of removed) deletePosition(network, pos.id);
  return { carved, removed };
}

/**
 * Cut every same-level position out of `piece` (existing shapes stay on top).
 * @returns {Piece[]} the parts of the piece that survive
 */
export function carvePieceUnderPositions(network, piece, level, exceptId = '') {
  ensureRegionHierarchy(network);
  const clean = validPiece(piece);
  if (!clean) return [];
  let parts = [clean];
  for (const pos of positionsOverlapping(network, clean, level, exceptId)) {
    for (const cutter of pos.pieces || []) {
      const next = [];
      for (const part of parts) next.push(...subtractPieceFromPiece(part, cutter));
      parts = next;
      if (!parts.length) return [];
    }
  }
  return parts.map(validPiece).filter(Boolean).slice(0, PIECES_MAX);
}

/**
 * Fold `sourceId` into `targetId`: pieces join, zone membership follows.
 * @returns {object|null} the surviving position
 */
export function mergePositions(network, targetId, sourceId) {
  ensureRegionHierarchy(network);
  if (targetId === sourceId) return null;
  const target = network.positions.find((p) => p.id === targetId);
  const source = network.positions.find((p) => p.id === sourceId);
  if (!target || !source) return null;
  target.pieces = [...(target.pieces || []), ...(source.pieces || [])].slice(0, PIECES_MAX);
  for (const z of network.zones) {
    if (!(z.positionIds || []).includes(sourceId)) continue;
    const ids = z.positionIds.filter((pid) => pid !== sourceId);
    if (!ids.includes(targetId)) ids.push(targetId);
    z.positionIds = ids;
  }
  network.positions = network.positions.filter((p) => p.id !== sourceId);
  return target;
}

/** Same-level position sharing this name, ignoring case. */
export function findPositionByName(network, name, level, exceptId = '') {
  const want = cleanName(name, '').toLowerCase();
  if (!want) return null;
  const lvl = cleanLevel(level);
  return (
    (network?.positions || []).find(
      (p) =>
        p.id !== exceptId &&
        cleanLevel(p.level) === lvl &&
        cleanName(p.name, '').toLowerCase() === want
    ) || null
  );
}

export function createPosition(network, { name, level, pieces, allowOverlap = false }) {
  ensureRegionHierarchy(network);
  const list = Array.isArray(pieces) ? pieces : [pieces];
  const cleanPieces = [];
  for (const p of list) {
    const c = validPiece(p);
    if (c) cleanPieces.push(c);
  }
  if (!cleanPieces.length) return null;
  const lvl = cleanLevel(level);
  if (!allowOverlap) {
    for (const piece of cleanPieces) {
      const hit = positionOverlapsOthers(network, piece, lvl);
      if (hit) {
        const err = new Error(`Overlaps position "${hit.name}"`);
        err.code = 'OVERLAP';
        err.position = hit;
        throw err;
      }
    }
  }
  let id = newRegionId('p');
  while (network.positions.some((p) => p.id === id)) id = newRegionId('p');
  const pos = {
    id,
    name: cleanName(name, `Position ${network.positions.length + 1}`),
    level: lvl,
    pieces: cleanPieces.slice(0, PIECES_MAX)
  };
  network.positions.push(pos);
  return pos;
}

export function renamePosition(network, id, name) {
  ensureRegionHierarchy(network);
  const pos = network.positions.find((p) => p.id === id);
  if (!pos) return null;
  pos.name = cleanName(name, pos.name);
  return pos;
}

export function deletePosition(network, id) {
  ensureRegionHierarchy(network);
  const before = network.positions.length;
  network.positions = network.positions.filter((p) => p.id !== id);
  for (const z of network.zones) {
    z.positionIds = (z.positionIds || []).filter((pid) => pid !== id);
  }
  return network.positions.length < before;
}

export function createZone(network, { name, positionIds }) {
  ensureRegionHierarchy(network);
  const ids = [];
  const seen = new Set();
  for (const pid of positionIds || []) {
    if (!network.positions.some((p) => p.id === pid) || seen.has(pid)) continue;
    seen.add(pid);
    ids.push(pid);
  }
  if (!ids.length) return null;
  let id = newRegionId('z');
  while (network.zones.some((z) => z.id === id)) id = newRegionId('z');
  const zone = {
    id,
    name: cleanName(name, `Zone ${network.zones.length + 1}`),
    positionIds: ids
  };
  network.zones.push(zone);
  return zone;
}

export function renameZone(network, id, name) {
  ensureRegionHierarchy(network);
  const zone = network.zones.find((z) => z.id === id);
  if (!zone) return null;
  zone.name = cleanName(name, zone.name);
  return zone;
}

export function deleteZone(network, id) {
  ensureRegionHierarchy(network);
  const before = network.zones.length;
  network.zones = network.zones.filter((z) => z.id !== id);
  for (const a of network.areas) {
    a.zoneIds = (a.zoneIds || []).filter((zid) => zid !== id);
  }
  return network.zones.length < before;
}

export function setZoneMembers(network, id, positionIds) {
  ensureRegionHierarchy(network);
  const zone = network.zones.find((z) => z.id === id);
  if (!zone) return null;
  const ids = [];
  const seen = new Set();
  for (const pid of positionIds || []) {
    if (!network.positions.some((p) => p.id === pid) || seen.has(pid)) continue;
    seen.add(pid);
    ids.push(pid);
  }
  zone.positionIds = ids;
  return zone;
}

export function createArea(network, { name, zoneIds }) {
  ensureRegionHierarchy(network);
  const ids = [];
  const seen = new Set();
  for (const zid of zoneIds || []) {
    if (!network.zones.some((z) => z.id === zid) || seen.has(zid)) continue;
    seen.add(zid);
    ids.push(zid);
  }
  if (!ids.length) return null;
  let id = newRegionId('a');
  while (network.areas.some((a) => a.id === id)) id = newRegionId('a');
  const area = {
    id,
    name: cleanName(name, `Area ${network.areas.length + 1}`),
    zoneIds: ids
  };
  network.areas.push(area);
  return area;
}

export function renameArea(network, id, name) {
  ensureRegionHierarchy(network);
  const area = network.areas.find((a) => a.id === id);
  if (!area) return null;
  area.name = cleanName(name, area.name);
  return area;
}

export function deleteArea(network, id) {
  ensureRegionHierarchy(network);
  const before = network.areas.length;
  network.areas = network.areas.filter((a) => a.id !== id);
  return network.areas.length < before;
}

export function setAreaMembers(network, id, zoneIds) {
  ensureRegionHierarchy(network);
  const area = network.areas.find((a) => a.id === id);
  if (!area) return null;
  const ids = [];
  const seen = new Set();
  for (const zid of zoneIds || []) {
    if (!network.zones.some((z) => z.id === zid) || seen.has(zid)) continue;
    seen.add(zid);
    ids.push(zid);
  }
  area.zoneIds = ids;
  return area;
}
