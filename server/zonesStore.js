// ---------------------------------------------------------------------------
// zonesStore.js — bombsites + vision layers per map
//
// JSON on the Coolify volume beside the replay library:
//   {AIM4_REPLAY_DIR}/zones/<MAP>.json
//
// Painted position / zone / area hierarchies are no longer stored. Old files
// may still contain those keys; GET ignores them and SAVE overwrites with the
// slim shape (bombsites + visionBlocks + elevated only).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT as REPLAY_ROOT } from './replays/demoStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ZONES_ROOT =
  process.env.AIM4_ZONES_DIR || path.join(REPLAY_ROOT, 'zones');

const LEGACY_DIR = path.join(__dirname, 'data', 'zones');

const MAP_RE = /^[A-Z0-9]{2,4}$/;
const LAYER_PIECES_MAX = 5000;

async function ensureDir(dir = ZONES_ROOT) {
  await fsp.mkdir(dir, { recursive: true });
}

function fileFor(map, root = ZONES_ROOT) {
  return path.join(root, `${map}.json`);
}

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3 || ring.length > 64) return false;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return false;
    if (!Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) return false;
  }
  return true;
}

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

function sanitizeBombRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { type: 'rect', x, y, w, h };
}

function sanitizeBombSites(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    a: sanitizeBombRect(src.a),
    b: sanitizeBombRect(src.b)
  };
}

/** Empty slim network for a map code. */
export function emptyZones(map) {
  const code = String(map || '').toUpperCase();
  return {
    map: code,
    visionBlocks: [],
    elevated: [],
    bombSites: { a: null, b: null },
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
  return {
    map: code,
    visionBlocks: sanitizeLayerPieces(src.visionBlocks),
    elevated: sanitizeLayerPieces(src.elevated),
    bombSites: sanitizeBombSites(src.bombSites),
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
    bombSites:
      payload?.bombSites && typeof payload.bombSites === 'object'
        ? payload.bombSites
        : existing.bombSites || { a: null, b: null },
    updatedAt: Date.now()
  };

  const clean = sanitizeZones(code, merged);
  await ensureDir();
  await fsp.writeFile(fileFor(clean.map), JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}
