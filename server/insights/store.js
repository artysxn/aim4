// ---------------------------------------------------------------------------
// server/insights/store.js
// Insights state on disk: a handful of JSON files under AIM4_INSIGHTS_DIR
// (default server/data/insights, which is the persistent volume when hosted).
//
// Everything is held in memory and each file is rewritten, atomically, a few
// seconds after something in it changes. The collections are small (hundreds
// of tracked matches, thousands of flagged trades) so this stays cheap, and a
// crash loses at most the last few seconds.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, sanitizeSettings } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function insightsDir() {
  return process.env.AIM4_INSIGHTS_DIR || path.join(__dirname, '..', 'data', 'insights');
}

/** Caps, newest kept. */
export const CAPS = { flags: 30000, bets: 30000, intents: 2000, log: 400, walletEntries: 400 };

const FILES = {
  settings: () => sanitizeSettings({}, DEFAULT_SETTINGS),
  events: () => ({}),
  prices: () => ({}),
  flags: () => [],
  wallets: () => ({}),
  bets: () => [],
  teams: () => ({}),
  intents: () => [],
  executor: () => ({ devices: [], armed: false }),
  strategies: () => ({}),
  bots: () => ({}),
  meta: () => ({ simEpoch: 0, backfill: null, log: [] }),
  football: () => ({ settings: {}, events: {}, flags: [], wallets: {} })
};

/** @type {Record<string, any>} */
const data = {};
const dirty = new Set();
let timer = null;
let loaded = false;

function file(name) {
  return path.join(insightsDir(), `${name}.json`);
}

export function loadStore() {
  if (loaded) return data;
  fs.mkdirSync(insightsDir(), { recursive: true });
  for (const [name, init] of Object.entries(FILES)) {
    try {
      data[name] = JSON.parse(fs.readFileSync(file(name), 'utf8'));
    } catch {
      data[name] = init();
    }
  }
  data.settings = sanitizeSettings(data.settings, DEFAULT_SETTINGS);
  loaded = true;
  installExitFlush();
  return data;
}

let exitHooked = false;
/** Write pending changes when the process stops. Only once something was loaded. */
function installExitFlush() {
  if (exitHooked) return;
  exitHooked = true;
  process.once('beforeExit', () => flush(true));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      try {
        flush();
      } finally {
        process.kill(process.pid, sig);
      }
    });
  }
}

/** The live object for one collection. Mutate it, then call touch(name). */
export function col(name) {
  if (!loaded) loadStore();
  return data[name];
}

export function setCol(name, value) {
  if (!loaded) loadStore();
  data[name] = value;
  touch(name);
}

export function touch(name) {
  dirty.add(name);
  if (!timer) timer = setTimeout(() => flush(false), 3000);
}

/** The big files are rewritten at most this often; the rest within 3 s. */
const HEAVY = new Set(['flags', 'wallets', 'events', 'prices']);
const HEAVY_MS = 15000;
const lastWrite = {};

/**
 * Write dirty files. `all` (shutdown, tests) writes everything now; otherwise
 * a heavy file written in the last 15 s waits for the next round.
 */
export function flush(all = true) {
  if (timer) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  for (const name of [...dirty]) {
    if (all !== true && HEAVY.has(name) && now - (lastWrite[name] || 0) < HEAVY_MS) continue;
    dirty.delete(name);
    lastWrite[name] = now;
    const target = file(name);
    const tmp = `${target}.tmp`;
    try {
      trim(name);
      fs.writeFileSync(tmp, JSON.stringify(data[name]));
      fs.renameSync(tmp, target);
    } catch (err) {
      console.warn(`[insights] could not write ${name}: ${err.message}`);
    }
  }
  if (dirty.size && !timer) timer = setTimeout(() => flush(false), 3000);
}

function trim(name) {
  const v = data[name];
  if (Array.isArray(v) && CAPS[name] && v.length > CAPS[name]) {
    v.splice(0, v.length - CAPS[name]);
  }
  if (name === 'meta' && Array.isArray(v.log) && v.log.length > CAPS.log) v.log.splice(0, v.log.length - CAPS.log);
}

/** One line in the engine log shown on the Settings page. */
export function logLine(level, msg) {
  const meta = col('meta');
  meta.log = meta.log || [];
  meta.log.push({ at: Date.now(), level, msg: String(msg).slice(0, 400) });
  touch('meta');
  if (level === 'error') console.warn(`[insights] ${msg}`);
}

/** Test helper: forget everything in memory (the next col() reads disk). */
export function resetStoreForTests() {
  for (const k of Object.keys(data)) delete data[k];
  dirty.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  loaded = false;
}
