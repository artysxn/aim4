// ---------------------------------------------------------------------------
// Round phase: early → mid → late (clock + man-count transitions).
//
// Early ends when the live clock hits 1:15 remaining, or 3 seconds after the
// first death (whichever comes first).
// Late begins at 0:40 remaining, or when both sides have ≤3 players alive.
// Mid is everything between those two transitions.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';

/** Live clock remaining when early → mid (1:15). */
export const EARLY_END_REMAINING = 75;
/** Live clock remaining when mid → late (0:40). */
export const LATE_START_REMAINING = 40;

/** Elapsed live seconds when early ends by clock (115 − 75 = 40). */
export const EARLY_END_ELAPSED = ROUND_SECONDS - EARLY_END_REMAINING;
/** Elapsed live seconds when late starts by clock (115 − 40 = 75). */
export const LATE_START_ELAPSED = ROUND_SECONDS - LATE_START_REMAINING;

/** Early continues this long after the first death before mid begins. */
export const EARLY_AFTER_DEATH_SECONDS = 3;

/**
 * @typedef {'early'|'mid'|'late'} RoundPhase
 * @typedef {{ midStartTick: number, lateStartTick: number, freezeEndTick: number, endTick: number }} PhaseBounds
 */

/**
 * First tick of mid and late for a round (from freeze-end kill log + clock).
 * @param {object} meta
 * @returns {PhaseBounds}
 */
export function phaseBounds(meta) {
  const timing = timingFor(meta);
  const tickRate = timing.tickRate || 64;
  const freezeEndTick = timing.freezeEndTick;
  const endTick = timing.endTick;
  const midByClock = freezeEndTick + EARLY_END_ELAPSED * tickRate;
  const lateByClock = freezeEndTick + LATE_START_ELAPSED * tickRate;

  const teamSides = {
    1: meta.team1Side || 'T',
    2: meta.team2Side || 'CT'
  };
  const sideOf = new Map();
  for (const p of meta.players || []) {
    const side = teamSides[p.team];
    if (side === 'T' || side === 'CT') sideOf.set(p.id, side);
  }

  const kills = [...(meta.events?.kills || [])]
    .filter((k) => k?.victim && (k.tick || 0) >= freezeEndTick)
    .sort((a, b) => (a.tick || 0) - (b.tick || 0));

  const firstDeathTick = kills.length ? kills[0].tick : Infinity;
  const midByDeath = Number.isFinite(firstDeathTick)
    ? firstDeathTick + EARLY_AFTER_DEATH_SECONDS * tickRate
    : Infinity;
  let midStartTick = Math.min(midByClock, midByDeath);
  if (!Number.isFinite(midStartTick)) midStartTick = midByClock;

  let ctAlive = 5;
  let tAlive = 5;
  let lateByMen = Infinity;
  for (const k of kills) {
    const side = sideOf.get(k.victim);
    if (side === 'CT') ctAlive = Math.max(0, ctAlive - 1);
    else if (side === 'T') tAlive = Math.max(0, tAlive - 1);
    if (ctAlive <= 3 && tAlive <= 3) {
      lateByMen = k.tick;
      break;
    }
  }

  let lateStartTick = Math.min(lateByClock, lateByMen);
  if (!Number.isFinite(lateStartTick)) lateStartTick = lateByClock;
  // Late cannot precede mid.
  lateStartTick = Math.max(lateStartTick, midStartTick);

  return { midStartTick, lateStartTick, freezeEndTick, endTick };
}

/**
 * @param {number} tick
 * @param {PhaseBounds} bounds
 * @returns {RoundPhase}
 */
export function phaseAtTick(tick, bounds) {
  if (tick >= bounds.lateStartTick) return 'late';
  if (tick >= bounds.midStartTick) return 'mid';
  return 'early';
}

/**
 * Phase at a tick for a full meta record.
 * @param {object} meta
 * @param {number} tick
 * @returns {RoundPhase}
 */
export function roundPhaseAt(meta, tick) {
  return phaseAtTick(tick, phaseBounds(meta));
}
