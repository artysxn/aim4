// ---------------------------------------------------------------------------
// shared/sim/observe.js
// The observation vector: what one bot may know, as numbers, versioned.
//
// SIM-PLAN 7.1's design rules, applied: everything here is readable from the
// bot's own side — self state, teammates (the team blackboard), the BELIEF's
// summaries (never enemy truth), the public clock and feed. The version stamp
// travels with every dataset and every trained model, because a policy fed a
// vector laid out for a different version fails silently and confidently.
//
// Small does not mean careless: the blocks are fixed-order, fixed-width,
// zero-padded, and every value is normalized to about [-1, 1] so the trainer
// never learns the units.
// ---------------------------------------------------------------------------

/**
 * 1  self / round / bodies / belief / teammates / recency
 * 2  + the doctrine block (20.4): zone classes, the four ledgers
 * 3  + the visualization block (19.12): typed threat, budget, pair, request
 *
 * A model carries the version it was trained on and policy.js refuses a
 * mismatch loudly, so bumping this invalidates every model rather than quietly
 * feeding a net a vector it cannot read.
 */
export const OBSERVE_VERSION = 3;

/** World units the position features normalize against (radar world span). */
const WORLD_SCALE = 4096;
/** Equipment average the economy features normalize against. */
const EQUIP_NORM = 5500;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Weapon classes the self block one-hots. Order is part of the version. */
export const WEAPON_CLASSES = Object.freeze(['pistol', 'smg', 'rifle', 'sniper', 'other']);

/** Fixed layout: block name -> width. Order is part of the version. */
export const OBSERVATION_BLOCKS = Object.freeze([
  ['self', 12],
  ['round', 6],
  ['bodies', 2],
  ['belief', 6],
  ['teammates', 12],
  ['recency', 2],
  // The doctrine block (SIM-PLAN 20.4). Small, fixed, interpretable, and
  // MAP-INDEPENDENT, which is the property that matters: "how many zones do we
  // hold, how much heavy utility is left, which site can they convert soonest,
  // who wins the race to the contested ground" are the same four questions on
  // every map, so a policy learns the theory once instead of learning seven
  // vocabularies.
  ['doctrine', 12],
  // 19.12: joint-belief extras, typed threat, VOI budget, pair, request.
  // Absent viz reads as zeros, same contract as doctrine.
  ['viz', 16]
]);

export const OBSERVATION_SIZE = OBSERVATION_BLOCKS.reduce((s, [, w]) => s + w, 0);

/**
 * Build one bot's observation at one decision step.
 *
 * @param {object} args
 * @param {object} args.me        {x, y, hp, armor, helmet, weaponClass, hasBomb, side}
 * @param {object} args.round     {elapsed, secondsLeft, planted, bombSecondsLeft,
 *                                 myEquipAvg, enemyEquipAvgBelieved}
 * @param {number} args.myAlive
 * @param {number} args.enemyAliveBelieved
 * @param {object} args.belief    {siteExpected: [a, b], sitePEmpty: [a, b],
 *                                 splitEntropy, threatAtMe}  — summaries, 5.5
 * @param {Array<{dx:number, dy:number, hp:number}>} args.teammates  living, ≤4
 * @param {object} args.recency   {sinceSeenSeconds, sinceHeardSeconds}
 * @param {object} [args.doctrine] readLedgers() output (20.4): {zone, utility,
 *   threat, timing}. Optional: a caller without a doctrine frame reads zeros.
 * @param {object} [args.viz] 19.12 extras: {awpThreat, rifleThreat,
 *   uncoveredMass, voi, secondsAffordable, breadth, pairDx, pairDy,
 *   pairWindow, requestToMe, requestFromMe, layout0, layout1, novelty,
 *   vizSpend, assigned}. Optional: zeros.
 * @returns {number[]} OBSERVATION_SIZE floats
 */
export function buildObservation({
  me,
  round,
  myAlive,
  enemyAliveBelieved,
  belief,
  teammates,
  recency,
  doctrine,
  viz
}) {
  const v = [];

  // self (12): where I am, what I carry, which side of the bomb I am on.
  v.push(
    me.x / WORLD_SCALE,
    me.y / WORLD_SCALE,
    me.hp / 100,
    me.armor > 0 ? 1 : 0,
    me.helmet ? 1 : 0
  );
  for (const c of WEAPON_CLASSES) v.push(me.weaponClass === c ? 1 : 0);
  v.push(me.hasBomb ? 1 : 0, me.side === 'T' ? 1 : -1);

  // round (6): the clock and the money, both sides of it.
  v.push(
    Math.min(1, round.elapsed / 115),
    Math.min(1, round.secondsLeft / 115),
    round.planted ? 1 : 0,
    round.planted ? Math.min(1, round.bombSecondsLeft / 40) : 0,
    Math.min(1.5, round.myEquipAvg / EQUIP_NORM),
    Math.min(1.5, round.enemyEquipAvgBelieved / EQUIP_NORM)
  );

  // bodies (2): the man count, mine known, theirs believed.
  v.push(myAlive / 5, enemyAliveBelieved / 5);

  // belief (6): the summaries the policy actually reads (5.5).
  v.push(
    Math.min(1, (belief.siteExpected?.[0] ?? 0) / 5),
    Math.min(1, (belief.siteExpected?.[1] ?? 0) / 5),
    belief.sitePEmpty?.[0] ?? 0,
    belief.sitePEmpty?.[1] ?? 0,
    Math.min(1, (belief.splitEntropy ?? 0) / 3),
    Math.min(1, belief.threatAtMe ?? 0)
  );

  // teammates (12): up to four living, nearest facts only, zero-padded.
  for (let i = 0; i < 4; i += 1) {
    const t = teammates?.[i];
    if (t) v.push(t.dx / WORLD_SCALE, t.dy / WORLD_SCALE, t.hp / 100);
    else v.push(0, 0, 0);
  }

  // recency (2): how stale the round's information is, capped at ten seconds.
  v.push(
    Math.min(1, (recency?.sinceSeenSeconds ?? 10) / 10),
    Math.min(1, (recency?.sinceHeardSeconds ?? 10) / 10)
  );

  // doctrine (12): the four ledgers of 20.4, normalized and side-agnostic.
  // Absent ledgers read as zeros rather than throwing, because a caller that
  // has not built the frame yet (a scripted controller, a test) is a valid
  // caller and a policy trained with the block sees "no doctrine read" as a
  // state rather than as a crash.
  const zone = doctrine?.zone || null;
  const zoneTotal = zone ? Math.max(1, zone.safe + zone.risk + zone.buffer + zone.unknown) : 1;
  v.push(
    zone ? zone.safe / zoneTotal : 0,
    zone ? zone.risk / zoneTotal : 0,
    zone ? zone.buffer / zoneTotal : 0,
    zone ? zone.unknown / zoneTotal : 0
  );
  const util = doctrine?.utility || null;
  v.push(
    Math.min(1, (util?.ourHeavy ?? 0) / 5),
    Math.min(1, (util?.ourLight ?? 0) / 5),
    Math.min(1, (util?.theirHeavy ?? 0) / 5),
    // The balance is the number chapter 11 says decides late rounds, so it is
    // carried signed rather than as two counts the net has to subtract.
    Math.max(-1, Math.min(1, (util?.heavyBalance ?? 0) / 5))
  );
  // The site the enemy can convert soonest, which is the threat ledger's own
  // sort order, plus the race for the most contested ground.
  const worst = doctrine?.threat?.[0] || null;
  v.push(
    Math.min(1, (worst?.expected ?? 0) / 5),
    worst?.pEmpty ?? 0,
    Number.isFinite(worst?.secondsToConvert) ? Math.min(1, worst.secondsToConvert / 60) : 1
  );
  const race = doctrine?.timing?.[0] || null;
  v.push(Math.max(-1, Math.min(1, (race?.edge ?? 0) / 10)));

  // viz (16): typed threat, VOI budget, pair, request, layout modes (19.12).
  const z = viz || {};
  v.push(
    clamp01(z.awpThreat),
    clamp01(z.rifleThreat),
    Math.min(1, z.uncoveredMass ?? 0),
    Math.min(1, z.voi ?? 0),
    Math.min(1, (z.secondsAffordable ?? 0) / 8),
    clamp01(z.breadth),
    Math.max(-1, Math.min(1, (z.pairDx ?? 0) / WORLD_SCALE)),
    Math.max(-1, Math.min(1, (z.pairDy ?? 0) / WORLD_SCALE)),
    Math.min(1, (z.pairWindow ?? 0) / 4),
    Math.min(1, (z.requestToMe ?? 0) / 4),
    Math.min(1, (z.requestFromMe ?? 0) / 4),
    clamp01(z.layout0),
    clamp01(z.layout1),
    z.novelty ? 1 : 0,
    clamp01(z.vizSpend),
    z.assigned ? 1 : 0
  );

  if (v.length !== OBSERVATION_SIZE) {
    throw new Error(`observe: built ${v.length} floats, layout says ${OBSERVATION_SIZE}`);
  }
  return v;
}

/** The weapon class bucket for a bare weapon id, via its fitted category. */
export function weaponClassOf(category) {
  return WEAPON_CLASSES.includes(category) ? category : 'other';
}
