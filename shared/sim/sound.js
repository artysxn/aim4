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
//   of three range bands, the name of the nearest zone, and — for a gunshot —
//   a CLAIM about which gun it was. Never a position. Bots learn on the same
//   lossy signal a human gets, which is the difference between a team that
//   reads footsteps and a team that has coordinates.
// ---------------------------------------------------------------------------

import {
  FOOTSTEP_DISTANCE,
  FOOTSTEP_SPEED_FRACTION,
  SOUND_RADIUS,
  TICK_RATE,
  speedCap
} from './constants.js';
import { isSilenced } from './weapons.js';
import { WEAPON_CLASSES, weaponClassOf } from './observe.js';
import { weaponInfo } from '../../src/replays/shared/weaponTable.js';

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

// ---- what a shot sounds like (SIM-PLAN 19.3) --------------------------------
//
// A gunshot is the percept that carries the most information per byte in the
// game, and until now this file threw most of it away. Extending it is what
// makes threat TYPED: "AWP on B" is a different round from "somebody on B",
// and a human gets that read for free through his ears.
//
// The model is a confusion matrix rather than a truth flag, because the ear is
// good and not perfect, and the failures are specific and asymmetric:
//
//   an AWP is unmistakable — nothing else in the game makes that noise
//   an AK and an M4 are distinguishable, which is really a SIDE read
//   a Galil and an AK are not, and the confusion runs the common way: a player
//     who half-hears a Galil says "AK", because that is what is usually there
//
// Two vocabularies, no new taxonomy. A row is keyed by the weapon id the rest
// of the sim already speaks (weaponTable.js / WEAPON_SIM), and a LABEL — what
// the listener claims — is either one of those same ids, when a player would
// actually name the gun, or a WEAPON_CLASSES member from observe.js, when he
// would only name the family. So the percept's class always comes out of the
// canonical taxonomy, and the finer claim is optional.
//
// Every number here is `[calibrate]`: they are ordered by how confusable these
// guns are in practice, not measured. What matters for the belief is the
// RATIO between a row's entries, and the ratios are the falsifiable part.

/** P(label | weapon fired), for the guns a player identifies by ear. `[calibrate]` */
export const SHOT_CONFUSION = Object.freeze({
  // The plan's anchor case. The 3% that is not "awp" is the Scout, which is
  // the only mistake anybody actually makes here.
  awp: Object.freeze({ awp: 0.97, ssg08: 0.02, sniper: 0.01 }),
  // ...and the asymmetry: the rare gun gets reported as the common one, not
  // the other way round. Hearing "AWP" when it was a Scout is a real error.
  ssg08: Object.freeze({ ssg08: 0.82, awp: 0.13, sniper: 0.05 }),

  ak47: Object.freeze({ ak47: 0.8, galilar: 0.13, sg556: 0.03, m4a1: 0.02, rifle: 0.02 }),
  // Near a coin flip with the AK, tilted toward it: the prior leaks into the
  // report because a listener names what he expects to be holding the angle.
  galilar: Object.freeze({ galilar: 0.45, ak47: 0.45, famas: 0.05, rifle: 0.05 }),
  m4a1: Object.freeze({ m4a1: 0.76, famas: 0.12, aug: 0.03, ak47: 0.03, rifle: 0.06 }),
  // The most distinctive report in the game after the AWP, and the only one
  // that names a side outright.
  m4a1_silencer: Object.freeze({ m4a1_silencer: 0.9, mp5sd: 0.04, usp_silencer: 0.03, rifle: 0.03 }),
  famas: Object.freeze({ famas: 0.5, m4a1: 0.38, rifle: 0.12 }),
  sg556: Object.freeze({ sg556: 0.55, ak47: 0.2, aug: 0.12, rifle: 0.13 }),
  aug: Object.freeze({ aug: 0.5, m4a1: 0.22, sg556: 0.15, rifle: 0.13 }),

  deagle: Object.freeze({ deagle: 0.86, revolver: 0.05, pistol: 0.09 }),
  revolver: Object.freeze({ revolver: 0.7, deagle: 0.2, pistol: 0.1 })
});

/**
 * Fallback rows for everything else: the family is heard, the gun is not.
 * Nobody tells an MP9 from an MP7, and pretending otherwise would hand bots a
 * read that no human has. `[calibrate]`
 */
export const CLASS_CONFUSION = Object.freeze({
  pistol: Object.freeze({ pistol: 0.86, smg: 0.08, rifle: 0.04, other: 0.02 }),
  smg: Object.freeze({ smg: 0.78, rifle: 0.14, pistol: 0.06, other: 0.02 }),
  rifle: Object.freeze({ rifle: 0.88, smg: 0.08, other: 0.03, pistol: 0.01 }),
  sniper: Object.freeze({ sniper: 0.9, rifle: 0.08, other: 0.02 }),
  other: Object.freeze({ other: 0.7, rifle: 0.15, smg: 0.1, pistol: 0.05 })
});

/**
 * Range costs identification, so the ear is sharpened close and flattened far.
 * Applied as p^(1/T): monotone, so the most likely label never changes, only
 * how much the alternatives are worth. `[calibrate]`
 */
export const EAR_TEMPERATURE = Object.freeze({ close: 0.75, mid: 1, far: 1.5 });

/** The canonical class of a weapon id, through observe.js. Never a new bucket. */
export function shotClass(weapon) {
  return weapon ? weaponClassOf(weaponInfo(weapon).category) : null;
}

/** The class a report label names, whether it named a gun or only a family. */
export function labelClass(label) {
  if (!label) return null;
  return WEAPON_CLASSES.includes(label) ? label : shotClass(label);
}

/** Cache: the rows are pure functions of (weapon, band) and get asked per shot. */
const REPORT_CACHE = new Map();

/**
 * P(label | weapon, band), normalized, temperature applied.
 *
 * Normalizing here rather than trusting the tables means the numbers above can
 * be edited toward a calibration without anybody having to make them sum to
 * one by hand, which is exactly the kind of arithmetic that rots silently.
 *
 * @returns {Record<string, number>} frozen row, labels to probabilities
 */
export function shotReport(weapon, band = RANGE_BAND.MID) {
  const key = `${weapon}|${band}`;
  const hit = REPORT_CACHE.get(key);
  if (hit) return hit;

  const cls = shotClass(weapon);
  const base = SHOT_CONFUSION[weapon] || CLASS_CONFUSION[cls] || CLASS_CONFUSION.other;
  const t = EAR_TEMPERATURE[band] ?? 1;

  const row = {};
  let total = 0;
  for (const [label, p] of Object.entries(base)) {
    const v = t === 1 ? p : Math.pow(p, 1 / t);
    row[label] = v;
    total += v;
  }
  for (const label of Object.keys(row)) row[label] /= total;

  const frozen = Object.freeze(row);
  REPORT_CACHE.set(key, frozen);
  return frozen;
}

/**
 * What the listener says he heard.
 *
 * With an `rng` the label is DRAWN, so the ear is sometimes plainly wrong,
 * which is what a dataset generator wants. Without one it is the row's mode —
 * the label a listener would most likely give — and the uncertainty is not
 * discarded but left for the likelihood to spend (threat.js inverts this same
 * matrix against the belief). Both paths are deterministic; neither touches
 * Math.random, and the engine's existing four-argument calls take the second.
 *
 * @param {string} weapon
 * @param {string} band
 * @param {import('./rng.js').Rng} [rng]
 * @returns {string|null} a weapon id or a WEAPON_CLASSES member
 */
export function heardShot(weapon, band = RANGE_BAND.MID, rng = null) {
  if (!weapon) return null;
  const row = shotReport(weapon, band);
  if (rng) {
    let r = rng.next();
    let last = null;
    for (const [label, p] of Object.entries(row)) {
      last = label;
      r -= p;
      if (r <= 0) return label;
    }
    return last;
  }
  let best = null;
  let bestP = -1;
  for (const [label, p] of Object.entries(row)) {
    if (p > bestP) {
      bestP = p;
      best = label;
    }
  }
  return best;
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
 * @param {import('./rng.js').Rng} [rng]  draws the weapon claim; see heardShot
 * @returns {object|null} the degraded percept
 */
export function perceive(sound, listener, pathDistance, zoneNamer = null, rng = null) {
  if (sound.slot === listener.slot) return null;

  const dist = pathDistance(listener.x, listener.y, sound.x, sound.y);
  if (!Number.isFinite(dist) || dist > sound.radius) return null;

  const band = rangeBand(dist, sound.radius);
  // The weapon claim is a CLAIM, not the emitter's loadout: it comes out of the
  // confusion matrix, it degrades with range, and it can be wrong.
  const heard = sound.type === SOUND.GUNSHOT ? heardShot(sound.weapon, band, rng) : null;

  return {
    type: sound.type,
    tick: sound.tick,
    // Eight-way and three-band. A listener knows roughly where and roughly how
    // far, and nothing more precise than that.
    sector: sector(listener.x, listener.y, sound.x, sound.y),
    band,
    zone: zoneNamer ? zoneNamer(sound.x, sound.y, sound.level) : null,
    // Whose sound it was is NOT included. A footstep does not carry a name,
    // and a bot that knew would be reading engine state through the ear.
    /** WEAPON_CLASSES member, the part of the claim that is usually right. */
    weaponClass: labelClass(heard),
    /** The finer claim, when a player would actually name the gun. Often null. */
    weaponHeard: heard && !WEAPON_CLASSES.includes(heard) ? heard : null,
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
export function broadcast(sound, listeners, pathDistance, zoneNamer = null, rng = null) {
  const out = [];
  for (const l of listeners) {
    if (!l.alive) continue;
    const p = perceive(sound, l, pathDistance, zoneNamer, rng);
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
