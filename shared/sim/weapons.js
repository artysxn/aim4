// ---------------------------------------------------------------------------
// shared/sim/weapons.js
// What a bullet does: damage, armor, range falloff, hit groups, tagging.
//
// Extends src/replays/shared/weaponTable.js rather than replacing it. That file
// is what the fitted duel model was trained against, so its prices, cycle times,
// magazines, and `oneTapHeadHelmet` flags stay exactly as they are; this one
// adds the fields a simulation needs and the analysis stack never did.
//
// The self-check at the bottom of the test is the interesting part: the duel
// model already believes things about these guns (an AK one-taps a helmeted
// head at fighting range and an M4 does not), and the damage numbers here have
// to reproduce those beliefs. Two sources of truth about the same gun that
// disagree would show up as a bot whose priced fights and actual fights come
// out differently, which is a bug nobody would find by watching rounds.
//
// It has already earned its keep: two of the numbers below were entered from
// memory and contradicted the table (the M4A1-S one-tapping a helmet, the AUG
// failing to), and both are now reconciled to it. Reconciled is not verified.
// Every `[verify]` in this file still needs checking against the game before a
// calibration run, and where the two disagree the table wins, because the
// fitted model is downstream of it and cannot be re-fitted casually.
// ---------------------------------------------------------------------------

import { WEAPONS } from '../../src/replays/shared/weaponTable.js';
import { WEAPON_SPEED, DEFAULT_WEAPON_SPEED } from './constants.js';
import { killAward } from './economy.js';

/**
 * Hit group multipliers, standard across CS weapons. `[verify]`
 * Armor covers the chest and stomach; helmets cover the head; nothing covers
 * legs, which is why a legs hit is both weak and unmitigated.
 */
export const HIT_GROUP = Object.freeze({
  head: { mult: 4.0, armored: 'helmet' },
  chest: { mult: 1.0, armored: 'kevlar' },
  stomach: { mult: 1.25, armored: 'kevlar' },
  arm: { mult: 1.0, armored: 'kevlar' },
  leg: { mult: 0.75, armored: null }
});

/**
 * Per-weapon simulation stats. `[verify all]` against the game before any
 * calibration run: these are the numbers every duel resolves through, and a
 * wrong one is a systematically wrong fight rather than a visible error.
 *
 * `rangeMod` applies as damage *= rangeMod ^ (distance / 500 units).
 */
export const WEAPON_SIM = Object.freeze({
  // Rifles
  ak47: { damage: 36, armorPen: 0.775, rangeMod: 0.98 },
  m4a1: { damage: 33, armorPen: 0.7, rangeMod: 0.97 },
  // Reconciled to the shipped table rather than verified against the game:
  // weaponTable.js says the M4A1-S does not one-tap a helmeted head, the duel
  // model was fitted with that flag, and 38 damage at 70% pen would one-tap at
  // fighting range. The table wins because consistency with the fitted model
  // matters more than my recollection of a number. `[verify both against CS2]`
  m4a1_silencer: { damage: 33, armorPen: 0.7, rangeMod: 0.97, silenced: true },
  galilar: { damage: 30, armorPen: 0.775, rangeMod: 0.98 },
  famas: { damage: 30, armorPen: 0.7, rangeMod: 0.97 },
  sg556: { damage: 39, armorPen: 0.79, rangeMod: 0.98 },
  // Same reconciliation in the other direction: the table says the AUG DOES
  // one-tap a helmet, which it is known for, and 0.9 pen at 0.97 falloff left
  // it just short at 500 units. `[verify both against CS2]`
  aug: { damage: 28, armorPen: 0.91, rangeMod: 0.99 },

  // Snipers
  awp: { damage: 115, armorPen: 0.975, rangeMod: 0.99 },
  ssg08: { damage: 88, armorPen: 0.85, rangeMod: 0.99 },
  g3sg1: { damage: 80, armorPen: 0.825, rangeMod: 0.99 },
  scar20: { damage: 80, armorPen: 0.825, rangeMod: 0.99 },

  // Pistols
  glock: { damage: 30, armorPen: 0.47, rangeMod: 0.99 },
  hkp2000: { damage: 35, armorPen: 0.505, rangeMod: 0.91 },
  usp_silencer: { damage: 35, armorPen: 0.505, rangeMod: 0.91, silenced: true },
  p250: { damage: 38, armorPen: 0.645, rangeMod: 0.9 },
  fiveseven: { damage: 32, armorPen: 0.77, rangeMod: 0.92 },
  tec9: { damage: 33, armorPen: 0.9, rangeMod: 0.81 },
  cz75a: { damage: 33, armorPen: 0.79, rangeMod: 0.81 },
  elite: { damage: 38, armorPen: 0.575, rangeMod: 0.86 },
  deagle: { damage: 53, armorPen: 0.93, rangeMod: 0.81 },
  revolver: { damage: 86, armorPen: 0.935, rangeMod: 0.87 },

  // SMGs
  mac10: { damage: 29, armorPen: 0.475, rangeMod: 0.82 },
  mp9: { damage: 26, armorPen: 0.6, rangeMod: 0.84 },
  mp7: { damage: 29, armorPen: 0.625, rangeMod: 0.84 },
  mp5sd: { damage: 27, armorPen: 0.615, rangeMod: 0.84, silenced: true },
  ump45: { damage: 35, armorPen: 0.65, rangeMod: 0.82 },
  p90: { damage: 26, armorPen: 0.69, rangeMod: 0.84 },
  bizon: { damage: 27, armorPen: 0.6, rangeMod: 0.84 },

  // Shotguns: one pellet's worth, fired as a spread of `pellets`
  nova: { damage: 26, armorPen: 0.5, rangeMod: 0.7, pellets: 9 },
  xm1014: { damage: 20, armorPen: 0.8, rangeMod: 0.7, pellets: 6 },
  mag7: { damage: 30, armorPen: 0.575, rangeMod: 0.7, pellets: 8 },
  sawedoff: { damage: 32, armorPen: 0.55, rangeMod: 0.7, pellets: 8 },

  // LMGs
  negev: { damage: 35, armorPen: 0.75, rangeMod: 0.84 },
  m249: { damage: 32, armorPen: 0.8, rangeMod: 0.97 },

  // Melee and utility
  knife: { damage: 40, armorPen: 0.85, rangeMod: 1 },
  taser: { damage: 50, armorPen: 0.5, rangeMod: 1 }
});

const DEFAULT_SIM = { damage: 30, armorPen: 0.7, rangeMod: 0.95 };

/**
 * Base standing inaccuracy in degrees, by category. `[calibrate]`
 *
 * A gun is not perfectly accurate even from a perfectly placed crosshair, and
 * that matters more than it sounds: without it the trigger gate and the hit
 * check read the same number, so a bot fires only when it will hit and its
 * accuracy comes out at 100% at every range. Weapon spread is what makes range
 * cost something on its own, separately from how steady the hand is.
 */
export const CATEGORY_SPREAD = Object.freeze({
  sniper: 0.1,
  rifle: 0.55,
  lmg: 1.1,
  smg: 0.95,
  pistol: 1.05,
  shotgun: 3.2,
  knife: 0,
  other: 1
});

/** Standing inaccuracy for one weapon, in degrees. */
export function weaponSpread(name) {
  const cat = WEAPONS[name]?.category || 'rifle';
  return CATEGORY_SPREAD[cat] ?? CATEGORY_SPREAD.rifle;
}

/**
 * Everything the sim knows about a weapon: the shipped table plus sim stats.
 *
 * Named `simWeapon` rather than `weaponInfo` deliberately. weaponTable.js
 * already exports a `weaponInfo`, and two functions of the same name returning
 * different shapes from adjacent modules is a mistake waiting for whoever
 * autocompletes the wrong import.
 */
export function simWeapon(name) {
  const table = WEAPONS[name] || {};
  const sim = WEAPON_SIM[name] || DEFAULT_SIM;
  return {
    name,
    ...table,
    ...sim,
    runSpeed: WEAPON_SPEED[name] ?? DEFAULT_WEAPON_SPEED,
    killAward: killAward(name),
    silenced: Boolean(sim.silenced),
    pellets: sim.pellets || 1
  };
}

/**
 * Damage one bullet does, and what it does to armor.
 *
 * The armor interaction is CS's, and it is the reason `armorPen` is the stat
 * that separates an AK from an M4 far more than raw damage does: against an
 * armored target the gun only lands `armorPen` of its damage on health, and the
 * rest is absorbed at half rate by the vest.
 *
 * @param {object} args
 * @param {string} args.weapon
 * @param {number} args.distance  world units
 * @param {'head'|'chest'|'stomach'|'arm'|'leg'} args.group
 * @param {number} args.armor     target's armor 0..100
 * @param {boolean} args.helmet
 * @returns {{health: number, armor: number, raw: number}}
 */
export function bulletDamage({ weapon, distance, group = 'chest', armor = 0, helmet = false }) {
  const info = simWeapon(weapon);
  const hit = HIT_GROUP[group] || HIT_GROUP.chest;

  const raw = info.damage * hit.mult * Math.pow(info.rangeMod, distance / 500);

  // Which armor, if any, applies to this hit group.
  const covered =
    hit.armored === 'kevlar' ? armor > 0 : hit.armored === 'helmet' ? armor > 0 && helmet : false;

  if (!covered) return { health: raw, armor: 0, raw };

  const toHealth = raw * info.armorPen;
  let toArmor = (raw - toHealth) * 0.5;
  if (toArmor > armor) toArmor = armor;
  return { health: toHealth, armor: toArmor, raw };
}

/**
 * Resolve a bullet against a target, returning the new state.
 * Pure: the engine applies the result, this does not mutate.
 */
export function applyBullet(target, { weapon, distance, group }) {
  const dmg = bulletDamage({
    weapon,
    distance,
    group,
    armor: target.armor,
    helmet: target.helmet
  });
  const health = Math.max(0, target.health - dmg.health);
  return {
    health,
    armor: Math.max(0, target.armor - dmg.armor),
    dealt: Math.min(target.health, dmg.health),
    killed: health <= 0,
    group
  };
}

/**
 * Shots to kill a full-health target, for the pricing layer and for sanity
 * checks. Ignores the aim model entirely: this is the ceiling a weapon has, not
 * what a bot will actually achieve.
 */
export function shotsToKill({ weapon, distance = 500, group = 'chest', armor = 100, helmet = true }) {
  let hp = 100;
  let ar = armor;
  let n = 0;
  while (hp > 0 && n < 50) {
    const d = bulletDamage({ weapon, distance, group, armor: ar, helmet });
    hp -= d.health;
    ar = Math.max(0, ar - d.armor);
    n += 1;
  }
  return n;
}

/**
 * Movement penalty after taking a hit. Tagging matters enormously for exit
 * frags and for running a crossfire, which is why SIM-PLAN 4.4 puts it in v1
 * rather than deferring it.
 *
 * @returns {number} speed multiplier in (0, 1]
 */
export function tagFactor(ticksSinceHit, tickRate = 64, recoverSeconds = 0.5, floor = 0.5) {
  const t = ticksSinceHit / tickRate;
  if (t >= recoverSeconds) return 1;
  const k = t / recoverSeconds;
  return floor + (1 - floor) * k;
}

/** Is this weapon's report loud enough to carry the long sound radius (4.7)? */
export function isSilenced(weapon) {
  return simWeapon(weapon).silenced;
}
