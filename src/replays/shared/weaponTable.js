// ---------------------------------------------------------------------------
// replays/shared/weaponTable.js
// CS2 gun stats the duel model needs: what a weapon costs, what class it is,
// how long it is unusable after emptying a magazine, and how long the shooter
// waits between shots.
//
// Prices are the buy-menu numbers. They matter twice over: on their own (an
// AWP is lethal at any range a pistol is not) and as a ratio between the two
// duellists (a $500 gap between a Glock and a Deagle is nothing like the $2000
// between a Deagle and an AK). The model reads both, so both live here as raw
// numbers and the shaping is left to learned parameters.
//
// `cycleSeconds` is the re-fire delay, and it is the one field that is not
// cosmetic: an AWP that has just fired is helpless for 1.46 s while the bolt
// cycles, which is the difference between a 95% duel and a coin flip.
//
// `oneTapHeadHelmet` marks guns that kill a helmeted 100 hp head in one shot at
// normal fighting range. It exists so the model can express the interaction the
// game actually has: the AK's headshot edge over the M4 disappears the moment
// the M4 player has no helmet, because then both guns one-tap.
//
// Keys are `bareWeapon()` stems so anything the parser writes into a round's
// weapon dictionary resolves without a second normalization pass.
//
// DOM-free: the trainer in node and the viewer in the browser share it.
// ---------------------------------------------------------------------------

import { bareWeapon, isKnife } from '../viewer/equipmentIcons.js';

/** @typedef {'knife'|'pistol'|'smg'|'shotgun'|'rifle'|'sniper'|'lmg'|'other'} WeaponCategory */

/**
 * @typedef {object} WeaponInfo
 * @property {string} id
 * @property {number} price             buy menu cost, dollars
 * @property {WeaponCategory} category
 * @property {number} magSize           rounds before a reload is forced
 * @property {number} reloadSeconds     magazine swap, start to usable
 * @property {number} cycleSeconds      minimum delay between two shots
 * @property {boolean} oneTapHeadHelmet kills a helmeted head in one shot
 */

/** Categories in ascending "generally wins fights" order, for bucket labels. */
export const CATEGORY_TIER = {
  knife: 0,
  other: 0,
  pistol: 1,
  shotgun: 2,
  smg: 2,
  lmg: 3,
  rifle: 4,
  sniper: 5
};

/** @type {Record<string, WeaponInfo>} */
export const WEAPONS = {
  // --- Pistols -------------------------------------------------------------
  glock: { price: 200, category: 'pistol', magSize: 20, reloadSeconds: 2.2, cycleSeconds: 0.15, oneTapHeadHelmet: false },
  hkp2000: { price: 200, category: 'pistol', magSize: 13, reloadSeconds: 2.2, cycleSeconds: 0.17, oneTapHeadHelmet: false },
  usp_silencer: { price: 200, category: 'pistol', magSize: 12, reloadSeconds: 2.2, cycleSeconds: 0.17, oneTapHeadHelmet: false },
  p250: { price: 300, category: 'pistol', magSize: 13, reloadSeconds: 2.2, cycleSeconds: 0.15, oneTapHeadHelmet: false },
  elite: { price: 300, category: 'pistol', magSize: 30, reloadSeconds: 4.5, cycleSeconds: 0.12, oneTapHeadHelmet: false },
  fiveseven: { price: 500, category: 'pistol', magSize: 20, reloadSeconds: 2.7, cycleSeconds: 0.15, oneTapHeadHelmet: false },
  tec9: { price: 500, category: 'pistol', magSize: 18, reloadSeconds: 2.5, cycleSeconds: 0.12, oneTapHeadHelmet: false },
  cz75a: { price: 500, category: 'pistol', magSize: 12, reloadSeconds: 2.7, cycleSeconds: 0.09, oneTapHeadHelmet: false },
  revolver: { price: 600, category: 'pistol', magSize: 8, reloadSeconds: 2.5, cycleSeconds: 0.4, oneTapHeadHelmet: true },
  deagle: { price: 700, category: 'pistol', magSize: 7, reloadSeconds: 2.2, cycleSeconds: 0.23, oneTapHeadHelmet: true },

  // --- SMGs ----------------------------------------------------------------
  mac10: { price: 1050, category: 'smg', magSize: 30, reloadSeconds: 2.7, cycleSeconds: 0.075, oneTapHeadHelmet: false },
  ump45: { price: 1200, category: 'smg', magSize: 25, reloadSeconds: 3.5, cycleSeconds: 0.09, oneTapHeadHelmet: false },
  mp9: { price: 1250, category: 'smg', magSize: 30, reloadSeconds: 2.1, cycleSeconds: 0.075, oneTapHeadHelmet: false },
  bizon: { price: 1400, category: 'smg', magSize: 64, reloadSeconds: 2.4, cycleSeconds: 0.08, oneTapHeadHelmet: false },
  mp7: { price: 1500, category: 'smg', magSize: 30, reloadSeconds: 3.1, cycleSeconds: 0.08, oneTapHeadHelmet: false },
  mp5sd: { price: 1500, category: 'smg', magSize: 30, reloadSeconds: 2.7, cycleSeconds: 0.08, oneTapHeadHelmet: false },
  p90: { price: 2350, category: 'smg', magSize: 50, reloadSeconds: 3.4, cycleSeconds: 0.07, oneTapHeadHelmet: false },

  // --- Shotguns ------------------------------------------------------------
  nova: { price: 1050, category: 'shotgun', magSize: 8, reloadSeconds: 4.0, cycleSeconds: 0.88, oneTapHeadHelmet: false },
  sawedoff: { price: 1100, category: 'shotgun', magSize: 7, reloadSeconds: 4.0, cycleSeconds: 0.88, oneTapHeadHelmet: false },
  mag7: { price: 1300, category: 'shotgun', magSize: 5, reloadSeconds: 4.0, cycleSeconds: 0.85, oneTapHeadHelmet: false },
  xm1014: { price: 2000, category: 'shotgun', magSize: 7, reloadSeconds: 5.0, cycleSeconds: 0.35, oneTapHeadHelmet: false },

  // --- Rifles --------------------------------------------------------------
  galilar: { price: 1800, category: 'rifle', magSize: 35, reloadSeconds: 3.0, cycleSeconds: 0.09, oneTapHeadHelmet: false },
  famas: { price: 2050, category: 'rifle', magSize: 25, reloadSeconds: 3.3, cycleSeconds: 0.09, oneTapHeadHelmet: false },
  ak47: { price: 2700, category: 'rifle', magSize: 30, reloadSeconds: 2.5, cycleSeconds: 0.1, oneTapHeadHelmet: true },
  m4a1_silencer: { price: 2900, category: 'rifle', magSize: 25, reloadSeconds: 3.1, cycleSeconds: 0.0925, oneTapHeadHelmet: false },
  sg556: { price: 3000, category: 'rifle', magSize: 30, reloadSeconds: 3.0, cycleSeconds: 0.09, oneTapHeadHelmet: true },
  m4a1: { price: 3100, category: 'rifle', magSize: 30, reloadSeconds: 3.1, cycleSeconds: 0.09, oneTapHeadHelmet: false },
  aug: { price: 3300, category: 'rifle', magSize: 30, reloadSeconds: 3.8, cycleSeconds: 0.09, oneTapHeadHelmet: true },

  // --- Snipers -------------------------------------------------------------
  // Bolt guns pay for their power in cycleSeconds, which is what makes a missed
  // AWP shot the most dangerous moment in the game for the AWPer.
  ssg08: { price: 1700, category: 'sniper', magSize: 10, reloadSeconds: 3.7, cycleSeconds: 1.25, oneTapHeadHelmet: true },
  awp: { price: 4750, category: 'sniper', magSize: 5, reloadSeconds: 3.7, cycleSeconds: 1.46, oneTapHeadHelmet: true },
  g3sg1: { price: 5000, category: 'sniper', magSize: 20, reloadSeconds: 4.7, cycleSeconds: 0.25, oneTapHeadHelmet: true },
  scar20: { price: 5000, category: 'sniper', magSize: 20, reloadSeconds: 4.7, cycleSeconds: 0.25, oneTapHeadHelmet: true },

  // --- Machine guns --------------------------------------------------------
  negev: { price: 1700, category: 'lmg', magSize: 150, reloadSeconds: 5.7, cycleSeconds: 0.07, oneTapHeadHelmet: false },
  m249: { price: 5200, category: 'lmg', magSize: 100, reloadSeconds: 5.7, cycleSeconds: 0.08, oneTapHeadHelmet: false },

  // --- Everything else -----------------------------------------------------
  // The Zeus is a gun by the parser's reckoning but not by any duel logic, so
  // it is priced honestly and parked in `other` where the category offset can
  // learn how bad it really is.
  taser: { price: 200, category: 'other', magSize: 1, reloadSeconds: 0, cycleSeconds: 0.5, oneTapHeadHelmet: false },
  knife: { price: 0, category: 'knife', magSize: 0, reloadSeconds: 0, cycleSeconds: 0.4, oneTapHeadHelmet: false }
};

/**
 * Anything unrecognized is treated as a starting pistol. Falling back to the
 * cheapest thing in the game keeps an unknown stem from silently inflating a
 * player's odds, and the model never sees a hole in its inputs.
 */
const FALLBACK = WEAPONS.glock;

/**
 * Stats for a weapon name in any spelling the parser produces.
 * Never throws and never returns null.
 *
 * @param {string} name
 * @returns {WeaponInfo}
 */
export function weaponInfo(name) {
  const bare = bareWeapon(name);
  const hit = WEAPONS[bare];
  if (hit) return { id: bare, ...hit };
  // Every knife skin shares one entry rather than 25 identical ones.
  if (isKnife(name)) return { id: 'knife', ...WEAPONS.knife };
  return { id: bare || 'glock', ...FALLBACK };
}

/**
 * Coarse 0-5 strength ordinal. Diagnostics only: the model reads price and
 * category, never this, so nothing depends on where the boundaries fall.
 *
 * @param {string} name
 */
export function weaponTier(name) {
  const info = weaponInfo(name);
  if (info.category === 'pistol' && info.price >= 600) return 2;
  return CATEGORY_TIER[info.category] ?? 1;
}
