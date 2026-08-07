// ---------------------------------------------------------------------------
// coachSmokesStore.js — private Autocoach utility landing spots (admin only)
//
//   {AIM4_REPLAY_DIR}/coachSmokes/<MAP>.json
//
// Schema:
//   { map, updatedAt, utilities: [{
//       id,           // mapname_side_name_type  e.g. ancient_t_window_smoke
//       name, side,   // side: t | ct | both
//       type,         // smokegrenade | flashbang | molotov | hegrenade
//       detonate: { x, y }
//     }] }
//
// Legacy `smokes` / `grenades` arrays are accepted on read.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT as REPLAY_ROOT } from './replays/demoStore.js';
import { MAPS } from '../src/replays/shared/roundId.js';
import {
  coachUtilityId,
  normalizeCoachSide,
  normalizeUtilType,
  uniqueCoachUtilityId
} from '../src/replays/coach/coachUtilityIds.js';

export const COACH_SMOKES_ROOT =
  process.env.AIM4_COACH_SMOKES_DIR || path.join(REPLAY_ROOT, 'coachSmokes');

const MAP_RE = /^[A-Z0-9]{2,4}$/;
const MAX_UTILITIES = 400;
const ALLOWED = new Set(['smokegrenade', 'flashbang', 'molotov', 'hegrenade', 'incgrenade']);

async function ensureDir() {
  await fsp.mkdir(COACH_SMOKES_ROOT, { recursive: true });
}

function fileFor(map) {
  return path.join(COACH_SMOKES_ROOT, `${map}.json`);
}

function assertMap(map) {
  const code = String(map || '').toUpperCase();
  if (!MAP_RE.test(code) || !MAPS[code]) throw new Error('Unknown map.');
  return code;
}

function clampNum(v, lo, hi, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function emptyCoachSmokes(map = '') {
  const code = String(map || '').toUpperCase();
  return { map: code, updatedAt: 0, utilities: [], smokes: [] };
}

/**
 * @param {string} map
 * @param {unknown} payload
 */
export function sanitizeCoachSmokes(map, payload) {
  const code = assertMap(map);
  const src = payload && typeof payload === 'object' ? payload : {};
  const incoming = (src.utilities || src.smokes || src.grenades || []).slice(0, MAX_UTILITIES);

  const used = new Set();
  const utilities = [];
  for (const s of incoming) {
    if (!s || typeof s !== 'object') continue;
    const type = normalizeUtilType(s.type || 'smokegrenade');
    if (!ALLOWED.has(type)) continue;
    const name = String(s.name || '').trim().slice(0, 80);
    const side = normalizeCoachSide(s.side);
    const base = coachUtilityId(code, side, name || 'unnamed', type);
    const id = uniqueCoachUtilityId(base, used);
    used.add(id);
    utilities.push({
      id,
      name,
      side,
      type: type === 'incgrenade' ? 'molotov' : type,
      detonate: {
        x: clampNum(s.detonate?.x ?? s.x, -10000, 10000, 0),
        y: clampNum(s.detonate?.y ?? s.y, -10000, 10000, 0)
      }
    });
  }
  return {
    map: code,
    updatedAt: Date.now(),
    utilities,
    // Alias for older coach loaders.
    smokes: utilities
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function listCoachSmokeMaps() {
  await ensureDir();
  const out = [];
  try {
    for (const f of await fsp.readdir(COACH_SMOKES_ROOT)) {
      if (!f.endsWith('.json')) continue;
      const map = f.replace(/\.json$/i, '').toUpperCase();
      if (!MAPS[map]) continue;
      out.push(map);
    }
  } catch {
    /* empty */
  }
  return out.sort();
}

export async function getCoachSmokes(map) {
  const code = assertMap(map);
  await ensureDir();
  const raw = await readJson(fileFor(code), null);
  return raw ? sanitizeCoachSmokes(code, raw) : emptyCoachSmokes(code);
}

export async function saveCoachSmokes(map, payload) {
  const archive = sanitizeCoachSmokes(map, payload);
  await ensureDir();
  // Persist canonical shape (utilities); keep smokes alias off disk to avoid dup.
  const onDisk = {
    map: archive.map,
    updatedAt: archive.updatedAt,
    utilities: archive.utilities
  };
  await fsp.writeFile(fileFor(archive.map), JSON.stringify(onDisk, null, 2), 'utf8');
  return archive;
}
