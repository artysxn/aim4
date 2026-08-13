// ---------------------------------------------------------------------------
// shared/sim/sound.js
// What a body emits, who hears it, and how badly degraded it arrives.
//
// Nothing in the analysis stack models sound, so this is new, and it is a
// first-class citizen rather than a detail: stepping and shooting create
// information the enemy gets for free, and walking is the counter-play. A
// simulation without it has no silence to spend, which removes most of what
// makes mid-round Counter-Strike a game of information (SIM-PLAN 4.7).
//
// Two rules make it honest:
//
//   Audibility is GEODESIC, not euclidean. Sound that travels through walls
//   would tell a bot that someone is close when they are two rooms and a
//   corridor away, and every timing read downstream of that would be wrong.
//
//   The percept is DEGRADED. A listener gets a type, an eight-way sector, one
//   of three range bands, and the name of the nearest zone. Never a position.
//   Bots learn on the same lossy signal a human gets, which is the difference
//   between a team that reads footsteps and a team that has coordinates.
// ---------------------------------------------------------------------------

import {
  FOOTSTEP_DISTANCE,
  FOOTSTEP_SPEED_FRACTION,
  SOUND_RADIUS,
  TICK_RATE,
  speedCap
} from './constants.js';
import { isSilenced } from './weapons.js';

export const SOUND = Object.freeze({
  FOOTSTEP: 'footstep',
  LANDING: 'landing',
  GUNSHOT: 'gunshot',
  RELOAD: 'reload',
  GRENADE: 'grenade',
  PLANT: 'plant',
  DEFUSE: 'defuseKit',
  BOMB_BEEP: 'bombBeep'
});

/** Range bands a listener can distinguish. Anything finer is not audible detail. */
export const RANGE_BAND = Object.freeze({ CLOSE: 'close', MID: 'mid', FAR: 'far' });

/** Eight compass sectors, the resolution a player actually localizes to. */
export function sector(fromX, fromY, toX, toY) {
  const deg = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI;
  return ((Math.round(deg / 45) % 8) + 8) % 8;
}

export function rangeBand(distance, radius) {
  const r = distance / Math.max(1, radius);
  if (r < 0.33) return RANGE_BAND.CLOSE;
  if (r < 0.66) return RANGE_BAND.MID;
  return RANGE_BAND.FAR;
}

/**
 * Should this body emit a footstep this tick?
 *
 * Distance-based rather than time-based, so a body that ramps up to speed
 * emits its first step after it has actually covered ground, and a body that
 * shuffles in place is silent. Walking and crouching emit nothing at all, which
 * is the whole tactical point of the shift key.
 *
 * @param {object} body      mutated: carries its own step accumulator
 * @param {number} moved     units travelled this tick
 * @returns {boolean}
 */
export function stepFootstep(body, moved) {
  if (body.gait !== 'run' || body.stance === 'crouch') {
    body.stepAccum = 0;
    return false;
  }
  const cap = speedCap(body.weapon, 'run');
  const speed = moved * TICK_RATE;
  if (speed < cap * FOOTSTEP_SPEED_FRACTION) {
    body.stepAccum = 0;
    return false;
  }
  body.stepAccum = (body.stepAccum || 0) + moved;
  if (body.stepAccum < FOOTSTEP_DISTANCE) return false;
  body.stepAccum -= FOOTSTEP_DISTANCE;
  return true;
}

/**
 * An emission, in world truth. Never handed to a bot: `perceive` degrades it
 * first, and the engine only ever passes the degraded form upward.
 */
export function emit({ type, x, y, level = 'default', slot, side, tick, weapon = null }) {
  const radius =
    type === SOUND.GUNSHOT && weapon && isSilenced(weapon)
      ? SOUND_RADIUS.gunshotSilenced
      : SOUND_RADIUS[type] ?? 800;
  return { type, x, y, level, slot, side, tick, weapon, radius };
}

/**
 * What one listener hears of one emission, or null.
 *
 * `pathDistance(ax, ay, bx, by)` must be geodesic. Passing a euclidean distance
 * here compiles and runs and quietly makes every bot able to hear through
 * walls, which is why it is a required argument rather than a default.
 *
 * @param {object} sound       from emit()
 * @param {object} listener    {x, y, level, slot, side}
 * @param {(ax:number, ay:number, bx:number, by:number) => number} pathDistance
 * @param {(x:number, y:number, level:string) => string|null} [zoneNamer]
 * @returns {object|null} the degraded percept
 */
export function perceive(sound, listener, pathDistance, zoneNamer = null) {
  if (sound.slot === listener.slot) return null;

  const dist = pathDistance(listener.x, listener.y, sound.x, sound.y);
  if (!Number.isFinite(dist) || dist > sound.radius) return null;

  return {
    type: sound.type,
    tick: sound.tick,
    // Eight-way and three-band. A listener knows roughly where and roughly how
    // far, and nothing more precise than that.
    sector: sector(listener.x, listener.y, sound.x, sound.y),
    band: rangeBand(dist, sound.radius),
    zone: zoneNamer ? zoneNamer(sound.x, sound.y, sound.level) : null,
    // Whose sound it was is NOT included. A footstep does not carry a name,
    // and a bot that knew would be reading engine state through the ear.
    weaponClass: sound.type === SOUND.GUNSHOT ? sound.weapon : null,
    /** Which side made it, only when that is genuinely inferable. */
    side: sound.type === SOUND.GUNSHOT ? null : null
  };
}

/**
 * Distribute one emission to every listener.
 *
 * The bot who hears it gets the percept immediately; relaying it to a teammate
 * is a comm and pays the delay (5.1). CS does not share footsteps on the radar
 * and neither does this.
 */
export function broadcast(sound, listeners, pathDistance, zoneNamer = null) {
  const out = [];
  for (const l of listeners) {
    if (!l.alive) continue;
    const p = perceive(sound, l, pathDistance, zoneNamer);
    if (p) out.push({ listener: l.slot, percept: p });
  }
  return out;
}

/**
 * A rolling window of what a side has heard, which is what the belief filter
 * reweights against (5.5 rule 4) and what the observation vector samples (7.2).
 */
export class SoundLog {
  constructor(windowSeconds = 6) {
    this.window = windowSeconds * TICK_RATE;
    this.items = [];
  }

  push(tick, listener, percept) {
    this.items.push({ tick, listener, ...percept });
    const cutoff = tick - this.window;
    while (this.items.length && this.items[0].tick < cutoff) this.items.shift();
  }

  /** Most recent first, which is the order a policy wants to read them in. */
  recent(n = 8) {
    return this.items.slice(-n).reverse();
  }

  clear() {
    this.items.length = 0;
  }
}
