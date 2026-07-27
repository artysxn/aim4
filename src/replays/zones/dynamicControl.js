// ---------------------------------------------------------------------------
 // replays/zones/dynamicControl.js
// Walkable cell grid for map possession (replaces painted positions).
// ---------------------------------------------------------------------------

import { RADAR_SIZE, calibrationFor, worldToRadar } from '../viewer/mapCalibration.js';

/** World-unit edge length of one claim cell. */
export const CELL_WORLD = 16;

/** Soft nearness: claim cells within this world radius of the player's feet. */
export const FOOT_NEAR_WORLD = 48;

/**
 * @typedef {{
 *   mapCode: string,
 *   cell: number,
 *   originX: number,
 *   originY: number,
 *   cols: number,
 *   rows: number,
 *   ids: string[],
 *   ixOf: Int16Array,
 *   iyOf: Int16Array,
 *   area: number,
 *   byKey: Map<string, number>,
 *   idIndex: Map<string, number>
 * }} CellGrid
 */

const gridCache = new Map();

/**
 * Build (or reuse) walkable cells for a map.
 * Requires a walkable LoS mask — at 16uu a full unfiltered grid is ~100k cells.
 * @param {string} mapCode
 * @param {{ isWalkableWorld: (x:number,y:number)=>boolean } | null} [los]
 * @returns {CellGrid | null}
 */
export function getCellGrid(mapCode, los = null) {
  if (!mapCode || !los?.isWalkableWorld) return null;
  const key = mapCode;
  const hit = gridCache.get(key);
  if (hit) return hit;

  const cal = calibrationFor(mapCode);
  const cell = CELL_WORLD;
  const worldW = RADAR_SIZE * cal.scale;
  const worldH = RADAR_SIZE * cal.scale;
  const originX = cal.posX;
  const originY = cal.posY - worldH;
  const cols = Math.ceil(worldW / cell);
  const rows = Math.ceil(worldH / cell);

  /** @type {string[]} */
  const ids = [];
  const ixOf = [];
  const iyOf = [];
  /** @type {Map<string, number>} */
  const byKey = new Map();
  /** @type {Map<string, number>} */
  const idIndex = new Map();

  const scratch = {};
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const cx = originX + (ix + 0.5) * cell;
      const cy = originY + (iy + 0.5) * cell;
      worldToRadar(mapCode, cx, cy, scratch);
      if (scratch.x < 0 || scratch.y < 0 || scratch.x >= RADAR_SIZE || scratch.y >= RADAR_SIZE) {
        continue;
      }
      if (!los.isWalkableWorld(cx, cy)) continue;
      const id = `c${ix}_${iy}`;
      const idx = ids.length;
      ids.push(id);
      ixOf.push(ix);
      iyOf.push(iy);
      byKey.set(`${ix},${iy}`, idx);
      idIndex.set(id, idx);
    }
  }

  if (!ids.length) return null;

  /** @type {CellGrid} */
  const grid = {
    mapCode,
    cell,
    originX,
    originY,
    cols,
    rows,
    ids,
    ixOf: Int16Array.from(ixOf),
    iyOf: Int16Array.from(iyOf),
    area: cell * cell,
    byKey,
    idIndex
  };
  gridCache.set(key, grid);
  return grid;
}

export function clearCellGridCache() {
  gridCache.clear();
}

/** @param {object | null | undefined} network */
export function hasDynamicGrid(network) {
  return Boolean(network?._dynGrid?.ids?.length);
}

/** Cell ids for iteration (dynamic grid or legacy zones). */
export function cellIdsOf(network) {
  if (network?._dynGrid?.ids?.length) return network._dynGrid.ids;
  /** @type {string[]} */
  const out = [];
  for (const z of network?.zones || []) {
    if (z?.id && !z.hidden) out.push(z.id);
  }
  return out;
}

/** @param {CellGrid} grid @param {number} x @param {number} y */
export function cellIndexAt(grid, x, y) {
  if (!grid) return -1;
  const ix = Math.floor((x - grid.originX) / grid.cell);
  const iy = Math.floor((y - grid.originY) / grid.cell);
  if (ix < 0 || iy < 0 || ix >= grid.cols || iy >= grid.rows) return -1;
  const idx = grid.byKey.get(`${ix},${iy}`);
  return idx == null ? -1 : idx;
}

/** @param {CellGrid} grid @param {number} x @param {number} y */
export function cellIdAt(grid, x, y) {
  const i = cellIndexAt(grid, x, y);
  return i < 0 ? null : grid.ids[i];
}

/**
 * Cell ids under a world point plus soft nearness.
 * @param {CellGrid} grid
 * @param {number} x
 * @param {number} y
 * @param {number} [radius]
 * @param {Set<string>} [into]  optional set to fill (avoids array alloc)
 * @returns {string[]|Set<string>}
 */
export function cellsNear(grid, x, y, radius = FOOT_NEAR_WORLD, into = null) {
  const out = into || [];
  const asSet = into instanceof Set;
  if (!grid) return out;
  const r = Math.max(0, radius);
  const ix0 = Math.floor((x - r - grid.originX) / grid.cell);
  const ix1 = Math.floor((x + r - grid.originX) / grid.cell);
  const iy0 = Math.floor((y - r - grid.originY) / grid.cell);
  const iy1 = Math.floor((y + r - grid.originY) / grid.cell);
  const r2 = r * r;
  const underIdx = cellIndexAt(grid, x, y);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const idx = grid.byKey.get(`${ix},${iy}`);
      if (idx == null) continue;
      const cx = grid.originX + (ix + 0.5) * grid.cell;
      const cy = grid.originY + (iy + 0.5) * grid.cell;
      const dx = cx - x;
      const dy = cy - y;
      if (dx * dx + dy * dy <= r2 || underIdx === idx) {
        const id = grid.ids[idx];
        if (asSet) /** @type {Set<string>} */ (out).add(id);
        else /** @type {string[]} */ (out).push(id);
      }
    }
  }
  if (underIdx >= 0) {
    const under = grid.ids[underIdx];
    if (asSet) /** @type {Set<string>} */ (out).add(under);
    else if (!/** @type {string[]} */ (out).includes(under)) {
      /** @type {string[]} */ (out).push(under);
    }
  }
  return out;
}

/** World rect for a cell by index. */
export function cellWorldRectAt(grid, idx) {
  if (!grid || idx < 0 || idx >= grid.ids.length) return null;
  const ix = grid.ixOf[idx];
  const iy = grid.iyOf[idx];
  return {
    type: 'rect',
    x: grid.originX + ix * grid.cell,
    y: grid.originY + iy * grid.cell,
    w: grid.cell,
    h: grid.cell
  };
}

/** World rect for a cell id. */
export function cellWorldRect(grid, cellId) {
  if (!grid || !cellId) return null;
  const idx = grid.ids.indexOf(cellId);
  return cellWorldRectAt(grid, idx);
}

/** Area map for controlShares / summarize. */
export function cellAreas(grid) {
  /** @type {Map<string, number>} */
  const map = new Map();
  if (!grid) return map;
  for (const id of grid.ids) map.set(id, grid.area);
  return map;
}

/**
 * Attach dynamic grid onto a slim network — no materialized zones[] array.
 * @param {object} network
 * @param {CellGrid | null} grid
 */
export function ensureDynamicZones(network, grid) {
  if (!network || !grid) return network;
  if (network._dynGrid === grid && network._areaCache instanceof Map) {
    return network;
  }
  network._dynGrid = grid;
  // Keep zones empty: paint/draw/claims use _dynGrid + _areaCache.
  network.zones = [];
  network._areaCache = cellAreas(grid);
  return network;
}
