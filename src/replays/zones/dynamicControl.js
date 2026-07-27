// ---------------------------------------------------------------------------
// replays/zones/dynamicControl.js
// Walkable cell grid for map possession (replaces painted positions).
// ---------------------------------------------------------------------------

import { RADAR_SIZE, calibrationFor, radarToWorld, worldToRadar } from '../viewer/mapCalibration.js';

/** World-unit edge length of one claim cell. */
export const CELL_WORLD = 160;

/** Soft nearness: claim cells within this world radius of the player's feet. */
export const FOOT_NEAR_WORLD = 120;

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
 *   byKey: Map<string, number>
 * }} CellGrid
 */

const gridCache = new Map();

/**
 * Build (or reuse) walkable cells for a map.
 * @param {string} mapCode
 * @param {{ isWalkableWorld: (x:number,y:number)=>boolean } | null} [los]
 * @returns {CellGrid | null}
 */
export function getCellGrid(mapCode, los = null) {
  if (!mapCode) return null;
  const key = los ? mapCode : `${mapCode}:full`;
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

  const scratch = {};
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const cx = originX + (ix + 0.5) * cell;
      const cy = originY + (iy + 0.5) * cell;
      worldToRadar(mapCode, cx, cy, scratch);
      if (scratch.x < 0 || scratch.y < 0 || scratch.x >= RADAR_SIZE || scratch.y >= RADAR_SIZE) {
        continue;
      }
      if (los?.isWalkableWorld && !los.isWalkableWorld(cx, cy)) continue;
      const id = `c${ix}_${iy}`;
      const idx = ids.length;
      ids.push(id);
      ixOf.push(ix);
      iyOf.push(iy);
      byKey.set(`${ix},${iy}`, idx);
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
    byKey
  };
  gridCache.set(key, grid);
  return grid;
}

export function clearCellGridCache() {
  gridCache.clear();
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
 * Cell ids under a world point plus soft nearness (Chebyshev-ish ring).
 * @param {CellGrid} grid
 * @param {number} x
 * @param {number} y
 * @param {number} [radius]
 * @returns {string[]}
 */
export function cellsNear(grid, x, y, radius = FOOT_NEAR_WORLD) {
  if (!grid) return [];
  const r = Math.max(0, radius);
  const ix0 = Math.floor((x - r - grid.originX) / grid.cell);
  const ix1 = Math.floor((x + r - grid.originX) / grid.cell);
  const iy0 = Math.floor((y - r - grid.originY) / grid.cell);
  const iy1 = Math.floor((y + r - grid.originY) / grid.cell);
  const out = [];
  const r2 = r * r;
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const idx = grid.byKey.get(`${ix},${iy}`);
      if (idx == null) continue;
      const cx = grid.originX + (ix + 0.5) * grid.cell;
      const cy = grid.originY + (iy + 0.5) * grid.cell;
      const dx = cx - x;
      const dy = cy - y;
      if (dx * dx + dy * dy <= r2 || cellIndexAt(grid, x, y) === idx) {
        out.push(grid.ids[idx]);
      }
    }
  }
  // Always include the cell under the feet when walkable.
  const under = cellIdAt(grid, x, y);
  if (under && !out.includes(under)) out.push(under);
  return out;
}

/** World rect for a cell id. */
export function cellWorldRect(grid, cellId) {
  if (!grid || !cellId) return null;
  const idx = grid.ids.indexOf(cellId);
  if (idx < 0) return null;
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

/** Area map for controlShares / summarize. */
export function cellAreas(grid) {
  /** @type {Map<string, number>} */
  const map = new Map();
  if (!grid) return map;
  for (const id of grid.ids) map.set(id, grid.area);
  return map;
}

/**
 * Synthetic zones list so overlay/summarize can iterate cells like positions.
 * @param {CellGrid} grid
 */
export function cellsAsZones(grid) {
  if (!grid) return [];
  return grid.ids.map((id, i) => {
    const ix = grid.ixOf[i];
    const iy = grid.iyOf[i];
    return {
      id,
      name: id,
      hidden: false,
      pieces: [
        {
          type: 'rect',
          x: grid.originX + ix * grid.cell,
          y: grid.originY + iy * grid.cell,
          w: grid.cell,
          h: grid.cell
        }
      ]
    };
  });
}

/**
 * Attach dynamic cell proxies onto a slim network for claim/paint code paths.
 * @param {object} network
 * @param {CellGrid | null} grid
 */
export function ensureDynamicZones(network, grid) {
  if (!network || !grid) return network;
  if (network._dynGrid === grid && Array.isArray(network.zones) && network.zones.length) {
    return network;
  }
  network._dynGrid = grid;
  network.zones = cellsAsZones(grid);
  network._areaCache = cellAreas(grid);
  return network;
}
