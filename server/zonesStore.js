// ---------------------------------------------------------------------------
// zonesStore.js — CS2 radar zone networks per map
//
// Same persistence model as demo round notes: JSON on the Coolify volume that
// backs AIM4_REPLAY_DIR (shared library, no Supabase). Notes live in
// <library>/rounds/*.json; zones live beside that tree at:
//
//   {AIM4_REPLAY_DIR}/zones/<MAP>.json
//
// so one persistent disk mount covers demos, notes, and zone polygons.
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

/**
 * @param {string} map
 * @param {unknown} payload
 * @returns {{ map: string, zones: Array, updatedAt: number }}
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
      if (piece.type === 'rect') {
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
    zones.push({
      id: String(z.id || `z${zones.length}`).slice(0, 40),
      name,
      color,
      hidden: Boolean(z.hidden),
      pieces
    });
  }

  return {
    map: code,
    zones,
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
  if (!data) return { map: code, zones: [], updatedAt: 0 };
  try {
    return sanitizeZones(code, data);
  } catch {
    return { map: code, zones: [], updatedAt: 0 };
  }
}

export async function saveZones(map, payload) {
  const clean = sanitizeZones(map, { ...payload, updatedAt: Date.now() });
  await ensureDir();
  // Same durable write style as round notes: replace the JSON file in place.
  await fsp.writeFile(fileFor(clean.map), JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}
