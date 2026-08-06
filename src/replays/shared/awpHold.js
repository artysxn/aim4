// ---------------------------------------------------------------------------
// Per-player AWP primary hold time for one round (from tick bins).
// Used by Database aKPR: kills / rounds where the AWP was held ≥ 10s.
// ---------------------------------------------------------------------------

import { timingFor } from '../viewer/roundClock.js';

const SCRATCH = {};

function bareWeapon(weapon) {
  return String(weapon || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '');
}

/**
 * Seconds the slot had the AWP as the active weapon while alive (live phase).
 *
 * @param {import('../tickStore.js').TickTrack} track
 * @param {number} slot
 * @param {string[]} weapons  meta.weapons dictionary
 * @param {ReturnType<typeof timingFor>} timing
 */
export function awpHoldSeconds(track, slot, weapons, timing) {
  if (!track || slot == null || slot < 0) return 0;
  const dict = weapons || [];
  const rate = timing.tickRate || 64;
  const start = timing.freezeEndTick;
  const end = timing.endTick;
  if (!(end > start) || !(rate > 0)) return 0;
  // ~4 samples / second — enough for a 10s threshold without walking every tick.
  const step = Math.max(1, Math.round(rate / 4));
  let holdTicks = 0;
  for (let tick = start; tick <= end; tick += step) {
    const s = track.sample(slot, tick, SCRATCH);
    if (!s.alive) continue;
    if (bareWeapon(dict[s.weapon]) === 'awp') holdTicks += step;
  }
  return holdTicks / rate;
}

/**
 * Write `row.aw[playerId] = holdSeconds` (1 decimal) for every rostered player.
 *
 * @param {object} row
 * @param {object} meta
 * @param {import('../tickStore.js').TickTrack|null} track
 * @param {{ id: string, slot?: number }[]} roster
 */
export function applyAwpHoldFields(row, meta, track, roster) {
  row.aw = {};
  if (!track || !meta || !roster?.length) return;
  const timing = timingFor(meta);
  const weapons = meta.weapons || [];
  for (const who of roster) {
    if (!who?.id || who.slot == null || who.slot < 0) continue;
    const sec = awpHoldSeconds(track, who.slot, weapons, timing);
    row.aw[who.id] = Math.round(sec * 10) / 10;
  }
}

/** Minimum AWP primary hold (seconds) for a round to count toward aKPR. */
export const AKPR_HOLD_SECONDS = 10;
