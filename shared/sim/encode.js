// ---------------------------------------------------------------------------
// shared/sim/encode.js
// Turn a simulated round into the exact bytes the demo parser writes.
//
// This is the single most leveraged file in the project, and it is forty lines
// of buffer writing. Because a sim round comes out in the parser's own tick
// format and meta schema, the entire existing stack plays it with no new code:
// the radar renderer, the timeline, the round clock, Team POV, possession
// paint, the duel overlay, the coach, the round library matcher, the analytics.
// A sim round is a round nobody had to play (SIM-PLAN 1).
//
// The rule that keeps that true: this file must never invent a field or bend a
// convention. Sides are the engine's own team numbers, positions are quantized
// exactly as the parser quantizes them, and the header's tick rate is the
// engine's. Anything the viewer would have to special-case for sim rounds is a
// bug here.
// ---------------------------------------------------------------------------

import {
  FLAG_ALIVE,
  FLAG_DEFUSING,
  FLAG_DUCKING,
  FLAG_HAS_BOMB,
  FLAG_HAS_HELMET,
  FLAG_PLANTING,
  FLAG_SCOPED,
  HEADER_BYTES,
  PLAYER_SLOTS,
  writeHeader,
  writeRecord,
  totalBytes
} from '../../src/replays/shared/tickFormat.js';
import { TICK_RATE } from './constants.js';

/** Flags for one body, in the parser's own bit order. */
export function flagsFor(body) {
  let flags = 0;
  if (body.alive) flags |= FLAG_ALIVE;
  if (body.stance === 'crouch') flags |= FLAG_DUCKING;
  if (body.scoped) flags |= FLAG_SCOPED;
  if (body.channel === 'planting') flags |= FLAG_PLANTING;
  if (body.channel === 'defusing') flags |= FLAG_DEFUSING;
  if (body.hasBomb) flags |= FLAG_HAS_BOMB;
  if (body.helmet) flags |= FLAG_HAS_HELMET;
  return flags;
}

/**
 * A recorder that samples engine state every tick into a tick buffer.
 *
 * Sampling rather than streaming because the round's length is not known until
 * it ends, and growing a buffer per tick would allocate through the hot loop.
 * Frames are held as small objects and packed once at the end, which costs a
 * few megabytes for the duration of one round and nothing at all during a
 * training rollout, where nobody records.
 */
export class RoundRecorder {
  /**
   * @param {ReturnType<import('./engine.js').createEngine>} engine
   * @param {{weaponDict?: string[]}} [opts]
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.frames = [];
    /** Weapon index 0 is "unknown", matching the parser's dictionary. */
    this.weaponDict = opts.weaponDict || ['', 'knife'];
    this.firstTick = engine.state.tick;
  }

  weaponIndex(name) {
    if (!name) return 0;
    let i = this.weaponDict.indexOf(name);
    if (i < 0) {
      this.weaponDict.push(name);
      i = this.weaponDict.length - 1;
    }
    return i;
  }

  /** Call once per engine tick, after step(). */
  sample() {
    const { bodies } = this.engine.state;
    const row = new Array(PLAYER_SLOTS);
    for (let slot = 0; slot < PLAYER_SLOTS; slot += 1) {
      const b = bodies[slot];
      if (!b) {
        row[slot] = null;
        continue;
      }
      row[slot] = {
        x: b.pos.x,
        y: b.pos.y,
        z: b.z,
        yaw: b.yaw,
        pitch: b.pitch,
        health: b.alive ? b.health : 0,
        armor: b.armor,
        weapon: this.weaponIndex(b.weapon),
        flags: flagsFor(b),
        flash: b.flashSeconds || 0,
        side: b.side === 'T' ? 2 : b.side === 'CT' ? 3 : 0
      };
    }
    this.frames.push(row);
  }

  /** @returns {Uint8Array} the tick buffer, ready to write or to hand a viewer */
  encodeTicks() {
    const count = this.frames.length;
    const buf = new ArrayBuffer(totalBytes(count));
    const view = new DataView(buf);
    writeHeader(view, {
      tickCount: count,
      firstTick: this.firstTick,
      stride: 1,
      tickRate: TICK_RATE,
      playerCount: Math.min(PLAYER_SLOTS, this.engine.state.bodies.length)
    });
    for (let row = 0; row < count; row += 1) {
      const frame = this.frames[row];
      for (let slot = 0; slot < PLAYER_SLOTS; slot += 1) {
        if (frame[slot]) writeRecord(view, row, slot, frame[slot]);
      }
    }
    return new Uint8Array(buf);
  }

  /**
   * Round meta in the parser's schema.
   *
   * Ticks in the meta are absolute engine ticks, the same numbers the tick
   * buffer's header starts from, because the round clock (`roundClock.js`)
   * derives every phase from them and a clock that disagrees with the bodies
   * is the first thing anyone notices.
   */
  encodeMeta(extra = {}) {
    const s = this.engine.state;
    return {
      map: s.map,
      tickRate: TICK_RATE,
      startTick: this.firstTick,
      freezeEndTick: s.liveTick,
      plantTick: s.plantTick,
      endTick: s.endTick ?? s.tick,
      winner: s.winner,
      endReason: s.endReason,
      weapons: this.weaponDict,
      players: s.bodies.map((b, slot) => ({
        slot,
        name: b.id,
        side: b.side,
        role: b.role
      })),
      events: s.events,
      ...extra
    };
  }
}

/** Header byte count, re-exported so callers do not reach past this module. */
export { HEADER_BYTES };
