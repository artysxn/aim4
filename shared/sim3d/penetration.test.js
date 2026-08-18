// Run: node shared/sim3d/penetration.test.js
//
// The bullet solver against the game's own tables. Two kinds of assertion in
// here and they are worth telling apart:
//
//   EXACT, because the input is real. The weapon numbers are the ones
//   scripts/cs3d-weapons.mjs read out of weapons.vdata and the surface numbers
//   are the ones scripts/cs3d-surfaces.mjs read out of
//   surfaceproperties_game.txt, so `an AK does 35.28 at 500 units` is a fact
//   about CS2 and this file will fail if the falloff law is ever edited.
//
//   ORDERING, because one constant is not. PENETRATION_UNITS is [guessed] (see
//   the header of penetration.js), so nothing below asserts how many units of
//   concrete an AK gets through. What it does assert is every RATIO that comes
//   out of the real tables: chainlink beats concrete beats solid metal, a rifle
//   beats a pistol, a thick wall beats a thin one, and damage only ever falls.
//   Those hold whatever that scale is set to, and they are what would break if
//   the surface table were misread.

import {
  fireBullet,
  traceToExit,
  boxWorld,
  rangeFalloff,
  armorSplit,
  hitgroupMultiplier,
  armorAgainst,
  wallCost,
  MAX_PENETRATIONS,
  MAX_WALL_THICKNESS,
  FALLOFF_UNITS
} from './penetration.js';
import { SURFACES, surface } from './surfaces.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// The real rows, as the pack carries them.
const AK = { name: 'ak47', damage: 36, penetration: 2, range: 8192, rangeModifier: 0.98, armorRatio: 1.55, headshot: 4 };
const GLOCK = { name: 'glock', damage: 30, penetration: 1, range: 8192, rangeModifier: 0.99, armorRatio: 0.47, headshot: 4 };

// ---- the surface table is the game's, and says what the game says ---------
{
  assert(SURFACES.chainlink.penetration > SURFACES.concrete.penetration, 'a fence is easier than concrete');
  assert(SURFACES.concrete.penetration > SURFACES.solidmetal.penetration, 'concrete is easier than solid metal');
  close(SURFACES.metalgrate.penetration, 0.95, 1e-9, 'metalgrate distance modifier');
  close(SURFACES.metalgrate.damage, 0.99, 1e-9, 'metalgrate damage modifier');
  close(SURFACES.solidmetal.penetration, 0.27, 1e-9, 'solidmetal distance modifier');
  close(SURFACES.concrete.damage, 0.25, 1e-9, 'concrete keeps a quarter of the damage');
  assert(SURFACES.metalgrate.material === 'G' && SURFACES.glass.material === 'Y', 'grate and glass game materials');
  // The inheritance the two files split across: `metal` writes only its own
  // distance modifier and takes gamematerial and damage from `solidmetal`,
  // which it names as its base in the OTHER file.
  close(SURFACES.metal.penetration, 0.4, 1e-9, 'metal has its own distance modifier');
  close(SURFACES.metal.damage, SURFACES.solidmetal.damage, 1e-9, 'and inherits solidmetal damage');
  assert(SURFACES.metal.material === 'M', 'and inherits its game material');
  assert(surface('nonsense-surface') === SURFACES.default, 'an unknown surface falls back to default');
}

// ---- range falloff --------------------------------------------------------
{
  close(rangeFalloff(36, 0.98, 0), 36, 1e-9, 'point blank is the full number');
  close(rangeFalloff(36, 0.98, FALLOFF_UNITS), 36 * 0.98, 1e-9, 'an AK does 35.28 at 500 units');
  close(rangeFalloff(36, 0.98, 2000), 36 * Math.pow(0.98, 4), 1e-9, '...and 33.2 at 2000');
  // The modifier is per 500 units and compounds, so the gentler curve wins at
  // range: a Glock keeps 90% of its damage where an AK has lost 20% of its.
  close(rangeFalloff(1, 0.99, 5000) / rangeFalloff(1, 0.98, 5000), Math.pow(0.99 / 0.98, 10), 1e-9, 'the two curves diverge as a power');
  assert(rangeFalloff(1, 0.99, 5000) > 0.9 && rangeFalloff(1, 0.98, 5000) < 0.82, 'and by 5000 units they are far apart');
}

// ---- armour ---------------------------------------------------------------
{
  const bare = armorSplit(36, 1.55, 0);
  close(bare.health, 36, 1e-9, 'no vest means the whole hit');
  // The table's armorRatio is twice the armour penetration the game shows, so
  // an AK's 1.55 is 77.5% and the hit lands at 36 × 0.775.
  const vest = armorSplit(36, 1.55, 100);
  close(vest.health, 36 * 0.775, 1e-9, 'an AK does 77.5% of its damage through kevlar');
  assert(vest.armor > 0, 'and the vest wears down');
  const pistol = armorSplit(30, 0.94, 100);
  close(pistol.health, 30 * 0.47, 1e-9, 'a Glock does 47% of its');
  assert(pistol.health < vest.health, 'which is far less than the rifle');
  // Every armour-penetration figure the game publishes is armorRatio × 50.
  for (const [ratio, pct] of [[1.55, 77.5], [1.95, 97.5], [1.864, 93.2], [0.94, 47], [1.4, 70]]) {
    close(armorSplit(100, ratio, 100).health, pct, 1e-6, `armorRatio ${ratio} is ${pct}% penetration`);
  }
  // A nearly-gone vest cannot absorb more than it has.
  const shred = armorSplit(100, 0.5, 1);
  assert(shred.armor <= 1, 'the vest never absorbs more than it is worth');
  assert(shred.health > 50, 'and what it cannot stop goes through');
}

// ---- hit groups -----------------------------------------------------------
// Solved from 1,347 recorded hits; see the note on HITGROUP.
{
  close(hitgroupMultiplier('head', 4), 4, 1e-9, 'a head is the weapon own multiplier');
  close(hitgroupMultiplier('head', 3.9), 3.9, 1e-9, '...whatever that is (the Deagle is 3.9)');
  close(hitgroupMultiplier('stomach'), 1.25, 1e-9, 'stomach 1.25');
  close(hitgroupMultiplier('leftleg'), 0.75, 1e-9, 'legs 0.75');
  close(hitgroupMultiplier('right_leg'), 0.75, 1e-9, '...under either spelling the demos use');
  close(hitgroupMultiplier('chest'), 1, 1e-9, 'chest 1');
  // A neck is NOT a head. Six recorded hits say so and they are not close.
  close(hitgroupMultiplier('neck', 4), 1, 1e-9, 'neck 1, not the headshot multiplier');
}

// ---- what armour is actually in the way of --------------------------------
// Kevlar covers the torso and arms; a helmet covers the head; nothing covers a
// leg. Measured: of 36 recorded leg hits on armoured victims, zero took any
// armour damage, against 96-100% for every other body group.
{
  close(armorAgainst('chest', 100), 100, 1e-9, 'a vest is in the way of a chest shot');
  close(armorAgainst('stomach', 100), 100, 1e-9, '...and a stomach shot');
  close(armorAgainst('right_arm', 100), 100, 1e-9, '...and an arm');
  close(armorAgainst('neck', 100), 100, 1e-9, '...and the neck');
  close(armorAgainst('leftleg', 100), 0, 1e-9, 'but not a leg');
  close(armorAgainst('right_leg', 100), 0, 1e-9, '...under either spelling');
  close(armorAgainst('head', 100, false), 0, 1e-9, 'and not the head without a helmet');
  close(armorAgainst('head', 100, true), 100, 1e-9, '...only with one');

  // The bug this rule came from: an unhelmeted head shot takes the full hit.
  const bare = armorSplit(107, 0.94, armorAgainst('head', 73, false));
  close(bare.health, 107, 1e-9, 'a Glock headshot on a bare head is the whole 107');
}

// ---- what a wall costs ----------------------------------------------------
{
  const concrete = wallCost(SURFACES.concrete, SURFACES.concrete, 10);
  const metal = wallCost(SURFACES.solidmetal, SURFACES.solidmetal, 10);
  const grate = wallCost(SURFACES.metalgrate, SURFACES.metalgrate, 10);
  assert(metal.cost > concrete.cost, 'ten units of solid metal cost more than ten of concrete');
  assert(concrete.cost > grate.cost, '...and concrete more than a grate');
  assert(grate.damageLeft > concrete.damageLeft, 'and a grate takes far less damage off');
  const thick = wallCost(SURFACES.concrete, SURFACES.concrete, 40);
  close(thick.cost, concrete.cost * 4, 1e-9, 'cost is linear in thickness');
}

// ---- finding the far side of a wall ---------------------------------------
{
  // One 10-unit concrete wall across x, and a body standing at the origin.
  const world = boxWorld([{ mins: [100, -200, -100], maxs: [110, 200, 200], surface: 'concrete' }]);
  const dir = { x: 1, y: 0, z: 0 };
  const enter = world.trace({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 0 });
  assert(enter && Math.abs(enter.distance - 100) < 1e-6, 'the near face is at 100');
  assert(enter.surface === 'concrete', 'and it knows what it is made of');
  const exit = traceToExit(world, enter.point, dir);
  assert(exit, 'the far face is found');
  close(exit.thickness, 10, 1e-6, 'and the wall is 10 units thick');

  // Thicker than the engine ever looks: no exit at all.
  const slab = boxWorld([{ mins: [100, -200, -100], maxs: [100 + MAX_WALL_THICKNESS + 20, 200, 200], surface: 'concrete' }]);
  const hit = slab.trace({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 0 });
  assert(!traceToExit(slab, hit.point, dir), 'a slab deeper than the search never resolves an exit');
}

// ---- one bullet, one wall -------------------------------------------------
{
  const shot = (weapon, thickness, surfaceName) => {
    const world = boxWorld([
      { mins: [100, -200, -100], maxs: [100 + thickness, 200, 200], surface: surfaceName },
      // A backstop well beyond it, so "did it get through" is a question with
      // an answer rather than a bullet flying off into nothing. Deliberately a
      // slab of solid metal thicker than anything crosses, so reaching it is
      // the only thing it ever reports.
      { mins: [600, -200, -100], maxs: [700, 200, 200], surface: 'solidmetal' }
    ]);
    return fireBullet({ src: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, weapon, world });
  };

  const thin = shot(AK, 4, 'concrete');
  assert(thin.penetrations === 1, 'an AK goes through four units of concrete');
  assert(thin.impacts.length === 2, 'and reaches the backstop behind it');
  assert(thin.damage < 36, 'losing damage on the way');
  close(thin.impacts[0].exit.thickness, 4, 1e-6, 'and it measured the wall');

  const thick = shot(AK, 80, 'concrete');
  assert(thick.penetrations === 0, 'eighty units of concrete stops it');
  assert(thick.impacts.length === 1, 'so the backstop is never reached');

  // The same wall, two guns: penetration power is the difference.
  for (let t = 2; t <= 40; t += 2) {
    const rifle = shot(AK, t, 'concrete').penetrations;
    const pistol = shot(GLOCK, t, 'concrete').penetrations;
    assert(rifle >= pistol, `a rifle never penetrates less than a pistol (${t}u)`);
  }
  assert(shot(AK, 30, 'concrete').penetrations > shot(GLOCK, 30, 'concrete').penetrations, 'and sometimes more');

  // The same gun, two walls: the surface is the difference, and it is the
  // game's own table doing the work.
  const t = 24;
  assert(shot(AK, t, 'chainlink').penetrations >= shot(AK, t, 'concrete').penetrations, 'a fence beats concrete');
  assert(shot(AK, t, 'concrete').penetrations >= shot(AK, t, 'solidmetal').penetrations, 'concrete beats solid metal');
  assert(shot(AK, t, 'solidmetal').penetrations === 0, 'and solid metal stops a rifle at 24 units');

  // Grates and glass are the special case Source makes of them: cheap to cross
  // and they barely touch the bullet.
  const grate = shot(AK, 2, 'metalgrate');
  assert(grate.penetrations === 1, 'a grate is no obstacle');
  assert(grate.damage > 0.9 * rangeFalloff(36, 0.98, 610), 'and takes almost nothing off the damage');
  const wall = shot(AK, 2, 'concrete');
  assert(grate.damage > wall.damage, 'two units of grate beat two units of concrete');
}

// ---- the four-penetration ceiling -----------------------------------------
{
  // Ten sheets of chainlink, which nothing but the ceiling would ever stop.
  const boxes = [];
  for (let i = 0; i < 10; i++) boxes.push({ mins: [100 + i * 40, -200, -100], maxs: [101 + i * 40, 200, 200], surface: 'chainlink' });
  const out = fireBullet({
    src: { x: 0, y: 0, z: 0 },
    dir: { x: 1, y: 0, z: 0 },
    weapon: { ...AK, penetration: 10 },
    world: boxWorld(boxes)
  });
  assert(out.penetrations <= MAX_PENETRATIONS, `never more than ${MAX_PENETRATIONS} walls`);
  assert(out.penetrations === MAX_PENETRATIONS, '...and a fence run reaches the ceiling rather than the budget');
}

// ---- damage only ever falls -----------------------------------------------
{
  const boxes = [];
  for (let i = 0; i < 4; i++) boxes.push({ mins: [100 + i * 30, -200, -100], maxs: [102 + i * 30, 200, 200], surface: 'wood' });
  const out = fireBullet({ src: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, weapon: AK, world: boxWorld(boxes) });
  let last = Infinity;
  for (const im of out.impacts) {
    assert(im.damage <= last + 1e-9, 'damage never goes up through a wall');
    last = im.damage;
  }
  assert(out.impacts.length > 1, 'and it really did cross more than one');
}

// ---- a player in the way ends it ------------------------------------------
{
  const world = boxWorld([{ mins: [400, -200, -100], maxs: [410, 200, 200], surface: 'concrete' }]);
  const out = fireBullet({
    src: { x: 0, y: 0, z: 0 },
    dir: { x: 1, y: 0, z: 0 },
    weapon: AK,
    world,
    hitTargets: (from) => (from.x < 200 ? { id: 'bot', group: 'head', distance: 200, armor: 0 } : null)
  });
  assert(out.hits.length === 1, 'the body is hit');
  assert(!out.impacts.length, 'and the wall behind it never is');
  close(out.hits[0].damage, rangeFalloff(36, 0.98, 200) * 4, 1e-6, 'a headshot is the weapon multiplier on the ranged damage');
}

console.log('penetration.test: ok');
