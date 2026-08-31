// ---------------------------------------------------------------------------
// server/affiliates/levels.js
// What an affiliate earns, and how they come to earn more of it.
//
// One flat rate for everybody pays a person who has sent one customer the same
// as a person who has sent four hundred, and the rate that makes the second
// one worth having is a rate the business cannot afford to hand to everybody.
// So the rate is a ladder: it starts where a referral is cheap to honour and
// rises as the affiliate proves the traffic is real.
//
//   Level 1   10%   the starting rate
//   Level 2   15%   200 earned, or 20 customers
//   Level 3   20%   1500 earned, or 100 customers
//
// Either threshold promotes, because the two describe different people who are
// both worth more: one sends a few expensive subscriptions, the other sends
// many cheap ones, and a ladder that only counted money would leave the second
// one on the bottom rung forever.
//
// A rate is frozen onto every commission row when it is written, so a
// promotion pays more from the next sale and never restates the last one. That
// also means demotion is impossible in practice: the ladder reads LIFETIME
// figures, and lifetime figures do not go down. Reversed commissions are not
// counted as earned, so a refunded sale cannot buy a level.
// ---------------------------------------------------------------------------

/**
 * The ladder, worst first. Thresholds are in minor units of the affiliate's
 * ledger currency (cents) and in whole customers.
 */
export const LEVELS = Object.freeze([
  Object.freeze({ level: 1, rate: 10, minEarned: 0, minCustomers: 0, name: 'Level 1' }),
  Object.freeze({ level: 2, rate: 15, minEarned: 20000, minCustomers: 20, name: 'Level 2' }),
  Object.freeze({ level: 3, rate: 20, minEarned: 150000, minCustomers: 100, name: 'Level 3' })
]);

export const BASE_LEVEL = LEVELS[0];
export const TOP_LEVEL = LEVELS[LEVELS.length - 1];

/**
 * The level an affiliate has reached.
 *
 * `customers` is DISTINCT PAYING CUSTOMERS, not payments. Counting renewals
 * would make the customer threshold meaningless on a subscription product: one
 * customer on a monthly plan is twelve payments a year, so 20 payments is two
 * customers who stayed ten months, and 100 is eight of them. The count has to
 * mean what an affiliate would think it means.
 *
 * @param {{earned?: number, customers?: number}} stats
 * @returns {typeof LEVELS[number]}
 */
export function levelFor({ earned = 0, customers = 0 } = {}) {
  const money = Number(earned) || 0;
  const heads = Number(customers) || 0;
  let best = BASE_LEVEL;
  for (const rung of LEVELS) {
    if (money >= rung.minEarned || heads >= rung.minCustomers) best = rung;
  }
  return best;
}

/** The commission rate an affiliate is on, as a percentage. */
export function rateFor(stats) {
  return levelFor(stats).rate;
}

/**
 * What is still needed for the next rung, or null at the top.
 *
 * Both routes are reported because either one promotes, and an affiliate
 * looking at "€140 to go" while sitting two customers away from the same rung
 * would be reading the harder of the two.
 */
export function nextLevel(stats) {
  const now = levelFor(stats);
  const next = LEVELS.find((r) => r.level === now.level + 1);
  if (!next) return null;
  const money = Number(stats?.earned) || 0;
  const heads = Number(stats?.customers) || 0;
  return {
    ...next,
    earnedToGo: Math.max(0, next.minEarned - money),
    customersToGo: Math.max(0, next.minCustomers - heads)
  };
}
