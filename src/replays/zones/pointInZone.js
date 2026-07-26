// ---------------------------------------------------------------------------
// replays/zones/pointInZone.js
// Membership test: player world (x, y) → position name(s) for a map's network.
// ---------------------------------------------------------------------------

import { pointInPiece } from './zoneGeom.js';

/**
 * @param {number} x  world X (tick state)
 * @param {number} y  world Y
 * @param {{ zones?: Array<{ id?: string, name: string, hidden?: boolean, pieces?: Array }> }} network
 * @returns {string[]} position names containing the point (usually 0 or 1)
 */
export function zonesAtPoint(x, y, network) {
  return positionsAtPoint(x, y, network).map((z) => z.name);
}

/** Position records containing the world point (topmost last drawn ≈ last in list). */
export function positionsAtPoint(x, y, network) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !network?.zones?.length) return [];
  const hit = [];
  for (const z of network.zones) {
    if (z.hidden || !z.pieces?.length) continue;
    for (const p of z.pieces) {
      if (pointInPiece(x, y, p)) {
        hit.push(z);
        break;
      }
    }
  }
  return hit;
}

/** First matching position name, or null. */
export function zoneAtPoint(x, y, network) {
  const names = zonesAtPoint(x, y, network);
  return names[0] || null;
}
