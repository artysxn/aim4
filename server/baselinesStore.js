// ---------------------------------------------------------------------------
// baselinesStore.js — server-side Aim4 rating baselines
//
// One JSON file (server/data/baselines.json) holds the per-gamemode baseline
// config edited via /tools/editvalues.html. The game fetches it on load so
// every player rates against the same server-defined baselines.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'baselines.json');

const BASELINE_KEYS = new Set([
  'speed',
  'tracking',
  'flicks_error_percent',
  'adjustments',
  'reaction_time_ms',
  'tension_percent'
]);

/** Keep only { gamemode: { knownKey: finiteNumber } } entries. */
function sanitize(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const out = {};
  for (const [mode, values] of Object.entries(config)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const clean = {};
    for (const [k, v] of Object.entries(values)) {
      const n = Number(v);
      if (BASELINE_KEYS.has(k) && Number.isFinite(n)) clean[k] = n;
    }
    if (Object.keys(clean).length) out[String(mode).slice(0, 40)] = clean;
  }
  return out;
}

export function getBaselines() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveBaselines(config) {
  const clean = sanitize(config);
  if (!clean) throw new Error('Invalid baselines payload');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}
