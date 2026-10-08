// ---------------------------------------------------------------------------
// replays/shared/roundZoneEvents.js
// Where each kill, death, assist and hit of a round happened.
//
// Performance > Zones rates a player per position on the map, and the round
// files say who killed whom and when but not from where: positions only exist
// in the tick buffer. This walks one round once and writes every event a
// player was part of with that player's own world position at the event tick,
// so the page can drop each one into whichever position or zone the map's
// network puts it in without opening the round again.
//
// Shared by the server (POST /api/replays/rounds/zone-events, which reads the
// precomputed 100-tick pass straight off disk) and the client (the same pass
// out of a round pack, for a server that predates the endpoint).
//
// Record shape, kept small because a player can have thousands of rounds:
//
//   { r: tickRate, b: [freezeEnd, midStart, lateStart, end], e: [event, ...] }
//   event = [kind, playerId, tick, x, y, z, n]
//
//   kind  'k' kill     n: 1 opening, 2 headshot
//         'd' death    n: 1 opening, 4 traded
//         'a' assist
//         'h' hit      n: health removed (friendly fire is 0 and left out)
//         's' alive at the end of the round
// ---------------------------------------------------------------------------

import { readHeader, readRecord } from './tickFormat.js';
import { cappedDamageFromMeta } from './roundDamage.js';
import { phaseBounds } from '../coach/roundPhases.js';

export const ZONE_EVENT_FLAGS = { OPENING: 1, HEADSHOT: 2, TRADED: 4 };

/** A kill answered inside this window counts the first death as traded. */
const TRADE_SECONDS = 5;

function asView(buffer) {
  if (!buffer) return null;
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * A reader for one tick buffer: a player's position at any tick.
 *
 * The buffer is thinned (one row every `stride` ticks), so a tick between two
 * rows is interpolated when the player is alive on both sides of it. Across a
 * death the later row is empty, and the last live row is the best there is.
 */
function positionReader(tickBuffer) {
  const view = asView(tickBuffer);
  if (!view) return null;
  let header;
  try {
    header = readHeader(view);
  } catch {
    return null;
  }
  if (!header.tickCount) return null;
  const a = {};
  const b = {};
  const stride = Math.max(1, header.stride || 1);
  return (slot, tick) => {
    if (slot == null || slot < 0 || slot >= header.slots) return null;
    const raw = (tick - header.firstTick) / stride;
    const row = Math.max(0, Math.min(header.tickCount - 1, Math.floor(raw)));
    readRecord(view, row, slot, a);
    const next = Math.min(header.tickCount - 1, row + 1);
    if (next !== row) readRecord(view, next, slot, b);
    const nextAlive = next !== row && b.alive;
    if (!a.alive && !nextAlive) {
      // A death on a sampled tick: that row already has the player dead, and
      // the one before it is where they fell.
      if (row === 0) return null;
      readRecord(view, row - 1, slot, a);
      return a.alive ? [a.x, a.y, a.z] : null;
    }
    if (!a.alive) return [b.x, b.y, b.z];
    if (!nextAlive) return [a.x, a.y, a.z];
    const f = Math.max(0, Math.min(1, raw - row));
    return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f];
  };
}

/**
 * The events of one round, for the players asked about.
 *
 * @param {object} meta        round meta (needs players, events.kills, events.damage)
 * @param {ArrayBuffer|DataView|Uint8Array|null} tickBuffer  any stride
 * @param {string[]|Set<string>|null} [ids]  players to keep; all when omitted
 * @returns {{ r: number, b: number[], e: Array }|null}  null without positions
 */
export function roundZoneEvents(meta, tickBuffer, ids = null) {
  if (!meta) return null;
  const at = positionReader(tickBuffer);
  if (!at) return null;
  const want = ids ? new Set(ids) : null;
  const keep = (id) => Boolean(id) && (!want || want.has(id));

  const players = meta.players || [];
  const slotOf = new Map(players.map((p) => [p.id, p.slot]));
  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const bounds = phaseBounds(meta);
  const tickRate = meta.tickRate || 64;
  const out = [];
  const round = (n) => Math.round(n);

  const push = (kind, id, tick, n = 0) => {
    const pos = at(slotOf.get(id), tick);
    if (!pos) return;
    out.push([kind, id, tick, round(pos[0]), round(pos[1]), round(pos[2]), n]);
  };

  const kills = [...(meta.events?.kills || [])]
    .filter((k) => Number.isFinite(k?.tick))
    .sort((x, y) => x.tick - y.tick);
  const enemies = (k) => {
    const a = teamOf.get(k.attacker);
    const v = teamOf.get(k.victim);
    return Boolean(a && v && a !== v);
  };
  const opening = kills.find(enemies) || null;
  const tradeTicks = TRADE_SECONDS * tickRate;
  const { OPENING, HEADSHOT, TRADED } = ZONE_EVENT_FLAGS;

  for (const k of kills) {
    const first = k === opening ? OPENING : 0;
    if (enemies(k) && keep(k.attacker)) {
      push('k', k.attacker, k.tick, first | (k.headshot ? HEADSHOT : 0));
    }
    if (k.victim && keep(k.victim)) {
      // Traded: the killer is killed by the victim's side inside the window.
      const victimTeam = teamOf.get(k.victim);
      const traded =
        k.attacker &&
        kills.some(
          (o) =>
            o.victim === k.attacker &&
            o.tick > k.tick &&
            o.tick - k.tick <= tradeTicks &&
            teamOf.get(o.attacker) === victimTeam
        );
      push('d', k.victim, k.tick, first | (traded ? TRADED : 0));
    }
    if (k.assister && keep(k.assister) && enemies(k)) push('a', k.assister, k.tick);
  }

  const capped = cappedDamageFromMeta(meta, teamOf);
  for (const d of capped?.events || []) {
    if (!(d.dealt > 0) || !keep(d.attacker)) continue;
    push('h', d.attacker, d.tick, round(d.dealt));
  }

  const dead = new Set(kills.map((k) => k.victim).filter(Boolean));
  const endTick = bounds.endTick;
  for (const p of players) {
    if (!keep(p.id) || dead.has(p.id)) continue;
    push('s', p.id, endTick);
  }

  out.sort((x, y) => x[2] - y[2]);
  return {
    r: tickRate,
    b: [bounds.freezeEndTick, bounds.midStartTick, bounds.lateStartTick, endTick].map(round),
    e: out
  };
}
