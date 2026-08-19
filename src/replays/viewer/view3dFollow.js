// ---------------------------------------------------------------------------
// Who the 3D timeline camera follows after the current POV dies.
//
// Playback holds the death eye for DEATH_FOLLOW_SECONDS of demo time, then
// this picks the next slot. Killer if they are still up; otherwise the same
// next-live fallback applyFrame used when the switch was instant.
// ---------------------------------------------------------------------------

export const DEATH_FOLLOW_SECONDS = 0.5;

/**
 * True when this frame is a seek / first sample, not playback through a death.
 * Matches applyFrame's animation window: more than a quarter second, or back.
 */
export function deathFollowShouldSnap(lastTick, tick, tickRate) {
  if (lastTick === null) return true;
  const dTicks = tick - lastTick;
  return dTicks < 0 || dTicks > tickRate / 4;
}

/**
 * Slot to watch after `deadSlot` dies.
 * @param {number} deadSlot
 * @param {number[]} live
 * @param {{ players?: { id: string, slot: number }[], kills?: { attacker?: string, victim?: string, tick?: number }[], tick?: number }} [opts]
 */
export function nextFollowSlot(deadSlot, live, { players = [], kills = [], tick = 0 } = {}) {
  if (!live.length) return deadSlot;
  const killer = killerSlotOf(deadSlot, players, kills, tick);
  if (killer != null && killer !== deadSlot && live.includes(killer)) return killer;
  return live.find((s) => s > deadSlot) ?? live[0];
}

function killerSlotOf(deadSlot, players, kills, tick) {
  if (!players.length || !kills.length) return null;
  const victim = players.find((p) => p.slot === deadSlot);
  if (!victim?.id) return null;
  let best = null;
  for (const k of kills) {
    if (k.victim !== victim.id) continue;
    if (!k.attacker || k.attacker === k.victim) continue;
    const at = k.tick || 0;
    if (at > tick) continue;
    if (!best || at >= (best.tick || 0)) best = k;
  }
  if (!best) return null;
  const att = players.find((p) => p.id === best.attacker);
  return att != null ? att.slot : null;
}
