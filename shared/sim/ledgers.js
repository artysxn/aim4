// ---------------------------------------------------------------------------
// shared/sim/ledgers.js
// The four ledgers: utility, zones, threat, timing.
//
// Chapter 9 of the doctrine says to track four things and to read them at 0:50
// and 0:30. That is a gift to this project, because it is a small, fixed,
// interpretable, MAP-INDEPENDENT feature block, which is exactly what a small
// network needs and exactly what the observation space lacked at the macro
// level (SIM-PLAN 20.4).
//
// Map-independent is the load-bearing word. "How many zones do we hold, how
// much heavy utility is left, which site can they convert soonest, who wins the
// race to the contested ground" are the same four questions on every map, so a
// policy learns the theory once rather than learning seven vocabularies.
//
// These are also the natural fields for the situation key (18.2), which is what
// makes a memory row sayable: "we are late on the timing ledger with a negative
// utility ledger against a 3-2" is a sentence.
// ---------------------------------------------------------------------------

import { TICK_RATE } from './constants.js';
import { zoneLedger } from './zones.js';

/** The doctrine's reading clocks, in seconds remaining. */
export const LEDGER_CLOCKS = Object.freeze([50, 30]);

/** Heavy utility wins late rounds; light utility buys tempo. Chapter 2. */
export const HEAVY = new Set(['smokegrenade', 'molotov', 'incgrenade']);
export const LIGHT = new Set(['flashbang', 'hegrenade', 'decoy']);

/**
 * Utility ledger: what each side has left, and how the balance is trending.
 *
 * Ours is exact, theirs is believed. The asymmetry is the point: a team that
 * knows precisely what it has and roughly what the enemy has is in the position
 * a real team is in, and the late-round decision (chapter 11: whoever reaches
 * 0:35 with the better heavy utility usually wins) is made on that footing.
 */
export function utilityLedger({ ours, theirs, spentByUs = 0, spentByThem = 0 }) {
  const count = (inv, set) => inv.filter((g) => set.has(g)).length;
  const ourHeavy = count(ours, HEAVY);
  const theirHeavy = count(theirs, HEAVY);
  return {
    ourHeavy,
    ourLight: count(ours, LIGHT),
    theirHeavy,
    theirLight: count(theirs, LIGHT),
    /** Positive means we are ahead on the resource that decides late rounds. */
    heavyBalance: ourHeavy - theirHeavy,
    spentByUs,
    spentByThem
  };
}

/**
 * Threat ledger: for each site, how close the enemy is to ending the round.
 *
 * Chapter 5 defines a threat as proximity to round loss rather than noise, and
 * insists it is not a body count: four Ts in a zone they cannot convert from
 * are a smaller threat than one lurker who has reached a position that matters.
 * So the ledger carries belief counts AND conversion time, and the second one
 * is what ranks them.
 */
export function threatLedger({ sites, countDist, secondsToConvert }) {
  return sites.map((site) => {
    const d = countDist(site);
    let expected = 0;
    for (let i = 0; i < d.length; i += 1) expected += i * d[i];
    const seconds = secondsToConvert(site);
    return {
      site,
      expected,
      pEmpty: d[0],
      pAtMostOne: d[0] + d[1],
      secondsToConvert: seconds,
      // Proximity to round loss: bodies that can convert soon outrank bodies
      // that cannot convert at all.
      threat: Number.isFinite(seconds) ? expected / Math.max(1, seconds) : 0
    };
  }).sort((a, b) => b.threat - a.threat);
}

/**
 * Timing ledger: who beats whom to the ground that is still contested.
 *
 * Straight out of the baked `earliestOccupy` tables, combined with the live
 * clock. A negative edge means they get there first, which is the difference
 * between a timing push and a walk into a set crossfire.
 */
export function timingLedger({ contested, ourEta, theirEta }) {
  return contested
    .map((zone) => {
      const ours = ourEta(zone);
      const theirs = theirEta(zone);
      return {
        zone,
        ourEta: ours,
        theirEta: theirs,
        /** Positive: we win the race. */
        edge: Number.isFinite(ours) && Number.isFinite(theirs) ? theirs - ours : 0
      };
    })
    .sort((a, b) => b.edge - a.edge);
}

/**
 * All four, at one moment. This is the block that joins the observation vector
 * and the situation key.
 */
export function readLedgers({ classification, utility, threat, timing, tick, liveTick, roundSeconds }) {
  const elapsed = (tick - liveTick) / TICK_RATE;
  return {
    clock: Math.max(0, roundSeconds - elapsed),
    zone: zoneLedger(classification),
    utility,
    threat,
    timing
  };
}

/**
 * Is this the moment the doctrine says to read?
 *
 * Snapshots rather than a continuous feed, because the value of the ledgers is
 * as a decision anchor: chapter 9 reads them at 0:50 and 0:30 precisely because
 * those are the moments before and after the mid-round commitment, and a
 * reading taken every tick is a number nobody acts on.
 */
export function isLedgerClock(secondsLeft, lastRead = Infinity) {
  for (const c of LEDGER_CLOCKS) {
    if (secondsLeft <= c && lastRead > c) return c;
  }
  return null;
}
