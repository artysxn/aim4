// ---------------------------------------------------------------------------
// replays/zones/maskContour.js
// Closed outlines around the set cells of a bitmask, and polyline simplification.
//
// Shared by the wall extractor (over the 1024² radar raster) and the territory
// renderer (over the possession lattice). Both need the same thing: follow the
// cracks between set and unset cells into closed rings.
//
// Simplification matters more than it looks. Crack-following a diagonal wall
// produces a staircase of single-texel steps, and collapsing only exactly
// collinear runs leaves every one of them. Douglas-Peucker turns that staircase
// back into the few long edges it was drawn as, which is both far cheaper to
// sweep against and a truer shape.
// ---------------------------------------------------------------------------

/**
 * Trace closed rings around every set cell of `mask`.
 *
 * Edges are emitted with the region on the right, so outer rings and holes wind
 * opposite ways — what canvas nonzero fill wants, and harmless for occlusion.
 *
 * @param {Uint8Array} mask
 * @param {number} cols @param {number} rows
 * @returns {Array<{ x: Int32Array, y: Int32Array }>} rings in lattice coords
 */
export function traceMaskRings(mask, cols, rows) {
  const vCols = cols + 1;

  // Pass one: how many boundary edges, so nothing is oversized. A full radar
  // raster would need 4M edge slots if sized by cell count, but only the
  // perimeter ever emits.
  let nEdges = 0;
  for (let iy = 0; iy < rows; iy++) {
    const row = iy * cols;
    for (let ix = 0; ix < cols; ix++) {
      if (!mask[row + ix]) continue;
      if (iy === 0 || !mask[row - cols + ix]) nEdges++;
      if (ix === cols - 1 || !mask[row + ix + 1]) nEdges++;
      if (iy === rows - 1 || !mask[row + cols + ix]) nEdges++;
      if (ix === 0 || !mask[row + ix - 1]) nEdges++;
    }
  }
  if (!nEdges) return [];

  const ex0 = new Int32Array(nEdges);
  const ey0 = new Int32Array(nEdges);
  const ex1 = new Int32Array(nEdges);
  const ey1 = new Int32Array(nEdges);
  const outA = new Int32Array(vCols * (rows + 1)).fill(-1);
  const outB = new Int32Array(vCols * (rows + 1)).fill(-1);
  const used = new Uint8Array(nEdges);

  let w = 0;
  const push = (x0, y0, x1, y1) => {
    ex0[w] = x0;
    ey0[w] = y0;
    ex1[w] = x1;
    ey1[w] = y1;
    const v = y0 * vCols + x0;
    if (outA[v] < 0) outA[v] = w;
    else if (outB[v] < 0) outB[v] = w;
    w++;
  };

  for (let iy = 0; iy < rows; iy++) {
    const row = iy * cols;
    for (let ix = 0; ix < cols; ix++) {
      if (!mask[row + ix]) continue;
      if (iy === 0 || !mask[row - cols + ix]) push(ix, iy, ix + 1, iy);
      if (ix === cols - 1 || !mask[row + ix + 1]) push(ix + 1, iy, ix + 1, iy + 1);
      if (iy === rows - 1 || !mask[row + cols + ix]) push(ix + 1, iy + 1, ix, iy + 1);
      if (ix === 0 || !mask[row + ix - 1]) push(ix, iy + 1, ix, iy);
    }
  }

  /** @type {Array<{ x: Int32Array, y: Int32Array }>} */
  const rings = [];
  /** @type {number[]} */
  const px = [];
  /** @type {number[]} */
  const py = [];

  for (let start = 0; start < nEdges; start++) {
    if (used[start]) continue;
    px.length = 0;
    py.length = 0;
    let e = start;
    while (e >= 0 && !used[e]) {
      used[e] = 1;
      px.push(ex0[e]);
      py.push(ey0[e]);
      const v = ey1[e] * vCols + ex1[e];
      const a = outA[v];
      const b = outB[v];
      // Two outgoing edges only happen at a diagonal pinch; either choice
      // closes a valid ring, so take whichever is still free.
      e = a >= 0 && !used[a] ? a : b >= 0 && !used[b] ? b : -1;
    }
    if (px.length < 4) continue;
    rings.push({ x: Int32Array.from(px), y: Int32Array.from(py) });
  }

  return rings;
}

/** Mark the Douglas-Peucker survivors between two anchors. */
function dpMark(xs, ys, from, to, tol2, keep) {
  const stack = [from, to];
  while (stack.length) {
    const j = stack.pop();
    const i = stack.pop();
    if (j <= i + 1) continue;
    const x0 = xs[i];
    const y0 = ys[i];
    const dx = xs[j] - x0;
    const dy = ys[j] - y0;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let best = tol2;
    for (let k = i + 1; k < j; k++) {
      let d2;
      if (len2 === 0) {
        const ax = xs[k] - x0;
        const ay = ys[k] - y0;
        d2 = ax * ax + ay * ay;
      } else {
        let t = ((xs[k] - x0) * dx + (ys[k] - y0) * dy) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const px = x0 + t * dx - xs[k];
        const py = y0 + t * dy - ys[k];
        d2 = px * px + py * py;
      }
      if (d2 > best) {
        best = d2;
        far = k;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push(i, far, far, j);
  }
}

/**
 * Simplify a closed ring, keeping it closed.
 *
 * Split at the point farthest from the first so the two halves are independent
 * open polylines — running Douglas-Peucker straight round a loop would let it
 * collapse the whole thing to a degenerate pair.
 *
 * @param {{ x: ArrayLike<number>, y: ArrayLike<number> }} ring
 * @param {number} tol  max deviation, in lattice units
 * @returns {{ x: number[], y: number[] } | null}
 */
export function simplifyRing(ring, tol) {
  const xs = ring.x;
  const ys = ring.y;
  const n = xs.length;
  if (n < 4) return null;

  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const dx = xs[i] - xs[0];
    const dy = ys[i] - ys[0];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  if (far < 1) return null;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const tol2 = tol * tol;
  dpMark(xs, ys, 0, far, tol2, keep);

  // Second half wraps past the end, so walk it through a temporary that has
  // index 0 appended as the closing anchor.
  const m = n - far + 1;
  const wx = new Float64Array(m);
  const wy = new Float64Array(m);
  for (let i = 0; i < m - 1; i++) {
    wx[i] = xs[far + i];
    wy[i] = ys[far + i];
  }
  wx[m - 1] = xs[0];
  wy[m - 1] = ys[0];
  const keep2 = new Uint8Array(m);
  keep2[0] = 1;
  keep2[m - 1] = 1;
  dpMark(wx, wy, 0, m - 1, tol2, keep2);
  for (let i = 1; i < m - 1; i++) if (keep2[i]) keep[far + i] = 1;

  /** @type {number[]} */
  const ox = [];
  /** @type {number[]} */
  const oy = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    ox.push(xs[i]);
    oy.push(ys[i]);
  }
  return ox.length >= 3 ? { x: ox, y: oy } : null;
}

/** Shoelace area of a ring, in lattice units². */
export function ringArea(x, y) {
  let sum = 0;
  for (let i = 0, j = x.length - 1; i < x.length; j = i++) {
    sum += x[j] * y[i] - x[i] * y[j];
  }
  return Math.abs(sum) * 0.5;
}
