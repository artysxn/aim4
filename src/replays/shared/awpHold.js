// ---------------------------------------------------------------------------
// Per-player active-weapon hold time for one round (from tick bins).
// Used by Database aKPR (AWP ≥ 10s) and Performance Guns (longest-held gun).
// ---------------------------------------------------------------------------

import { timingFor } from '../viewer/roundClock.js';
import { bareWeapon, isGun } from '../viewer/equipmentIcons.js';

const SCRATCH = {};

/**
 * Sample live-phase ticks (~4 / s) and count hold ticks per gun plus AWP.
 *
 * @param {import('../tickStore.js').TickTrack} track
 * @param {number} slot
 * @param {string[]} weapons  meta.weapons dictionary
 * @param {ReturnType<typeof timingFor>} timing
 * @returns {{ awpTicks: number, guns: Map<string, number>, rate: number }}
 */
export function weaponHoldTicks(track, slot, weapons, timing) {
  const empty = { awpTicks: 0, guns: new Map(), rate: 0 };
  if (!track || slot == null || slot < 0) return empty;
  const dict = weapons || [];
  const rate = timing.tickRate || 64;
  const start = timing.freezeEndTick;
  const end = timing.endTick;
  if (!(end > start) || !(rate > 0)) return empty;
  const step = Math.max(1, Math.round(rate / 4));
  let awpTicks = 0;
  const guns = new Map();
  for (let tick = start; tick <= end; tick += step) {
    const s = track.sample(slot, tick, SCRATCH);
    if (!s.alive) continue;
    const id = bareWeapon(dict[s.weapon]);
    if (!id) continue;
    if (id === 'awp') awpTicks += step;
    if (!isGun(id)) continue;
    guns.set(id, (guns.get(id) || 0) + step);
  }
  return { awpTicks, guns, rate };
}

/** Gun with the most alive hold ticks. Empty when none. */
export function longestHeldGun(guns) {
  let best = '';
  let n = 0;
  for (const [w, c] of guns || []) {
    if (c > n || (c === n && w.localeCompare(best) < 0)) {
      best = w;
      n = c;
    }
  }
  return best;
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
  const { awpTicks, rate } = weaponHoldTicks(track, slot, weapons, timing);
  if (!(rate > 0)) return 0;
  return awpTicks / rate;
}

/**
 * Write `row.aw[playerId]` (AWP seconds, 1 decimal) and `row.hg[playerId]`
 * (gun held longest while alive).
 *
 * @param {object} row
 * @param {object} meta
 * @param {import('../tickStore.js').TickTrack|null} track
 * @param {{ id: string, slot?: number }[]} roster
 */
export function applyAwpHoldFields(row, meta, track, roster) {
  row.aw = {};
  row.hg = {};
  if (!track || !meta || !roster?.length) return;
  const timing = timingFor(meta);
  const weapons = meta.weapons || [];
  for (const who of roster) {
    if (!who?.id || who.slot == null || who.slot < 0) continue;
    const { awpTicks, guns, rate } = weaponHoldTicks(track, who.slot, weapons, timing);
    row.aw[who.id] = rate > 0 ? Math.round((awpTicks / rate) * 10) / 10 : 0;
    const gun = longestHeldGun(guns);
    if (gun) row.hg[who.id] = gun;
  }
}

/** Minimum AWP primary hold (seconds) for a round to count toward aKPR. */
export const AKPR_HOLD_SECONDS = 10;
