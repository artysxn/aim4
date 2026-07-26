// ---------------------------------------------------------------------------
// replays/zones/zoneModel.js
// Named zone network helpers: colors, merge-by-name, overlap carve.
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

/** @typedef {'zone'|'section'} ColorMode */

export function emptyNetwork(map) {
  return { map, zones: [], sections: [], colorMode: 'zone', updatedAt: 0 };
}

/**
 * Named group of zone ids (e.g. Banana = top banana + logs + …).
 * @param {object} network
 * @param {string} name
 * @param {string[]} [zoneIds]
 */
export function addSection(network, name, zoneIds = []) {
  if (!Array.isArray(network.sections)) network.sections = [];
  const label = String(name || '').trim() || 'Section';
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

function normalizeHex(color) {
  const s = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const [, a, b, c] = s;
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  return '';
}

/**
 * Paint color for a zone under the network's color mode.
 * Group mode: selected section wins if the zone is in it, else first section.
 */
export function displayColorForZone(network, zone, { preferSectionId = null } = {}) {
  if (!zone) return PALETTE[0];
  const mode = network?.colorMode === 'section' ? 'section' : 'zone';
  if (mode === 'section') {
    const sections = network.sections || [];
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
}

export function renameSection(network, sectionId, newName) {
  const section = network.sections?.find((s) => s.id === sectionId);
  if (!section) return;
  section.name = String(newName || '').trim() || section.name;
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

export function findZoneByName(network, name) {
  const key = String(name || '').trim().toLowerCase();
  return network.zones.find((z) => z.name.trim().toLowerCase() === key) || null;
}

/**
 * Zones whose pieces overlap the candidate rect (world), excluding same name
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
        area += 1; // treat poly overlap as conflicting
      }
    }
    if (area > 1e-3) hits.push({ zone: z, area });
  }
  hits.sort((a, b) => b.area - a.area);
  return hits;
}

/**
 * Add a world rect under `name`. Same name merges into that zone.
 * Caller must resolve foreign overlaps first (carve losers).
 */
export function addRectToNetwork(network, name, worldRect) {
  const label = String(name || '').trim() || 'Zone';
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
  } else {
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

/** Carve `cutter` out of every zone except the keeper (by id). */
export function carveRectFromOthers(network, cutter, keepZoneId) {
  for (const z of network.zones) {
    if (z.id === keepZoneId) continue;
    z.pieces = subtractRectFromPieces(z.pieces || [], cutter);
  }
  network.zones = network.zones.filter((z) => (z.pieces || []).length > 0);
  pruneSectionZoneIds(network);
}

export function renameZone(network, zoneId, newName) {
  const zone = network.zones.find((z) => z.id === zoneId);
  if (!zone) return;
  const label = String(newName || '').trim() || zone.name;
  const existing = findZoneByName(network, label);
  if (existing && existing.id !== zone.id) {
    // Merge into existing same-name zone; retarget section membership.
    existing.pieces.push(...(zone.pieces || []));
    existing.color = colorForName(existing.name);
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
}

/** Radar-space drag → world rect via radarToWorld corners. */
export function worldRectFromRadarDrag(mapCode, radarToWorld, rx0, ry0, rx1, ry1) {
  const a = radarToWorld(mapCode, rx0, ry0, {});
  const b = radarToWorld(mapCode, rx1, ry1, {});
  return normalizeRect(a.x, a.y, b.x, b.y);
}
