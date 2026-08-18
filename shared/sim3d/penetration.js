// ---------------------------------------------------------------------------
// shared/sim3d/penetration.js
// One bullet: where it goes, what it goes through, and what it does when it
// gets there. Source's FireBullet loop — trace, damage, find the exit face,
// spend penetration power, trace again — in the sim's frame and with no
// renderer in sight, the same way shared/sim3d/grenade.js is.
//
// PROVENANCE, because this file is a mix and the mix matters.
//
//   REAL, extracted. Every per-weapon number (damage, penetration, range,
//   rangeModifier, armorRatio, headshot multiplier) comes out of the game's
//   own weapons.vdata via scripts/cs3d-weapons.mjs. Every per-surface number
//   (bulletPenetrationDistanceModifier, bulletPenetrationDamageModifier, the
//   game material) comes out of surfaceproperties_game.txt via
//   scripts/cs3d-surfaces.mjs. Nothing in either table is invented, and the
//   ratios they encode are the ones players feel: chainlink 0.99, metalgrate
//   0.95, concrete 0.5, solid metal 0.27.
//
//   [docs] The SHAPE of the loop, and the constants stated plainly in the
//   Source engine: at most four penetrations per bullet, a 90-unit ceiling on
//   how far past an entry face the exit is looked for, damage falling off as
//   rangeModifier^(distance/500), and the armour split at armorRatio with a
//   0.5 bonus.
//
//   [measured], against the demo corpus. The hit-group multipliers, the
//   armorRatio halving, and WHICH hits armour is in the way of were all solved
//   from 1,347 recorded hits by scripts/cs3d-bullet-oracle.mjs rather than
//   assumed — and two of the three were bugs when it was first run. See the
//   notes on HITGROUP, ARMOR_RATIO_SCALE and armorAgainst.
//
//   [guessed] ONE number: PENETRATION_UNITS, which converts a weapon's
//   penetration power into units of wall it can cross. Unlike everything in
//   shared/sim3d/grenade.js — where every constant was solved against recorded
//   throws — this one has no local measurement behind it, because a demo
//   records that a bullet penetrated but not the thickness or surface of what
//   it went through. It is set so the ratios that ARE real do the work: an AK
//   (power 2) crosses about twice what a Glock (power 1) does, chainlink is
//   nearly free, and solid metal stops both. If it is ever measured, this is
//   the single line to change; see the note on the constant.
//
// The world is an interface, exactly like the one motion.js takes, so the same
// solver runs over the map's BVH in the browser (src/cs3d/rayWorld.js) and
// over a list of boxes in a Node test:
//
//   world.trace(from, to) ->
//     { point:{x,y,z}, normal:{x,y,z}, distance, triangle, surface } | null
// ---------------------------------------------------------------------------

import { surface as surfaceOf, MAT_GRATE, MAT_GLASS } from './surfaces.js';

/** [docs] A bullet may cross at most this many surfaces. */
export const MAX_PENETRATIONS = 4;

/** [docs] How far past an entry face Source looks for the exit. */
export const MAX_WALL_THICKNESS = 90;

/** [docs] The step TraceToExit walks forward in while hunting for open air. */
const EXIT_STEP = 4;

/** [docs] Damage falls off as rangeModifier ^ (distance / this). */
export const FALLOFF_UNITS = 500;

/**
 * [guessed] Units of wall one point of a weapon's penetration power is worth.
 *
 * The only number in this file with nothing behind it — see the header. What
 * it is NOT: a fudge factor on the surface table, which is real and does the
 * shaping. A wall costs `thickness / surface.penetration` of budget, so at 35
 * an AK (power 2, budget 70) crosses ~35 units of concrete (0.5), ~70 of
 * chainlink (0.99) and ~19 of solid metal (0.27), while a Glock (power 1)
 * crosses half of each. Those ratios are the game's; the scale is a choice.
 */
export const PENETRATION_UNITS = 35;

/**
 * [measured] Hit group damage multipliers. The head's is per weapon
 * (`m_flHeadshotMultiplier`, 4 on nearly everything, 3.9 on the Deagle); the
 * rest are engine constants, and these are the values the demo corpus gives
 * back when the damage law is inverted on every recorded hit
 * (scripts/cs3d-bullet-oracle.mjs, 1,347 hits across two demos):
 *
 *   chest      0.980  n=411      arms   0.979 / 0.986  n=85
 *   stomach    1.235  n=106      legs   0.741 / 0.777  n=30
 *   neck       0.981  n=6        head   0.930 of the weapon's own, n=68
 *
 * Every one within 2% of the number below, and the 2% is accounted for: the
 * oracle measures distance feet-to-feet where the real shot runs eye to
 * hitbox, which biases every row slightly long and so slightly low. The head
 * sits further off because a head shot that did NOT kill is over-represented by
 * wallbangs, which is the one thing that population cannot avoid.
 *
 * `neck` is a group of its own and takes 1, not the headshot multiplier —
 * asserting otherwise put its six recorded hits 84 points out.
 */
export const HITGROUP = Object.freeze({
  generic: 1,
  head: null, // the weapon's own
  neck: 1,
  chest: 1,
  stomach: 1.25,
  leftarm: 1,
  rightarm: 1,
  left_arm: 1,
  right_arm: 1,
  leftleg: 0.75,
  rightleg: 0.75,
  left_leg: 0.75,
  right_leg: 0.75
});

/** [docs] Kevlar takes half of what it stops off the vest. */
export const ARMOR_BONUS = 0.5;

/**
 * [measured] `m_flArmorRatio` in the game's table is TWICE the armour
 * penetration the game shows, so it is halved before use.
 *
 * Not an assumption: the pack's own values match the published percentages on
 * every weapon checked. AK 1.55 → 77.5%, AWP 1.95 → 97.5%, Deagle 1.864 →
 * 93.2%, Glock 0.94 → 47%. Without the halving an AK would do MORE damage
 * through kevlar than without it, which is how the mistake announces itself.
 */
export const ARMOR_RATIO_SCALE = 0.5;

/** Damage left after flying `distance` units. */
export function rangeFalloff(damage, rangeModifier, distance) {
  if (!(rangeModifier > 0) || rangeModifier >= 1) return damage;
  return damage * Math.pow(rangeModifier, distance / FALLOFF_UNITS);
}

/**
 * Source's armour split: the vest takes a share of the hit and wears down.
 *
 * @returns {{ health: number, armor: number }} damage to each
 */
export function armorSplit(damage, armorRatio, armorValue) {
  if (!(armorValue > 0)) return { health: damage, armor: 0 };
  let health = damage * armorRatio * ARMOR_RATIO_SCALE;
  let armor = (damage - health) * ARMOR_BONUS;
  if (armor > armorValue) {
    armor = armorValue * (1 / ARMOR_BONUS);
    health = damage - armor;
  }
  return { health, armor: Math.min(armorValue, armor * ARMOR_BONUS) };
}

/** The multiplier for a hit group, given the weapon's own headshot number. */
export function hitgroupMultiplier(group, headshot = 4) {
  if (group === 'head') return headshot;
  const m = HITGROUP[group];
  return Number.isFinite(m) ? m : 1;
}

/**
 * [measured] Which hits armour is actually in the way of.
 *
 * Kevlar covers the torso and arms. A head shot meets a HELMET or nothing at
 * all, and a leg is not covered by either.
 *
 * Both halves came out of the demo corpus rather than out of a manual, and both
 * were bugs first. Across two demos, 1,347 recorded hits:
 *
 *   chest 445/462, stomach 134/136, arms 97/100 and neck 5/5 hits on an
 *   armoured victim took armour damage — 96 to 100%, so the vest is in the way.
 *   Legs: 0 out of 36. Not one. Kevlar does not cover a leg.
 *
 * The head is 166/216, which is the helmet being a separate purchase, so
 * `helmet` is a parameter rather than an assumption. Getting this wrong put
 * every recorded pistol headshot 40 to 60 points above the prediction and the
 * numbers landed exactly on the vest ratio: a Glock at 353 units recorded 107
 * where the model said 50, and 107 is 30 × 0.85^(353/500) × 4 with no armour
 * term in it at all.
 */
export function armorAgainst(group, armor = 0, helmet = false) {
  if (group === 'head') return helmet ? armor : 0;
  if (group === 'leftleg' || group === 'rightleg' || group === 'left_leg' || group === 'right_leg') return 0;
  return armor;
}

/**
 * How much of a bullet's budget one wall costs, and how much damage survives.
 *
 * Grates and glass are the special case Source makes of them: you can see
 * through a fence and you can shoot through it, so it is nearly free both
 * ways. Everything else pays by thickness over the surface's own modifier.
 *
 * @param {object} enter  the surface the bullet went in through
 * @param {object} exit   the surface it came out of (usually the same wall)
 * @param {number} thickness  units between the two faces
 */
export function wallCost(enter, exit, thickness) {
  const seeThrough = enter.material === MAT_GRATE || enter.material === MAT_GLASS;
  // Two faces of one wall: the easier of the two is not a free pass, so the
  // pair is averaged, which is what Source does with the entry and exit
  // surfaces when they differ.
  const modifier = seeThrough ? 1 : Math.max(0.01, (enter.penetration + (exit?.penetration ?? enter.penetration)) / 2);
  return {
    cost: thickness / modifier,
    // A grate barely touches the bullet (0.99 in the table); a concrete wall
    // takes three quarters of it (0.25).
    damageLeft: seeThrough ? Math.max(enter.damage, 0.9) : enter.damage
  };
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
const along = (from, dir, d) => ({ x: from.x + dir.x * d, y: from.y + dir.y * d, z: from.z + dir.z * d });

/**
 * Source's TraceToExit: from a point on an entry face, walk forward until the
 * bullet is in open air, then trace back to find the face it came out of.
 *
 * @returns {{ point, normal, surface, thickness }|null} null when the bullet
 *   never leaves the solid inside MAX_WALL_THICKNESS
 */
export function traceToExit(world, enterPoint, dir, maxThickness = MAX_WALL_THICKNESS) {
  for (let d = EXIT_STEP; d <= maxThickness; d += EXIT_STEP) {
    const probe = along(enterPoint, dir, d);
    // From out there, back towards the entry: the first thing hit is the wall's
    // far face. Nothing hit means the probe is still inside the solid.
    const back = world.trace(probe, enterPoint);
    if (!back) continue;
    const thickness = len(sub(back.point, enterPoint));
    if (thickness > maxThickness) return null;
    return { point: back.point, normal: back.normal, surface: back.surface, thickness };
  }
  return null;
}

/**
 * Fire one bullet.
 *
 * @param {object} o
 * @param {{x,y,z}} o.src        eye, Source frame
 * @param {{x,y,z}} o.dir        unit direction, Source frame
 * @param {object} o.weapon      a row from the weapons pack
 * @param {object} o.world       see the header
 * @param {(from, to) => object|null} [o.hitTargets]  first player hit on a
 *   segment: `{ id, group, distance, point, armor }`
 * @returns {{ impacts, hits, damage, penetrations, traveled }}
 */
export function fireBullet({ src, dir, weapon, world, hitTargets = null }) {
  const range = weapon?.range || 8192;
  const rangeModifier = weapon?.rangeModifier ?? 0.98;
  const headshot = weapon?.headshot ?? 4;
  let damage = weapon?.damage || 0;
  let budget = (weapon?.penetration || 0) * PENETRATION_UNITS;
  let left = MAX_PENETRATIONS;

  const impacts = [];
  const hits = [];
  let from = { x: src.x, y: src.y, z: src.z };
  let traveled = 0;
  let penetrations = 0;
  /** Where the bullet actually stopped, for anything that wants to draw it. */
  let end = { x: src.x, y: src.y, z: src.z };

  while (traveled < range) {
    const remain = range - traveled;
    const to = along(from, dir, remain);
    end = to;

    // A player in the way ends the bullet before the wall behind them does.
    const wall = world.trace(from, to);
    const target = hitTargets ? hitTargets(from, wall ? wall.point : to) : null;
    if (target && (!wall || target.distance <= wall.distance)) {
      const d = traveled + target.distance;
      const raw = rangeFalloff(damage, rangeModifier, d) * hitgroupMultiplier(target.group, headshot);
      const split = armorSplit(
        raw,
        weapon?.armorRatio ?? 1,
        armorAgainst(target.group, target.armor || 0, target.helmet)
      );
      hits.push({ ...target, distance: d, damage: split.health, armor: split.armor, penetrated: penetrations });
      return { impacts, hits, damage: split.health, penetrations, traveled: d, end: target.point || along(from, dir, target.distance) };
    }

    if (!wall) {
      traveled += remain;
      break;
    }
    end = wall.point;

    traveled += wall.distance;
    damage = rangeFalloff(damage, rangeModifier, wall.distance);
    const enter = surfaceOf(wall.surface);
    const impact = {
      point: wall.point,
      normal: wall.normal,
      surface: wall.surface,
      triangle: wall.triangle,
      // A mover (a door leaf) carries itself and where on it the round
      // landed; both are undefined for ordinary world geometry.
      interactive: wall.interactive,
      local: wall.local,
      distance: traveled,
      damage,
      penetrated: false
    };
    impacts.push(impact);

    if (left <= 0 || budget <= 0) break;
    const exit = traceToExit(world, wall.point, dir);
    if (!exit) break; // never comes out: the wall is thicker than the engine looks

    const { cost, damageLeft } = wallCost(enter, surfaceOf(exit.surface), exit.thickness);
    if (cost > budget) break;

    budget -= cost;
    left--;
    penetrations++;
    damage *= damageLeft;
    impact.penetrated = true;
    impact.exit = exit;
    if (damage <= 1) break;

    // Out the far side, one step clear so the next trace does not re-hit the
    // face it just left.
    from = along(exit.point, dir, 1 / 32);
    traveled += exit.thickness;
  }

  return { impacts, hits, damage, penetrations, traveled, end };
}

/**
 * A world made of axis-aligned boxes, for tests and headless use. Source
 * frame; `surface` names index shared/sim3d/surfaces.js.
 *
 * @param {{mins:number[], maxs:number[], surface?:string}[]} boxes
 */
export function boxWorld(boxes) {
  return {
    trace(from, to) {
      const d = sub(to, from);
      const total = len(d);
      if (!(total > 0)) return null;
      const dir = { x: d.x / total, y: d.y / total, z: d.z / total };
      let bestT = total;
      let best = null;
      for (const b of boxes) {
        let t0 = 0;
        let t1 = bestT;
        let axis = -1;
        let sign = 1;
        const p = [from.x, from.y, from.z];
        const v = [dir.x, dir.y, dir.z];
        let miss = false;
        for (let k = 0; k < 3 && !miss; k++) {
          if (Math.abs(v[k]) < 1e-9) {
            if (p[k] < b.mins[k] || p[k] > b.maxs[k]) miss = true;
            continue;
          }
          let lo = (b.mins[k] - p[k]) / v[k];
          let hi = (b.maxs[k] - p[k]) / v[k];
          let s = -1;
          if (lo > hi) {
            const sw = lo;
            lo = hi;
            hi = sw;
            s = 1;
          }
          if (lo > t0) {
            t0 = lo;
            axis = k;
            sign = s;
          }
          if (hi < t1) t1 = hi;
          if (t0 > t1) miss = true;
        }
        if (miss || t0 <= 0 || t0 >= bestT) continue;
        bestT = t0;
        const n = { x: 0, y: 0, z: 0 };
        if (axis === 0) n.x = sign;
        else if (axis === 1) n.y = sign;
        else n.z = sign;
        best = {
          point: along(from, dir, t0),
          normal: n,
          distance: t0,
          triangle: boxes.indexOf(b),
          surface: b.surface || 'default'
        };
      }
      return best;
    }
  };
}
