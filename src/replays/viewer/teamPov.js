// ---------------------------------------------------------------------------
// replays/viewer/teamPov.js
// The viewer, restricted to what one team actually knew.
//
// The normal round viewer is omniscient: every droplet, every name, every gun,
// on both sides, at once. That is the right default for analysis and the wrong
// one for asking "was that rotate reasonable with what they had". This module
// is the difference between the two.
//
// Two things are restricted, and they are restricted differently:
//
//   players     an enemy exists on screen only while someone on the chosen team
//               has them in view, and then only as a droplet. Name, gun and HP
//               are things a teammate's callout gives you, not the radar.
//   possession  only the chosen team's own control is painted. Territory the
//               other side is taking is not information this team has; the map
//               going quiet is what losing control looks like from the inside.
//
// Vision is the same geometry the duel model uses (real 16:9 FOV, line of sight
// through the zone network, smokes block), so a POV frame and a duel pairing
// never disagree about who can see whom.
//
// DOM-free. The renderer is handed a side and a set of slots; it does not know
// how either was decided.
// ---------------------------------------------------------------------------

import { blockingSmokesAt, getBlockedMask } from '../duels/sightRay.js';
import { pairVision } from '../duels/visionState.js';

/**
 * How long an enemy stays drawn after the last frame anyone could see them.
 *
 * Not a fudge of the vision test: a crosshair sweeps past a doorway several
 * times a second, and a droplet that strictly followed it would flicker so hard
 * the mode would be unusable. This is the same idea as the game's own radar
 * holding a spotted enemy for a moment, and it is short enough that a player
 * who has genuinely broken contact is gone.
 */
export const POV_MEMORY_SECONDS = 0.75;

/**
 * Per-round vision memory for the POV mode.
 *
 * Seeking backwards invalidates it — a "last seen" tick in the future is not a
 * memory, it is a leak — so the tracker throws the whole thing away rather than
 * trying to be clever about it.
 */
export function createPovVision() {
  /** slot -> last tick anyone on the POV side had them in view */
  let lastSeen = new Map();
  let lastTick = -Infinity;
  let key = '';

  return {
    reset() {
      lastSeen = new Map();
      lastTick = -Infinity;
      key = '';
    },

    /**
     * Enemy slots the POV side can see at this tick.
     *
     * @param {object} args
     * @param {object} args.meta        round meta (players, sides, grenades)
     * @param {Array} args.states       per-slot tick states
     * @param {object|null} args.network  prepared zone network
     * @param {string} args.mapCode
     * @param {number} args.tick
     * @param {number} args.tickRate
     * @param {'T'|'CT'} args.povSide
     * @param {string} [args.roundKey]  changing it drops the memory
     * @returns {Set<number>} enemy slots to draw
     */
    seenAt({ meta, states, network, mapCode, tick, tickRate = 64, povSide, roundKey = '' }) {
      const out = new Set();
      if (!meta || !states || (povSide !== 'T' && povSide !== 'CT')) return out;

      if (roundKey !== key || tick < lastTick) {
        lastSeen = new Map();
        key = roundKey;
      }
      lastTick = tick;

      const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
      const mine = [];
      const theirs = [];
      for (const p of meta.players || []) {
        const s = states[p.slot];
        if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
        const side = s.side || teamSides[p.team];
        (side === povSide ? mine : theirs).push({ slot: p.slot, s });
      }
      if (!theirs.length) return out;

      const memory = POV_MEMORY_SECONDS * tickRate;
      if (mine.length) {
        // Hoisted: every pair below rasterises against the same mask, and
        // resolving it per pair is the whole cost of this function.
        const blockedMask = network ? getBlockedMask(network, mapCode) : null;
        const smokes = blockingSmokesAt(meta.events?.grenades, tick, tickRate);
        for (const foe of theirs) {
          // Inside the hold from an earlier frame. The geometry still runs
          // below: it is what keeps the hold refreshed while contact lasts.
          if (tick - (lastSeen.get(foe.slot) ?? -Infinity) <= memory) out.add(foe.slot);
          let seen = false;
          for (const me of mine) {
            if (!Number.isFinite(me.s.yaw)) continue;
            const v = pairVision({
              a: me.s,
              b: foe.s,
              network,
              mapCode,
              smokes,
              blockedMask
            });
            if (v.aSeesB) {
              seen = true;
              break;
            }
          }
          if (!seen) continue;
          lastSeen.set(foe.slot, tick);
          out.add(foe.slot);
        }
      } else {
        // Nobody left alive to see anything. The hold still runs out on its own
        // rather than blinking every enemy off the instant the last one dies.
        for (const foe of theirs) {
          if (tick - (lastSeen.get(foe.slot) ?? -Infinity) <= memory) out.add(foe.slot);
        }
      }
      return out;
    }
  };
}

/**
 * The duel network, seen from one side.
 *
 * A pair line runs between two players, so drawing one to an enemy nobody can
 * see hands back the position the droplet was withheld to protect. Sight rays
 * and xK badges are per player and go the same way.
 *
 * @param {object|null} overlay  from duelOverlay.compute
 * @param {'T'|'CT'} povSide
 * @param {Set<number>} seen     enemy slots currently in view
 */
export function povDuelOverlay(overlay, povSide, seen) {
  if (!overlay) return overlay;
  const shown = (side, slot) => side === povSide || seen?.has(slot);
  const lines = (overlay.lines || []).filter(
    (l) => shown(l.aSide, l.aSlot) && shown(l.bSide, l.bSlot)
  );
  const hover = overlay.hover && lines.includes(overlay.hover) ? overlay.hover : null;
  return {
    ...overlay,
    lines,
    rays: (overlay.rays || []).filter((r) => shown(r.side, r.slot)),
    xk: (overlay.xk || []).filter((x) => shown(x.side, x.slot)),
    hover,
    showPercent: Boolean(hover)
  };
}

/**
 * The possession overlay, seen from one side.
 *
 * Territory, view cones and foot markers all exist per side already, so this is
 * a filter rather than a second computation. Contested ground is dropped with
 * the enemy's: "someone is contesting this" is exactly the knowledge the mode
 * is withholding.
 *
 * @param {object|null} paint  from computeZonePaint
 * @param {'T'|'CT'} povSide
 */
export function povZonePaint(paint, povSide) {
  if (!paint) return paint;
  const mineKey = povSide === 'CT' ? 'ct' : 't';
  const theirsKey = povSide === 'CT' ? 't' : 'ct';
  return {
    ...paint,
    territory: {
      [mineKey]: paint.territory?.[mineKey] || [],
      [theirsKey]: [],
      contested: []
    },
    cones: {
      [mineKey]: paint.cones?.[mineKey] || [],
      [theirsKey]: []
    },
    feet: {
      [mineKey]: paint.feet?.[mineKey] || [],
      [theirsKey]: []
    }
  };
}
