// ---------------------------------------------------------------------------
// shared/sim3d/fireSpread.js
// Where a molotov burns.
//
// This is CS2's own spread, the one its walk mode lays down when there is no
// recorded inferno to replay: seats are added one at a time, each one grown
// OUTWARD off a seat that is already burning, and the puddle that comes out is
// a branching splat rather than a disc. Four rules do all of it:
//
//   OUTWARD OFF A PARENT   A new seat picks a burning one at random and steps
//                          42 units away from the impact, within ±45° of
//                          straight out. That is why a molotov has arms — it
//                          reaches down the line a previous seat opened
//                          instead of filling a circle evenly.
//
//   NO OVERLAP             A candidate closer than 0.9 spacings to an existing
//                          seat is thrown away, so the puddle never doubles up
//                          and the 16 seats spend themselves on ground.
//
//   IT HAS TO BE FLOOR     Each candidate is dropped onto whatever is beneath
//                          it, searching from 48 above its parent down 160, and
//                          kept only if the floor it finds is within 54 units
//                          of the parent's. Fire walks down a staircase and
//                          stops at the lip of a drop.
//
//   IT LIGHTS AND DIES     Seats light one at a time over 115 ticks (1.8 s) and
//                          go out LAST-LIT-FIRST from 72% of the burn, which is
//                          what makes a molotov shrink back towards where the
//                          bottle broke instead of dimming all at once.
//
// ONE THING IS OURS, and it is marked below. CS2 draws its candidate angles
// from `Math.random()`, so the same throw makes a different puddle every time;
// this runs the identical walk on a PRNG, seeded from the impact and the
// velocity it broke with, because a lineup tool that moves the fire between
// replays is not a lineup tool.
//
// The spread has NO downrange bias, and that is the game's shape rather than an
// omission: the first branch leaves the impact in a direction CS2 picks at
// random, and every branch after it points away from the impact. A version that
// leaned downrange was tried and is wrong twice over — it does not match the
// recorded infernos, and a bottle thrown at a ledge spread nowhere at all,
// because every candidate it was allowed to try was over the drop.
//
// Headless, like the rest of shared/sim3d. It needs one thing from the world:
// what is under a point.
// ---------------------------------------------------------------------------

/**
 * [docs] How far apart two seats sit, and the radius each one covers. CS2's
 * walk spread steps exactly this far and rejects anything within 0.9 of it.
 */
export const FLAME_SPACING = 42;

/** A candidate this close to an existing seat is a duplicate. */
const MIN_SEPARATION = FLAME_SPACING * 0.9;

/** [docs] How far off straight-out a branch may lean, radians. */
const BRANCH_SPREAD = (45 * Math.PI) / 180;

/**
 * [docs] `inferno_max_range`, and the one number that differs between the two.
 *
 * Not the flame COUNT — both get 16 seats. A molotov is allowed to spend them
 * over 150 units and an incendiary over 110, so the incendiary packs the same
 * number of flames into a smaller puddle. Side by side that reads as the
 * molotov covering more ground, which is what it does.
 */
export const FIRE_RANGE = 150;
export const FIRE_RANGE_INC = 110;

/** [docs] `inferno_flame_lifetime`: seconds the patch burns. */
export const FIRE_SECONDS = 7;
export const FIRE_SECONDS_INC = 5.5;

/** [docs] Seats, both types. */
export const MAX_FLAMES = Object.freeze({ molotov: 16, incgrenade: 16 });

/** [docs] How long the puddle takes to finish spreading, seconds (115 ticks). */
export const FIRE_SPREAD_SECONDS = 115 / 64;

/** [docs] Fraction of the burn that passes before seats start going out. */
export const FIRE_DIEBACK_AT = 0.72;

/** [docs] How far up a step the fire will follow, units. */
const MAX_STEP = 54;

/** How many candidates may be rejected before the walk gives up. */
const MAX_TRIES = 200;

/**
 * The world, as fire sees it.
 *
 * `groundAt` searches from 48 above `z` down 160 units and returns where it
 * landed, or null for a hole. `canReach` is optional and CS2's walk spread does
 * not use it — a seat is accepted on the strength of its floor alone.
 *
 * @typedef {{
 *   groundAt(x: number, y: number, z: number): {x,y,z}|null,
 *   canReach?(from: {x,y,z}, to: {x,y,z}): boolean
 * }} FireWorld
 */

/** xorshift32, so a throw replays identically. */
function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** The throw, hashed, so the seed is the throw rather than a call counter. */
function seedOf(origin, dir, type) {
  let h = type === 'incgrenade' || type === 'incendiary' ? 0x1f83d9ab : 0x5bf03635;
  const bits = [origin.x, origin.y, origin.z, dir?.x || 0, dir?.y || 0, dir?.z || 0];
  for (const v of bits) h = Math.imul(h ^ Math.round(v * 8), 0x01000193) >>> 0;
  return h;
}

/**
 * Lay out a molotov's flames.
 *
 * @param {object} o
 * @param {{x,y,z}} o.origin      where it broke, Source frame
 * @param {{x,y,z}} [o.dir]       the velocity it broke with; folded into the
 *                                 seed so two throws that land on the same spot
 *                                 from different angles are different puddles
 * @param {string} [o.type]       'molotov' | 'incgrenade'
 * @param {FireWorld} [o.world]
 * @returns {{x,y,z,d,at,out}[]} seats, in the order they light. `at` is when it
 *   lights and `out` when it goes out, both seconds from the break.
 */
export function buildFireSpread({ origin, dir = null, type = 'molotov', world = null } = {}) {
  const inc = type === 'incgrenade' || type === 'incendiary';
  const range = inc ? FIRE_RANGE_INC : FIRE_RANGE;
  const life = inc ? FIRE_SECONDS_INC : FIRE_SECONDS;
  const seats = MAX_FLAMES[type] ?? MAX_FLAMES.molotov;
  const rand = rng(seedOf(origin, dir, type));

  // [dx, dy, dz] from the impact.
  const cells = [[0, 0, 0]];
  for (let tries = 0; cells.length < seats && tries < MAX_TRIES; tries++) {
    const parent = cells[Math.floor(rand() * cells.length)];
    // Away from the impact; the seat AT the impact has no outward direction,
    // so it branches wherever the roll says.
    const out = parent[0] || parent[1] ? Math.atan2(parent[1], parent[0]) : rand() * Math.PI * 2;
    const a = out + (rand() * 2 - 1) * BRANCH_SPREAD;
    const nx = parent[0] + Math.cos(a) * FLAME_SPACING;
    const ny = parent[1] + Math.sin(a) * FLAME_SPACING;
    if (Math.hypot(nx, ny) > range) continue;
    let clash = false;
    for (const c of cells) {
      if (Math.hypot(c[0] - nx, c[1] - ny) < MIN_SEPARATION) {
        clash = true;
        break;
      }
    }
    if (clash) continue;

    // The parent's height is what the drop is measured from, not the impact's,
    // so a run of seats can walk a staircase one step at a time.
    let dz = parent[2];
    if (world) {
      const spot = world.groundAt(origin.x + nx, origin.y + ny, origin.z + parent[2]);
      if (!spot) continue;
      if (Math.abs(spot.z - (origin.z + parent[2])) > MAX_STEP) continue;
      dz = spot.z - origin.z;
    }
    cells.push([nx, ny, dz]);
  }

  // When it lights, and when it goes out. The last seat laid is the first to
  // go, so the puddle retreats towards the bottle.
  const n = cells.length;
  const dieAt = life * FIRE_DIEBACK_AT;
  const dieOver = life - dieAt;
  return cells.map((c, i) => ({
    x: origin.x + c[0],
    y: origin.y + c[1],
    z: origin.z + c[2],
    d: Math.hypot(c[0], c[1]),
    at: n > 1 ? (FIRE_SPREAD_SECONDS * i) / (n - 1) : 0,
    out: dieAt + (dieOver * (n - i)) / n
  }));
}

/**
 * Is this point in the fire? What a player standing in it has to ask.
 * @param {{x,y,z,at,out}[]} flames
 */
export function fireCovers(flames, x, y, z, at = 0) {
  const r = FLAME_SPACING * 0.75;
  for (const f of flames) {
    if (f.at > at || (f.out != null && f.out < at)) continue;
    if (Math.abs(f.z - z) > 72) continue;
    if (Math.hypot(f.x - x, f.y - y) < r) return true;
  }
  return false;
}
