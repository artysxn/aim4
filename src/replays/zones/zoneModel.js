// ---------------------------------------------------------------------------
// replays/zones/zoneModel.js
// Map network: bombsites, vision layers, and Positions → Zones → Areas.
// ---------------------------------------------------------------------------

import { normalizeRect } from './zoneGeom.js';
import { ensureRegionHierarchy } from './regionHierarchy.js';

export function emptyNetwork(map) {
  return {
    map,
    visionBlocks: [],
    elevated: [],
    underpasses: [],
    ledges: [],
    bombSites: { a: [], b: [] },
    keyZones: { a: [], b: [] },
    positions: [],
    zones: [],
    areas: [],
    updatedAt: 0
  };
}

/**
 * True when the map has at least one painted position (hierarchy ready).
 */
export function isZoneNetworkReady(network) {
  return Boolean(network?.positions?.length);
}

/** World rect from a radar drag (bomb-site / key-zone / position tool). */
export function worldRectFromRadarDrag(mapCode, radarToWorldFn, x0, y0, x1, y1) {
  const a = radarToWorldFn(mapCode, x0, y0, {});
  const b = radarToWorldFn(mapCode, x1, y1, {});
  return normalizeRect(a.x, a.y, b.x, b.y);
}

/**
 * World polygon from radar-space vertices.
 * @param {string} mapCode
 * @param {Function} radarToWorldFn
 * @param {Array<[number, number]>} radarVerts
 */
export function worldPolyFromRadarVerts(mapCode, radarToWorldFn, radarVerts) {
  const ring = [];
  for (const [rx, ry] of radarVerts || []) {
    const w = radarToWorldFn(mapCode, rx, ry, {});
    if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) continue;
    ring.push([w.x, w.y]);
  }
  return { type: 'poly', ring };
}

export { ensureRegionHierarchy };
