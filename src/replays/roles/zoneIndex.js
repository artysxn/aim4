// ---------------------------------------------------------------------------
// Lookup tables: position → sections → areas for occupancy classification.
// ---------------------------------------------------------------------------

import { positionsAtPoint } from '../zones/pointInZone.js';
import { keysForName } from './regionKeys.js';

/**
 * @param {{ zones?: Array, sections?: Array, areas?: Array }} network
 */
export function buildZoneIndex(network) {
  const sections = network?.sections || [];
  const areas = network?.areas || [];
  /** @type {Map<string, object[]>} positionId → sections */
  const sectionsByZoneId = new Map();
  for (const sec of sections) {
    for (const zid of sec.zoneIds || []) {
      if (!sectionsByZoneId.has(zid)) sectionsByZoneId.set(zid, []);
      sectionsByZoneId.get(zid).push(sec);
    }
  }
  /** @type {Map<string, object[]>} sectionId → areas */
  const areasBySectionId = new Map();
  for (const area of areas) {
    for (const sid of area.sectionIds || []) {
      if (!areasBySectionId.has(sid)) areasBySectionId.set(sid, []);
      areasBySectionId.get(sid).push(area);
    }
  }
  return { network, sectionsByZoneId, areasBySectionId };
}

/**
 * Region storage keys for a world point (areas + sections).
 * @returns {Set<string>}
 */
export function regionKeysAt(x, y, zIndex) {
  const keys = new Set();
  if (!zIndex?.network) return keys;
  const hits = positionsAtPoint(x, y, zIndex.network);
  for (const pos of hits) {
    const secs = zIndex.sectionsByZoneId.get(pos.id) || [];
    for (const sec of secs) {
      for (const k of keysForName('zone', sec.name)) keys.add(k);
      const ars = zIndex.areasBySectionId.get(sec.id) || [];
      for (const area of ars) {
        for (const k of keysForName('area', area.name)) keys.add(k);
      }
    }
    // Also match bare position names (editor labels sometimes equal zone names).
    for (const k of keysForName('zone', pos.name)) keys.add(k);
    for (const k of keysForName('area', pos.name)) keys.add(k);
  }
  return keys;
}

/**
 * Position / section / area entity ids covering a world point.
 * @returns {{ positionIds: string[], sectionIds: string[], areaIds: string[] }}
 */
export function occupancyAt(x, y, zIndex) {
  const positionIds = [];
  const sectionIds = [];
  const areaIds = [];
  if (!zIndex?.network) return { positionIds, sectionIds, areaIds };
  const hits = positionsAtPoint(x, y, zIndex.network);
  const seenSec = new Set();
  const seenArea = new Set();
  for (const pos of hits) {
    if (pos.id) positionIds.push(pos.id);
    const secs = zIndex.sectionsByZoneId.get(pos.id) || [];
    for (const sec of secs) {
      if (!sec.id || seenSec.has(sec.id)) continue;
      seenSec.add(sec.id);
      sectionIds.push(sec.id);
      const ars = zIndex.areasBySectionId.get(sec.id) || [];
      for (const area of ars) {
        if (!area.id || seenArea.has(area.id)) continue;
        seenArea.add(area.id);
        areaIds.push(area.id);
      }
    }
  }
  return { positionIds, sectionIds, areaIds };
}

/** Id with the highest sample count (first max wins ties). */
export function argmaxCount(counts) {
  let best = '';
  let bestN = 0;
  for (const [id, n] of Object.entries(counts || {})) {
    if (!id || n <= bestN) continue;
    best = id;
    bestN = n;
  }
  return best;
}
