// ---------------------------------------------------------------------------
// Round-decided: equal-buy rounds where win% hits 88% for one side and never
// drops below that threshold before that side wins. The decide moment is the
// first tick of that uninterrupted stretch.
// ---------------------------------------------------------------------------

import { isEqualBuyRound } from '../shared/roundId.js';
import {
  deadPlayersAt,
  decidedSideAt,
  liveEquipment,
  plantSituationAt,
  winProbability
} from './winProbability.js';
import { phaseAtTick, phaseBounds } from './roundPhases.js';

export { isEqualBuyRound };

/** Leading win% that counts as "decided momentum". */
export const DECIDED_THRESHOLD = 88;

/**
 * Build 1 Hz win% samples from freeze end → round end using the kill log
 * (full HP assumed for living players — no tick buffer required).
 * @param {object} meta
 * @returns {Array<{tick:number, ct:number, t:number, ctAlive:number, tAlive:number}>}
 */
export function winSeriesFromMeta(meta) {
  if (!meta) return [];
  const tickRate = meta.tickRate || 64;
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const winnerSide =
    meta.winnerSide || (meta.winner === 1 ? teamSides[1] : teamSides[2]);
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const endTick = meta.endTick ?? from;
  const grenades = meta.events?.grenades || [];
  const bomb = meta.events?.bomb || [];
  const kills = meta.events?.kills || [];

  let maxSlot = 0;
  for (const p of players) {
    if (Number.isFinite(p.slot) && p.slot > maxSlot) maxSlot = p.slot;
  }

  const series = [];
  for (let tick = from; tick <= endTick; tick += tickRate) {
    const deadIds = deadPlayersAt(kills, tick);
    const states = new Array(maxSlot + 1).fill(null);
    for (const p of players) {
      if (p.slot == null) continue;
      states[p.slot] = {
        alive: !deadIds.has(p.id),
        health: 100
      };
    }
    const eq = liveEquipment({
      players,
      stats: meta.stats,
      states,
      grenades,
      tick,
      teamSides,
      deadIds
    });
    const decided = decidedSideAt({
      tick,
      endTick,
      winnerSide,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      bomb
    });
    // Kill-log stubs have no FLAG_DEFUSING — plantSituationAt leaves
    // ctDefusing null so the hard no-time-to-defuse cutoff is skipped here.
    const plant = plantSituationAt({
      meta,
      states,
      tick,
      deadIds,
      teamSides,
      players
    });
    const wp = winProbability({
      map: meta.map,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      ctEff: eq.ctEff,
      tEff: eq.tEff,
      ctEquip: eq.CT,
      tEquip: eq.T,
      decided,
      ...plant
    });
    series.push({
      tick,
      ct: wp.ct,
      t: wp.t,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive
    });
  }
  return series;
}

/**
 * @typedef {{ tick: number, side: 'CT'|'T', phase: import('./roundPhases.js').RoundPhase }} RoundDecided
 */

/**
 * Moment the round was decided, or null if it does not meet the criteria.
 * Only meaningful for equal-buy rounds; returns null otherwise.
 *
 * @param {object} meta
 * @returns {RoundDecided|null}
 */
export function findRoundDecided(meta) {
  if (!meta) return null;
  if (!isEqualBuyRound(meta.econ1, meta.econ2)) return null;

  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const winnerSide =
    meta.winnerSide || (meta.winner === 1 ? teamSides[1] : teamSides[2]);
  if (winnerSide !== 'CT' && winnerSide !== 'T') return null;

  const series = winSeriesFromMeta(meta);
  if (!series.length) return null;

  const thr = DECIDED_THRESHOLD;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const side = s.ct >= thr ? 'CT' : s.t >= thr ? 'T' : null;
    if (!side || side !== winnerSide) continue;

    let holds = true;
    for (let j = i; j < series.length; j++) {
      const lead = side === 'CT' ? series[j].ct : series[j].t;
      if (lead < thr) {
        holds = false;
        break;
      }
    }
    if (!holds) continue;

    const bounds = phaseBounds(meta);
    return {
      tick: s.tick,
      side,
      phase: phaseAtTick(s.tick, bounds)
    };
  }
  return null;
}
