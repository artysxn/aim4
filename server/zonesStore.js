// ---------------------------------------------------------------------------
// zonesStore.js — bombsites + vision layers + Positions/Zones/Areas per map
//
// JSON on the Coolify volume beside the replay library:
//   {AIM4_REPLAY_DIR}/zones/<MAP>.json
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT as REPLAY_ROOT } from './replays/demoStore.js';
import { sanitizeBombSites } from '../src/replays/zones/bombSites.js';
import { sanitizeKeyZones } from '../src/replays/zones/keyZones.js';
import { sanitizeLedges } from '../src/replays/zones/ledges.js';
import { sanitizeRegionHierarchy } from '../src/replays/zones/regionHierarchy.js';
import { sanitizeLayerPieces } from '../src/replays/zones/visionLayers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ZONES_ROOT =
  process.env.AIM4_ZONES_DIR || path.join(REPLAY_ROOT, 'zones');

const LEGACY_DIR = path.join(__dirname, 'data', 'zones');

const MAP_RE = /^[A-Z0-9]{2,4}$/;

async function ensureDir(dir = ZONES_ROOT) {
  await fsp.mkdir(dir, { recursive: true });
}

function fileFor(map, root = ZONES_ROOT) {
  return path.join(root, `${map}.json`);
}

/** Empty network for a map code. */
export function emptyZones(map) {
  const code = String(map || '').toUpperCase();
  return {
    map: code,
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
 * @param {string} map
 * @param {unknown} payload
 */
export function sanitizeZones(map, payload) {
  const code = String(map || '').toUpperCase();
  if (!MAP_RE.test(code)) throw new Error('Invalid map code');
  const src = payload && typeof payload === 'object' ? payload : {};
  const hierarchy = sanitizeRegionHierarchy(src);
  return {
    map: code,
    visionBlocks: sanitizeLayerPieces(src.visionBlocks),
    elevated: sanitizeLayerPieces(src.elevated),
    underpasses: sanitizeLayerPieces(src.underpasses),
    ledges: sanitizeLedges(src.ledges),
    bombSites: sanitizeBombSites(src.bombSites),
    keyZones: sanitizeKeyZones(src.keyZones),
    positions: hierarchy.positions,
    zones: hierarchy.zones,
    areas: hierarchy.areas,
    updatedAt: Number(src.updatedAt) || Date.now()
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
  if (!data) return emptyZones(code);
  try {
    return sanitizeZones(code, data);
  } catch {
    return emptyZones(code);
  }
}

export async function saveZones(map, payload) {
  const code = String(map || '').toUpperCase();
  if (!MAP_RE.test(code)) throw new Error('Invalid map code');
  await migrateLegacyIfNeeded(code);
  const existing = (await readJsonFile(fileFor(code))) || {};

  const merged = {
    map: code,
    visionBlocks: Array.isArray(payload?.visionBlocks)
      ? payload.visionBlocks
      : existing.visionBlocks || [],
    elevated: Array.isArray(payload?.elevated) ? payload.elevated : existing.elevated || [],
    underpasses: Array.isArray(payload?.underpasses)
      ? payload.underpasses
      : existing.underpasses || [],
    ledges: Array.isArray(payload?.ledges) ? payload.ledges : existing.ledges || [],
    bombSites:
      payload?.bombSites && typeof payload.bombSites === 'object'
        ? payload.bombSites
        : existing.bombSites || { a: [], b: [] },
    keyZones:
      payload?.keyZones && typeof payload.keyZones === 'object'
        ? payload.keyZones
        : existing.keyZones || { a: [], b: [] },
    positions: Array.isArray(payload?.positions)
      ? payload.positions
      : existing.positions || [],
    zones: Array.isArray(payload?.zones) ? payload.zones : existing.zones || [],
    areas: Array.isArray(payload?.areas) ? payload.areas : existing.areas || [],
    // Legacy keys kept only when modern arrays were omitted, so old files still
    // round-trip through sanitizeRegionHierarchy until the next explicit save.
    sections: payload?.sections ?? existing.sections,
    updatedAt: Date.now()
  };

  const clean = sanitizeZones(code, merged);
  await ensureDir();
  await fsp.writeFile(fileFor(clean.map), JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}
