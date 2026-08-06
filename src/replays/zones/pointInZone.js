// ---------------------------------------------------------------------------
// replays/zones/pointInZone.js
// Membership test: player world (x, y) → position name(s) for a map's network.
// ---------------------------------------------------------------------------

import { pointInPiece } from './zoneGeom.js';

/**
 * @param {number} x  world X (tick state)
 * @param {number} y  world Y
 * @param {{ positions?: Array, zones?: Array }} network
 * @param {{ level?: 'default'|'lower'|null }} [opts]
 *   When `level` is set, only positions on that floor match. Omit to match any.
 * @returns {string[]} position names containing the point (usually 0 or 1)
 */
export function zonesAtPoint(x, y, network, opts = {}) {
  return positionsAtPoint(x, y, network, opts).map((z) => z.name);
}

/**
 * Position records containing the world point.
 * Prefers `network.positions`; falls back to legacy `network.zones` with pieces.
 */
export function positionsAtPoint(x, y, network, opts = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !network) return [];
  const list = Array.isArray(network.positions)
    ? network.positions
    : Array.isArray(network.zones)
      ? network.zones.filter((z) => z?.pieces)
      : [];
  if (!list.length) return [];
  const wantLevel = opts.level === 'lower' || opts.level === 'default' ? opts.level : null;
  const hit = [];
  for (const z of list) {
    if (z.hidden || !z.pieces?.length) continue;
    if (wantLevel && (z.level || 'default') !== wantLevel) continue;
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
export function zoneAtPoint(x, y, network, opts = {}) {
  const names = zonesAtPoint(x, y, network, opts);
  return names[0] || null;
}
