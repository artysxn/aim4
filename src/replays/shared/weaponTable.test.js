// Guards the duel model's weapon inputs.
//
// The table is keyed by bareWeapon() stems, so the failure it is built to catch
// is drift: a gun gets added to GUN_PRIORITY, nothing here changes, and every
// duel involving it is silently scored as if the player held a Glock.

import { GUN_PRIORITY, bareWeapon } from '../viewer/equipmentIcons.js';
import { CATEGORY_TIER, WEAPONS, weaponInfo, weaponTier } from './weaponTable.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// Every gun the rest of the app knows about has real stats here.
{
  for (const stem of GUN_PRIORITY) {
    assert(WEAPONS[stem], `GUN_PRIORITY stem missing from WEAPONS: ${stem}`);
  }
}

// Ranges, so a typo'd price or magazine cannot pass unnoticed.
{
  const categories = new Set(Object.keys(CATEGORY_TIER));
  for (const [stem, w] of Object.entries(WEAPONS)) {
    assert(categories.has(w.category), `${stem}: unknown category ${w.category}`);
    assert(w.price >= 0 && w.price <= 6000, `${stem}: price out of range`);
    assert(w.magSize >= 0 && w.magSize <= 200, `${stem}: magSize out of range`);
    assert(w.reloadSeconds >= 0 && w.reloadSeconds <= 8, `${stem}: reloadSeconds out of range`);
    assert(w.cycleSeconds > 0 && w.cycleSeconds <= 2, `${stem}: cycleSeconds out of range`);
    assert(typeof w.oneTapHeadHelmet === 'boolean', `${stem}: oneTapHeadHelmet not a boolean`);
  }
}

// Spelling variants the parser emits all land on the same entry.
{
  for (const [a, b] of [
    ['weapon_ak47', 'ak47'],
    ['AK-47', 'ak47'],
    ['Desert Eagle', 'deagle'],
    ['M4A1-S', 'm4a1_silencer'],
    ['M4A4', 'm4a1'],
    ['USP-S', 'usp_silencer'],
    ['Glock-18', 'glock'],
    ['AWP', 'awp']
  ]) {
    assert(bareWeapon(a) === b, `bareWeapon(${a}) should be ${b}`);
    assert(weaponInfo(a).price === WEAPONS[b].price, `${a} should price like ${b}`);
  }
}

// Unknown input degrades to the cheapest thing in the game rather than throwing.
{
  const junk = weaponInfo('not_a_real_gun_9000');
  assert(junk.price === WEAPONS.glock.price, 'unknown weapon falls back to a starting pistol');
  assert(weaponInfo('').price === WEAPONS.glock.price, 'empty name falls back');
  assert(weaponInfo(null).category === 'pistol', 'null name falls back');
}

// Knife skins share one entry instead of appearing as unknown pistols.
{
  for (const k of ['Karambit', 'weapon_knife_t', 'Butterfly Knife', 'Bayonet']) {
    assert(weaponInfo(k).category === 'knife', `${k} should read as a knife`);
    assert(weaponInfo(k).price === 0, `${k} should be free`);
  }
}

// Ordering the model relies on being sane: the facts that motivate the
// nonlinear price handling in the first place.
{
  assert(WEAPONS.awp.price - WEAPONS.ak47.price === 2050, 'AK to AWP gap');
  assert(WEAPONS.ak47.price - WEAPONS.deagle.price === 2000, 'Deagle to AK gap');
  assert(WEAPONS.awp.cycleSeconds > 1, 'AWP re-fire delay is the punishing one');
  assert(WEAPONS.awp.cycleSeconds > 10 * WEAPONS.ak47.cycleSeconds, 'AWP cycles far slower than an AK');
  assert(WEAPONS.ak47.oneTapHeadHelmet && !WEAPONS.m4a1.oneTapHeadHelmet, 'AK one-taps helmets, M4 does not');
}

// Tier ordinals are only used for diagnostic buckets, but they should still rank.
{
  assert(weaponTier('awp') > weaponTier('ak47'), 'sniper outranks rifle');
  assert(weaponTier('ak47') > weaponTier('mp9'), 'rifle outranks smg');
  assert(weaponTier('deagle') > weaponTier('glock'), 'expensive pistol outranks starting pistol');
  assert(weaponTier('knife') === 0, 'knife is the floor');
}

console.log('weaponTable.test.js: ok');
