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

const CLIP_EPS = 1e-9;
const MIN_PIECE_AREA = 4;

/** Signed area of a ring; positive when counter-clockwise in math coords. */
export function ringSignedArea(ring) {
  let s = 0;
  for (let i = 0, j = (ring?.length || 0) - 1; i < (ring?.length || 0); j = i++) {
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return s / 2;
}

function ccwRing(ring) {
  return ringSignedArea(ring) < 0 ? ring.slice().reverse() : ring.slice();
}

/** Keep the half of `ring` on one side of the directed line a→b. */
function clipRingToHalfPlane(ring, a, b, keepLeft) {
  const side = (p) => {
    const d = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    return keepLeft ? d : -d;
  };
  const cut = (p, q, dp, dq) => {
    const t = dp / (dp - dq);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    const prev = ring[(i + ring.length - 1) % ring.length];
    const dc = side(cur);
    const dp = side(prev);
    if (dc >= -CLIP_EPS) {
      if (dp < -CLIP_EPS) out.push(cut(prev, cur, dp, dc));
      out.push(cur);
    } else if (dp >= -CLIP_EPS) {
      out.push(cut(prev, cur, dp, dc));
    }
  }
  return out.length >= 3 ? out : [];
}

function pointInTriangle(p, a, b, c) {
  const s = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const d1 = s(a, b, p);
  const d2 = s(b, c, p);
  const d3 = s(c, a, p);
  const neg = d1 < -CLIP_EPS || d2 < -CLIP_EPS || d3 < -CLIP_EPS;
  const pos = d1 > CLIP_EPS || d2 > CLIP_EPS || d3 > CLIP_EPS;
  return !(neg && pos);
}

/** Ear-clip a ring into triangles so concave cutters subtract correctly. */
export function triangulateRing(ring) {
  const pts = ccwRing(ring || []);
  if (pts.length < 3) return [];
  const idx = pts.map((_, i) => i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 4000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = pts[idx[(i + idx.length - 1) % idx.length]];
      const b = pts[idx[i]];
      const c = pts[idx[(i + 1) % idx.length]];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= CLIP_EPS) continue;
      let contains = false;
      for (const j of idx) {
        const p = pts[j];
        if (p === a || p === b || p === c) continue;
        if (pointInTriangle(p, a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  return tris;
}

/** subject − convex, as a set of disjoint rings. */
function subtractConvexRing(subject, convex) {
  const clip = ccwRing(convex);
  const out = [];
  let remaining = subject;
  for (let i = 0; i < clip.length && remaining.length >= 3; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const outside = clipRingToHalfPlane(remaining, a, b, false);
    if (outside.length >= 3) out.push(outside);
    remaining = clipRingToHalfPlane(remaining, a, b, true);
  }
  return out;
}

function convexPartsOfPiece(piece) {
  if (piece.type === 'rect') return [ccwRing(rectToRing(piece))];
  return triangulateRing(pieceToRing(piece));
}

function ringToPiece(ring) {
  if (Math.abs(ringSignedArea(ring)) < MIN_PIECE_AREA) return null;
  return { type: 'poly', ring: ring.map(([x, y]) => [x, y]) };
}

/**
 * piece − cutter, for any mix of rect and poly. Rect − rect stays rectangular;
 * anything else comes back as polygons.
 * @param {Piece} piece
 * @param {Piece} cutter
 * @returns {Piece[]}
 */
export function subtractPieceFromPiece(piece, cutter) {
  if (!piece) return [];
  if (!cutter) return [piece];
  if (!boundsOverlap(pieceBounds(piece), pieceBounds(cutter))) return [piece];
  if (piece.type === 'rect' && cutter.type === 'rect') {
    return rectDifference(piece, cutter).filter((r) => r.w * r.h >= MIN_PIECE_AREA);
  }
  let rings = [ccwRing(pieceToRing(piece))];
  for (const part of convexPartsOfPiece(cutter)) {
    const next = [];
    for (const ring of rings) next.push(...subtractConvexRing(ring, part));
    rings = next;
    if (!rings.length) break;
  }
  return rings.map(ringToPiece).filter(Boolean);
}

/** Subtract one cutter from every piece in a list. */
export function subtractPieceFromPieces(pieces, cutter) {
  /** @type {Piece[]} */
  const out = [];
  for (const p of pieces || []) out.push(...subtractPieceFromPiece(p, cutter));
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

/** Quantize world coords so shared edges cancel despite float noise. */
function qCoord(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Sweep axis-aligned intervals; keep spans where coverage is odd.
 * Shared walls between two rects appear twice → even → cancelled.
 * @param {Array<[number, number]>} intervals
 * @returns {Array<[number, number]>}
 */
function oddCoverageSpans(intervals) {
  if (!intervals.length) return [];
  /** @type {Array<[number, number]>} */
  const events = [];
  for (const [a, b] of intervals) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo < 1e-6) continue;
    events.push([lo, 1], [hi, -1]);
  }
  if (!events.length) return [];
  events.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
  /** @type {Array<[number, number]>} */
  const out = [];
  let cover = 0;
  let prev = events[0][0];
  for (const [x, d] of events) {
    if (x > prev && cover % 2 === 1) out.push([prev, x]);
    cover += d;
    prev = x;
  }
  return out;
}

/**
 * Exterior edge segments of a union of axis-aligned rects (no internal walls).
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @returns {Array<{x0:number,y0:number,x1:number,y1:number}>}
 */
export function exteriorSegmentsFromRects(rects) {
  /** @type {Map<number, Array<[number, number]>>} */
  const horiz = new Map();
  /** @type {Map<number, Array<[number, number]>>} */
  const vert = new Map();
  const push = (map, line, a, b) => {
    if (!map.has(line)) map.set(line, []);
    map.get(line).push([a, b]);
  };

  for (const r of rects || []) {
    if (!r) continue;
    const w = Number(r.w);
    const h = Number(r.h);
    if (!(w > 0) || !(h > 0)) continue;
    const x0 = qCoord(r.x);
    const y0 = qCoord(r.y);
    const x1 = qCoord(r.x + w);
    const y1 = qCoord(r.y + h);
    push(horiz, y0, x0, x1);
    push(horiz, y1, x0, x1);
    push(vert, x0, y0, y1);
    push(vert, x1, y0, y1);
  }

  /** @type {Array<{x0:number,y0:number,x1:number,y1:number}>} */
  const segs = [];
  for (const [y, intervals] of horiz) {
    for (const [a, b] of oddCoverageSpans(intervals)) {
      segs.push({ x0: a, y0: y, x1: b, y1: y });
    }
  }
  for (const [x, intervals] of vert) {
    for (const [a, b] of oddCoverageSpans(intervals)) {
      segs.push({ x0: x, y0: a, x1: x, y1: b });
    }
  }
  return segs;
}

/** Unique endpoints of exterior segments (for corner handles). */
export function exteriorVerticesFromSegments(segs) {
  const seen = new Set();
  /** @type {Array<[number, number]>} */
  const pts = [];
  for (const s of segs || []) {
    for (const [x, y] of [
      [s.x0, s.y0],
      [s.x1, s.y1]
    ]) {
      const k = `${qCoord(x)},${qCoord(y)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pts.push([x, y]);
    }
  }
  return pts;
}

/** Collect rect pieces only (polys ignored for outline merge). */
export function rectsFromPieces(pieces) {
  /** @type {Array<{x:number,y:number,w:number,h:number}>} */
  const out = [];
  for (const p of pieces || []) {
    if (p?.type === 'rect' || (p && p.type == null && p.w > 0 && p.h > 0)) {
      out.push({ x: p.x, y: p.y, w: p.w, h: p.h });
    }
  }
  return out;
}
