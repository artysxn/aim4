// ---------------------------------------------------------------------------
// shared/sim/buy.js
// What five bots actually buy, given what they have and what round it is.
//
// The table this replaces had three rows and two of them were wrong: it gave
// the MAC-10 to both sides (it is T-only; CTs buy the MP9), it never bought an
// AWP at any income, and it knew one M4. A side that never holds an AWP plays
// a different game from Counter-Strike, so this is not cosmetic.
//
// The shape of a buy is: gun by side and budget, armour before utility,
// utility before a better gun, and a kit for one CT. The AWP is a ROLE rather
// than a price point: exactly one player per side carries it, and only when
// the side can afford it without leaving anyone on a pistol, because two AWPs
// and three ecos is how a team loses a round it could have won.
//
// Prices are CS2's, read from the shipped weapon table rather than repeated
// here, so a price change lands in one place (`weaponTable.js`).
// ---------------------------------------------------------------------------

import { weaponInfo } from '../../src/replays/shared/weaponTable.js';

/** Armour, kit and grenade prices. CS2, and not in the weapon table. */
export const KEVLAR = 650;
export const HELMET_KIT = 1000;
export const DEFUSE_KIT = 400;
export const NADE_PRICE = Object.freeze({
  flashbang: 200,
  smokegrenade: 300,
  hegrenade: 300,
  molotov: 400,
  incgrenade: 600,
  decoy: 50
});

/** The fire grenade each side actually gets to buy. */
export const FIRE = Object.freeze({ T: 'molotov', CT: 'incgrenade' });

/**
 * Gun ladders, cheapest last. The bot walks DOWN this list until it finds one
 * it can afford alongside armour, which is why the order is by preference
 * rather than by price: an M4A1-S at 2900 is preferred to a FAMAS at 2050
 * whenever both fit.
 */
export const RIFLES = Object.freeze({
  T: ['ak47', 'sg556', 'galilar'],
  CT: ['m4a1_silencer', 'm4a1', 'aug', 'famas']
});
export const SMGS = Object.freeze({
  T: ['mac10', 'mp7', 'ump45'],
  CT: ['mp9', 'mp7', 'ump45']
});
export const PISTOLS = Object.freeze({
  T: ['tec9', 'p250', 'glock'],
  CT: ['fiveseven', 'p250', 'usp_silencer']
});

const price = (w) => weaponInfo(w).price || 0;

/**
 * A full buy for one player.
 *
 * @param {object} args
 * @param {number} args.money
 * @param {'T'|'CT'} args.side
 * @param {boolean} [args.awper]     this player carries the AWP when affordable
 * @param {boolean} [args.wantsKit]  one CT per round takes the kit
 * @param {boolean} [args.save]      eco: pistol and nothing that costs a round
 * @returns {{cost, weapon, armor, helmet, hasKit, grenades: string[]}}
 */
export function buyFor({ money, side, awper = false, wantsKit = false, save = false }) {
  const out = { cost: 0, weapon: null, armor: 0, helmet: false, hasKit: false, grenades: [] };
  let left = Math.max(0, money);

  const take = (amount) => {
    left -= amount;
    out.cost += amount;
  };

  // A save is a decision, not a shortfall: keep the money, take a pistol, and
  // buy nothing that would leave the next round broke.
  if (save) {
    for (const p of PISTOLS[side]) {
      if (price(p) <= left) {
        out.weapon = p;
        take(price(p));
        break;
      }
    }
    if (!out.weapon) out.weapon = side === 'T' ? 'glock' : 'usp_silencer';
    return out;
  }

  // Armour first. It is the cheapest survivability in the game and every buy
  // decision after it is worse without it.
  if (left >= HELMET_KIT) {
    out.armor = 100;
    out.helmet = true;
    take(HELMET_KIT);
  } else if (left >= KEVLAR) {
    out.armor = 100;
    take(KEVLAR);
  }

  // The gun. An AWPer takes the AWP when it still leaves room for armour,
  // which the ordering above has already reserved.
  if (awper && left >= price('awp')) {
    out.weapon = 'awp';
    take(price('awp'));
  } else {
    for (const w of RIFLES[side]) {
      if (price(w) <= left) {
        out.weapon = w;
        take(price(w));
        break;
      }
    }
    if (!out.weapon) {
      for (const w of SMGS[side]) {
        if (price(w) <= left) {
          out.weapon = w;
          take(price(w));
          break;
        }
      }
    }
  }
  if (!out.weapon) {
    for (const p of PISTOLS[side]) {
      if (price(p) <= left) {
        out.weapon = p;
        take(price(p));
        break;
      }
    }
  }
  if (!out.weapon) out.weapon = side === 'T' ? 'glock' : 'usp_silencer';

  // The kit pays for itself once per round on the retake, so one CT takes it
  // ahead of a third grenade.
  if (side === 'CT' && wantsKit && left >= DEFUSE_KIT) {
    out.hasKit = true;
    take(DEFUSE_KIT);
  }

  // Utility, in the order a real player buys it: the flash that wins an entry,
  // the smoke that makes one possible, then the fire that denies a hold.
  const wish = ['flashbang', 'smokegrenade', FIRE[side], 'flashbang', 'hegrenade'];
  for (const n of wish) {
    const p = NADE_PRICE[n] || 0;
    if (p > left) continue;
    if (out.grenades.length >= 4) break;
    if (n === 'flashbang' && out.grenades.filter((g) => g === 'flashbang').length >= 2) continue;
    out.grenades.push(n);
    take(p);
  }

  return out;
}

/**
 * Equipment value of one body at freeze, using the same prices the buy table
 * spends. Mirror of the demoparser's loadout sum, so a sim round and a demo
 * round land in the same 0-5 bucket.
 */
export function equipValueOf(body) {
  if (!body) return 0;
  let v = price(body.weapon);
  if ((body.armor || 0) > 0) v += body.helmet ? HELMET_KIT : KEVLAR;
  if (body.hasKit) v += DEFUSE_KIT;
  for (const g of body.grenades || []) v += NADE_PRICE[g] || 0;
  return v;
}

/**
 * 0-5 economy bucket for a side's freeze loadout.
 *
 * Thresholds are copied from `server/demoparser/economy.js` (eco 5000, half
 * 10000, force 18000). shared/ must not import from server/, so the numbers
 * live here with a pointer rather than a shared module. Remaining cash is
 * not available on a sim body, so half vs force inside 5-18k is read off
 * equipment value alone.
 *
 * @returns {number|null} 0 pistol, 1 eco, 2 half, 3 force, 4 full, 5 full+AWP
 */
export function econBucketOf(bodies) {
  const list = (bodies || []).filter(Boolean);
  if (!list.length) return null;
  const equipValue = list.reduce((s, b) => s + equipValueOf(b), 0);
  const pistols = list.every((b) => {
    const cat = weaponInfo(b.weapon).category;
    return cat === 'pistol' || cat === 'knife' || !b.weapon;
  });
  const hasAwp = list.some((b) => /awp/i.test(b.weapon || ''));
  // Keep in sync with server/demoparser/economy.js THRESHOLDS.
  if (pistols) return 0;
  if (hasAwp && equipValue >= 18000) return 5;
  if (equipValue >= 18000) return 4;
  if (equipValue < 5000) return 1;
  if (equipValue >= 10000) return 3;
  return 2;
}

/**
 * Buys for a whole side, which is where the decisions that need a team view
 * get made: whether this is a save round at all, who holds the AWP, and who
 * carries the kit.
 *
 * The save rule is the one worth stating. A side that cannot put rifles and
 * armour on most of its players is better off keeping the money and buying
 * properly next round; buying half a rifle each is how a team stays broke for
 * four rounds instead of one. `[calibrate against the library's econ digits]`
 *
 * @param {object} args
 * @param {number[]} args.slots
 * @param {(slot:number) => number} args.moneyOf
 * @param {'T'|'CT'} args.side
 * @param {number|null} [args.awpSlot]  who prefers the AWP, when affordable
 * @param {boolean} [args.forceBuy]     ignore the save rule (last round, etc.)
 * @returns {Map<number, object>}
 */
export function buySide({ slots, moneyOf, side, awpSlot = null, forceBuy = false }) {
  const cash = slots.map((s) => moneyOf(s) || 0);
  const fullBuy = price(RIFLES[side][RIFLES[side].length - 1]) + HELMET_KIT;
  const canAfford = cash.filter((m) => m >= fullBuy).length;
  const save = !forceBuy && canAfford < Math.ceil(slots.length * 0.6);

  // The AWP goes to the nominated player only if he can hold it AND the side
  // is not saving. Everyone else buys normally.
  const awpAffordable =
    awpSlot != null && !save && (moneyOf(awpSlot) || 0) >= price('awp') + KEVLAR;

  const kitSlot =
    side === 'CT' && !save
      ? slots.reduce((best, s) => ((moneyOf(s) || 0) > (moneyOf(best) || 0) ? s : best), slots[0])
      : null;

  const out = new Map();
  for (const slot of slots) {
    out.set(
      slot,
      buyFor({
        money: moneyOf(slot),
        side,
        awper: awpAffordable && slot === awpSlot,
        wantsKit: slot === kitSlot,
        save
      })
    );
  }
  return out;
}
