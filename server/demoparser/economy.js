// ---------------------------------------------------------------------------
// demoparser/economy.js
// Turns a team's freezetime loadout into the single digit the round name
// carries. The buckets come from the naming scheme:
//
//   0 pistol   1 eco   2 half buy   3 force buy   4 full buy
//   5 full buy + AWP  (legacy filename encoding; UI treats 5 as Full buy
//                      and exposes Has AWP as a separate filter)
//
// Thresholds are heuristics over team equipment value, so they live here on
// their own rather than being scattered through an adapter. Tune this file
// and every future round picks up the change; already-parsed rounds keep the
// digit they were named with.
// ---------------------------------------------------------------------------

/** Equipment value, summed across the five players of one side. */
export const THRESHOLDS = {
  /** Below this a side has effectively bought nothing. */
  eco: 5000,
  /** Below this it is a partial buy: some rifles, little armor or utility. */
  half: 10000,
  /** Below this it is a force: most of the money spent, not enough for a real buy. */
  force: 18000
};

const AWP_WEAPONS = new Set(['awp', 'weapon_awp']);

const PISTOLS = new Set([
  'glock',
  'usp_silencer',
  'hkp2000',
  'p250',
  'fiveseven',
  'tec9',
  'cz75a',
  'deagle',
  'revolver',
  'elite'
]);

function bare(name) {
  return String(name || '').replace(/^weapon_/, '').toLowerCase();
}

export function hasAwp(loadouts) {
  return loadouts.some((items) => (items || []).some((w) => AWP_WEAPONS.has(bare(w))));
}

/** True when nobody on the side carries anything better than a pistol. */
export function pistolsOnly(loadouts) {
  return loadouts.every((items) =>
    (items || []).every((w) => {
      const b = bare(w);
      return PISTOLS.has(b) || b === 'knife' || b.startsWith('knife') || isUtility(b) || b === 'c4';
    })
  );
}

function isUtility(b) {
  return (
    b === 'flashbang' ||
    b === 'smokegrenade' ||
    b === 'hegrenade' ||
    b === 'molotov' ||
    b === 'incgrenade' ||
    b === 'decoy' ||
    b === 'taser'
  );
}

/**
 * Classify one side's buy.
 *
 * @param {object} side
 * @param {number} side.equipValue    team equipment value at freezetime end
 * @param {number} side.money         team cash still banked at freezetime end
 * @param {string[][]} side.loadouts  each player's inventory
 * @param {boolean} side.isPistolRound  first round of either half
 * @returns {number} 0-5
 */
export function classifyEconomy(side) {
  const { equipValue = 0, money = 0, loadouts = [], isPistolRound = false } = side;

  // A pistol round is a fact about the round, not about the buy: it outranks
  // every value-based bucket even when a side saved into an armor-heavy buy.
  if (isPistolRound) return 0;

  if (hasAwp(loadouts) && equipValue >= THRESHOLDS.force) return 5;
  if (equipValue >= THRESHOLDS.force) return 4;
  if (equipValue < THRESHOLDS.eco || pistolsOnly(loadouts)) return 1;

  // Between a real buy and an eco. A side that emptied its wallet to get here
  // forced; a side sitting on savings deliberately bought half.
  if (equipValue >= THRESHOLDS.half) return money < 4000 ? 3 : 2;
  return money < 3000 ? 3 : 2;
}

/**
 * Which rounds start a half. CS2 competitive is MR12 (halftime after 12), but
 * older demos are MR15, and overtime restarts the cycle every 6 rounds.
 */
export function isPistolRoundNumber(round, roundsPerHalf = 12) {
  if (round === 1) return true;
  if (round === roundsPerHalf + 1) return true;
  const regulation = roundsPerHalf * 2;
  if (round > regulation) {
    // Overtime: 3 rounds per half, so a pistol every 3rd round of each OT.
    const ot = round - regulation - 1;
    return ot % 3 === 0;
  }
  return false;
}
