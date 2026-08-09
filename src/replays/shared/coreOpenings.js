// ---------------------------------------------------------------------------
// replays/shared/coreOpenings.js
// Core opening attempts (COPATT).
//
// After 1:30 on the round clock, each side's living players are read for a
// core (see coach/cores.js). The first player in that core to kill an enemy
// or die to one is that side's core opener for the round.
// ---------------------------------------------------------------------------

import { findCore } from '../coach/cores.js';
import { secondsAtClock } from '../analytics/roundFacts.js';
import { timingFor } from '../viewer/roundClock.js';

/** Round-clock cut: events before this do not count. */
export const CORE_OPENING_CLOCK = '1:30';

/** Elapsed live seconds at 1:30 remaining (25s into a 1:55 round). */
export const CORE_OPENING_ELAPSED = secondsAtClock(CORE_OPENING_CLOCK);

/**
 * Alive teammates on one side at a tick, shaped for findCore.
 * @param {Array<{id: string, team: number, slot: number}>} roster
 * @param {number} team
 * @param {Array} states  TickTrack.sampleAll result
 */
function aliveOnTeam(roster, team, states) {
  const out = [];
  for (const p of roster) {
    if (p.team !== team) continue;
    const st = states?.[p.slot];
    if (!st?.alive) continue;
    if (!Number.isFinite(st.x) || !Number.isFinite(st.y)) continue;
    out.push({ id: p.id, x: st.x, y: st.y, z: st.z });
  }
  return out;
}

/**
 * Per-side core openers after 1:30.
 *
 * @param {object} meta  round meta (kills, tickRate, freeze…)
 * @param {{ sampleAll: Function, firstTick?: number }} track
 * @param {Array<{id: string, team: number, slot: number}>} roster
 * @returns {{ cok: string[], cod: string[] }}
 */
export function coreOpeningDuels(meta, track, roster) {
  const cok = [];
  const cod = [];
  if (!meta || !track || !Array.isArray(roster) || !roster.length) {
    return { cok, cod };
  }
  if (!Number.isFinite(CORE_OPENING_ELAPSED)) return { cok, cod };

  const timing = timingFor(meta || {});
  const rate = timing.tickRate || 64;
  const minTick = timing.freezeEndTick + CORE_OPENING_ELAPSED * rate;

  const teamOf = new Map(roster.map((p) => [p.id, p.team]));
  const kills = [...(meta.events?.kills || [])]
    .filter((k) => k?.attacker && k?.victim && (k.tick || 0) >= minTick)
    .sort((a, b) => (a.tick || 0) - (b.tick || 0));

  const done = { 1: false, 2: false };

  for (const k of kills) {
    if (done[1] && done[2]) break;
    const at = teamOf.get(k.attacker);
    const vt = teamOf.get(k.victim);
    if (!at || !vt || at === vt) continue;

    // Sample just before the frag so the victim is still alive for core checks.
    const sampleTick = Math.max(track.firstTick || 0, (k.tick || 0) - 1);
    const states = track.sampleAll(sampleTick);

    for (const team of [1, 2]) {
      if (done[team]) continue;
      const alive = aliveOnTeam(roster, team, states);
      const { core } = findCore(alive);
      if (!core.length) continue;
      const inCore = new Set(core);

      if (at === team && inCore.has(k.attacker)) {
        cok.push(k.attacker);
        done[team] = true;
      } else if (vt === team && inCore.has(k.victim)) {
        cod.push(k.victim);
        done[team] = true;
      }
    }
  }

  return { cok, cod };
}
