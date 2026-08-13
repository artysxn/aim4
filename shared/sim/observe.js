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
// This is the v1, deliberately small (7.2's ~420 floats arrive with P3c/P3d's
// belief structure and macro action space; building the full vector before
// them would mean building it twice). Small does not mean careless: the
// blocks are fixed-order, fixed-width, zero-padded, and every value is
// normalized to about [-1, 1] so the trainer never learns the units.
// ---------------------------------------------------------------------------

export const OBSERVE_VERSION = 1;

/** World units the position features normalize against (radar world span). */
const WORLD_SCALE = 4096;
/** Equipment average the economy features normalize against. */
const EQUIP_NORM = 5500;

/** Weapon classes the self block one-hots. Order is part of the version. */
export const WEAPON_CLASSES = Object.freeze(['pistol', 'smg', 'rifle', 'sniper', 'other']);

/** Fixed layout: block name -> width. Order is part of the version. */
export const OBSERVATION_BLOCKS = Object.freeze([
  ['self', 12],
  ['round', 6],
  ['bodies', 2],
  ['belief', 6],
  ['teammates', 12],
  ['recency', 2]
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
 * @returns {number[]} OBSERVATION_SIZE floats
 */
export function buildObservation({
  me,
  round,
  myAlive,
  enemyAliveBelieved,
  belief,
  teammates,
  recency
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

  if (v.length !== OBSERVATION_SIZE) {
    throw new Error(`observe: built ${v.length} floats, layout says ${OBSERVATION_SIZE}`);
  }
  return v;
}

/** The weapon class bucket for a bare weapon id, via its fitted category. */
export function weaponClassOf(category) {
  return WEAPON_CLASSES.includes(category) ? category : 'other';
}
