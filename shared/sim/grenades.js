// ---------------------------------------------------------------------------
// shared/sim/grenades.js
// Utility: what a thrown thing does once it lands.
//
// Trajectories are NOT simulated. Every parsed demo already carries throwTick,
// detonateTick, from, at, and the full path, so a lineup is mined rather than
// solved and travel time is replicated from real demos by construction
// (SIM-PLAN 4.8). That removes an entire physics model and, more importantly,
// removes the risk of a physics model that is subtly wrong in a way that makes
// every execute mistimed.
//
// What is left is effects, and effects are where the tactical content is: a
// smoke is a wall that expires, a molotov is an area you may not stand in, a
// flash is a few seconds of a player being worth nothing.
//
// Flash in particular is modelled as SECONDS OF BLINDNESS rather than as a
// hit-chance penalty, because the two behave differently: a blind player can be
// walked past, traded for, or ignored, and a player with worse aim cannot.
// ---------------------------------------------------------------------------

import {
  FIRE_DPS,
  FIRE_IGNITE_DELAY,
  FIRE_RADIUS,
  FIRE_SECONDS,
  FLASH_MAX_SECONDS,
  HE_FALLOFF_RADIUS,
  HE_MAX_DAMAGE,
  SMOKE_RADIUS,
  SMOKE_SECONDS,
  TICK_RATE,
  ticksFor
} from './constants.js';

export const NADE = Object.freeze({
  SMOKE: 'smokegrenade',
  FLASH: 'flashbang',
  HE: 'hegrenade',
  MOLOTOV: 'molotov',
  INCENDIARY: 'incgrenade',
  DECOY: 'decoy'
});

/** Is this a fire grenade? Molotov and incendiary differ only by side and price. */
export function isFire(type) {
  return type === NADE.MOLOTOV || type === NADE.INCENDIARY;
}

/**
 * An active effect on the map. Created at detonation, expires on its own.
 */
export function createEffect({ type, x, y, level = 'default', tick, thrownBy, side }) {
  const base = { type, x, y, level, startTick: tick, thrownBy, side };
  if (type === NADE.SMOKE) {
    return { ...base, radius: SMOKE_RADIUS, endTick: tick + ticksFor(SMOKE_SECONDS) };
  }
  if (isFire(type)) {
    return {
      ...base,
      radius: FIRE_RADIUS,
      igniteTick: tick + ticksFor(FIRE_IGNITE_DELAY),
      endTick: tick + ticksFor(FIRE_IGNITE_DELAY + FIRE_SECONDS)
    };
  }
  // HE and flash are instantaneous: they exist for one tick so the viewer has
  // something to draw and the belief has something to reweight against.
  return { ...base, radius: HE_FALLOFF_RADIUS, endTick: tick + 1 };
}

export function isActive(effect, tick) {
  return tick >= effect.startTick && tick < effect.endTick;
}

/** Smokes that are up right now, which is what the vision code needs. */
export function activeSmokes(effects, tick) {
  return effects.filter((e) => e.type === NADE.SMOKE && isActive(e, tick));
}

/**
 * HE damage at a distance: full at the centre, linear to zero at the falloff
 * radius, reduced by armor. Line of sight matters, so the caller supplies it:
 * a wall between the blast and the body means no damage at all.
 */
export function heDamage(distance, { armor = 0, losClear = true } = {}) {
  if (!losClear || distance >= HE_FALLOFF_RADIUS) return { health: 0, armor: 0 };
  const raw = HE_MAX_DAMAGE * (1 - distance / HE_FALLOFF_RADIUS);
  if (armor <= 0) return { health: raw, armor: 0 };
  // Armor halves grenade damage and takes some of it. `[verify]`
  const health = raw * 0.5;
  return { health, armor: Math.min(armor, (raw - health) * 0.5) };
}

/**
 * Fire damage for one tick inside a molotov, in health per tick.
 * Standing in fire is 40 hp/s, which is why crossing one is a decision with a
 * price rather than a thing to avoid absolutely (6.9).
 */
export function fireDamagePerTick() {
  return FIRE_DPS / TICK_RATE;
}

/** Is a point inside a burning molotov right now? */
export function inFire(effects, x, y, level, tick) {
  for (const e of effects) {
    if (!isFire(e.type)) continue;
    if (tick < (e.igniteTick ?? e.startTick) || tick >= e.endTick) continue;
    if (e.level !== level) continue;
    if (Math.hypot(e.x - x, e.y - y) <= e.radius) return e;
  }
  return null;
}

/**
 * Seconds of blindness from a flash.
 *
 * Two things decide it: how much of the flash the eyes caught, and how far away
 * it was. Facing it directly at close range is a full blind; catching it in
 * peripheral vision is a fraction of a second; having it behind you is almost
 * nothing. Line of sight is required, so a flash behind a wall does nothing at
 * all, which is why the pop-flash is a skill.
 *
 * @param {object} args
 * @param {number} args.angleFromFacing  degrees between facing and the flash
 * @param {number} args.distance
 * @param {boolean} args.losClear
 */
export function flashSeconds({ angleFromFacing, distance, losClear }) {
  if (!losClear || distance > 2000) return 0;

  const a = Math.abs(angleFromFacing);
  let base;
  if (a <= 53) base = FLASH_MAX_SECONDS;
  else if (a <= 90) base = 2.0;
  else base = 0.3;

  // Falls off with distance, but never to nothing inside the range: a flash
  // across a site still takes an angle away for a moment. `[verify curve]`
  const near = Math.max(0, 1 - distance / 2000);
  return base * (0.25 + 0.75 * near);
}

/**
 * Does a smoke block the line between two points?
 *
 * A segment/circle intersection rather than a check on the endpoints, because
 * the interesting case is exactly the one where neither body is inside the
 * cloud and the cloud is between them.
 */
export function smokeBlocks(smokes, ax, ay, bx, by, level = 'default') {
  for (const s of smokes) {
    if (s.level !== level) continue;
    if (segmentHitsCircle(ax, ay, bx, by, s.x, s.y, s.radius)) return true;
  }
  return false;
}

export function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(px - cx, py - cy) <= r;
}

/**
 * A mined lineup: where it is thrown from, where it lands, and how long it
 * takes. Every field comes from a real grenade in a real demo, so the travel
 * time is a measurement rather than a guess.
 *
 * @typedef {object} Lineup
 * @property {string} id
 * @property {string} type
 * @property {{x: number, y: number}} from
 * @property {{x: number, y: number}} at
 * @property {number} travelTicks
 * @property {number} thrownCount   how many real throws this cluster holds
 */

/**
 * A grenade in flight. Travel is a countdown rather than an integration: the
 * mined path already says where it goes and how long it takes.
 */
export function throwLineup(lineup, { tick, thrownBy, side, level = 'default' }) {
  return {
    id: lineup.id,
    type: lineup.type,
    from: lineup.from,
    at: lineup.at,
    level,
    thrownBy,
    side,
    throwTick: tick,
    detonateTick: tick + lineup.travelTicks
  };
}

/** Grenades whose timer is up this tick, ready to become effects. */
export function detonating(inFlight, tick) {
  return inFlight.filter((g) => g.detonateTick === tick);
}
