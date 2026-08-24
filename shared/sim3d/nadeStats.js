// ---------------------------------------------------------------------------
// shared/sim3d/nadeStats.js
// The numbers a grenade's EFFECT is made of, with no renderer attached.
//
// These used to live in src/cs3d/nadeEffects.js, which is the right place for
// them right up until a second renderer needs them. That file is 1,200 lines of
// WebGPU node materials — sprite cards, a smoke volume, a flame sheet — and it
// cannot run in the aim trainer's WebGL scene, so importing it there would drag
// in a whole second three core to read two integers off.
//
// So the integers moved here and both sides import them. What each renderer
// then DRAWS is its own (the explorer's cards and volumes; the trainer's much
// plainer stand-ins), but how far an HE reaches, what it does at the centre, how
// long a molotov burns and what colour a flight's trail is are facts about the
// game, and there is now one copy of each.
// ---------------------------------------------------------------------------

/** [docs] HE blast radius and damage, weapons.vdata `m_flRange` / `m_nDamage`. */
export const HE_RADIUS = 350;
export const HE_DAMAGE = 99;

/**
 * Fire's own numbers stay where the fire model is.
 *
 * shared/sim3d/fireSpread.js already owns the radius and the lifetime for both
 * types, and it has no renderer in it either — so it is re-exported rather than
 * copied. A second copy of `FIRE_RANGE` is exactly the drift this module exists
 * to stop.
 */
export {
  FIRE_RANGE,
  FIRE_RANGE_INC,
  FIRE_SECONDS,
  FIRE_SECONDS_INC
} from './fireSpread.js';

/**
 * [guessed] What standing in fire costs a second.
 *
 * CS2 applies it as a stream of small ticks rather than a rate, and the rate is
 * what a caller with a health bar actually wants. Named a guess because the
 * tick interval is not in the vdata.
 */
export const FIRE_DPS = 40;

/** [guessed] Decoy lifetime, seconds. */
export const DECOY_SECONDS = 15;

/**
 * Trail colour per type — the same family the radar and the demo view use, so a
 * flight drawn in the explorer and the same flight drawn in the trainer are the
 * same colour as the icon that threw it.
 */
export const TRAIL_COLOR = Object.freeze({
  hegrenade: 0xd8503a,
  flashbang: 0xfff0a8,
  smokegrenade: 0xc8ccd0,
  molotov: 0xe87a28,
  incgrenade: 0xe87a28,
  decoy: 0x7fc46a
});
