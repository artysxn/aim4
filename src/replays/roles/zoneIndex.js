// ---------------------------------------------------------------------------
// Lookup tables: position → zone → area for occupancy classification.
// ---------------------------------------------------------------------------

import { positionsAtPoint } from '../zones/pointInZone.js';
import { keysForName } from './regionKeys.js';

/**
 * @param {{ positions?: Array, zones?: Array, areas?: Array, sections?: Array }} network
 */
export function buildZoneIndex(network) {
  // Modern: zones group positionIds. Legacy: sections grouped zoneIds (old
  // "positions" stored as zones with pieces).
  const zones =
    Array.isArray(network?.zones) && network.zones[0] && !network.zones[0].pieces
      ? network.zones
      : Array.isArray(network?.sections)
        ? network.sections.map((s) => ({
            ...s,
            positionIds: s.positionIds || s.zoneIds || []
          }))
        : [];
  const areas = (network?.areas || []).map((a) => ({
    ...a,
    zoneIds: a.zoneIds || a.sectionIds || []
  }));

  /** @type {Map<string, object[]>} positionId → zones */
  const zonesByPositionId = new Map();
  for (const zone of zones) {
    for (const pid of zone.positionIds || zone.zoneIds || []) {
      if (!zonesByPositionId.has(pid)) zonesByPositionId.set(pid, []);
      zonesByPositionId.get(pid).push(zone);
    }
  }
  /** @type {Map<string, object[]>} zoneId → areas */
  const areasByZoneId = new Map();
  for (const area of areas) {
    for (const zid of area.zoneIds || []) {
      if (!areasByZoneId.has(zid)) areasByZoneId.set(zid, []);
      areasByZoneId.get(zid).push(area);
    }
  }
  return {
    network,
    /** @deprecated alias */
    sectionsByZoneId: zonesByPositionId,
    zonesByPositionId,
    areasBySectionId: areasByZoneId,
    areasByZoneId
  };
}

/**
 * Region storage keys for a world point (areas + zones).
 * @returns {Set<string>}
 */
export function regionKeysAt(x, y, zIndex) {
  const keys = new Set();
  if (!zIndex?.network) return keys;
  const hits = positionsAtPoint(x, y, zIndex.network);
  for (const pos of hits) {
    const zones = zIndex.zonesByPositionId?.get(pos.id) || zIndex.sectionsByZoneId?.get(pos.id) || [];
    for (const zone of zones) {
      for (const k of keysForName('zone', zone.name)) keys.add(k);
      const ars = zIndex.areasByZoneId?.get(zone.id) || zIndex.areasBySectionId?.get(zone.id) || [];
      for (const area of ars) {
        for (const k of keysForName('area', area.name)) keys.add(k);
      }
    }
    for (const k of keysForName('zone', pos.name)) keys.add(k);
    for (const k of keysForName('area', pos.name)) keys.add(k);
  }
  return keys;
}

/**
 * Position / zone / area entity ids covering a world point.
 * @returns {{ positionIds: string[], zoneIds: string[], sectionIds: string[], areaIds: string[] }}
 */
export function occupancyAt(x, y, zIndex) {
  const positionIds = [];
  const zoneIds = [];
  const areaIds = [];
  if (!zIndex?.network) return { positionIds, zoneIds, sectionIds: zoneIds, areaIds };
  const hits = positionsAtPoint(x, y, zIndex.network);
  const seenZone = new Set();
  const seenArea = new Set();
  for (const pos of hits) {
    if (pos.id) positionIds.push(pos.id);
    const zones = zIndex.zonesByPositionId?.get(pos.id) || zIndex.sectionsByZoneId?.get(pos.id) || [];
    for (const zone of zones) {
      if (!zone.id || seenZone.has(zone.id)) continue;
      seenZone.add(zone.id);
      zoneIds.push(zone.id);
      const ars = zIndex.areasByZoneId?.get(zone.id) || zIndex.areasBySectionId?.get(zone.id) || [];
      for (const area of ars) {
        if (!area.id || seenArea.has(area.id)) continue;
        seenArea.add(area.id);
        areaIds.push(area.id);
      }
    }
  }
  return { positionIds, zoneIds, sectionIds: zoneIds, areaIds };
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
