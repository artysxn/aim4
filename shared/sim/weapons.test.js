// Run: node shared/sim/weapons.test.js
//
// The damage numbers are new; the beliefs they have to satisfy are not. The
// duel model was fitted against weaponTable.js, and that table already asserts
// which guns one-tap a helmeted head at fighting range. If the damage model
// here disagrees with those flags, then a bot's priced fights and its actual
// fights resolve differently, and nothing about that shows up as an error.
//
// So the load-bearing block is the last one: every `oneTapHeadHelmet` flag in
// the shipped table is checked against what this file computes.

import { WEAPONS } from '../../src/replays/shared/weaponTable.js';
import {
  HIT_GROUP,
  applyBullet,
  bulletDamage,
  isSilenced,
  shotsToKill,
  tagFactor,
  simWeapon
} from './weapons.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the info merge ---------------------------------------------------------

{
  const ak = simWeapon('ak47');
  assert(ak.price === 2700, 'the shipped table still supplies the price');
  assert(ak.cycleSeconds > 0, 'and the cycle time the duel model uses');
  assert(ak.damage === 36, 'while the sim table supplies damage');
  assert(ak.runSpeed === 215, 'and the movement constant supplies speed');
  assert(ak.killAward === 300, 'and the economy supplies the award');

  const unknown = simWeapon('bfg9000');
  assert(unknown.damage > 0, 'an unknown weapon still resolves rather than throwing');
}

// ---- hit groups -------------------------------------------------------------

{
  const at = (group) => bulletDamage({ weapon: 'ak47', distance: 0, group }).raw;
  assert(Math.abs(at('head') / at('chest') - 4) < 1e-9, 'a head hit is 4x a chest hit');
  assert(Math.abs(at('stomach') / at('chest') - 1.25) < 1e-9, 'stomach is 1.25x');
  assert(Math.abs(at('leg') / at('chest') - 0.75) < 1e-9, 'legs are 0.75x');
  assert(HIT_GROUP.leg.armored === null, 'and nothing armors the legs');
}

{
  // Legs are unarmored, so a vest does not reduce a leg shot at all.
  const bare = bulletDamage({ weapon: 'ak47', distance: 0, group: 'leg', armor: 0 });
  const vest = bulletDamage({ weapon: 'ak47', distance: 0, group: 'leg', armor: 100 });
  assert(Math.abs(bare.health - vest.health) < 1e-9, 'kevlar does not cover legs');
  assert(vest.armor === 0, 'and takes no damage from a leg hit');

  // A helmet only matters for the head.
  const chestHelm = bulletDamage({ weapon: 'ak47', distance: 0, group: 'chest', armor: 100, helmet: true });
  const chestNoHelm = bulletDamage({ weapon: 'ak47', distance: 0, group: 'chest', armor: 100, helmet: false });
  assert(Math.abs(chestHelm.health - chestNoHelm.health) < 1e-9, 'a helmet does nothing for the chest');
}

// ---- armor -----------------------------------------------------------------

{
  const naked = bulletDamage({ weapon: 'ak47', distance: 0, group: 'chest', armor: 0 });
  const armored = bulletDamage({ weapon: 'ak47', distance: 0, group: 'chest', armor: 100 });
  assert(armored.health < naked.health, 'armor reduces damage to health');
  assert(armored.armor > 0, 'and absorbs some itself');
  assert(Math.abs(armored.health / naked.health - 0.775) < 1e-9, "by exactly the AK's armor pen");

  // Armor penetration, not raw damage, is what separates these two guns
  // against an armored target.
  const akArm = bulletDamage({ weapon: 'ak47', distance: 0, group: 'chest', armor: 100 }).health;
  const m4Arm = bulletDamage({ weapon: 'm4a1', distance: 0, group: 'chest', armor: 100 }).health;
  assert(akArm > m4Arm, 'the AK hits harder through a vest');
}

// ---- range falloff ---------------------------------------------------------

{
  const near = bulletDamage({ weapon: 'ak47', distance: 0, group: 'chest' }).raw;
  const far = bulletDamage({ weapon: 'ak47', distance: 2000, group: 'chest' }).raw;
  assert(far < near, 'a rifle loses damage with range');
  assert(far / near > 0.8, 'but not much: it is a rifle');

  const smgNear = bulletDamage({ weapon: 'mac10', distance: 0, group: 'chest' }).raw;
  const smgFar = bulletDamage({ weapon: 'mac10', distance: 2000, group: 'chest' }).raw;
  assert(smgFar / smgNear < far / near, 'an SMG falls off far harder, which is why range is the counter');

  const awpNear = bulletDamage({ weapon: 'awp', distance: 0, group: 'chest', armor: 100 }).health;
  const awpFar = bulletDamage({ weapon: 'awp', distance: 3000, group: 'chest', armor: 100 }).health;
  assert(awpNear >= 100 && awpFar >= 100, 'the AWP kills a full-hp armored body at any range');
}

// ---- applying a bullet ------------------------------------------------------

{
  const target = { health: 100, armor: 100, helmet: true };
  const r = applyBullet(target, { weapon: 'ak47', distance: 500, group: 'chest' });
  assert(r.health < 100 && r.health > 0, 'one AK body shot does not kill a full-hp target');
  assert(r.armor < 100, 'and takes armor off');
  assert(!r.killed, 'and does not kill');
  assert(r.dealt > 0, 'and reports what it dealt');

  const lowHp = applyBullet({ health: 5, armor: 0, helmet: false }, { weapon: 'glock', distance: 500, group: 'chest' });
  assert(lowHp.killed && lowHp.health === 0, 'a lethal hit kills and floors health at zero');
  assert(lowHp.dealt === 5, 'and reports only the damage that landed, not the overkill');
}

// ---- shots to kill ----------------------------------------------------------

{
  const akBody = shotsToKill({ weapon: 'ak47', distance: 500, group: 'chest' });
  assert(akBody === 4, `an AK needs 4 armored body shots at mid range (got ${akBody})`);
  const awpBody = shotsToKill({ weapon: 'awp', distance: 1000, group: 'chest' });
  assert(awpBody === 1, 'an AWP body shot is always lethal');
  // Legs are unarmored but only 0.75x, so a Glock needs five of them where it
  // would need four to the chest of the same unarmored target.
  const glockLegs = shotsToKill({ weapon: 'glock', distance: 500, group: 'leg', armor: 0, helmet: false });
  const glockChest = shotsToKill({ weapon: 'glock', distance: 500, group: 'chest', armor: 0, helmet: false });
  assert(glockLegs === 5, `glock legs is five bullets (got ${glockLegs})`);
  assert(glockChest === 4, `and chest is four (got ${glockChest})`);
  assert(glockLegs > glockChest, 'legs always cost more bullets than chest');
}

// ---- tagging ----------------------------------------------------------------

{
  assert(Math.abs(tagFactor(0) - 0.5) < 1e-9, 'a fresh hit halves speed');
  assert(tagFactor(16) > 0.5 && tagFactor(16) < 1, 'and it recovers over time');
  assert(tagFactor(32) === 1, 'fully, after half a second');
  assert(tagFactor(1000) === 1, 'and stays there');
}

// ---- silencers --------------------------------------------------------------

assert(isSilenced('usp_silencer'), 'the USP-S is quiet');
assert(isSilenced('m4a1_silencer'), 'so is the M4A1-S');
assert(!isSilenced('ak47'), 'the AK is not');

// ---- agreement with the shipped table ---------------------------------------

{
  // The one that matters. weaponTable.js already states which guns one-tap a
  // helmeted 100 hp head at normal fighting range, and the duel model was
  // fitted with those flags. The damage model has to reproduce them, or the
  // fights a bot prices and the fights it fights come out differently.
  const RANGE = 500;
  const mismatches = [];
  for (const [name, table] of Object.entries(WEAPONS)) {
    if (table.category === 'knife' || table.category === 'other') continue;
    if (table.category === 'shotgun') continue; // pellet spread, not one bullet
    const d = bulletDamage({ weapon: name, distance: RANGE, group: 'head', armor: 100, helmet: true });
    const oneTaps = d.health >= 100;
    if (oneTaps !== Boolean(table.oneTapHeadHelmet)) {
      mismatches.push(`${name}: table says ${table.oneTapHeadHelmet}, damage says ${oneTaps} (${d.health.toFixed(1)})`);
    }
  }
  assert(
    mismatches.length === 0,
    `damage model disagrees with the shipped table on:\n  ${mismatches.join('\n  ')}`
  );

  // And the headline case, spelled out, because it is the single most
  // consequential asymmetry in the game's gun balance.
  const ak = bulletDamage({ weapon: 'ak47', distance: 500, group: 'head', armor: 100, helmet: true });
  const m4 = bulletDamage({ weapon: 'm4a1', distance: 500, group: 'head', armor: 100, helmet: true });
  assert(ak.health >= 100, `the AK one-taps a helmeted head (${ak.health.toFixed(1)})`);
  assert(m4.health < 100, `the M4 does not (${m4.health.toFixed(1)})`);

  // Without a helmet both do, which is why the helmet is the thing being bought.
  const m4NoHelm = bulletDamage({ weapon: 'm4a1', distance: 500, group: 'head', armor: 100, helmet: false });
  assert(m4NoHelm.health >= 100, 'against a bare head the M4 one-taps too');
}

console.log('weapons: ok');
