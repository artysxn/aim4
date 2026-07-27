// ---------------------------------------------------------------------------
// replays/zones/zoneModel.js
// Slim map network: bombsites + vision layers. Hierarchy helpers removed.
// ---------------------------------------------------------------------------

import { normalizeRect } from './zoneGeom.js';

export function emptyNetwork(map) {
  return {
    map,
    visionBlocks: [],
    elevated: [],
    bombSites: { a: null, b: null },
    keyZones: { a: [], b: [] },
    updatedAt: 0
  };
}

/**
 * @deprecated Painted position networks are gone. Always false.
 * Use hasBombSites() / dynamic control instead.
 */
export function isZoneNetworkReady(_network) {
  return false;
}

/** World rect from a radar drag (bomb-site / key-zone tool). */
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
