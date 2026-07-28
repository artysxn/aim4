// ---------------------------------------------------------------------------
// replays/zones/ledges.js
// One-way vision ledges: oriented strokes. Relative to draw direction on the
// radar, left = drop-down (blocks), right = upper (open). Open normals are
// baked in world space at edit time so the radar↔world Y flip does not swap sides.
// ---------------------------------------------------------------------------

export const LEDGES_MAX = 400;
export const LEDGE_PTS_MAX = 256;

/**
 * @param {unknown} raw
 * @returns {Array<{type:'ledge', pts:number[][], open:'R'|'L', openN:number[][]}>}
 */
export function sanitizeLedges(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const piece of raw.slice(0, LEDGES_MAX)) {
    if (!piece || typeof piece !== 'object') continue;
    if (piece.type != null && piece.type !== 'ledge') continue;
    if (!Array.isArray(piece.pts) || piece.pts.length < 2) continue;
    const pts = [];
    for (const p of piece.pts.slice(0, LEDGE_PTS_MAX)) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pts.push([x, y]);
    }
    if (pts.length < 2) continue;
    const open = piece.open === 'L' ? 'L' : 'R';
    let openN = [];
    if (Array.isArray(piece.openN) && piece.openN.length === pts.length - 1) {
      for (const n of piece.openN) {
        if (!Array.isArray(n) || n.length < 2) {
          openN = [];
          break;
        }
        const nx = Number(n[0]);
        const ny = Number(n[1]);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
          openN = [];
          break;
        }
        const len = Math.hypot(nx, ny) || 1;
        openN.push([nx / len, ny / len]);
      }
    }
    if (!openN.length) openN = inferOpenNormals(pts, open);
    out.push({ type: 'ledge', pts, open, openN });
  }
  return out;
}

/** Fallback when openN was not stored (legacy): world-space travel right/left. */
function inferOpenNormals(pts, open) {
  const openN = [];
  const openRight = open !== 'L';
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      openN.push([0, 0]);
      continue;
    }
    const rNx = dy / len;
    const rNy = -dx / len;
    openN.push(openRight ? [rNx, rNy] : [-rNx, -rNy]);
  }
  return openN;
}

export function ensureLedges(network) {
  if (!network || typeof network !== 'object') return network;
  if (!Array.isArray(network.ledges)) network.ledges = [];
  return network;
}

/** Drop near-duplicates along a radar stroke; keep endpoints. */
export function simplifyStrokePts(pts, minDist = 2.5) {
  if (!pts?.length) return [];
  const out = [[pts[0][0], pts[0][1]]];
  const min2 = minDist * minDist;
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const dx = pts[i][0] - prev[0];
    const dy = pts[i][1] - prev[1];
    if (dx * dx + dy * dy >= min2) out.push([pts[i][0], pts[i][1]]);
  }
  const last = pts[pts.length - 1];
  const tip = out[out.length - 1];
  if (tip[0] !== last[0] || tip[1] !== last[1]) out.push([last[0], last[1]]);
  return out;
}

/**
 * World ledge from a radar-space stroke. Open normals follow radar left/right.
 * @param {string} mapCode
 * @param {Function} radarToWorldFn
 * @param {Array<[number, number]>} radarPts
 * @param {'R'|'L'} [open]
 */
export function worldLedgeFromRadarStroke(mapCode, radarToWorldFn, radarPts, open = 'R') {
  const simplified = simplifyStrokePts(radarPts, 2.5);
  if (simplified.length < 2) return null;
  const openRight = open !== 'L';
  const pts = [];
  const openN = [];
  for (let i = 0; i < simplified.length; i++) {
    const w = radarToWorldFn(mapCode, simplified[i][0], simplified[i][1], {});
    if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return null;
    pts.push([w.x, w.y]);
  }
  for (let i = 0; i < simplified.length - 1; i++) {
    const rx0 = simplified[i][0];
    const ry0 = simplified[i][1];
    const rx1 = simplified[i + 1][0];
    const ry1 = simplified[i + 1][1];
    const dx = rx1 - rx0;
    const dy = ry1 - ry0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      openN.push([0, 0]);
      continue;
    }
    // Radar-space right-of-travel unit normal.
    let nx = dy / len;
    let ny = -dx / len;
    if (!openRight) {
      nx = -nx;
      ny = -ny;
    }
    const mx = (rx0 + rx1) * 0.5;
    const my = (ry0 + ry1) * 0.5;
    const a = radarToWorldFn(mapCode, mx, my, {});
    const b = radarToWorldFn(mapCode, mx + nx, my + ny, {});
    const wx = b.x - a.x;
    const wy = b.y - a.y;
    const wlen = Math.hypot(wx, wy) || 1;
    openN.push([wx / wlen, wy / wlen]);
  }
  return { type: 'ledge', pts, open: openRight ? 'R' : 'L', openN };
}

function distPointSeg2(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    const ex = px - x0;
    const ey = py - y0;
    return ex * ex + ey * ey;
  }
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = x0 + t * dx - px;
  const qy = y0 + t * dy - py;
  return qx * qx + qy * qy;
}

/** True when a world point lies within `radius` of any ledge segment. */
export function pointNearLedge(ledge, wx, wy, radius) {
  const pts = ledge?.pts;
  if (!pts || pts.length < 2) return false;
  const r2 = radius * radius;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distPointSeg2(wx, wy, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= r2) {
      return true;
    }
  }
  return false;
}

/**
 * Erase ledges intersecting a world brush stamp (center + radius).
 * @returns {number} removed count
 */
export function eraseLedgesNear(ledges, wx, wy, radius) {
  if (!ledges?.length) return 0;
  let removed = 0;
  for (let i = ledges.length - 1; i >= 0; i--) {
    if (pointNearLedge(ledges[i], wx, wy, radius)) {
      ledges.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/**
 * Append ledge segments that block the viewer (drop-down / closed half-plane).
 * Open side of the stroke does not contribute occluders.
 *
 * @param {Array<{pts:number[][], openN?:number[][], open?:string}>|null|undefined} ledges
 * @param {number} ox @param {number} oy  viewer
 * @param {number} minX @param {number} minY @param {number} maxX @param {number} maxY
 * @param {Float32Array} out
 * @param {number} written
 * @returns {number}
 */
export function appendBlockingLedgeSegs(ledges, ox, oy, minX, minY, maxX, maxY, out, written) {
  if (!ledges?.length) return written;
  let n = written;
  const cap = (out.length / 4) | 0;
  for (const ledge of ledges) {
    const pts = ledge?.pts;
    if (!pts || pts.length < 2) continue;
    const openN =
      Array.isArray(ledge.openN) && ledge.openN.length === pts.length - 1
        ? ledge.openN
        : inferOpenNormals(pts, ledge.open === 'L' ? 'L' : 'R');
    for (let i = 0; i < pts.length - 1; i++) {
      if (n >= cap) return n;
      const x0 = pts[i][0];
      const y0 = pts[i][1];
      const x1 = pts[i + 1][0];
      const y1 = pts[i + 1][1];
      const segMinX = x0 < x1 ? x0 : x1;
      const segMaxX = x0 > x1 ? x0 : x1;
      const segMinY = y0 < y1 ? y0 : y1;
      const segMaxY = y0 > y1 ? y0 : y1;
      if (segMaxX < minX || segMinX > maxX || segMaxY < minY || segMinY > maxY) continue;

      const on = openN[i];
      if (!on || (on[0] === 0 && on[1] === 0)) continue;
      const mx = (x0 + x1) * 0.5;
      const my = (y0 + y1) * 0.5;
      const side = (ox - mx) * on[0] + (oy - my) * on[1];
      // Open half-plane (and on-line): do not occlude.
      if (side >= -1e-3) continue;

      const o = n * 4;
      out[o] = x0;
      out[o + 1] = y0;
      out[o + 2] = x1;
      out[o + 3] = y1;
      n++;
    }
  }
  return n;
}
