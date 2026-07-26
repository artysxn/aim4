// ---------------------------------------------------------------------------
// replays/zones/zoneGeom.js
// Axis-aligned rect pieces in world space, plus point-in-piece tests.
// Overlaps carve via rectangle difference so squares become rectilinear
// "polygons" (multipart rects) without a clipping library.
// ---------------------------------------------------------------------------

/** @typedef {{ type: 'rect', x: number, y: number, w: number, h: number }} RectPiece */
/** @typedef {{ type: 'poly', ring: [number, number][] }} PolyPiece */
/** @typedef {RectPiece | PolyPiece} Piece */

export function rect(x, y, w, h) {
  return { type: 'rect', x, y, w, h };
}

export function normalizeRect(x0, y0, x1, y1) {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  return rect(x, y, w, h);
}

export function rectBounds(r) {
  return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
}

export function pieceBounds(piece) {
  if (piece.type === 'rect') return rectBounds(piece);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of piece.ring || []) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsOverlap(a, b, pad = 0) {
  return !(
    a.maxX <= b.minX - pad ||
    a.minX >= b.maxX + pad ||
    a.maxY <= b.minY - pad ||
    a.minY >= b.maxY + pad
  );
}

export function rectsOverlap(a, b) {
  return boundsOverlap(rectBounds(a), rectBounds(b));
}

/** Area of intersection of two AABBs, or 0. */
export function rectIntersectionArea(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * A − B for axis-aligned rects → 0..4 rects covering the remainder.
 * @param {RectPiece} a
 * @param {RectPiece} b
 * @returns {RectPiece[]}
 */
export function rectDifference(a, b) {
  if (!rectsOverlap(a, b)) return [a];
  const ax1 = a.x + a.w;
  const ay1 = a.y + a.h;
  const bx0 = Math.max(a.x, b.x);
  const by0 = Math.max(a.y, b.y);
  const bx1 = Math.min(ax1, b.x + b.w);
  const by1 = Math.min(ay1, b.y + b.h);
  /** @type {RectPiece[]} */
  const out = [];
  // Top slab
  if (by0 > a.y) out.push(rect(a.x, a.y, a.w, by0 - a.y));
  // Bottom slab
  if (by1 < ay1) out.push(rect(a.x, by1, a.w, ay1 - by1));
  // Middle-left
  if (bx0 > a.x) out.push(rect(a.x, by0, bx0 - a.x, by1 - by0));
  // Middle-right
  if (bx1 < ax1) out.push(rect(bx1, by0, ax1 - bx1, by1 - by0));
  return out.filter((r) => r.w > 1e-6 && r.h > 1e-6);
}

/**
 * Subtract cutter from every rect piece (poly pieces are left alone if they
 * do not overlap the cutter's bounds in a simple way — editor only draws rects).
 * @param {Piece[]} pieces
 * @param {RectPiece} cutter
 * @returns {Piece[]}
 */
export function subtractRectFromPieces(pieces, cutter) {
  /** @type {Piece[]} */
  const out = [];
  for (const p of pieces) {
    if (p.type !== 'rect') {
      out.push(p);
      continue;
    }
    if (!rectsOverlap(p, cutter)) {
      out.push(p);
      continue;
    }
    out.push(...rectDifference(p, cutter));
  }
  return out;
}

/** Point-in-rect (world). Inclusive min, exclusive max on +edges to avoid double hits. */
export function pointInRect(x, y, r) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Ray-cast point-in-polygon (world). Ring is [[x,y], ...], not closed. */
export function pointInRing(x, y, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInPiece(x, y, piece) {
  if (piece.type === 'rect') return pointInRect(x, y, piece);
  if (piece.type === 'poly') return pointInRing(x, y, piece.ring);
  return false;
}

/** Convert a rect piece to a closed-ish ring for drawing (4 corners). */
export function rectToRing(r) {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h]
  ];
}

export function pieceToRing(piece) {
  if (piece.type === 'rect') return rectToRing(piece);
  return piece.ring || [];
}
