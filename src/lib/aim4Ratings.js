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
  'flicks_hit_percent',
  'adjustments',
  'reaction_time_ms',
  'tension_percent',
  'tracking'
];

// Human labels for the radar chart / editor axes.
export const RATING_LABELS = {
  precision_accuracy_percent: 'Precision',
  speed: 'Speed',
  flicks_hit_percent: 'Flicks',
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

/** Hold-fire modes use a 6-axis radar (no Flicks category). */
export const FLICKLESS_RATED_MODES = new Set(['ball', 'tracking']);

/** Rating axes shown for a gamemode (6 for Ball / Strafes, 7 otherwise). */
export function ratingCategoriesForMode(mode) {
  if (FLICKLESS_RATED_MODES.has(mode)) {
    return RATING_CATEGORIES.filter((k) => k !== 'flicks_hit_percent');
  }
  return RATING_CATEGORIES;
}

// Baseline categories that need a config value (Precision is curve-only).
export const BASELINE_KEYS = [
  'speed',
  'tracking',
  'flicks_hit_percent',
  'adjustments',
  'reaction_time_ms',
  'tension_percent'
];

/** Default baseline (B = a 1.00 rating) per category, shared by all modes. */
const DEFAULT_BASELINE = {
  speed: 44.0, // °/s of angular travel while flicking (≈53°/s → ~1.10)
  tracking: 0.5, // fraction of engagement time spent on target
  flicks_hit_percent: 50.0, // % of flicks that land on target
  adjustments: 2.0, // flicks per target hit (1.0 = one-and-done → 2.00)
  reaction_time_ms: 200.0, // blended direction-change + hold-before-shot delay
  tension_percent: 40.0 // % deviation from the direct path to the target
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

/**
 * Engine 1 — Precision curve. A = average per-flick closeness % (how much of
 * the start→target gap each adjustment closed). 70% = a 1.00 rating.
 */
export function precisionScore(A) {
  const a = Number(A) || 0;
  let s;
  if (a < 70) {
    s = a / 70;
  } else {
    s = 1.0 + Math.pow((a - 70) / 30, 2.2);
  }
  return clamp(s, 0, 2);
}

/**
 * Engine 4 — Flicks per target hit (lower is better). 1.0 flick/target is ideal
 * but the rating is capped well below 2.00; baseline B (default 2.0) = 1.00.
 */
export function adjustmentsScore(adjPerTarget, baseline = 2.0) {
  const a = Math.max(1, Number(adjPerTarget) || 1);
  const b = Math.max(1.01, Number(baseline) || 2.0);
  const excess = a - 1;
  const bExcess = b - 1;
  const raw = 2 * Math.exp(-0.693147 * excess / bExcess);
  return clamp(raw, 0, 1.78);
}

/**
 * Engine 5 — Reaction time (ms). Exponential decay: instant still caps below
 * 2.00; baseline ms (default 200) = 1.00; double baseline ≈ 0.50.
 */
export function reactionScore(ms, baseline = 200) {
  const m = Math.max(0, Number(ms) || 0);
  if (m <= 0) return 1.82;
  const b = Math.max(1, Number(baseline) || 200);
  return clamp(2 * Math.exp(-0.693147 * m / b), 0, 1.82);
}

/**
 * Engine 2b — Forgiving higher-is-better (speed). Square-root curve: being
 * below the baseline costs far less than a linear ratio would (half the
 * baseline speed still rates ~0.71), and 4× the baseline caps at 2.00.
 */
export function speedScore(raw, baseline) {
  const b = Number(baseline);
  if (!Number.isFinite(b) || b <= 0) return 0;
  const v = Math.max(0, Number(raw) || 0);
  return clamp(Math.sqrt(v / b), 0, 2);
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
  const B = { ...DEFAULT_BASELINE, ...(gamemodeConfig.baselines || gamemodeConfig || {}) };
  return {
    // How close each adjustment lands (70% closeness = 1.00).
    precision_accuracy_percent: round2(precisionScore(telemetry.precision_accuracy_percent)),
    // Distance travelled while flicking over time spent flicking (°/s).
    // Forgiving sqrt curve — see speedScore.
    speed: round2(speedScore(telemetry.speed, B.speed)),
    // On-target fraction (per engagement, or whole-run for hold-fire modes).
    tracking: round2(higherIsBetter(telemetry.tracking, B.tracking)),
    // How many flicks land on target at all (%).
    flicks_hit_percent: round2(higherIsBetter(telemetry.flicks_hit_percent, B.flicks_hit_percent)),
    // Motions per target hit — 1.0 is ideal; brutal exponential curve.
    adjustments: round2(adjustmentsScore(telemetry.adjustments, B.adjustments)),
    // Direction-change response + hold-before-click, 50/50 blend (ms).
    reaction_time_ms: round2(reactionScore(telemetry.reaction_time_ms, B.reaction_time_ms)),
    // Path deviation from the direct route to the engaged target (lower wins;
    // 0% → 2.00, the baseline (default 40%) → 1.00).
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
  /** Column present in the aggregate row (null/undefined = never logged). */
  const hasField = (v) => v != null && v !== '' && Number.isFinite(Number(v));

  const acc = num(row.flick_accuracy_pct, 0);
  const over = num(row.flicks_over, 0);
  const under = num(row.flicks_under, 0);
  const accurate = num(row.flicks_accurate, 0);
  const totalFlicks = over + under + accurate;
  const hitPct = totalFlicks > 0 ? (accurate / totalFlicks) * 100 : 0;
  const games = Math.max(1, num(row.games, 1));
  const msPerDeg = num(row.flick_speed_ms, 0);
  const clickLate = num(row.click_late_ms, 0);

  // Speed: speed_deg_s is 0 when no flick timing was captured — fall back to ms/°.
  const speed = hasField(row.speed_deg_s) && num(row.speed_deg_s) > 0
    ? num(row.speed_deg_s)
    : (msPerDeg > 0 ? 1000 / msPerDeg : 0);

  // Tracking: 0% means no engagement samples — fall back to flick-accuracy proxy.
  const tracking = hasField(row.tracking_pct) && num(row.tracking_pct) > 0
    ? num(row.tracking_pct) / 100
    : (acc > 0 ? acc / 100 : 0.5);

  const adjustments = hasField(row.adjustments_per_target) && num(row.adjustments_per_target) > 0
    ? num(row.adjustments_per_target)
    : 2.0;

  // Reaction: null = no samples; 0 is a valid instant-reaction reading.
  const reaction_time_ms = hasField(row.reaction_ms)
    ? num(row.reaction_ms)
    : (clickLate > 0 ? clickLate / games : 200);

  return {
    precision_accuracy_percent: acc,
    speed,
    tracking,
    flicks_hit_percent: hitPct,
    adjustments,
    reaction_time_ms,
    tension_percent: num(row.tension_pct, 0)
  };
}

/** Map one replay analytics aggregate to rating telemetry + detail fields. */
export function telemetryFromRunAnalytics(analytics = {}) {
  const t = telemetryFromAimStats({ ...analytics, games: 1 });
  const pick = (k) => analytics[k];
  return {
    ...t,
    reaction_dir_ms: pick('reaction_dir_ms'),
    reaction_hold_ms: pick('reaction_hold_ms'),
    kill_to_flick_ms: pick('kill_to_flick_ms'),
    reaction_dir_samples: pick('reaction_dir_samples'),
    reaction_hold_samples: pick('reaction_hold_samples'),
    kill_to_flick_samples: pick('kill_to_flick_samples'),
    flicks_total: pick('flicks_total'),
    targets_hit: pick('targets_hit'),
    flick_deg_total: pick('flick_deg_total'),
    flick_time_ms: pick('flick_time_ms'),
    flicks_accurate: pick('flicks_accurate'),
    flicks_over: pick('flicks_over'),
    flicks_under: pick('flicks_under')
  };
}

/**
 * Per-category rating plus the raw stat and formula used (for radar tooltips).
 * @returns {Record<string, { rating:number, raw:number, rawLabel:string, formula:string, direction:'higher'|'lower'|'precision' }>}
 */
export function buildRatingBreakdown(telemetry = {}, gamemodeConfig = {}) {
  const B = { ...DEFAULT_BASELINE, ...(gamemodeConfig.baselines || gamemodeConfig || {}) };
  const rating = calculateAim4Ratings(telemetry, gamemodeConfig);
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const line = (s) => s;

  const precisionRaw = num(telemetry.precision_accuracy_percent);
  const speedRaw = num(telemetry.speed);
  const trackingRaw = num(telemetry.tracking);
  const flicksRaw = num(telemetry.flicks_hit_percent);
  const adjRaw = num(telemetry.adjustments);
  const reactRaw = num(telemetry.reaction_time_ms);
  const tensionRaw = num(telemetry.tension_percent);

  const flicksTotal = telemetry.flicks_total;
  const targetsHit = telemetry.targets_hit;
  const flickDeg = telemetry.flick_deg_total;
  const flickMs = telemetry.flick_time_ms;
  const dirMs = telemetry.reaction_dir_ms;
  const holdMs = telemetry.reaction_hold_ms;
  const ktfMs = telemetry.kill_to_flick_ms;

  const speedLines = [
    line(`${speedRaw.toFixed(1)} °/s while flicking`),
    flickDeg != null && flickMs != null && flickMs > 0
      ? line(`${Number(flickDeg).toFixed(1)}° travelled in ${Number(flickMs).toFixed(0)} ms`)
      : null,
    line(`Baseline ${B.speed} °/s → 1.00 rating`)
  ].filter(Boolean);

  const adjLines = [
    flicksTotal != null && targetsHit != null
      ? line(`${flicksTotal} flicks ÷ ${targetsHit} targets = ${adjRaw.toFixed(2)} per hit`)
      : line(`${adjRaw.toFixed(2)} flicks per target hit`),
    line('1.00 per target is ideal — rating capped below 2.00'),
    line(`Baseline ${B.adjustments.toFixed(1)}/target → 1.00 rating`)
  ];

  const reactLines = [];
  if (dirMs != null) {
    reactLines.push(line(
      `Target turn → aim: ${Number(dirMs).toFixed(1)} ms` +
      (telemetry.reaction_dir_samples ? ` (${telemetry.reaction_dir_samples}×)` : '')
    ));
  }
  if (holdMs != null) {
    reactLines.push(line(
      `On-target before click: ${Number(holdMs).toFixed(1)} ms` +
      (telemetry.reaction_hold_samples ? ` (${telemetry.reaction_hold_samples}×)` : '')
    ));
  }
  if (ktfMs != null) {
    reactLines.push(line(
      `Kill → next flick: ${Number(ktfMs).toFixed(1)} ms` +
      (telemetry.kill_to_flick_samples ? ` (${telemetry.kill_to_flick_samples}×)` : '')
    ));
  }
  reactLines.push(line(`Combined → ${reactRaw.toFixed(1)} ms (50/50 when both present)`));
  reactLines.push(line(`Baseline ${B.reaction_time_ms} ms → 1.00 rating`));

  const flicksLines = [
    line(`${flicksRaw.toFixed(1)}% of flicks land on target`),
    telemetry.flicks_accurate != null
      ? line(`${telemetry.flicks_accurate} accurate / ${telemetry.flicks_over ?? 0} over / ${telemetry.flicks_under ?? 0} under`)
      : null,
    line(`Baseline ${B.flicks_hit_percent}% → 1.00 rating`)
  ].filter(Boolean);

  return {
    precision_accuracy_percent: {
      rating: rating.precision_accuracy_percent,
      raw: precisionRaw,
      rawLabel: `${precisionRaw.toFixed(1)}% avg closeness per flick`,
      detailLines: [
        line(`${precisionRaw.toFixed(1)}% of start→target gap closed per flick`),
        line('70% closeness → 1.00 rating')
      ],
      direction: 'precision'
    },
    speed: {
      rating: rating.speed,
      raw: speedRaw,
      rawLabel: `${speedRaw.toFixed(0)} °/s while flicking`,
      detailLines: speedLines,
      direction: 'higher'
    },
    tracking: {
      rating: rating.tracking,
      raw: trackingRaw,
      rawLabel: `${(trackingRaw * 100).toFixed(1)}% time on target`,
      detailLines: [
        line(`${(trackingRaw * 100).toFixed(1)}% of engagement on target`),
        line(`Baseline ${(B.tracking * 100).toFixed(0)}% → 1.00 rating`)
      ],
      direction: 'higher'
    },
    flicks_hit_percent: {
      rating: rating.flicks_hit_percent,
      raw: flicksRaw,
      rawLabel: `${flicksRaw.toFixed(1)}% of flicks land on target`,
      detailLines: flicksLines,
      direction: 'higher'
    },
    adjustments: {
      rating: rating.adjustments,
      raw: adjRaw,
      rawLabel: `${adjRaw.toFixed(2)} flicks per target hit`,
      detailLines: adjLines,
      direction: 'lower'
    },
    reaction_time_ms: {
      rating: rating.reaction_time_ms,
      raw: reactRaw,
      rawLabel: `${reactRaw.toFixed(1)} ms blended reaction`,
      detailLines: reactLines,
      direction: 'lower'
    },
    tension_percent: {
      rating: rating.tension_percent,
      raw: tensionRaw,
      rawLabel: `${tensionRaw.toFixed(1)}% path deviation`,
      detailLines: [
        line(`${tensionRaw.toFixed(1)}% deviation from direct path`),
        line(`Baseline ${B.tension_percent}% → 1.00 rating`)
      ],
      direction: 'lower'
    }
  };
}

/**
 * Build a radar rating from individual runs: for each category, take the top
 * `bestN` run scores (higher normalized rating = better) and average them.
 * Axes may come from different games when bestN is 1.
 */
export function composeRatingFromBestRuns(runs, gamemodeConfig = {}, bestN = 1) {
  if (!runs?.length) return null;
  const perRun = runs.map((row) =>
    calculateAim4Ratings(telemetryFromAimStats({ ...row, games: 1 }), gamemodeConfig)
  );
  const cap = Math.max(1, Math.min(Number(bestN) || 1, runs.length));
  const out = {};
  for (const key of RATING_CATEGORIES) {
    const scores = perRun
      .map((r) => r[key])
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => b - a);
    if (!scores.length) {
      out[key] = null;
      continue;
    }
    const top = scores.slice(0, Math.min(cap, scores.length));
    out[key] = round2(top.reduce((s, v) => s + v, 0) / top.length);
  }
  return out;
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

/**
 * Average per-mode ratings into one radar polygon. Skips modes with no data and
 * excludes Flicks from Ball / Strafes when averaging that axis.
 */
export function averageRatingsAcrossModes(perModeList) {
  const out = {};
  for (const key of RATING_CATEGORIES) {
    const vals = [];
    for (const { mode, rating } of perModeList) {
      if (!rating) continue;
      if (key === 'flicks_hit_percent' && FLICKLESS_RATED_MODES.has(mode)) continue;
      const v = rating[key];
      if (Number.isFinite(v)) vals.push(v);
    }
    out[key] = vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  return out;
}

/** Single-number overall score: mean of the axes that apply to this mode / view. */
export function overallAimScore(rating, mode = 'all') {
  if (!rating) return null;
  let keys;
  if (mode && mode !== 'all') {
    keys = ratingCategoriesForMode(mode);
  } else {
    keys = RATING_CATEGORIES.filter((k) => {
      if (k === 'flicks_hit_percent' && !Number.isFinite(rating[k])) return false;
      return Number.isFinite(rating[k]);
    });
  }
  const vals = keys.map((k) => rating[k]).filter((v) => Number.isFinite(v));
  return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

/**
 * Combined profile overall: average of each rated mode's overall score (only
 * modes the player has competitive data for).
 */
export function overallAimScoreFromModes(perModeList) {
  const scores = perModeList
    .map(({ mode, rating }) => overallAimScore(rating, mode))
    .filter((v) => Number.isFinite(v));
  return scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}

/** Categories to draw for a radar view (all-mode avg omits Flicks if no data). */
export function radarCategoriesForView(mode, rating) {
  if (mode && mode !== 'all') return ratingCategoriesForMode(mode);
  const cats = RATING_CATEGORIES.filter(
    (k) => k !== 'flicks_hit_percent' || Number.isFinite(rating?.[k])
  );
  return cats.length ? cats : ratingCategoriesForMode('gridshot');
}
