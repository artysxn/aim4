// ---------------------------------------------------------------------------
// replays/zones/pathDistance.js
// How far away somewhere actually is, on foot.
//
// Straight-line distance is a lie on a Counter-Strike map, and it is a lie in a
// direction that matters: it is always shorter than the walk. A CT on the far
// side of a wall from the bomb is nine hundred units away and cannot get there
// in four seconds, and any model fed the straight line will believe they can.
// B tunnels on Dust2 and mid on Anubis are the obvious offenders, but every map
// has them.
//
// So distance comes from the walkable raster instead. A Dijkstra sweep out from
// the target across a coarsened radar mask gives the length of the actual path
// to every cell at once, which is exactly the shape the question has: one bomb,
// ten players, "who can reach it".
//
// Coarse on purpose. The radar is 1024 square; this walks it at a quarter of
// that, so a cell is four pixels, or roughly twenty world units. That is well
// under the size of a player and far under the size of the errors it removes,
// and it makes a full sweep cheap enough to do per round rather than per map.
//
// DOM-free. Reads the same walkable mask the vision stack uses, so a caller in
// node needs registerRadarMask first and a caller in the browser needs the
// radar image loaded; both end up at getCachedLos.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, calibrationFor, worldToRadar } from '../viewer/mapCalibration.js';
import { getCachedLos } from './zoneOverlay.js';

/** Radar pixels per grid cell. 4 gives a 256x256 lattice. */
export const CELL_PIXELS = 4;
/** Grid width and height. */
const GRID = RADAR_SIZE / CELL_PIXELS;
/**
 * Walkable pixels needed in a cell's block before the cell counts as walkable.
 *
 * Requiring all sixteen would close every corridor narrower than the cell;
 * requiring one would let a path squeeze diagonally through the corner of a
 * wall. A quarter keeps the corridors open and the walls solid.
 */
const WALKABLE_PIXELS = 4;

const SQRT2 = Math.SQRT2;
/** Fields are held per map and target; this many before the oldest is dropped. */
const CACHE_LIMIT = 24;

/** @type {Map<string, {grid: Uint8Array}>} */
const gridCache = new Map();
/** @type {Map<string, {field: Float64Array, unit: number, tx: number, ty: number}>} */
const fieldCache = new Map();

/** Coarsen the map's walkable mask to the lattice, once per map. */
function walkableGrid(mapCode) {
  const hit = gridCache.get(mapCode);
  if (hit) return hit.grid;

  const los = getCachedLos(mapCode);
  const mask = los?.mask;
  if (!mask || mask.length !== RADAR_SIZE * RADAR_SIZE) return null;

  const grid = new Uint8Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let n = 0;
      const py0 = gy * CELL_PIXELS;
      const px0 = gx * CELL_PIXELS;
      for (let dy = 0; dy < CELL_PIXELS; dy++) {
        const row = (py0 + dy) * RADAR_SIZE + px0;
        for (let dx = 0; dx < CELL_PIXELS; dx++) {
          if (mask[row + dx]) n++;
        }
      }
      if (n >= WALKABLE_PIXELS) grid[gy * GRID + gx] = 1;
    }
  }
  gridCache.set(mapCode, { grid });
  return grid;
}

/** Nearest walkable cell to one that is not, so a target inside a wall still works. */
function snapToWalkable(grid, gx, gy, radius = 6) {
  if (gx >= 0 && gy >= 0 && gx < GRID && gy < GRID && grid[gy * GRID + gx]) return gy * GRID + gx;
  let best = -1;
  let bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = gy + dy;
    if (y < 0 || y >= GRID) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = gx + dx;
      if (x < 0 || x >= GRID) continue;
      if (!grid[y * GRID + x]) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = y * GRID + x;
      }
    }
  }
  return best;
}

/**
 * Dijkstra out from one cell across the walkable lattice.
 *
 * Eight-connected with chamfer weights of 1 and root two, which is within a few
 * percent of true path length and is the standard trade for not running a
 * proper any-angle search. A binary heap is enough at this size.
 */
function sweep(grid, startIdx) {
  // Float64, not Float32. The heap carries full precision, so storing a
  // distance narrowed to float32 can round it below the value the heap holds,
  // and the staleness check below (`d > dist[idx]`) then fires on a node's own
  // entry and drops it unexpanded. That silently prunes about half the frontier
  // at every step and the sweep dies a few dozen cells out.
  const dist = new Float64Array(GRID * GRID).fill(Infinity);
  if (startIdx < 0) return dist;

  // Heap of [distance, index] pairs, kept as two parallel arrays.
  const heapD = [0];
  const heapI = [startIdx];
  dist[startIdx] = 0;

  const push = (d, i) => {
    heapD.push(d);
    heapI.push(i);
    let c = heapD.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapD[p] <= heapD[c]) break;
      [heapD[p], heapD[c]] = [heapD[c], heapD[p]];
      [heapI[p], heapI[c]] = [heapI[c], heapI[p]];
      c = p;
    }
  };
  const pop = () => {
    const topD = heapD[0];
    const topI = heapI[0];
    const lastD = heapD.pop();
    const lastI = heapI.pop();
    if (heapD.length) {
      heapD[0] = lastD;
      heapI[0] = lastI;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let s = p;
        if (l < heapD.length && heapD[l] < heapD[s]) s = l;
        if (r < heapD.length && heapD[r] < heapD[s]) s = r;
        if (s === p) break;
        [heapD[p], heapD[s]] = [heapD[s], heapD[p]];
        [heapI[p], heapI[s]] = [heapI[s], heapI[p]];
        p = s;
      }
    }
    return [topD, topI];
  };

  while (heapD.length) {
    const [d, idx] = pop();
    if (d > dist[idx]) continue;
    const cx = idx % GRID;
    const cy = (idx / GRID) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= GRID) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        if (nx < 0 || nx >= GRID) continue;
        const ni = ny * GRID + nx;
        if (!grid[ni]) continue;
        // No cutting a corner that both orthogonal neighbours block.
        if (dx !== 0 && dy !== 0) {
          if (!grid[cy * GRID + nx] && !grid[ny * GRID + cx]) continue;
        }
        const step = dx !== 0 && dy !== 0 ? SQRT2 : 1;
        const nd = d + step;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          push(nd, ni);
        }
      }
    }
  }
  return dist;
}

/**
 * @typedef {object} PathField
 * @property {(wx: number, wy: number) => number|null} distanceTo world units on
 *   foot from the target, or null when the point is not reachable on the
 *   lattice and the caller should fall back to the straight line.
 */

/**
 * A walking-distance field radiating from one world point.
 *
 * Cached by map and target cell, so every snapshot in a round shares the one
 * sweep for that round's plant, and the two bombsite centres are swept once for
 * the whole extraction.
 *
 * @param {string} mapCode
 * @param {number} tx target world x
 * @param {number} ty target world y
 * @returns {PathField|null} null when the map has no baked walkable mask
 */
export function pathDistanceField(mapCode, tx, ty) {
  const grid = walkableGrid(mapCode);
  if (!grid) return null;

  const px = worldToRadar(mapCode, tx, ty);
  const gx = (px.x / CELL_PIXELS) | 0;
  const gy = (px.y / CELL_PIXELS) | 0;
  const key = `${mapCode}:${gx}:${gy}`;

  let entry = fieldCache.get(key);
  if (!entry) {
    const start = snapToWalkable(grid, gx, gy);
    entry = {
      field: sweep(grid, start),
      // One orthogonal step is CELL_PIXELS radar pixels, and the calibration
      // says how many world units a pixel is.
      unit: calibrationFor(mapCode).scale * CELL_PIXELS,
      tx,
      ty
    };
    if (fieldCache.size >= CACHE_LIMIT) fieldCache.delete(fieldCache.keys().next().value);
    fieldCache.set(key, entry);
  }

  return {
    distanceTo(wx, wy) {
      const p = worldToRadar(mapCode, wx, wy);
      let cx = (p.x / CELL_PIXELS) | 0;
      let cy = (p.y / CELL_PIXELS) | 0;
      if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return null;
      let d = entry.field[cy * GRID + cx];
      if (!Number.isFinite(d)) {
        // Standing somewhere the mask calls a wall (a boost, a doorway the
        // luminance test lost). Take the nearest cell that is walkable rather
        // than declaring the player unreachable.
        const snapped = snapToWalkable(grid, cx, cy, 3);
        if (snapped < 0) return null;
        d = entry.field[snapped];
        if (!Number.isFinite(d)) return null;
      }
      return d * entry.unit;
    }
  };
}

/** Drop every cached lattice and field. Test hook. */
export function clearPathDistanceCache() {
  gridCache.clear();
  fieldCache.clear();
}
