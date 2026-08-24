// ---------------------------------------------------------------------------
// wallbang.js
// One bullet through a ported CS2 map, by CS2's rules.
//
// The trainer used to resolve a shot with a single raycast against the bot
// colliders and the map, nearest wins: anything behind geometry was simply not
// hit. That is not how Counter-Strike works, and it is the difference between a
// map and a map you can play on — half the angles on Mirage and Inferno are
// held through plywood, a door, or a stack of crates.
//
// So the resolution is shared/sim3d/penetration.js, which is Source's own
// FireBullet loop: trace, damage, find the exit face, spend penetration power,
// trace again. It charges a wall by THICKNESS over the surface's own
// `bulletPenetrationDistanceModifier` and takes damage off by its
// `bulletPenetrationDamageModifier`, both straight out of
// surfaceproperties_game.txt (shared/sim3d/surfaces.js). Chainlink is 0.99 and
// nearly free; concrete is 0.5; solid metal is 0.27 and stops an AK dead. A
// brush the mapper flagged `physics_passbullets_*` costs nothing at all.
//
// Three things had to exist before this file could:
//
//   the surface table   scripts/gen-trainer-map.mjs now carries the phys hull's
//                       per-triangle surface and passbullets flags across as
//                       index bands, and src/maps/meshMap.js expands them.
//                       Without that every wall is `default` and the material
//                       half of the rule is missing.
//   the tracer          src/cs3d/rayWorld.js, the explorer's own bullet
//                       broadphase, made renderer-agnostic and unit-scaled.
//   the weapon table    the weapons pack's rows — damage, penetration, range,
//                       rangeModifier, armorRatio — which are the game's.
//
// What this file adds is the last mile: turning the solver's answer into
// whatever health model the scenario is running.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  fireBullet,
  rangeFalloff,
  hitgroupMultiplier,
  armorSplit,
  armorAgainst
} from '../../shared/sim3d/penetration.js';
import { UNIT_M } from '../../shared/sim3d/units.js';

const U_PER_M = 1 / UNIT_M;

const _ray = new THREE.Raycaster();
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Fallback weapon rows, for a run whose weapons pack has not landed yet.
 *
 * The pack is the real source (`sharedWeaponAssets().stats(name)`) and these
 * are the same numbers for the three guns the trainer actually fires, so a shot
 * taken in the first second of a session is charged the same as one taken
 * later rather than not penetrating at all.
 */
export const FALLBACK_WEAPONS = Object.freeze({
  ak47: { damage: 36, headshot: 4, armorRatio: 1.55, penetration: 2, range: 8192, rangeModifier: 0.98 },
  awp: { damage: 115, headshot: 4, armorRatio: 1.95, penetration: 2.5, range: 8192, rangeModifier: 0.99 },
  usp_silencer: { damage: 35, headshot: 4, armorRatio: 1.01, penetration: 1, range: 4096, rangeModifier: 0.91 }
});

/** Scene metres, y-up → Source units, z-up. */
function toSource(v) {
  return { x: v.x * U_PER_M, y: -v.z * U_PER_M, z: v.y * U_PER_M };
}

/** Source units, z-up → scene metres, y-up. */
function toScene(p, out) {
  return out.set(p.x * UNIT_M, p.z * UNIT_M, -p.y * UNIT_M);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function along(from, dir, d) {
  return { x: from.x + dir.x * d, y: from.y + dir.y * d, z: from.z + dir.z * d };
}

/**
 * Resolve a shot through a ported map's hull.
 *
 * @param {object} o
 * @param {THREE.Vector3} o.origin       eye, scene metres
 * @param {THREE.Vector3} o.direction    unit, scene metres
 * @param {object} o.world               a ported map's `rayWorld`
 * @param {object} o.weapon              a weapons-pack row (or FALLBACK_WEAPONS)
 * @param {THREE.Object3D[]} o.colliders bot hit meshes
 * @param {boolean} [o.ignoreWalls]      if set, a bot on the ray is a hit even
 *   when the wall in front of them is thicker than the bullet can pay for.
 *   Misses still walk the real hull so the tracer has a wall to stop on.
 * @returns {{ hit: object|null, impacts: object[], penetrations: number,
 *   damage: number, end: THREE.Vector3 }}
 */
export function resolveShot({ origin, direction, world, weapon, colliders = [], ignoreWalls = false }) {
  const src = toSource(origin);
  const dir = toSource(direction);
  // toSource is a rotation plus a uniform scale, so a direction comes back
  // scaled; the solver wants it unit.
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  dir.x /= dl;
  dir.y /= dl;
  dir.z /= dl;

  /**
   * The first bot on a segment of the bullet's path.
   *
   * Called once per penetration step with the segment between where the bullet
   * currently is and the next wall, so a bot standing in front of a wall is hit
   * before the wall and one behind it only after the wall has been paid for.
   */
  const hitTargets = (from, to) => {
    if (!colliders.length) return null;
    toScene(from, _a);
    toScene(to, _b);
    const far = _a.distanceTo(_b);
    if (!(far > 1e-6)) return null;
    _from.copy(_a);
    _dir.copy(_b).sub(_a).multiplyScalar(1 / far);
    _ray.set(_from, _dir);
    _ray.near = 0;
    _ray.far = far;
    const hits = _ray.intersectObjects(colliders, false);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      object: h.object,
      group: h.object.userData?.hitgroup || (h.object.userData?.zone === 'head' ? 'head' : 'chest'),
      // Source units, which is what the solver adds to `traveled`.
      distance: h.distance * U_PER_M,
      point: toSource(h.point),
      armor: 0,
      helmet: false
    };
  };

  if (ignoreWalls) {
    const range = weapon?.range || 8192;
    const target = hitTargets(src, along(src, dir, range));
    if (target) {
      const d = target.distance;
      const raw = rangeFalloff(weapon?.damage || 0, weapon?.rangeModifier ?? 0.98, d)
        * hitgroupMultiplier(target.group, weapon?.headshot ?? 4);
      const split = armorSplit(
        raw,
        weapon?.armorRatio ?? 1,
        armorAgainst(target.group, target.armor || 0, target.helmet)
      );
      const wall = world.trace(src, along(src, dir, d));
      const through = !!(wall && wall.distance < d - 1e-3);
      const end = new THREE.Vector3();
      toScene(target.point || along(src, dir, d), end);
      return {
        hit: { ...target, distance: d, damage: split.health, armor: split.armor, penetrated: through ? 1 : 0 },
        impacts: [],
        penetrations: through ? 1 : 0,
        damage: split.health,
        end
      };
    }
  }

  const res = fireBullet({ src, dir, weapon, world, hitTargets });
  const end = new THREE.Vector3();
  toScene(res.end || src, end);
  return {
    hit: res.hits[0] || null,
    impacts: res.impacts,
    penetrations: res.penetrations,
    damage: res.damage,
    end
  };
}

/**
 * Did enough of the bullet arrive to count?
 *
 * The trainer's deathmatch counts HITS, not health, so the solver's damage has
 * to become a yes or a no somewhere. This is that line, and it is drawn low on
 * purpose: CS2 stops a bullet outright when what is left would be under a
 * point, so anything that arrives at all was meant to arrive. What this rejects
 * is the long-range graze through two walls that would tickle for four damage
 * and, under a hit-counting model, would otherwise count the same as a clean
 * chest shot.
 */
export const GRAZE_DAMAGE = 15;

/** A hit that landed after going through something, for a kill feed. */
export function wasWallbang(res) {
  return !!res.hit && res.penetrations > 0;
}
