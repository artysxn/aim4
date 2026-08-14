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
import { weaponInfo } from '../../src/replays/shared/weaponTable.js';
import { END_REASON } from './engine.js';
import { TICK_RATE } from './constants.js';
import { markSynthetic } from './firewall.js';

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
    // The parser records loadouts "at freezetime end", so the sim does too:
    // the first sampled tick at or past live start is that snapshot.
    if (!this.freezeLoadouts && this.engine.state.tick >= this.engine.state.liveTick) {
      this.freezeLoadouts = bodies.map((b) => {
        const items = [b.weapon];
        if (b.armor > 0) items.push(b.helmet ? 'assaultsuit' : 'kevlar');
        if (b.hasKit) items.push('defuser');
        items.push(...b.grenades);
        return items;
      });
    }
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
    const idOf = (slot) => (slot == null || slot < 0 ? '' : s.bodies[slot]?.id || `p${slot}`);

    // The engine's flat log into the parser's RoundEvents shape
    // (demoparser/schema.js). This is the convention rule doing its job: the
    // radar's whole utility layer, the kill feed, and the round analytics all
    // read `events.grenades` and friends, so a sim round that stores anything
    // else is a round they silently cannot draw.
    const events = { kills: [], shots: [], grenades: [], bomb: [] };
    for (const e of s.events) {
      if (e.type === 'death') {
        events.kills.push({
          tick: e.tick,
          attacker: idOf(e.by),
          victim: idOf(e.slot),
          assister: '',
          weapon: e.weapon || '',
          headshot: false,
          noscope: false,
          throughSmoke: false,
          penetrated: false,
          attackerBlind: false
        });
      } else if (e.type === 'shot') {
        events.shots.push({
          tick: e.tick,
          player: idOf(e.slot),
          weapon: e.weapon || '',
          x: e.x,
          y: e.y,
          z: 0,
          yaw: 0,
          pitch: 0
        });
      } else if (e.type === 'grenade_throw') {
        events.grenades.push({
          type: e.nade,
          player: idOf(e.slot),
          throwTick: e.tick,
          detonateTick: e.detonateTick ?? e.tick,
          from: { x: e.fromX ?? e.x, y: e.fromY ?? e.y, z: 0 },
          at: { x: e.x, y: e.y, z: 0 },
          path: []
        });
      } else if (e.type === 'bomb_planted') {
        events.bomb.push({
          type: 'planted',
          tick: e.tick,
          player: idOf(e.slot),
          site: e.site || s.bomb.site || '',
          x: e.x,
          y: e.y
        });
      } else if (e.type === 'bomb_defused') {
        events.bomb.push({ type: 'defused', tick: e.tick, player: idOf(e.slot), site: s.bomb.site || '' });
      } else if (e.type === 'bomb_dropped') {
        events.bomb.push({
          type: 'dropped',
          tick: e.tick,
          player: idOf(e.slot),
          site: '',
          x: e.x,
          y: e.y
        });
      } else if (e.type === 'bomb_pickup') {
        events.bomb.push({ type: 'pickup', tick: e.tick, player: idOf(e.slot), site: '' });
      }
    }
    if (s.endReason === END_REASON.BOMB_EXPLODED) {
      events.bomb.push({
        type: 'exploded',
        tick: s.endTick ?? s.tick,
        player: '',
        site: s.bomb.site || '',
        x: s.bomb.x,
        y: s.bomb.y
      });
    }

    // Per-player stats in the parser's shape. Kills and deaths come from the
    // log; damage and shots exist only under record 'full' and honestly read
    // zero otherwise. Money is the match layer's, not the engine's, so it is
    // absent unless the caller passes it in `extra.stats`.
    const damageBy = {};
    for (const e of s.events) {
      if (e.type !== 'damage' || e.by == null) continue;
      damageBy[e.by] = (damageBy[e.by] || 0) + (e.amount || 0);
    }
    const stats = {};
    for (const [slot, b] of s.bodies.entries()) {
      const loadout = this.freezeLoadouts?.[slot] || [b.weapon];
      let equipValue = 0;
      for (const item of loadout) {
        if (item === 'kevlar') equipValue += 650;
        else if (item === 'assaultsuit') equipValue += 1000;
        else if (item === 'defuser') equipValue += 400;
        else equipValue += weaponInfo(item).price || 0;
      }
      stats[b.id] = {
        kills: events.kills.filter((k) => k.attacker === b.id && k.victim !== b.id).length,
        deaths: events.kills.filter((k) => k.victim === b.id).length,
        assists: 0,
        damage: damageBy[slot] || 0,
        shots: events.shots.filter((sh) => sh.player === b.id).length,
        equipValue,
        loadout
      };
    }

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
      // Sides A and B are slot-contiguous (versusMatch seats A on 0-4, B on
      // 5-9), so roster team follows the seat and the per-round side comes
      // from the seat's body, halves and overtime included.
      team1Side: s.bodies[0]?.side || 'T',
      team2Side: s.bodies[5]?.side || 'CT',
      players: s.bodies.map((b, slot) => ({
        slot,
        id: b.id,
        name: b.id,
        steamId: '',
        team: slot < 5 ? 1 : 2,
        side: b.side,
        role: b.role
      })),
      events,
      stats,
      ...extra,
      // The firewall marker (12.1), stamped last so no caller can clear it
      // through `extra`. Every meta this module writes describes a round that
      // was simulated, and 9.3's extractor filters on exactly this field.
      // Where the round came from is a fact, not an option.
      ...markSynthetic({})
    };
  }
}

/** Header byte count, re-exported so callers do not reach past this module. */
export { HEADER_BYTES };
