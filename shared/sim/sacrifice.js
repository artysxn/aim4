// ---------------------------------------------------------------------------
// shared/sim/sacrifice.js
// When to run at a death you expect.
//
// SIM-PLAN 19.9. The brief's hardest question, and the naive implementation
// (reward the bot for dying usefully) is reward hacking with a bow on it.
// Willingness is `deathPermission` (6.19), but the clause that matters is that
// it is GATED ON THE GEOMETRY THAT MAKES THE DEATH PRODUCTIVE, never on
// courage. If `tradeCover` is false the death buys nothing: that is a donation,
// not a sacrifice, and the difference is computable BEFORE the peek.
//
// The plan writes the gate as one conjunction:
//
//   sacrificeIsPriced(entry) iff
//       tradeCover(entrySpot, partnerSpot) holds inside the trade window, AND
//       the partner's arrival lands inside the killer's exposure window, AND
//       dPRW( P(die)·[traded + space + information] + P(live)·[entry won] )
//           > dPRW(wait)  and  > dPRW(reroute)
//
// The dPRW of dying (`dPRWdie`) and of living (`dPRWlive`) are already computed
// by the caller. This file adds them and asks the two inequalities. It never
// invents a third term that pays for the corpse.
//
// THE WINDOW. The killer's post-kill state is known and decaying: an AWP
// cycling for about 1.4 s (already a trigger in 6.15), a rifle in recoil
// recovery, a crosshair committed to a corpse. `refragArmed` is that timer.
// It is what forces skip-every-other-angle through 19.4's inequality rather
// than through a special case: with a window this short, no plausible VOI
// beats looking elsewhere, so the bot pre-aims the killer's most likely cell.
//
// THE CORPSE CONSTRAINT lives on JointBelief.deathRecord. Nothing here
// reimplements it. `killerLosPredicate` is only the catalogue adapter that
// builds the `canSeeFrom(anchor, level)` the belief already consumes.
//
// THE ANTI-FEEDING DEFENCE IS THE GRADE, NOT THE REWARD. Nothing here adds a
// reward term for dying, and nothing should: under a shared team reward with
// team spirit annealed toward selfless (9.10), a bot that is paid to die will
// find a way to die. Untraded-death rate and contract compliance are already
// scorecard metrics (9.17); a team that learned to feed passes Elo and fails
// teamwork, loudly.
//
// Pure: no I/O, no clock, no rng. Geometry in, a priced-or-donation sentence
// out. The same peek always gets the same answer.
// ---------------------------------------------------------------------------

import { TICK_RATE } from './constants.js';
import { tradeCover, TRADE_WINDOW_SECONDS } from './geometry.js';

export { TRADE_WINDOW_SECONDS };

/** AWP cycle / rifle recovery. The killer's post-kill exposure. `[calibrate]` */
export const KILLER_WINDOW_SECONDS = 1.4;

/**
 * The geometry gate, delegated to 6.12. A sacrifice without this is a donation.
 *
 * @param {object} args  the same argument object `tradeCover` takes
 */
export function coverForSacrifice(args) {
  return tradeCover(args);
}

function coveredOf(tradeCovered, geometry) {
  if (tradeCovered && typeof tradeCovered === 'object' && 'covered' in tradeCovered) {
    return !!tradeCovered.covered;
  }
  if (tradeCovered != null) return !!tradeCovered;
  if (geometry.killerSpot && geometry.mate && typeof geometry.canSee === 'function') {
    return tradeCover({
      killerSpot: geometry.killerSpot,
      mate: geometry.mate,
      canSee: geometry.canSee,
      travelSeconds: geometry.travelSeconds
    }).covered;
  }
  return false;
}

/**
 * Is this peek a sacrifice, or a donation?
 *
 * `dPRWdie` is P(die)·[traded + space + information], already computed.
 * `dPRWlive` is P(live)·[entry won]. Their sum is the peek; it must strictly
 * beat both waiting and rerouting. Equality is a no, because a death that
 * does not improve the round is not priced, it is hoped.
 *
 * @param {object} args
 * @param {boolean|{covered:boolean}} [args.tradeCovered]
 * @param {number} args.partnerArrivalSeconds
 * @param {number} [args.killerWindowSeconds]
 * @param {number} [args.dPRWdie]
 * @param {number} [args.dPRWlive]
 * @param {number} [args.dPRWwait]
 * @param {number} [args.dPRWreroute]
 * @returns {{priced: boolean, motive: string, value: number, donation: boolean}}
 */
export function sacrificeIsPriced({
  tradeCovered,
  partnerArrivalSeconds,
  killerWindowSeconds = KILLER_WINDOW_SECONDS,
  dPRWdie = 0,
  dPRWlive = 0,
  dPRWwait = 0,
  dPRWreroute = 0,
  killerSpot,
  mate,
  canSee,
  travelSeconds
} = {}) {
  const covered = coveredOf(tradeCovered, { killerSpot, mate, canSee, travelSeconds });
  if (!covered) {
    return {
      priced: false,
      donation: true,
      value: 0,
      motive: 'no trade cover: that is a donation, not a sacrifice'
    };
  }

  const window = Number.isFinite(killerWindowSeconds) ? killerWindowSeconds : KILLER_WINDOW_SECONDS;
  const arrival = Number.isFinite(partnerArrivalSeconds) ? partnerArrivalSeconds : Infinity;
  if (arrival > window) {
    return {
      priced: false,
      donation: false,
      value: dPRWdie + dPRWlive,
      motive: `partner arrives after the killer window (${window}s)`
    };
  }

  const peek = dPRWdie + dPRWlive;
  const beatsWait = peek > dPRWwait;
  const beatsReroute = peek > dPRWreroute;
  const priced = beatsWait && beatsReroute;
  let motive;
  if (priced) {
    motive = 'sacrifice is priced: trade cover, partner inside the killer window, peek beats wait and reroute';
  } else if (!beatsWait) {
    motive = 'peek does not beat waiting';
  } else {
    motive = 'peek does not beat rerouting';
  }
  return { priced, donation: false, value: peek, motive };
}

/**
 * True while the killer's post-kill window is still open.
 *
 * `tick` and `deathTick` are engine ticks. The window is seconds, converted
 * here so a caller who has the death event does not have to.
 *
 * @param {object} args
 * @param {number} args.tick
 * @param {number} args.deathTick
 * @param {number} [args.windowSeconds]
 */
export function refragArmed({ tick, deathTick, windowSeconds = KILLER_WINDOW_SECONDS } = {}) {
  if (!Number.isFinite(tick) || !Number.isFinite(deathTick)) return false;
  const elapsed = tick - deathTick;
  if (elapsed < 0) return false;
  const seconds = Number.isFinite(windowSeconds) ? windowSeconds : KILLER_WINDOW_SECONDS;
  return elapsed / TICK_RATE < seconds;
}

/**
 * Catalogue adapter for JointBelief.deathRecord's `canSeeFrom`.
 *
 * The belief already owns the hard likelihood. This only answers "from this
 * hypothesized anchor, did the killer have a line to the corpse?", using the
 * catalogue shape `{ canSee(ax,ay,bx,by,level), nearestAnchor, anchor }`.
 *
 * @param {{canSee: Function, anchor?: Function, byAnchor?: Map, entries?: Array}} catalogue
 * @param {{x:number, y:number, level?: string}} victimPos
 * @returns {(anchor: string, level: string) => boolean}
 */
export function killerLosPredicate(catalogue, victimPos) {
  const vx = victimPos.x;
  const vy = victimPos.y;
  return (anchor, level = 'default') => {
    const world = worldOfAnchor(catalogue, anchor, level);
    if (!world) return false;
    return !!catalogue.canSee(world.x, world.y, vx, vy, world.level || level);
  };
}

function worldOfAnchor(catalogue, id, level) {
  if (typeof catalogue.anchor === 'function') {
    const a = catalogue.anchor(id, level);
    if (!a) return null;
    return { x: a.x ?? a.world?.x, y: a.y ?? a.world?.y, level: a.level || level };
  }
  if (catalogue.byAnchor && catalogue.entries) {
    const list = catalogue.byAnchor.get(id);
    if (!list || !list.length) return null;
    const e = catalogue.entries[list[0]];
    return { x: e.world.x, y: e.world.y, level: e.level };
  }
  return null;
}
