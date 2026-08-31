// ---------------------------------------------------------------------------
// lib/routines.js
// Building a training routine from what a player is bad at.
//
// The bridge between two vocabularies. Demos and the aim panel speak in
// thirteen MECHANICS (precision, tension, first bullet...); gamemodes speak in
// five TAGS (Accuracy, Control, Speed, Reactions, Movement). TAG_HELPS is the
// dictionary between them, and everything else here is arithmetic over it:
// which modes cover which weaknesses, and how many modes fit in the time the
// player says they have.
//
// Pure on purpose. No DOM, no engine, no storage: the site's routine creator
// and the trainer both import this, and the recommendation logic is testable
// as a function of (time, mechanics) -> playlist items.
// ---------------------------------------------------------------------------

import { SCENARIO_META, isChallengeMode, gamemodeTitle } from './gamemodeCatalog.js';

/**
 * The thirteen mechanics a routine can target, keyed exactly like the aim
 * rating components so a weakness read off the aim panel needs no translation.
 */
export const MECHANICS = Object.freeze([
  { key: 'precision', label: 'Precision' },
  { key: 'speed', label: 'Speed' },
  { key: 'flicks', label: 'Flicks' },
  { key: 'adjustments', label: 'Adjustments' },
  { key: 'reaction', label: 'Reaction' },
  { key: 'tension', label: 'Tension' },
  { key: 'tracking', label: 'Tracking' },
  { key: 'crosshairError', label: 'Crosshair placement' },
  { key: 'readyRate', label: 'Readiness' },
  { key: 'accuracy', label: 'Accuracy' },
  { key: 'firstBullet', label: 'First bullet' },
  { key: 'overflick', label: 'Overflick' },
  { key: 'underflick', label: 'Underflick' }
]);

export const MECHANIC_KEYS = Object.freeze(MECHANICS.map((m) => m.key));
const MECHANIC_LABEL = Object.fromEntries(MECHANICS.map((m) => [m.key, m.label]));

export function mechanicLabel(key) {
  return MECHANIC_LABEL[key] || key;
}

/**
 * What each gamemode tag trains. This is the product decision the whole
 * recommender rests on, stated once as data.
 */
export const TAG_HELPS = Object.freeze({
  Accuracy: ['precision', 'flicks', 'tracking', 'accuracy', 'firstBullet', 'underflick'],
  Control: ['flicks', 'adjustments', 'tension', 'tracking', 'firstBullet', 'overflick'],
  Speed: ['speed', 'reaction', 'tension', 'accuracy', 'overflick', 'underflick'],
  Reactions: ['precision', 'speed', 'adjustments', 'reaction', 'underflick'],
  Movement: ['crosshairError', 'readyRate', 'tension', 'adjustments', 'accuracy', 'reaction']
});

/** Every mechanic a mode's tags claim to help, deduplicated. */
export function mechanicsHelpedBy(tags) {
  const out = new Set();
  for (const tag of tags || []) {
    for (const key of TAG_HELPS[tag] || []) out.add(key);
  }
  return out;
}

/**
 * The n weakest mechanics from a scores object (higher = better, whatever the
 * scale: engine 0-2 and panel 0-100 both rank the same way). Mechanics with no
 * score are skipped rather than treated as weak: unmeasured is not bad.
 */
export function weakestMechanics(scores, n = 5) {
  return MECHANIC_KEYS.filter((key) => Number.isFinite(scores?.[key]))
    .sort((a, b) => scores[a] - scores[b])
    .slice(0, Math.max(0, n));
}

/** Time budgeted per switch between modes: load, a breath, the first click. */
export const SWITCH_SECONDS = 15;
/** Bounds on one item's run, so a routine is never one endless mode. */
const MIN_ITEM_SECONDS = 30;
const MAX_ITEM_SECONDS = 180;
/** Bounds on how many modes one routine holds. */
const MIN_MODES = 3;
const MAX_MODES = 12;

/**
 * Every mode that helps at least one wanted mechanic, best first.
 *
 * A mode's raw score is how many of the wanted mechanics it covers. Ties go to
 * the more FOCUSED mode (fewer tags), because a mode that helps the wanted
 * mechanics through one tag drills them harder than a generalist that happens
 * to brush the same list, then alphabetically so the order is stable.
 */
export function rankModesFor(mechanics) {
  const wanted = new Set(mechanics || []);
  const out = [];
  for (const [mode, meta] of Object.entries(SCENARIO_META)) {
    if (isChallengeMode(mode)) continue;
    const helps = mechanicsHelpedBy(meta.tags);
    const covered = [...wanted].filter((k) => helps.has(k));
    if (!covered.length) continue;
    out.push({ mode, covered, tagCount: (meta.tags || []).length });
  }
  out.sort(
    (a, b) =>
      b.covered.length - a.covered.length ||
      a.tagCount - b.tagCount ||
      gamemodeTitle(a.mode).localeCompare(gamemodeTitle(b.mode))
  );
  return out;
}

/**
 * Pick modes so every wanted mechanic gets attention, not just the popular
 * ones. Greedy on the least-covered mechanic: each pick is the mode that most
 * helps whatever the routine so far has helped least. Without this, asking for
 * five mechanics fills the routine with modes for the two easiest to cover and
 * the other three ride along in name only.
 */
function pickModes(mechanics, count) {
  const ranked = rankModesFor(mechanics);
  const coverage = Object.fromEntries(mechanics.map((k) => [k, 0]));
  const picked = [];
  const pool = [...ranked];
  while (picked.length < count && pool.length) {
    let best = 0;
    let bestGain = -1;
    for (let i = 0; i < pool.length; i++) {
      const low = Math.min(...pool[i].covered.map((k) => coverage[k]));
      // Gain: covering something at the current minimum beats raw breadth.
      const gain = pool[i].covered.reduce(
        (g, k) => g + (coverage[k] === 0 ? 3 : coverage[k] === low ? 2 : 1),
        0
      );
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    }
    const [chosen] = pool.splice(best, 1);
    for (const k of chosen.covered) coverage[k] += 1;
    picked.push(chosen);
  }
  return picked;
}

/**
 * Build a recommended routine.
 *
 * @param {object} args
 * @param {number} args.minutes    how long the player says they have
 * @param {string[]} args.mechanics mechanic keys to train (already chosen or
 *   already defaulted to the five weakest by the caller)
 * @returns {{name: string, items: {scenario: string, config: object}[],
 *   mechanics: string[], estimatedSeconds: number}|null} null when nothing
 *   covers the ask
 */
export function recommendRoutine({ minutes, mechanics }) {
  const wanted = (mechanics || []).filter((k) => MECHANIC_KEYS.includes(k));
  if (!wanted.length) return null;
  const totalSeconds = Math.max(3 * 60, Math.round(Number(minutes) * 60) || 0);

  // How many modes fit: one slot is a run plus the switch after it, at the
  // default run length. Clamped so a two-minute ask still trains three things
  // and a two-hour ask does not become forty modes of ten seconds' attention.
  const slots = Math.floor(totalSeconds / (60 + SWITCH_SECONDS));
  const count = Math.max(MIN_MODES, Math.min(MAX_MODES, slots));

  const picked = pickModes(wanted, count);
  if (!picked.length) return null;

  // Spread the time evenly over what was actually picked, in 15-second steps
  // so the durations read as chosen rather than computed.
  const overhead = SWITCH_SECONDS * picked.length;
  const per = Math.round((totalSeconds - overhead) / picked.length / 15) * 15;
  const itemSeconds = Math.max(MIN_ITEM_SECONDS, Math.min(MAX_ITEM_SECONDS, per));

  const items = picked.map(({ mode }) => ({
    scenario: mode,
    config: { duration: { type: 'time', value: itemSeconds } }
  }));

  const label = wanted.slice(0, 3).map(mechanicLabel).join(', ');
  return {
    name: `Routine: ${label}${wanted.length > 3 ? ` +${wanted.length - 3}` : ''}`,
    items,
    mechanics: wanted,
    estimatedSeconds: picked.length * (itemSeconds + SWITCH_SECONDS)
  };
}

/** "12 min" or "1 h 05 min", for routine cards. */
export function estimateLabel(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
}
