// ---------------------------------------------------------------------------
// lib/adaptiveElo.js
// Adaptive difficulty: a rating per MECHANIC, and what it does to the targets.
//
// The rating is not per gamemode. Gamemodes are made of the same handful of
// mechanics in different mixtures (Gridshot is Speed and Accuracy, Microflicks
// is Accuracy and Reactions), and a rating per gamemode learns each mixture
// from scratch: getting faster in one mode teaches the other twelve speed
// modes nothing. So there is one rating per mechanic, and a gamemode's
// difficulty is the mean of the ones it is made of.
//
//   speed 1000, movement 1500  ->  a Speed + Movement mode is played at 1250
//
// What comes back from a run is then split by ordinary Elo, against that same
// 1250 as the opponent, and SHARED between the mechanics rather than paid to
// each in full. The 1000 was not expected to beat a 1250 and takes most of the
// win; the 1500 was expected to and takes little:
//
//   speed     expected 0.19,  wins  ->  +16
//   movement  expected 0.81,  wins  ->  +4
//
// which is the whole point. A mode you are lopsided at pulls hardest on the
// half that is behind, and playing to your strength stops paying. The share is
// what keeps one run worth one run: a mode testing three mechanics says less
// about each of them than a mode testing one, and moves each of them less.
//
// It also means a run that goes exactly as expected still moves both: the
// weaker mechanic up, the stronger one down, both toward the difficulty the
// evidence supports. That convergence is not a bug to damp out. A player who
// only ever plays one mixture has no evidence separating its halves, and the
// honest reading of no evidence is that they are the same. Playing a mode that
// isolates one of them is what separates them again.
//
// The ELO then leans on the COMPETITIVE preset - never on practice settings -
// by scaling exactly three families of knob: target size (smaller is harder),
// movement speed (faster is harder) and tracking hold time (longer is harder).
//
// The scaling is deliberately timid. A full climb from 1000 to 1500 moves the
// knobs by under a fifth; 200 ELO is a few percent, not a different game. Two
// reasons. First, scores stay roughly comparable between neighbouring ELOs,
// which the update quietly depends on: it compares raw scores across runs at
// different difficulty. Second, difficulty that changes noticeably between two
// runs teaches the player about the difficulty system, not about aiming.
//
// The stable point is an oscillation, not a rest: at your true level you beat
// your median about half the time, so the rating breathes around it. That is
// by design - a rating that can sit still is a rating that has stopped
// listening.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import { SCENARIO_META } from './gamemodeCatalog.js';

export const DEFAULT_ELO = 1000;
/**
 * The most one RUN can move the ratings it touches, in total.
 *
 * Shared between the mode's mechanics rather than paid to each, so this is the
 * budget for the run and not the budget per mechanic. On a one mechanic mode a
 * decisive win moves it the full 20 at even odds; on a two mechanic mode the
 * same win is split, and a lopsided pair splits it unevenly by design.
 *
 * Chosen against the fixed step it replaces, where a decisive run moved a
 * rating 50 points and a marginal one 10.
 */
export const K_FACTOR = 40;
/**
 * The classic Elo scale: 400 points is ten to one odds. Kept at the standard
 * value because every intuition anyone has about Elo numbers assumes it.
 */
export const ELO_SPREAD = 400;
/**
 * How far above your own median counts as a decisive win, and how far below a
 * decisive loss. Inherited from the step ramp this replaces, so a run that
 * used to earn the full 50 still counts as a clean win.
 */
export const DECISIVE = 0.16;
/** Runs remembered per mode. The median of these is "your usual score". */
const HISTORY = 10;
/** Hard bounds, so corrupted storage cannot ask for absurd geometry. */
const ELO_FLOOR = 200;
const ELO_CEIL = 3000;

const STORAGE_KEY = 'adaptiveElo';
const STORAGE_VERSION = 2;

// ---- the update -------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Elo's expected score: the chance `rating` beats `opponent`.
 *
 * 0.5 at equal ratings, and 0.09 at 400 points down. This is the whole of the
 * split: a mechanic's share of a result is exactly the part that was not
 * already expected of it.
 */
export function expectedScore(rating, opponent) {
  return 1 / (1 + 10 ** ((Number(opponent) - Number(rating)) / ELO_SPREAD));
}

/**
 * The result of a run, as a score in [0, 1]: 1 a clean win, 0.5 a draw, 0 a
 * clean loss.
 *
 * The opponent is the difficulty, and the evidence is the run against the
 * median of your own recent runs at that mode. Matching your median is a draw,
 * which is right: the difficulty was set from your rating, so performing
 * exactly to it says the rating was correct.
 *
 * @param {number} score this run's leaderboard-relevant value
 * @param {number[]} history previous runs' values
 * @returns {number|null} null when there is nothing to compare against yet
 */
export function outcomeFor(score, history) {
  const prev = (history || []).filter((v) => Number.isFinite(v));
  if (!prev.length) return null;
  const med = median(prev);
  const s = Number(score) || 0;
  // A zero median cannot make a ratio. Scoring anything beats it; scoring
  // nothing again is a mild loss rather than a judgment.
  if (med <= 0) return s > 0 ? 1 : 0.35;
  const r = s / med;
  return clamp(0.5 + ((r - 1) / DECISIVE) * 0.5, 0, 1);
}

// ---- what an ELO does to the game -------------------------------------------

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
//
// One rating per mechanic, and the recent scores per mode that the result is
// judged against. Runs stay keyed by MODE because "your usual score" is only
// meaningful within one mode; ratings are keyed by MECHANIC because that is
// what is actually being rated.

function blank() {
  return { v: STORAGE_VERSION, cats: {}, runs: {} };
}

/**
 * Read the store, migrating a per-gamemode one on the way.
 *
 * v1 held `{ [mode]: { elo, runs } }`. Each mechanic is seeded with the mean
 * rating of the modes that trained it, which is the closest thing to what the
 * old numbers were evidence for; a mechanic no mode had rated starts fresh.
 * Throwing the old ratings away instead would silently reset everybody who had
 * played adaptive, and they would have no way to tell that is what happened.
 */
function loadAll() {
  const raw = Storage.read(STORAGE_KEY, null);
  if (!raw || typeof raw !== 'object') return blank();
  if (raw.v === STORAGE_VERSION && raw.cats) {
    return { v: STORAGE_VERSION, cats: { ...raw.cats }, runs: { ...(raw.runs || {}) } };
  }

  const out = blank();
  const seed = new Map();
  for (const [mode, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.runs)) out.runs[mode] = entry.runs.filter((v) => Number.isFinite(v));
    const elo = Number(entry.elo);
    if (!Number.isFinite(elo)) continue;
    for (const cat of categoriesFor(mode)) {
      const bucket = seed.get(cat) || [];
      bucket.push(elo);
      seed.set(cat, bucket);
    }
  }
  for (const [cat, list] of seed) {
    out.cats[cat] = clamp(list.reduce((a, b) => a + b, 0) / list.length, ELO_FLOOR, ELO_CEIL);
  }
  return out;
}

/** The mechanics a gamemode is made of, from its tags. */
export function categoriesFor(mode) {
  const tags = SCENARIO_META[mode]?.tags;
  return Array.isArray(tags) && tags.length ? [...tags] : [];
}

/** One mechanic's rating. */
export function categoryElo(category, store = null) {
  const cats = (store || loadAll()).cats || {};
  const v = Number(cats[category]);
  return Number.isFinite(v) ? clamp(v, ELO_FLOOR, ELO_CEIL) : DEFAULT_ELO;
}

/** Every mechanic that has a rating, plus the ones this build knows about. */
export function allCategoryElos() {
  const store = loadAll();
  const out = {};
  for (const key of Object.keys(SCENARIO_META)) {
    for (const cat of categoriesFor(key)) out[cat] = categoryElo(cat, store);
  }
  return out;
}

/**
 * The difficulty a mode is played at: the mean of its mechanics' ratings.
 *
 * A mode with no tags at all cannot be composed, so it plays at the default
 * rather than at nothing.
 */
export function eloFor(mode, store = null) {
  const cats = categoriesFor(mode);
  if (!cats.length) return DEFAULT_ELO;
  const s = store || loadAll();
  const sum = cats.reduce((a, c) => a + categoryElo(c, s), 0);
  return Math.round(clamp(sum / cats.length, ELO_FLOOR, ELO_CEIL));
}

/**
 * Fold one finished adaptive run into the mechanics it exercised.
 *
 * Every mechanic of the mode is rated against the difficulty the mode was
 * played at, so the split falls out of Elo rather than being apportioned by
 * hand: a mechanic below the difficulty gains most of the win, one above it
 * gains little, and one exactly at it gains half. The whole is then divided
 * by how many mechanics shared it, so one run is worth one run however many
 * things the mode was testing.
 *
 * @param {string} mode
 * @param {number} score the run's leaderboard-relevant value (score or kills)
 * @returns {{prevElo: number, elo: number, delta: number, runs: number,
 *   outcome: number|null, categories: Array<{category: string, from: number,
 *   to: number, delta: number, expected: number}>}}
 */
export function recordAdaptiveRun(mode, score) {
  const store = loadAll();
  const cats = categoriesFor(mode);
  const runs = Array.isArray(store.runs[mode])
    ? store.runs[mode].filter((v) => Number.isFinite(v))
    : [];

  const prevElo = eloFor(mode, store);
  const outcome = outcomeFor(score, runs);

  const moved = [];
  if (outcome !== null) {
    // Split across the mechanics the mode tests, not applied whole to each.
    // One run is one result: a mode that tests three things at once is weaker
    // evidence about any one of them than a mode that tests one, and without
    // the division a three tag mode would move a rating three times as fast
    // per run as a one tag mode for saying less about it.
    const share = 1 / cats.length;
    for (const cat of cats) {
      const from = categoryElo(cat, store);
      const expected = expectedScore(from, prevElo);
      const to = clamp(from + K_FACTOR * (outcome - expected) * share, ELO_FLOOR, ELO_CEIL);
      store.cats[cat] = to;
      moved.push({
        category: cat,
        from: Math.round(from),
        to: Math.round(to),
        delta: Math.round(to - from),
        expected: Math.round(expected * 100) / 100
      });
    }
  }

  runs.push(Number(score) || 0);
  store.runs[mode] = runs.slice(-HISTORY);
  Storage.write(STORAGE_KEY, store);

  const elo = eloFor(mode, store);
  return { prevElo, elo, delta: elo - prevElo, runs: runs.length, outcome, categories: moved };
}
