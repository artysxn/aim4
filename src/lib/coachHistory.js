// ---------------------------------------------------------------------------
// lib/coachHistory.js
// Per-run mechanic scores, remembered per gamemode, so the coach has a memory.
//
// Every finished run that produced aim analytics leaves one row here: the
// seven per-run category ratings (0 to 2), keyed by MECHANIC names so the
// coach, the routines page and the graphs all speak one vocabulary. From that
// the two questions the coaching UI asks are cheap: "did a targeted mechanic
// come in lower than the run before on this mode?" and "what has this
// mechanic done over my recent runs?".
//
// Local on purpose, like practice bests and the adaptive ELO: this is a
// coaching aid about YOUR recent hands, not a synced record, and it has to
// work signed out.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import { TRAINER_TO_MECHANIC } from './routines.js';

const STORAGE_KEY = 'coachHistory';
/** Runs remembered per gamemode. Enough for a trend line, cheap to hold. */
const HISTORY = 20;

/**
 * A drop smaller than this is measurement noise, not a regression. Per-run
 * ratings wobble a few hundredths on identical play; nagging a player over
 * 0.03 would teach them to ignore the coach.
 */
export const REGRESSION_EPSILON = 0.05;

// ---- pure -------------------------------------------------------------------

/**
 * Trainer-keyed per-run ratings into mechanic-keyed ones, finite values only.
 * Accepts either vocabulary so callers can pass calculateAim4Ratings output
 * directly.
 */
export function mechanicRatings(ratings) {
  const out = {};
  for (const [key, value] of Object.entries(ratings || {})) {
    const mechanic = TRAINER_TO_MECHANIC[key] || key;
    if (Number.isFinite(value)) out[mechanic] = value;
  }
  return out;
}

/**
 * Mechanics that came in lower on the last run than the one before.
 *
 * @param {Array<{r: Record<string, number>}>} runs oldest first
 * @param {string[]|null} mechanics restrict to these (a routine's targets);
 *   null compares everything measured
 * @returns {Array<{mechanic: string, prev: number, last: number}>} biggest
 *   drop first
 */
export function regressionsIn(runs, mechanics = null) {
  if (!Array.isArray(runs) || runs.length < 2) return [];
  const prev = runs[runs.length - 2]?.r || {};
  const last = runs[runs.length - 1]?.r || {};
  const wanted = mechanics ? new Set(mechanics) : null;
  const out = [];
  for (const [mechanic, before] of Object.entries(prev)) {
    if (wanted && !wanted.has(mechanic)) continue;
    const now = last[mechanic];
    if (!Number.isFinite(before) || !Number.isFinite(now)) continue;
    if (before - now > REGRESSION_EPSILON) {
      out.push({ mechanic, prev: before, last: now });
    }
  }
  out.sort((a, b) => b.prev - b.last - (a.prev - a.last));
  return out;
}

// ---- storage ----------------------------------------------------------------

function loadAll() {
  const raw = Storage.read(STORAGE_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Remember one finished run's per-mechanic ratings for a gamemode.
 * @returns {number} how many runs this mode now remembers
 */
export function recordCoachRun(scenario, ratings, at = Date.now()) {
  const r = mechanicRatings(ratings);
  if (!scenario || !Object.keys(r).length) return 0;
  const all = loadAll();
  const runs = Array.isArray(all[scenario]) ? all[scenario] : [];
  runs.push({ at, r });
  all[scenario] = runs.slice(-HISTORY);
  Storage.write(STORAGE_KEY, all);
  return all[scenario].length;
}

/** This mode's remembered runs, oldest first. */
export function coachRunsFor(scenario) {
  const runs = loadAll()[scenario];
  return Array.isArray(runs) ? runs : [];
}

/**
 * Last-vs-previous regressions for one gamemode, optionally restricted to a
 * routine's targeted mechanics.
 */
export function coachRegressions(scenario, mechanics = null) {
  return regressionsIn(coachRunsFor(scenario), mechanics);
}

/**
 * One mechanic's recent values on one gamemode, oldest first, for the graphs.
 * @returns {number[]}
 */
export function coachSeries(scenario, mechanic, n = 12) {
  return coachRunsFor(scenario)
    .map((run) => run?.r?.[mechanic])
    .filter((v) => Number.isFinite(v))
    .slice(-n);
}
