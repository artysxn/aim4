// ---------------------------------------------------------------------------
// Per-player PSDT + raw distance travelled for one round (from tick bins).
// ---------------------------------------------------------------------------

import { timingFor } from '../viewer/roundClock.js';
import { pathDistance, pulledStringDistance } from './roleMetrics.js';

const SCRATCH = {};

/**
 * Sample an alive path through the live phase (until plant or round end).
 * @param {import('../tickStore.js').TickTrack} track
 * @param {number} slot
 * @param {object} timing
 * @param {number} strideTicks
 */
function samplePath(track, slot, timing, strideTicks) {
  const out = [];
  const start = timing.freezeEndTick;
  const end =
    Number.isFinite(timing.plantTick) && timing.plantTick
      ? Math.min(timing.endTick, timing.plantTick)
      : timing.endTick;
  const step = Math.max(1, strideTicks | 0);
  for (let tick = start; tick <= end; tick += step) {
    const s = track.sample(slot, tick, SCRATCH);
    out.push({ x: s.x, y: s.y, alive: Boolean(s.alive) });
  }
  return out;
}

/**
 * Write `row.mv[playerId] = { psdt, dt }` for every rostered player.
 *
 * @param {object} row  stats index row
 * @param {object} meta round meta
 * @param {import('../tickStore.js').TickTrack} track
 * @param {{ id: string, slot?: number }[]} roster
 */
export function applyMovementFields(row, meta, track, roster) {
  row.mv = {};
  if (!track || !meta || !roster?.length) return;

  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const stride = Math.max(1, Math.round(rate / 2));

  for (const who of roster) {
    if (who.slot == null || who.slot < 0 || !who.id) continue;
    const path = samplePath(track, who.slot, timing, stride);
    const psdt = pulledStringDistance(path);
    const dt = pathDistance(path);
    row.mv[who.id] = {
      psdt: Math.round(psdt),
      dt: Math.round(dt)
    };
  }
}
