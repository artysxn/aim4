// ---------------------------------------------------------------------------
// Stacked-map floor levels (Nuke upper / lower).
//
// Maps with calibration.lowerZ split painted geometry by floor. Untagged
// legacy pieces count as upper (`default`). Maps without a Z split ignore
// level and treat every piece as active.
// ---------------------------------------------------------------------------

import { calibrationFor, isLowerLevel } from '../viewer/mapCalibration.js';

/** @typedef {'default'|'lower'} RegionLevel */

export function cleanRegionLevel(raw) {
  return raw === 'lower' ? 'lower' : 'default';
}

/** True when the map has a lowerZ split (Nuke). */
export function mapHasStackedFloors(mapCode) {
  return calibrationFor(mapCode).lowerZ !== undefined;
}

/** Floor for a world Z on a stacked map; always `default` elsewhere. */
export function regionLevelForZ(mapCode, z) {
  if (!mapHasStackedFloors(mapCode)) return 'default';
  return isLowerLevel(mapCode, z) ? 'lower' : 'default';
}

/**
 * Keep pieces that belong on `level`. On non-stacked maps, returns all pieces.
 * @param {Array<{ level?: string }>|null|undefined} pieces
 * @param {RegionLevel|string} level
 * @param {string} [mapCode]
 */
export function filterPiecesByLevel(pieces, level, mapCode = '') {
  const list = Array.isArray(pieces) ? pieces : [];
  if (!mapCode || !mapHasStackedFloors(mapCode)) return list;
  const want = cleanRegionLevel(level);
  return list.filter((p) => cleanRegionLevel(p?.level) === want);
}

/** Tag a piece with a floor level (mutates a shallow copy). */
export function withPieceLevel(piece, level) {
  if (!piece || typeof piece !== 'object') return piece;
  return { ...piece, level: cleanRegionLevel(level) };
}
