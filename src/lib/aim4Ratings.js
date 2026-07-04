// ---------------------------------------------------------------------------
// lib/aim4Ratings.js — "Aim4 Rating" engine.
//
// Turns a completed run's telemetry into a normalized 0.00–2.00 rating across
// 7 aiming categories, compared to a per-gamemode baseline config. A baseline
// value B defines what a 1.00 rating means for that scenario.
//
// Baselines are editable in-game via the secret /tools/editvalues page, which
// writes the same localStorage key this module reads. Defaults below are the
// fallback when nothing has been customized.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';

const STORAGE_KEY = 'aim4Baselines';

// The 7 rating categories (keys used everywhere: telemetry, config, output).
export const RATING_CATEGORIES = [
  'precision_accuracy_percent',
  'speed',
  'flicks_error_percent',
  'adjustments',
  'reaction_time_ms',
  'tension_percent',
  'tracking'
];

// Human labels for the radar chart / editor axes.
export const RATING_LABELS = {
  precision_accuracy_percent: 'Precision',
  speed: 'Speed',
  flicks_error_percent: 'Flicks',
  adjustments: 'Adjustments',
  reaction_time_ms: 'Reaction',
  tension_percent: 'Tension',
  tracking: 'Tracking'
};

// Base gamemodes that carry a rating config (not custom/playlist/challenge runs).
export const RATED_GAMEMODES = [
  'gridshot', 'stars', 'bounce', 'microflicks', 'pasu', 'spidershot',
  'survival', 'arena', 'duels', 'range', 'tracking', 'deathmatch',
  'sequence', 'double', 'ball', 'bouncetracking', 'pasutracking', 'turn'
];

// Baseline categories that need a config value (Precision is curve-only).
export const BASELINE_KEYS = [
  'speed',
  'tracking',
  'flicks_error_percent',
  'adjustments',
  'reaction_time_ms',
  'tension_percent'
];

/** Default baseline (B = a 1.00 rating) per category, shared by all modes. */
const DEFAULT_BASELINE = {
  speed: 2000.0,
  tracking: 0.45,
  flicks_error_percent: 15.0,
  adjustments: 2.0,
  reaction_time_ms: 200.0,
  tension_percent: 30.0
};

/** Full default config: every rated gamemode maps to the default baseline. */
export function defaultBaselines() {
  const out = {};
  for (const id of RATED_GAMEMODES) out[id] = { ...DEFAULT_BASELINE };
  return out;
}

/** Load the (possibly edited) baseline config, merged over defaults. */
export function loadBaselines() {
  const saved = Storage.read(STORAGE_KEY, null);
  const base = defaultBaselines();
  if (saved && typeof saved === 'object') {
    for (const id of RATED_GAMEMODES) {
      base[id] = { ...base[id], ...(saved[id] || {}) };
    }
  }
  return base;
}

export function saveBaselines(config) {
  return Storage.write(STORAGE_KEY, config);
}

// ---- Server sync ------------------------------------------------------------
// Baselines live on the game server (edited via /tools/editvalues.html, stored
// in server/data/baselines.json). The client pulls them once per session and
// mirrors them into localStorage, which stays the offline fallback.

// Optional-chained: import.meta.env only exists under Vite (not node --test).
const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
let _serverSynced = false;

/**
 * Fetch the shared baselines from the server and mirror them locally.
 * Safe to call repeatedly — only the first call per session hits the network.
 * Resolves regardless of outcome so callers can just `await` it.
 */
export async function syncBaselinesFromServer() {
  if (_serverSynced) return;
  try {
    const res = await fetch(`${API_BASE}/api/baselines`);
    if (!res.ok) return;
    const data = await res.json();
    if (data?.baselines && typeof data.baselines === 'object') {
      Storage.write(STORAGE_KEY, data.baselines);
    }
    _serverSynced = true;
  } catch {
    /* offline / server unreachable — keep the local mirror */
  }
}

/** Baseline object for one gamemode (falls back to the shared default). */
export function baselinesForGamemode(gamemodeId, config = null) {
  const cfg = config || loadBaselines();
  return cfg[gamemodeId] || { ...DEFAULT_BASELINE };
}

// ---- Math engines ---------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Engine 1 — Precision curve (custom exponential). A = accuracy % (0–100). */
export function precisionScore(A) {
  const a = Number(A) || 0;
  let s;
  if (a < 75) {
    s = a / 75;
  } else {
    s = 1.0 + Math.pow((a - 75) / 25, 3.2);
  }
  return clamp(s, 0, 2);
}

/** Engine 2 — Higher is better (speed, tracking). */
export function higherIsBetter(raw, baseline) {
  const b = Number(baseline);
  if (!Number.isFinite(b) || b === 0) return 0;
  return clamp((Number(raw) || 0) / b, 0, 2);
}

/** Engine 3 — Lower is better (flicks, adjustments, reaction, tension). */
export function lowerIsBetter(raw, baseline) {
  const b = Number(baseline);
  if (!Number.isFinite(b) || b === 0) return 0;
  return clamp(2.0 - (Number(raw) || 0) / b, 0, 2);
}

/**
 * Route the 7 raw telemetry stats through their engines and return the rating
 * object (0.00–2.00, 2 dp) keyed by category.
 * @param {object} telemetry raw player stats
 * @param {object} gamemodeConfig { baselines: {...} } or a bare baselines obj
 */
export function calculateAim4Ratings(telemetry = {}, gamemodeConfig = {}) {
  const B = gamemodeConfig.baselines || gamemodeConfig || {};
  return {
    precision_accuracy_percent: round2(precisionScore(telemetry.precision_accuracy_percent)),
    speed: round2(higherIsBetter(telemetry.speed, B.speed)),
    tracking: round2(higherIsBetter(telemetry.tracking, B.tracking)),
    flicks_error_percent: round2(lowerIsBetter(telemetry.flicks_error_percent, B.flicks_error_percent)),
    adjustments: round2(lowerIsBetter(telemetry.adjustments, B.adjustments)),
    reaction_time_ms: round2(lowerIsBetter(telemetry.reaction_time_ms, B.reaction_time_ms)),
    tension_percent: round2(lowerIsBetter(telemetry.tension_percent, B.tension_percent))
  };
}

/**
 * Best-effort mapping from the stored aim-stats aggregate row (aim_run_stats /
 * get_aim_stats) to the 7 raw rating telemetry values. Missing stats fall back
 * to neutral values so a partial row still produces a usable radar.
 */
export function telemetryFromAimStats(row = {}) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const acc = num(row.flick_accuracy_pct, 0);
  const over = num(row.flicks_over, 0);
  const under = num(row.flicks_under, 0);
  const accurate = num(row.flicks_accurate, 0);
  const totalFlicks = over + under + accurate;
  const errorPct = totalFlicks > 0 ? ((over + under) / totalFlicks) * 100 : 0;
  const games = Math.max(1, num(row.games, 1));
  const msPerDeg = num(row.flick_speed_ms, 0);
  // Speed as °/s from ms-per-degree (higher = faster).
  const speed = msPerDeg > 0 ? 1000 / msPerDeg : 0;
  // Adjustments ≈ average over/under flicks per game (corrective re-flicks).
  const adjustments = (over + under) / games;
  // Reaction ≈ average late-click ms (how far behind on-target clicks land).
  const reaction = num(row.click_late_ms, 0) / games;
  return {
    precision_accuracy_percent: acc,
    speed,
    tracking: acc / 100,
    flicks_error_percent: errorPct,
    adjustments,
    reaction_time_ms: reaction,
    tension_percent: num(row.tension_pct, 0)
  };
}

/** Map one replay analytics aggregate to the 7 raw telemetry values (games = 1). */
export function telemetryFromRunAnalytics(analytics = {}) {
  return telemetryFromAimStats({ ...analytics, games: 1 });
}

/** Average a list of rating objects into one (for the "all modes" radar). */
export function averageRatings(list) {
  const out = {};
  for (const key of RATING_CATEGORIES) {
    const vals = list.map((r) => r?.[key]).filter((v) => Number.isFinite(v));
    out[key] = vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  }
  return out;
}
