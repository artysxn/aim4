// ---------------------------------------------------------------------------
// replays/coach/duelLookahead.js
// The round, seen through the fights that are open in it right now.
//
// A 5v5 with a gunfight in it is not a 5v5. If one of the two players in that
// fight is a 99% favourite, the round is already 99% of the way to being a 5v4:
// the bodies have not changed yet, but the thing that changes them has all but
// happened. A model that waits for the kill feed prints a number it already
// knows to be wrong, for as long as the fight lasts.
//
// So every open fight is resolved forward. Each one is a coin with the duel
// model's probability on its face; the joint outcome of all of them is
// enumerated, each branch is priced as the round state it would leave behind,
// and the answer is the probability-weighted average of those prices. With a
// single fight at 99% that is exactly "99% of the 5v4 win chance and 1% of the
// 4v5", which is what the sentence means once it is written down.
//
// Two things are worth being explicit about.
//
// The average is taken over *prices*, not over bodies. Feeding an expected body
// count into the man-advantage ladder would be a different and wrong answer,
// because that ladder is not a straight line: half of a 5v4 plus half of a 4v5
// is not a 4.5v4.5. Only the win chances may be averaged.
//
// Fights are treated as independent, which is an approximation and a chosen
// one — the alternative is a joint model over five simultaneous engagements,
// fitted on nothing. A player caught in two fights at once is still handled
// correctly, because the enumeration is over who ends up dead rather than over
// duels: losing either fight kills them once, not twice.
//
// Pure arithmetic. No model, no map, no ticks. The caller supplies the duel
// probabilities and a way to price a round state, which is what keeps the duel
// model out of the coach's imports and keeps this testable on its own.
// ---------------------------------------------------------------------------

/**
 * How many fights are resolved forward at once.
 *
 * Every extra fight doubles the branch count, and five simultaneous
 * engagements is already every player on the map in one. When more than this
 * are open, the most decisive ones are taken: a 50/50 fight barely moves the
 * answer, so those are the ones that can afford to be left standing.
 */
export const MAX_LOOKAHEAD_DUELS = 5;

/**
 * The fights worth resolving, most decisive first and capped.
 *
 * A fight only moves the round if both players are on the board the round model
 * is counting. The kill log runs ahead of the tick `alive` flags (that is the
 * whole reason `deadPlayersAt` exists), so a slot it has already buried is
 * dropped here rather than resurrected as a live body in every branch.
 *
 * @param {Array<{aSlot:number,bSlot:number,pa:number}>} duels
 * @param {Record<number, {side:string, weight:number, value:number}>} bySlot
 */
function usableDuels(duels, bySlot) {
  const out = [];
  for (const d of duels || []) {
    const a = bySlot?.[d.aSlot];
    const b = bySlot?.[d.bSlot];
    if (!a || !b || a.side === b.side) continue;
    const pa = Number(d.pa);
    if (!Number.isFinite(pa) || pa < 0 || pa > 1) continue;
    out.push({ ...d, pa });
  }
  out.sort((x, y) => Math.abs(y.pa - 0.5) - Math.abs(x.pa - 0.5));
  return out.slice(0, MAX_LOOKAHEAD_DUELS);
}

/**
 * The round state left behind once `dead` have fallen.
 *
 * Equipment is carried as a side total rather than the average the model wants,
 * because the average is over living players and the whole point here is that
 * the living set changes. Averaging is the caller's job, after the subtraction.
 */
function stateAfter(base, dead, bySlot) {
  let { ctAlive, tAlive, ctEff, tEff, ctSum, tSum } = base;
  for (const slot of dead) {
    const p = bySlot[slot];
    if (!p) continue;
    if (p.side === 'CT') {
      ctAlive -= 1;
      ctEff -= p.weight;
      ctSum -= p.value;
    } else {
      tAlive -= 1;
      tEff -= p.weight;
      tSum -= p.value;
    }
  }
  return {
    ctAlive: Math.max(0, ctAlive),
    tAlive: Math.max(0, tAlive),
    ctEff: Math.max(0, ctEff),
    tEff: Math.max(0, tEff),
    ctSum: Math.max(0, ctSum),
    tSum: Math.max(0, tSum)
  };
}

/**
 * CT win percent, averaged over how the open fights could resolve.
 *
 * @param {object} args
 * @param {{ctAlive:number,tAlive:number,ctEff:number,tEff:number,ctSum:number,tSum:number}} args.base
 *        the round as it stands, with equipment as side totals
 * @param {Array<{aSlot:number,bSlot:number,pa:number}>} args.duels
 *        open fights; `pa` is P(the player in `aSlot` wins)
 * @param {Record<number, {side:'CT'|'T', weight:number, value:number}>} args.bySlot
 *        each living player's body weight and equipment value
 * @param {(state: object) => number} args.evaluate  prices one round state as CT%
 * @returns {{ct: number, used: Array}|null} null when no fight is usable
 */
export function expectedCtOverDuels({ base, duels, bySlot, evaluate }) {
  const used = usableDuels(duels, bySlot);
  if (!used.length) return null;

  let ct = 0;
  const branches = 1 << used.length;
  for (let mask = 0; mask < branches; mask++) {
    let p = 1;
    const dead = [];
    for (let i = 0; i < used.length; i++) {
      const d = used[i];
      const aWins = (mask >> i) & 1;
      p *= aWins ? d.pa : 1 - d.pa;
      if (p === 0) break;
      // The loser of each fight falls. A player who loses one fight and wins
      // another is dead either way, and a Set-like check is what stops that
      // being counted as two bodies off their side.
      const loser = aWins ? d.bSlot : d.aSlot;
      if (!dead.includes(loser)) dead.push(loser);
    }
    if (!(p > 0)) continue;
    ct += p * evaluate(stateAfter(base, dead, bySlot));
  }
  return { ct, used };
}
