// ---------------------------------------------------------------------------
// shared/sim/saving.js
// When to stop playing the round and keep the gun.
//
// `save` has been in the option table since 2.1 and nothing ever started it.
// The economic save in buy.js is a different decision — that one is "do not
// buy this round" — and it happens at freeze. This is the in-round one: the
// round is gone, and the question is whether the rifle survives to the next.
//
// Three conditions, all of them required:
//
//   1. THE ROUND IS GONE. Believed win probability at or under 10%. Not "we
//      are behind": behind is a read, and a 2v3 with the bomb down is not a
//      save. Ten percent is the operator's number and it is deliberately low,
//      because a save that starts too early throws the round away rather than
//      recognizing it was already thrown.
//
//   2. THE MONEY NEEDS IT. Under $7,500 average across the side, which is what
//      two full buys would take. A side that can simply rebuy loses nothing by
//      dying with the gun, so saving costs them a round for no gain — the
//      gun's value is exactly the buy it spares, and above this line it spares
//      nothing.
//
//   3. THERE IS SOMETHING TO SAVE. An M4, an AWP, or an AK. A save with a
//      pistol is a bot running away from a fight for no reason, which is the
//      failure mode that makes saving look stupid on a scoreboard.
//
// Belief, not truth: `pWin` here is the believed number (18.6b), the same one
// the caller gates on. A side that has miscounted the enemy saves at the wrong
// time, and that mistake is theirs to make and to be graded on later.
//
// Pure. No I/O, no rng.
// ---------------------------------------------------------------------------

/** At or under this believed win probability, the round is not being won. */
export const SAVE_PWIN_MAX = 0.1;

/**
 * Average money per player that would fund two full buys. Above this the side
 * can rebuy regardless, so the gun is not worth a round.
 */
export const SAVE_BUY_FLOOR = 7500;

/**
 * Guns worth a save, by the weapon table's own ids. `m4a1` is the M4 here and
 * `m4a1_silencer` is the same rifle; the AK is on this list because a CT who
 * picked one up is holding the same $2,700 problem.
 */
export const SAVEABLE_WEAPONS = Object.freeze([
  'awp',
  'ak47',
  'm4a1',
  'm4a1_silencer'
]);

/**
 * Is this a gun worth walking away with?
 *
 * @param {string|null|undefined} weapon
 * @returns {boolean}
 */
export function isSaveable(weapon) {
  return SAVEABLE_WEAPONS.includes(String(weapon || '').toLowerCase());
}

/**
 * Average money across a side. Dead players' money counts: it buys next round
 * exactly the same as a living player's does.
 *
 * @param {Record<number|string, number>|null} money  slot -> dollars
 * @param {Array<number>} slots  this side's seats
 * @returns {number|null} null when the caller has no money frame at all
 */
export function averageMoney(money, slots = []) {
  if (!money || !slots.length) return null;
  let total = 0;
  let n = 0;
  for (const slot of slots) {
    const m = money[slot];
    if (!Number.isFinite(m)) continue;
    total += m;
    n += 1;
  }
  return n ? total / n : null;
}

/**
 * Should this body break off and save?
 *
 * @param {object} args
 * @param {number} args.pWin           believed round win probability for MY side
 * @param {string|null} [args.weapon]   what this body is holding
 * @param {number|null} [args.moneyAvg] side average money, from averageMoney()
 * @param {boolean} [args.alive]
 * @param {number} [args.pWinMax]
 * @param {number} [args.buyFloor]
 * @returns {{save: boolean, reason: string}}
 */
export function shouldSave({
  pWin,
  weapon = null,
  moneyAvg = null,
  alive = true,
  pWinMax = SAVE_PWIN_MAX,
  buyFloor = SAVE_BUY_FLOOR
} = {}) {
  if (!alive) return { save: false, reason: 'dead' };
  if (!Number.isFinite(pWin)) return { save: false, reason: 'no read on the round' };
  if (pWin > pWinMax) {
    return { save: false, reason: `still winnable (${(pWin * 100).toFixed(0)}%)` };
  }
  if (!isSaveable(weapon)) {
    return { save: false, reason: `nothing worth saving (${weapon || 'empty'})` };
  }
  // No money frame means no evidence the economy is fine, and the other two
  // conditions have already said the round is gone with a rifle in hand.
  // Saving on a missing number is the recoverable mistake; dying with the
  // rifle because a field was absent is not.
  if (Number.isFinite(moneyAvg) && moneyAvg >= buyFloor) {
    return { save: false, reason: `can rebuy anyway ($${Math.round(moneyAvg)} each)` };
  }
  const cash = Number.isFinite(moneyAvg) ? `$${Math.round(moneyAvg)} each` : 'thin economy';
  return {
    save: true,
    reason: `round is gone (${(pWin * 100).toFixed(0)}%), saving the ${weapon} — ${cash}`
  };
}
