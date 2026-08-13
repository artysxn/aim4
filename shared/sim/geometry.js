// ---------------------------------------------------------------------------
// shared/sim/geometry.js
// Trades, spacing, crossfires: the arithmetic of playing as five.
//
// SIM-PLAN 6.12. Five individually sensible bots lose to any real team,
// because CS is won by trades and nothing in an individual's price knows a
// teammate exists. This module is that knowledge, as geometry:
//
//   tradeCover     an entry with a teammate who can contest the killer inside
//                  the trade window is a DIFFERENT ACTION from the same entry
//                  without one, and they must not price identically
//   spacingPenalty a price, not a leash: bots may stack deliberately when it
//                  is right, they just pay for it
//   crossfireScore watcherSpreadDeg read backwards — the fitted model says a
//                  wide spread cannot be answered, so CT setups are built by
//                  maximizing the spread an entering enemy faces
//
// Everything is a pure function over positions and hooks; nothing reads the
// engine. The arbiter folds these into an option's price (6.7 step 5), the
// reward gets a matching term (9.5), and the eval gets a trade-rate band with
// coach-rule counterparts (`no-trade-attempt`, `trade-failure`).
// ---------------------------------------------------------------------------

import { watcherSpreadDeg } from '../../src/replays/duels/duelSnapshot.js';
import { bearingDeg } from '../../src/replays/duels/visionState.js';

/** Seconds inside which a death can still be answered. `[mine from the library]` */
export const TRADE_WINDOW_SECONDS = 2;

/**
 * Geodesic separation bands per task, world units. Inside `min` two bots are
 * one grenade; beyond `max` they are two lone players. `[calibrate against the
 * spacing coach rule's thresholds]`
 */
export const SPACING = Object.freeze({
  default: { min: 180, max: 1400 },
  execute: { min: 140, max: 700 },
  hold: { min: 220, max: 1800 },
  retake: { min: 140, max: 900 },
  lurk: { min: 600, max: Infinity }
});

/**
 * Can `mate` contest a kill happening at `killerSpot` inside the trade window?
 *
 * Two ways to have cover: the mate already holds a line to the killer's
 * ground, or the mate can reach such a line in time. Both are questions the
 * angle catalogue and the nav graph already answer; this composes them.
 *
 * @param {object} args
 * @param {{x:number, y:number, level?:string}} args.killerSpot  where the killer fires from
 * @param {{x:number, y:number, level?:string}} args.mate        the would-be trader
 * @param {(ax,ay,bx,by, level:string) => boolean} args.canSee
 * @param {(from:object, to:object) => number} [args.travelSeconds]
 *        geodesic time for the mate to gain the line; omitted = LOS only
 * @returns {{covered: boolean, how: 'line'|'reach'|null, seconds: number}}
 */
export function tradeCover({ killerSpot, mate, canSee, travelSeconds = null }) {
  const level = killerSpot.level || 'default';
  if ((mate.level || 'default') === level && canSee(mate.x, mate.y, killerSpot.x, killerSpot.y, level)) {
    return { covered: true, how: 'line', seconds: 0 };
  }
  if (travelSeconds) {
    const s = travelSeconds(mate, killerSpot);
    if (Number.isFinite(s) && s <= TRADE_WINDOW_SECONDS) {
      return { covered: true, how: 'reach', seconds: s };
    }
  }
  return { covered: false, how: null, seconds: Infinity };
}

/**
 * The spacing cost of standing `separation` units from the nearest teammate,
 * in [0, 1]: zero inside the band, rising quadratically outside it. Quadratic
 * so a small violation is almost free — stacking for a purpose stays cheap —
 * and a gross one is not.
 *
 * @param {number} separation  geodesic units to the nearest relevant teammate
 * @param {keyof SPACING | {min:number, max:number}} [task]
 */
export function spacingPenalty(separation, task = 'default') {
  const band = typeof task === 'string' ? SPACING[task] || SPACING.default : task;
  if (!Number.isFinite(separation)) return band.max === Infinity ? 0 : 1;
  if (separation >= band.min && separation <= band.max) return 0;
  const off =
    separation < band.min
      ? (band.min - separation) / band.min
      : (separation - band.max) / band.max;
  return Math.min(1, off * off * 4);
}

/**
 * The spread an enemy entering at `corridor` faces from these held spots, in
 * degrees. This is `watcherSpreadDeg` from the duel pipeline, read backwards:
 * the model fitted `spreadW` on real fights, so "place my five so an entering
 * T faces the widest spread we can build" prices CT setups with a term that
 * means something. Spots without a line onto the corridor contribute nothing.
 *
 * @param {Array<{x:number, y:number, level?:string}>} spots  held positions
 * @param {{x:number, y:number, level?:string}} corridor      the entry point
 * @param {(ax,ay,bx,by, level:string) => boolean} canSee
 * @returns {{spreadDeg: number, watchers: number}}
 */
export function crossfireScore(spots, corridor, canSee) {
  const level = corridor.level || 'default';
  const bearings = [];
  for (const s of spots) {
    if ((s.level || 'default') !== level) continue;
    if (!canSee(s.x, s.y, corridor.x, corridor.y, level)) continue;
    bearings.push(bearingDeg(corridor.x, corridor.y, s.x, s.y));
  }
  return { spreadDeg: watcherSpreadDeg(bearings), watchers: bearings.length };
}

/**
 * Which of two placements builds the better crossfire over a set of expected
 * entry corridors? The placement question is just the score summed where the
 * belief says entries happen; two bots holding the same angle from the same
 * depth — the most common bad bot behavior in every FPS ever shipped — scores
 * near zero and loses to anything.
 *
 * @param {Array<{x:number, y:number, level?:string}>} spots
 * @param {Array<{point: object, mass: number}>} corridors  entry points with belief mass
 * @param {(ax,ay,bx,by, level:string) => boolean} canSee
 * @returns {number} mass-weighted spread, degrees
 */
export function placementScore(spots, corridors, canSee) {
  let total = 0;
  for (const c of corridors) {
    const { spreadDeg, watchers } = crossfireScore(spots, c.point, canSee);
    // One watcher is a duel, not a crossfire; spread only exists from two up,
    // but a single covered corridor still beats an uncovered one.
    total += c.mass * (watchers > 0 ? 15 + spreadDeg : 0);
  }
  return total;
}
