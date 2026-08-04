// ---------------------------------------------------------------------------
// replays/duels/reloadTracker.js
// Estimated magazine state, rebuilt from weapon_fire events.
//
// APPROXIMATION, deliberately. The tick format carries no ammo count and no
// reload flag, so the only evidence a demo leaves of a magazine is the stream
// of shots that emptied it. Counting those shots gets the big, decisive cases
// right: the player who just dumped thirty rounds and is holding an empty
// rifle, and the AWPer who fired one second ago and is still cycling the bolt.
//
// What it cannot see:
//   - reloads a player chose to do before the magazine ran dry, except through
//     the idle heuristic below
//   - guns picked up off the ground mid-round, which arrive part-used
//   - the reload a player cancelled by switching weapons
//
// So the numbers here are inputs to a learned weight, never a verdict. If the
// signal is as noisy as its worst case, training is free to drive that weight
// to zero, and the honest thing is to let it.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { isGun } from '../viewer/equipmentIcons.js';
import { weaponInfo } from '../shared/weaponTable.js';

/**
 * A gap this long between two shots from the same gun is taken as a reload.
 *
 * Players top up constantly between engagements, and assuming otherwise makes
 * every second contact of a round look like it was fought on a half magazine.
 * Six seconds is longer than any reload in the game and short enough that a
 * player who crossed the map is credited with the reload they certainly did.
 */
const IDLE_REFILL_SECONDS = 6;

/**
 * Estimated magazine and firing state per player per weapon.
 *
 * @param {object} args
 * @param {object} args.meta   round meta, for events and tickRate
 * @returns {{ stateAt: (playerId: string, weaponName: string, tick: number) => {
 *   reloading: boolean, magFraction: number, sinceShot: number
 * } }}
 */
export function createReloadTracker({ meta }) {
  const tickRate = meta?.tickRate || 64;
  /** key `player|weapon` -> ascending shot chain */
  const chains = new Map();

  const shots = meta?.events?.shots || [];
  // weapon_fire covers grenade throws too, and a thrown smoke is not a round
  // out of a magazine.
  const ordered = shots
    .filter((s) => s && s.player && isGun(s.weapon))
    .sort((a, b) => (a.tick || 0) - (b.tick || 0));

  for (const shot of ordered) {
    const info = weaponInfo(shot.weapon);
    const key = `${shot.player}|${info.id}`;
    let chain = chains.get(key);
    if (!chain) {
      chain = { info, ticks: [], magAfter: [], reloadFrom: [], reloadTo: [] };
      chains.set(key, chain);
    }

    const tick = shot.tick || 0;
    const n = chain.ticks.length;
    let remaining = n ? chain.magAfter[n - 1] : info.magSize;
    if (n && (tick - chain.ticks[n - 1]) / tickRate > IDLE_REFILL_SECONDS) {
      remaining = info.magSize;
    }

    remaining -= 1;
    let reloadFrom = 0;
    let reloadTo = 0;
    if (remaining <= 0) {
      // The reload starts once the shot that emptied the gun has cycled.
      reloadFrom = tick + info.cycleSeconds * tickRate;
      reloadTo = reloadFrom + info.reloadSeconds * tickRate;
      remaining = info.magSize;
    }

    chain.ticks.push(tick);
    chain.magAfter.push(remaining);
    chain.reloadFrom.push(reloadFrom);
    chain.reloadTo.push(reloadTo);
  }

  /** Index of the last shot at or before `tick`, or -1. */
  function lastShotIndex(ticks, tick) {
    let lo = 0;
    let hi = ticks.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid] <= tick) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  return {
    /**
     * @returns {{ reloading: boolean, magFraction: number, sinceShot: number }}
     *   `sinceShot` is seconds since this player last fired this weapon, and is
     *   Infinity when they have not fired it yet.
     */
    stateAt(playerId, weaponName, tick) {
      const info = weaponInfo(weaponName);
      const chain = chains.get(`${playerId}|${info.id}`);
      if (!chain) return { reloading: false, magFraction: 1, sinceShot: Infinity };

      const i = lastShotIndex(chain.ticks, tick);
      if (i < 0) return { reloading: false, magFraction: 1, sinceShot: Infinity };

      const sinceShot = (tick - chain.ticks[i]) / tickRate;
      if (sinceShot > IDLE_REFILL_SECONDS) {
        return { reloading: false, magFraction: 1, sinceShot };
      }
      const reloading = chain.reloadTo[i] > 0 && tick >= chain.reloadFrom[i] && tick < chain.reloadTo[i];
      const magSize = chain.info.magSize || 1;
      return {
        reloading,
        magFraction: Math.max(0, Math.min(1, chain.magAfter[i] / magSize)),
        sinceShot
      };
    }
  };
}
