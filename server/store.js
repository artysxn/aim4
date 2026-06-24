// ---------------------------------------------------------------------------
// store.js — persistent map of settings code → configuration snapshot
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { generateCode, isValidCodeFormat, normalizeCode } from './configCodes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'configs.json');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashSettings(settings) {
  return createHash('sha256').update(stableStringify(settings)).digest('hex');
}

function emptyDb() {
  return { byCode: {}, byHash: {} };
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyDb();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.byCode || !parsed.byHash) return emptyDb();
    return parsed;
  } catch {
    return emptyDb();
  }
}

function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

let db = loadDb();

/** One unique code per distinct settings snapshot (re-export returns the same code). */
export function saveConfig(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Invalid settings payload');
  }

  const snapshot = structuredClone(settings);
  const hash = hashSettings(snapshot);

  const existing = db.byHash[hash];
  if (existing) {
    return { code: existing, created: false };
  }

  let code;
  let attempts = 0;
  do {
    code = generateCode();
    attempts++;
    if (attempts > 50) throw new Error('Failed to allocate unique code');
  } while (db.byCode[code]);

  const now = Date.now();
  db.byCode[code] = { settings: snapshot, hash, createdAt: now };
  db.byHash[hash] = code;
  saveDb(db);

  return { code, created: true };
}

export function getConfig(code) {
  const normalized = normalizeCode(code);
  if (!isValidCodeFormat(normalized)) return null;
  const entry = db.byCode[normalized];
  if (!entry) return null;
  return structuredClone(entry.settings);
}
