// ---------------------------------------------------------------------------
// replays/zones/zoneModel.js
// Position / zone / area network helpers: colors, merge-by-name, overlap carve.
// JSON: `zones` = positions, `sections` = zones, `areas` = areas (zone groups).
// ---------------------------------------------------------------------------

import {
  boundsOverlap,
  normalizeRect,
  pieceBounds,
  rectIntersectionArea,
  rectsOverlap,
  subtractRectFromPieces
} from './zoneGeom.js';

const PALETTE = [
  '#5b9fd4',
  '#e8b84a',
  '#7bc96f',
  '#d47bb8',
  '#e8913c',
  '#6ec6c6',
  '#c47bff',
  '#e2622a',
  '#8fc4ef',
  '#f5d27a'
];

export function colorForName(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function newZoneId() {
  return `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newSectionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newAreaId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** @typedef {'zone'|'section'|'area'} ColorMode */

export function emptyNetwork(map) {
  return { map, zones: [], sections: [], areas: [], colorMode: 'zone', updatedAt: 0 };
}

function normalizeHex(color) {
  const s = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const [, a, b, c] = s;
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  return '';
}

export function normalizeColorMode(mode) {
  if (mode === 'section' || mode === 'area') return mode;
  return 'zone';
}

/**
 * Named zone grouping position ids (e.g. Banana = top banana + logs + …).
 */
export function addSection(network, name, zoneIds = []) {
  if (!Array.isArray(network.sections)) network.sections = [];
  const label = String(name || '').trim() || 'Zone';
  const existing = network.sections.find(
    (s) => s.name.trim().toLowerCase() === label.toLowerCase()
  );
  if (existing) return existing;
  const section = {
    id: newSectionId(),
    name: label,
    color: colorForName(label),
    zoneIds: [...new Set((zoneIds || []).map(String).filter(Boolean))]
  };
  network.sections.push(section);
  return section;
}

/**
 * Named area grouping zone (section) ids (e.g. A site = banana + apps + …).
 */
export function addArea(network, name, sectionIds = []) {
  if (!Array.isArray(network.areas)) network.areas = [];
  const label = String(name || '').trim() || 'Area';
  const existing = network.areas.find(
    (a) => a.name.trim().toLowerCase() === label.toLowerCase()
  );
  if (existing) return existing;
  const area = {
    id: newAreaId(),
    name: label,
    color: colorForName(label),
    sectionIds: [...new Set((sectionIds || []).map(String).filter(Boolean))]
  };
  network.areas.push(area);
  return area;
}

export function setZoneColor(network, zoneId, color) {
  const zone = network.zones.find((z) => z.id === zoneId);
  if (!zone) return;
  const hex = normalizeHex(color);
  if (hex) zone.color = hex;
}

export function setSectionColor(network, sectionId, color) {
  const section = network.sections?.find((s) => s.id === sectionId);
  if (!section) return;
  const hex = normalizeHex(color);
  if (hex) section.color = hex;
}

export function setAreaColor(network, areaId, color) {
  const area = network.areas?.find((a) => a.id === areaId);
  if (!area) return;
  const hex = normalizeHex(color);
  if (hex) area.color = hex;
}

/**
 * Paint color for a position under the network's color mode.
 */
export function displayColorForZone(
  network,
  zone,
  { preferSectionId = null, preferAreaId = null } = {}
) {
  if (!zone) return PALETTE[0];
  const mode = normalizeColorMode(network?.colorMode);
  const sections = network.sections || [];

  if (mode === 'area') {
    const areas = network.areas || [];
    const inArea = (area) =>
      (area.sectionIds || []).some((sid) => {
        const sec = sections.find((s) => s.id === sid);
        return sec?.zoneIds?.includes(zone.id);
      });
    if (preferAreaId) {
      const pref = areas.find((a) => a.id === preferAreaId);
      if (pref && inArea(pref)) return pref.color || colorForName(pref.name);
    }
    const area = areas.find(inArea);
    if (area) return area.color || colorForName(area.name);
  }

  if (mode === 'section') {
    if (preferSectionId) {
      const pref = sections.find((s) => s.id === preferSectionId);
      if (pref?.zoneIds?.includes(zone.id)) {
        return pref.color || colorForName(pref.name);
      }
    }
    const sec = sections.find((s) => s.zoneIds?.includes(zone.id));
    if (sec) return sec.color || colorForName(sec.name);
  }

  return zone.color || colorForName(zone.name);
}

export function deleteSection(network, sectionId) {
  if (!Array.isArray(network.sections)) return;
  network.sections = network.sections.filter((s) => s.id !== sectionId);
  pruneAreaSectionIds(network);
}

export function deleteArea(network, areaId) {
  if (!Array.isArray(network.areas)) return;
  network.areas = network.areas.filter((a) => a.id !== areaId);
}

export function renameSection(network, sectionId, newName) {
  const section = network.sections?.find((s) => s.id === sectionId);
  if (!section) return;
  section.name = String(newName || '').trim() || section.name;
}

export function renameArea(network, areaId, newName) {
  const area = network.areas?.find((a) => a.id === areaId);
  if (!area) return;
  area.name = String(newName || '').trim() || area.name;
}

export function addZoneToSection(network, sectionId, zoneId) {
  const section = network.sections?.find((s) => s.id === sectionId);
  if (!section || !zoneId) return;
  if (!Array.isArray(section.zoneIds)) section.zoneIds = [];
  if (!section.zoneIds.includes(zoneId)) section.zoneIds.push(zoneId);
}

export function removeZoneFromSection(network, sectionId, zoneId) {
  const section = network.sections?.find((s) => s.id === sectionId);
  if (!section?.zoneIds) return;
  section.zoneIds = section.zoneIds.filter((id) => id !== zoneId);
}

export function addSectionToArea(network, areaId, sectionId) {
  const area = network.areas?.find((a) => a.id === areaId);
  if (!area || !sectionId) return;
  if (!Array.isArray(area.sectionIds)) area.sectionIds = [];
  if (!area.sectionIds.includes(sectionId)) area.sectionIds.push(sectionId);
}

export function removeSectionFromArea(network, areaId, sectionId) {
  const area = network.areas?.find((a) => a.id === areaId);
  if (!area?.sectionIds) return;
  area.sectionIds = area.sectionIds.filter((id) => id !== sectionId);
}

export function findZoneByName(network, name) {
  const key = String(name || '').trim().toLowerCase();
  return network.zones.find((z) => z.name.trim().toLowerCase() === key) || null;
}

/**
 * Positions whose pieces overlap the candidate rect (world), excluding same name
 * when `ignoreSameName` is true.
 */
export function overlappingZones(network, rectPiece, { ignoreSameName = '', skipHidden = true } = {}) {
  const ignore = String(ignoreSameName || '').trim().toLowerCase();
  const rb = {
    minX: rectPiece.x,
    minY: rectPiece.y,
    maxX: rectPiece.x + rectPiece.w,
    maxY: rectPiece.y + rectPiece.h
  };
  const hits = [];
  for (const z of network.zones) {
    if (skipHidden && z.hidden) continue;
    if (ignore && z.name.trim().toLowerCase() === ignore) continue;
    let area = 0;
    for (const p of z.pieces || []) {
      if (p.type === 'rect') {
        if (rectsOverlap(rectPiece, p)) area += rectIntersectionArea(rectPiece, p);
      } else if (boundsOverlap(rb, pieceBounds(p))) {
        area += 1;
      }
    }
    if (area > 1e-3) hits.push({ zone: z, area });
  }
  hits.sort((a, b) => b.area - a.area);
  return hits;
}

/**
 * Add a world rect under `name`. Same name merges into that position.
 * Caller must resolve foreign overlaps first (carve losers).
 */
export function addRectToNetwork(network, name, worldRect) {
  const label = String(name || '').trim() || 'Position';
  let zone = findZoneByName(network, label);
  if (!zone) {
    zone = {
      id: newZoneId(),
      name: label,
      color: colorForName(label),
      hidden: false,
      pieces: []
    };
    network.zones.push(zone);
  } else if (!zone.color) {
    zone.color = colorForName(zone.name);
  }
  zone.pieces.push({ ...worldRect, type: 'rect' });
  return zone;
}

function pruneSectionZoneIds(network) {
  if (!Array.isArray(network.sections)) return;
  const ids = new Set((network.zones || []).map((z) => z.id));
  for (const s of network.sections) {
    if (!Array.isArray(s.zoneIds)) continue;
    s.zoneIds = s.zoneIds.filter((id) => ids.has(id));
  }
}

function pruneAreaSectionIds(network) {
  if (!Array.isArray(network.areas)) return;
  const ids = new Set((network.sections || []).map((s) => s.id));
  for (const a of network.areas) {
    if (!Array.isArray(a.sectionIds)) continue;
    a.sectionIds = a.sectionIds.filter((id) => ids.has(id));
  }
}

/** Carve `cutter` out of every position except the keeper (by id). */
export function carveRectFromOthers(network, cutter, keepZoneId) {
  for (const z of network.zones) {
    if (z.id === keepZoneId) continue;
    z.pieces = subtractRectFromPieces(z.pieces || [], cutter);
  }
  network.zones = network.zones.filter((z) => (z.pieces || []).length > 0);
  pruneSectionZoneIds(network);
  pruneAreaSectionIds(network);
}

export function renameZone(network, zoneId, newName) {
  const zone = network.zones.find((z) => z.id === zoneId);
  if (!zone) return;
  const label = String(newName || '').trim() || zone.name;
  const existing = findZoneByName(network, label);
  if (existing && existing.id !== zone.id) {
    existing.pieces.push(...(zone.pieces || []));
    if (!existing.color) existing.color = colorForName(existing.name);
    if (Array.isArray(network.sections)) {
      for (const s of network.sections) {
        if (!Array.isArray(s.zoneIds)) continue;
        s.zoneIds = s.zoneIds.map((id) => (id === zone.id ? existing.id : id));
        s.zoneIds = [...new Set(s.zoneIds)];
      }
    }
    network.zones = network.zones.filter((z) => z.id !== zone.id);
  } else {
    zone.name = label;
    if (!zone.color) zone.color = colorForName(label);
  }
}

export function deleteZone(network, zoneId) {
  network.zones = network.zones.filter((z) => z.id !== zoneId);
  pruneSectionZoneIds(network);
  pruneAreaSectionIds(network);
}

/** Radar-space drag → world rect via radarToWorld corners. */
export function worldRectFromRadarDrag(mapCode, radarToWorld, rx0, ry0, rx1, ry1) {
  const a = radarToWorld(mapCode, rx0, ry0, {});
  const b = radarToWorld(mapCode, rx1, ry1, {});
  return normalizeRect(a.x, a.y, b.x, b.y);
}
