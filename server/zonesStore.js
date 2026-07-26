// ---------------------------------------------------------------------------
// zonesStore.js — CS2 radar position/zone networks per map
//
// Same persistence model as demo round notes: JSON on the Coolify volume that
// backs AIM4_REPLAY_DIR (shared library, no Supabase). Notes live in
// <library>/rounds/*.json; position editor data lives beside that tree at:
//
//   {AIM4_REPLAY_DIR}/zones/<MAP>.json
//
// (`zones` array = positions; `sections` = named zones grouping positions.)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT as REPLAY_ROOT } from './replays/demoStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Prefer AIM4_ZONES_DIR; else sibling of the replay root on the same volume. */
export const ZONES_ROOT =
  process.env.AIM4_ZONES_DIR || path.join(REPLAY_ROOT, 'zones');

/** Pre-migration path (before zones shared the replay volume). */
const LEGACY_DIR = path.join(__dirname, 'data', 'zones');

const MAP_RE = /^[A-Z0-9]{2,4}$/;
const NAME_MAX = 48;
const PIECES_MAX = 400;
const ZONES_MAX = 80;
const SECTIONS_MAX = 40;
const SECTION_ZONES_MAX = 40;
const AREAS_MAX = 40;
const AREA_SECTIONS_MAX = 40;
const LAYER_PIECES_MAX = 5000;

async function ensureDir(dir = ZONES_ROOT) {
  await fsp.mkdir(dir, { recursive: true });
}

function fileFor(map, root = ZONES_ROOT) {
  return path.join(root, `${map}.json`);
}

/** @returns {boolean} */
function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3 || ring.length > 64) return false;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return false;
    if (!Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) return false;
  }
  return true;
}

/** Vision-block / elevated brush pieces (same rect/poly shape as positions). */
function sanitizeLayerPieces(raw) {
  const pieces = [];
  if (!Array.isArray(raw)) return pieces;
  for (const piece of raw.slice(0, LAYER_PIECES_MAX)) {
    if (!piece || typeof piece !== 'object') continue;
    const asRect =
      piece.type === 'rect' ||
      (piece.type == null &&
        Number.isFinite(Number(piece.x)) &&
        Number.isFinite(Number(piece.y)) &&
        Number.isFinite(Number(piece.w)) &&
        Number.isFinite(Number(piece.h)));
    if (asRect) {
      const x = Number(piece.x);
      const y = Number(piece.y);
      const w = Number(piece.w);
      const h = Number(piece.h);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      pieces.push({ type: 'rect', x, y, w, h });
    } else if (piece.type === 'poly' && validRing(piece.ring)) {
      pieces.push({
        type: 'poly',
        ring: piece.ring.map((p) => [Number(p[0]), Number(p[1])])
      });
    }
  }
  return pieces;
}

/** @returns {{ type: 'rect', x: number, y: number, w: number, h: number } | null} */
function sanitizeBombRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { type: 'rect', x, y, w, h };
}

/** @returns {{ a: object | null, b: object | null }} */
function sanitizeBombSites(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    a: sanitizeBombRect(src.a),
    b: sanitizeBombRect(src.b)
  };
}

/**
 * @param {string} map
 * @param {unknown} payload
 * @returns {{ map: string, zones: Array, sections: Array, areas: Array, visionBlocks: Array, elevated: Array, bombSites: { a: object | null, b: object | null }, colorMode: string, updatedAt: number }}
 */
export function sanitizeZones(map, payload) {
  const code = String(map || '').toUpperCase();
  if (!MAP_RE.test(code)) throw new Error('Invalid map code');

  const rawZones = Array.isArray(payload?.zones)
    ? payload.zones
    : Array.isArray(payload)
      ? payload
      : null;
  if (!rawZones) throw new Error('Invalid zones payload');

  const zones = [];
  const zoneIds = new Set();
  for (const z of rawZones.slice(0, ZONES_MAX)) {
    if (!z || typeof z !== 'object') continue;
    const name = String(z.name || '')
      .trim()
      .slice(0, NAME_MAX);
    if (!name) continue;
    const color = String(z.color || '').slice(0, 32);
    const pieces = [];
    for (const piece of Array.isArray(z.pieces) ? z.pieces.slice(0, PIECES_MAX) : []) {
      if (!piece || typeof piece !== 'object') continue;
      const asRect =
        piece.type === 'rect' ||
        // Older drafts sometimes omitted type on axis-aligned squares.
        (piece.type == null &&
          Number.isFinite(Number(piece.x)) &&
          Number.isFinite(Number(piece.y)) &&
          Number.isFinite(Number(piece.w)) &&
          Number.isFinite(Number(piece.h)));
      if (asRect) {
        const x = Number(piece.x);
        const y = Number(piece.y);
        const w = Number(piece.w);
        const h = Number(piece.h);
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
        pieces.push({ type: 'rect', x, y, w, h });
      } else if (piece.type === 'poly' && validRing(piece.ring)) {
        pieces.push({
          type: 'poly',
          ring: piece.ring.map((p) => [Number(p[0]), Number(p[1])])
        });
      }
    }
    if (!pieces.length) continue;
    // Keep stored ids stable so section membership from older saves still matches.
    let id = String(z.id || `z${zones.length}`).slice(0, 40);
    if (zoneIds.has(id)) id = `${id}_${zones.length}`.slice(0, 40);
    zoneIds.add(id);
    zones.push({
      id,
      name,
      color,
      hidden: Boolean(z.hidden),
      pieces
    });
  }

  const sections = [];
  const rawSections = Array.isArray(payload?.sections) ? payload.sections : [];
  for (const s of rawSections.slice(0, SECTIONS_MAX)) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name || '')
      .trim()
      .slice(0, NAME_MAX);
    if (!name) continue;
    const ids = [];
    const seen = new Set();
    for (const raw of Array.isArray(s.zoneIds) ? s.zoneIds.slice(0, SECTION_ZONES_MAX) : []) {
      const id = String(raw || '').slice(0, 40);
      if (!id || !zoneIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const color = String(s.color || '').slice(0, 32);
    const sid = String(s.id || `s${sections.length}`).slice(0, 40);
    sections.push({
      id: sid,
      name,
      color,
      zoneIds: ids
    });
  }

  const sectionIds = new Set(sections.map((s) => s.id));
  const areas = [];
  const rawAreas = Array.isArray(payload?.areas) ? payload.areas : [];
  for (const a of rawAreas.slice(0, AREAS_MAX)) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || '')
      .trim()
      .slice(0, NAME_MAX);
    if (!name) continue;
    const ids = [];
    const seen = new Set();
    for (const raw of Array.isArray(a.sectionIds) ? a.sectionIds.slice(0, AREA_SECTIONS_MAX) : []) {
      const id = String(raw || '').slice(0, 40);
      if (!id || !sectionIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    areas.push({
      id: String(a.id || `a${areas.length}`).slice(0, 40),
      name,
      color: String(a.color || '').slice(0, 32),
      sectionIds: ids
    });
  }

  const colorMode =
    payload?.colorMode === 'section' ||
    payload?.colorMode === 'area' ||
    payload?.colorMode === 'none'
      ? payload.colorMode
      : 'zone';

  return {
    map: code,
    zones,
    sections,
    areas,
    visionBlocks: sanitizeLayerPieces(payload?.visionBlocks),
    elevated: sanitizeLayerPieces(payload?.elevated),
    bombSites: sanitizeBombSites(payload?.bombSites),
    colorMode,
    updatedAt: Number(payload?.updatedAt) || Date.now()
  };
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** One-time copy from server/data/zones → AIM4_REPLAY_DIR/zones when needed. */
async function migrateLegacyIfNeeded(map) {
  const dest = fileFor(map);
  if (fs.existsSync(dest)) return;
  const legacy = fileFor(map, LEGACY_DIR);
  if (!fs.existsSync(legacy)) return;
  await ensureDir();
  await fsp.copyFile(legacy, dest);
}

export async function listZoneMaps() {
  await ensureDir();
  const names = new Set();
  try {
    for (const f of await fsp.readdir(ZONES_ROOT)) {
      if (f.endsWith('.json')) names.add(f.replace(/\.json$/i, ''));
    }
  } catch {
    /* empty */
  }
  try {
    if (fs.existsSync(LEGACY_DIR)) {
      for (const f of await fsp.readdir(LEGACY_DIR)) {
        if (f.endsWith('.json')) names.add(f.replace(/\.json$/i, ''));
      }
    }
  } catch {
    /* empty */
  }
  return [...names].sort();
}

export async function getZones(map) {
  const code = String(map || '').toUpperCase();
  if (!MAP_RE.test(code)) return null;
  await migrateLegacyIfNeeded(code);
  const data = await readJsonFile(fileFor(code));
  if (!data) {
    return {
      map: code,
      zones: [],
      sections: [],
      areas: [],
      visionBlocks: [],
      elevated: [],
      bombSites: { a: null, b: null },
      colorMode: 'zone',
      updatedAt: 0
    };
  }
  try {
    // Read-only: never rewrite the file on GET. Missing sections/areas/colorMode
    // become empty defaults in memory; existing polygons keep their ids/names.
    return sanitizeZones(code, data);
  } catch {
    // Last resort — still try not to blank a map the user already drew.
    try {
      return sanitizeZones(code, { zones: Array.isArray(data.zones) ? data.zones : [] });
    } catch {
      return {
        map: code,
        zones: [],
        sections: [],
        areas: [],
        visionBlocks: [],
        elevated: [],
        bombSites: { a: null, b: null },
        colorMode: 'zone',
        updatedAt: 0
      };
    }
  }
}

/**
 * Persist a network. Fields omitted by older clients are filled from the
 * on-disk file so an upgrade never wipes sections/areas the UI hadn't heard of.
 */
export async function saveZones(map, payload) {
  const code = String(map || '').toUpperCase();
  if (!MAP_RE.test(code)) throw new Error('Invalid map code');
  await migrateLegacyIfNeeded(code);
  const existing = (await readJsonFile(fileFor(code))) || {};

  const merged = {
    map: code,
    zones: Array.isArray(payload?.zones) ? payload.zones : existing.zones || [],
    sections: Array.isArray(payload?.sections) ? payload.sections : existing.sections || [],
    areas: Array.isArray(payload?.areas) ? payload.areas : existing.areas || [],
    // Older clients omit these — keep on-disk brush layers instead of wiping them.
    visionBlocks: Array.isArray(payload?.visionBlocks)
      ? payload.visionBlocks
      : existing.visionBlocks || [],
    elevated: Array.isArray(payload?.elevated) ? payload.elevated : existing.elevated || [],
    bombSites:
      payload?.bombSites && typeof payload.bombSites === 'object'
        ? payload.bombSites
        : existing.bombSites || { a: null, b: null },
    colorMode:
      payload?.colorMode === 'section' ||
      payload?.colorMode === 'area' ||
      payload?.colorMode === 'zone' ||
      payload?.colorMode === 'none'
        ? payload.colorMode
        : existing.colorMode || 'zone',
    updatedAt: Date.now()
  };

  const clean = sanitizeZones(code, merged);
  await ensureDir();
  // Same durable write style as round notes: replace the JSON file in place.
  await fsp.writeFile(fileFor(clean.map), JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}
