// ---------------------------------------------------------------------------
// lib/adaptiveElo.js
// Adaptive difficulty: a per-gamemode rating, and what it does to the targets.
//
// Every gamemode has an ELO, starting at 1000. An adaptive run compares your
// score against the median of your own recent adaptive runs on that mode and
// moves the ELO by ±10 to ±50: match yourself and it barely moves, blow your
// usual score away and it climbs the full step. The ELO then leans on the
// COMPETITIVE preset - never on practice settings - by scaling exactly three
// families of knob: target size (smaller is harder), movement speed (faster is
// harder) and tracking hold time (longer is harder).
//
// The scaling is deliberately timid. A full climb from 1000 to 1500 moves the
// knobs by under a fifth; 200 ELO is a few percent, not a different game. Two
// reasons. First, scores stay roughly comparable between neighbouring ELOs,
// which the ±10..50 update quietly depends on - it compares raw scores across
// runs at different difficulty. Second, difficulty that changes noticeably
// between two runs teaches the player about the difficulty system, not about
// aiming.
//
// The stable point is an oscillation, not a rest: at your true level you beat
// your median about half the time, so the ELO breathes ±10 around it. That is
// by design - a rating that can sit still is a rating that has stopped
// listening.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';

export const DEFAULT_ELO = 1000;
/** One run can move the rating this much, and never less than MIN_STEP. */
export const MIN_STEP = 10;
export const MAX_STEP = 50;
/** Runs remembered per mode. The median of these is "your usual score". */
const HISTORY = 10;
/** Hard bounds, so corrupted storage cannot ask for absurd geometry. */
const ELO_FLOOR = 200;
const ELO_CEIL = 3000;

const STORAGE_KEY = 'adaptiveElo';

// ---- the update -------------------------------------------------------------

function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How far one run moves the ELO.
 *
 * r is the run over the median of the previous runs. The magnitude ramps from
 * MIN_STEP at "matched yourself" to MAX_STEP at ±16% or more; the 250 is just
 * that slope. Every run with history moves the rating at least MIN_STEP - a
 * rating that can decide a run changed nothing invites grinding for the run
 * that does.
 *
 * @param {number} score  this run's leaderboard-relevant value
 * @param {number[]} history previous runs' values, oldest first
 * @returns {number} signed delta, 0 only when there is no history yet
 */
export function eloDeltaFor(score, history) {
  const prev = (history || []).filter((v) => Number.isFinite(v));
  if (!prev.length) return 0;
  const med = median(prev);
  const s = Number(score) || 0;
  // A zero median cannot make a ratio. Scoring anything beats it; scoring
  // nothing again is a mild step down rather than a judgment.
  if (med <= 0) return s > 0 ? 25 : -MIN_STEP;
  const r = s / med;
  const magnitude = Math.min(MAX_STEP, MIN_STEP + Math.round(Math.abs(r - 1) * 250));
  return r >= 1 ? magnitude : -magnitude;
}

// ---- what an ELO does to the game -------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The three multipliers for an ELO. Per 100 points: sizes shrink ~3.5%, speeds
 * rise ~3%, tracking holds lengthen ~4%. Clamped so even a runaway rating
 * cannot produce planet targets or teleporting bots.
 *
 * @returns {{size: number, speed: number, track: number}}
 */
export function difficultyFor(elo) {
  const d = clamp(Number(elo) || DEFAULT_ELO, ELO_FLOOR, ELO_CEIL) - DEFAULT_ELO;
  return {
    size: clamp(1 - d * 0.00035, 0.75, 1.3),
    speed: clamp(1 + d * 0.0003, 0.75, 1.35),
    track: clamp(1 + d * 0.0004, 0.7, 1.5)
  };
}

/**
 * The preset fields each multiplier touches. Everything else in a competitive
 * preset - counts, distances, arenas, cover - is layout, and layout changing
 * with rating would make runs at different ELOs different modes rather than
 * the same mode at different sharpness.
 */
const SIZE_FIELDS = ['targetSize', 'botWidth'];
const SPEED_FIELDS = ['travelSpeed', 'travelSpeedMax', 'botSpeed', 'floatSpeedMax', 'strafeRate'];
const TRACK_FIELDS = ['trackTime'];

const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * A competitive preset, sharpened (or blunted) for an ELO.
 *
 * Only fields the preset already has are touched: a mode with no trackTime
 * does not grow one, and a preset of pure layout comes back unchanged.
 */
export function applyAdaptiveDifficulty(preset, elo) {
  if (!preset) return preset;
  const m = difficultyFor(elo);
  const out = { ...preset };
  for (const f of SIZE_FIELDS) {
    if (Number.isFinite(out[f])) out[f] = round4(out[f] * m.size);
  }
  for (const f of SPEED_FIELDS) {
    if (Number.isFinite(out[f])) out[f] = round4(out[f] * m.speed);
  }
  for (const f of TRACK_FIELDS) {
    if (Number.isFinite(out[f])) out[f] = round4(out[f] * m.track);
  }
  return out;
}

// ---- storage ----------------------------------------------------------------

function loadAll() {
  const raw = Storage.read(STORAGE_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/** Current adaptive ELO for a mode. */
export function eloFor(mode) {
  const entry = loadAll()[mode];
  const elo = Number(entry?.elo);
  return Number.isFinite(elo) ? clamp(elo, ELO_FLOOR, ELO_CEIL) : DEFAULT_ELO;
}

/**
 * Fold one finished adaptive run into the mode's rating.
 *
 * @param {string} mode
 * @param {number} score the run's leaderboard-relevant value (score or kills)
 * @returns {{prevElo: number, elo: number, delta: number, runs: number}}
 */
export function recordAdaptiveRun(mode, score) {
  const all = loadAll();
  const entry = all[mode] && typeof all[mode] === 'object' ? all[mode] : {};
  const prevElo = Number.isFinite(Number(entry.elo))
    ? clamp(Number(entry.elo), ELO_FLOOR, ELO_CEIL)
    : DEFAULT_ELO;
  const runs = Array.isArray(entry.runs) ? entry.runs.filter((v) => Number.isFinite(v)) : [];

  const delta = eloDeltaFor(score, runs);
  const elo = clamp(prevElo + delta, ELO_FLOOR, ELO_CEIL);

  runs.push(Number(score) || 0);
  all[mode] = { elo, runs: runs.slice(-HISTORY) };
  Storage.write(STORAGE_KEY, all);

  return { prevElo, elo, delta, runs: runs.length };
}
