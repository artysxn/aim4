// ---------------------------------------------------------------------------
// replays/duels/duelFeatures.js
// Raw inputs for one player, and for one pair of players, at one tick.
//
// Everything here is a measurement, not a judgement: no weighting, no shaping,
// no probabilities. That line matters, because these same numbers are computed
// in node while training and in the browser while a demo plays, and the only
// way the two can agree is if neither of them decides anything.
//
// DOM-free.
// ---------------------------------------------------------------------------

import {
  FLAG_AIRBORNE,
  FLAG_DUCKING,
  FLAG_HAS_HELMET,
  FLAG_SCOPED
} from '../shared/tickFormat.js';
import { weaponInfo } from '../shared/weaponTable.js';

/**
 * Ticks looked back to measure movement.
 *
 * Positions are quantized to quarter units, so a window this short is mostly
 * reading quantization noise on a standing player; 8 ticks at 64 tick is an
 * eighth of a second, long enough to be real and short enough that a player who
 * has just stopped to shoot already reads as stopped.
 */
const SPEED_LOOKBACK_TICKS = 8;

/**
 * Speeds above this are not movement.
 *
 * Nothing on foot in CS2 exceeds ~250 units per second. Anything faster is a
 * teleport across a respawn, a round boundary, or a gap in the tick data, and
 * should not be read as a player sprinting.
 */
const MAX_PLAUSIBLE_SPEED = 400;

/** Reference ground speed, world units per second. */
export const RUN_SPEED = 250;

/**
 * Ground speed for one player, from position deltas.
 *
 * The tick format has no velocity field, so this is the only way to know
 * whether a player is standing still, and standing still is most of what
 * decides whether their first bullet lands.
 *
 * @param {import('../tickStore.js').TickTrack} track
 * @param {number} slot
 * @param {number} tick
 * @param {number} tickRate
 * @returns {number} world units per second
 */
export function speedAt(track, slot, tick, tickRate = 64) {
  const prevTick = Math.max(track.firstTick, tick - SPEED_LOOKBACK_TICKS);
  const dt = (tick - prevTick) / tickRate;
  if (!(dt > 0)) return 0;

  const now = track.sample(slot, tick, {});
  const before = track.sample(slot, prevTick, {});
  if (!now.alive || !before.alive) return 0;

  const speed = Math.hypot(now.x - before.x, now.y - before.y) / dt;
  return speed > MAX_PLAUSIBLE_SPEED ? 0 : speed;
}

/**
 * @typedef {object} PlayerFeatures
 * @property {number} slot
 * @property {string} id           short player id
 * @property {string} side         'T' | 'CT'
 * @property {number} x @property {number} y @property {number} z
 * @property {number} yaw
 * @property {number} hp
 * @property {number} armor        0-100
 * @property {boolean} helmet
 * @property {number} flash        seconds of blindness left
 * @property {boolean} scoped
 * @property {boolean} ducking
 * @property {boolean} airborne
 * @property {number} speed        world units per second
 * @property {string} weapon       bare weapon id
 * @property {number} price
 * @property {string} category
 * @property {boolean} oneTap      one-shots a helmeted head
 * @property {number} cycleSeconds
 * @property {boolean} reloading
 * @property {number} magFraction
 * @property {number} sinceShot    seconds since this weapon last fired
 */

/**
 * One player's state, resolved from the tick record plus the trackers.
 *
 * @param {object} args
 * @param {object} args.state       decoded tick record
 * @param {object} args.player      roster entry, for the short id
 * @param {string[]} args.weapons   round weapon dictionary
 * @param {number} args.speed
 * @param {object} args.reload      from reloadTracker.stateAt
 * @returns {PlayerFeatures}
 */
export function playerFeatures({ state, player, weapons, speed, reload }) {
  const name = weapons?.[state.weapon] || '';
  const info = weaponInfo(name);
  return {
    slot: player.slot,
    id: player.id,
    side: state.side,
    x: state.x,
    y: state.y,
    z: state.z,
    yaw: state.yaw,
    hp: state.health,
    armor: state.armor,
    helmet: (state.flags & FLAG_HAS_HELMET) !== 0,
    flash: state.flash,
    scoped: (state.flags & FLAG_SCOPED) !== 0,
    ducking: (state.flags & FLAG_DUCKING) !== 0,
    airborne: (state.flags & FLAG_AIRBORNE) !== 0,
    speed,
    weapon: info.id,
    price: info.price,
    category: info.category,
    oneTap: info.oneTapHeadHelmet,
    cycleSeconds: info.cycleSeconds,
    reloading: reload.reloading,
    magFraction: reload.magFraction,
    sinceShot: reload.sinceShot
  };
}

/**
 * Everything about one pairing that does not depend on the rest of the server.
 *
 * `off` is each player's crosshair error toward the other, which is the single
 * most informative number in a duel and the reason this pairing exists at all.
 *
 * @param {object} args
 * @param {PlayerFeatures} args.a
 * @param {PlayerFeatures} args.b
 * @param {import('./visionState.js').PairVision} args.vision
 * @param {number} args.infoAdvSecs  positive when A saw B first
 */
export function pairFeatures({ a, b, vision, infoAdvSecs }) {
  return {
    aSlot: a.slot,
    bSlot: b.slot,
    dist: vision.dist,
    losClear: vision.losClear,
    aSeesB: vision.aSeesB,
    bSeesA: vision.bSeesA,
    offA: vision.offA,
    offB: vision.offB,
    infoAdvSecs,
    a,
    b
  };
}
