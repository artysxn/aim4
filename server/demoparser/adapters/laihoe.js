// ---------------------------------------------------------------------------
// demoparser/adapters/laihoe.js
// Adapter for https://github.com/LaihoE/demoparser (npm @laihoe/demoparser2).
//
// Everything specific to that package lives in this file. It reads a .dem and
// returns the NormalizedDemo shape from ../schema.js; the rest of the site
// never sees a demoparser type. To move to a different parser, copy this file,
// swap the calls, and register it in ../index.js.
//
// Ticks are pulled one round at a time rather than in a single sweep: a full
// match is well over a million player-tick rows, and materializing that as JS
// objects would blow the heap on a modest host. Per round it is ~70k rows,
// which is packed straight into the binary buffer and released.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
import { deriveBatchTicks } from '../../replays/hostMemory.js';
import { mapCodeFromName, shortIdFor } from '../../../src/replays/shared/roundId.js';
import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  writeHeader,
  writeRecord,
  readRecord,
  FLAG_ALIVE,
  FLAG_DUCKING,
  FLAG_SCOPED,
  FLAG_DEFUSING,
  FLAG_HAS_BOMB,
  FLAG_AIRBORNE,
  FLAG_HAS_HELMET
} from '../../../src/replays/shared/tickFormat.js';
import { SCHEMA_VERSION } from '../schema.js';
import { classifyEconomy, isPistolRoundNumber } from '../economy.js';
import { bareWeapon } from '../../../src/replays/viewer/equipmentIcons.js';

const require = createRequire(import.meta.url);

export const name = 'laihoe/demoparser2';

let pkg = null;
let loadError = null;

/** Lazy require so the site boots even when the native module is absent. */
function parser() {
  if (pkg) return pkg;
  if (loadError) throw loadError;
  try {
    pkg = require('@laihoe/demoparser2');
    return pkg;
  } catch (err) {
    loadError = new Error(
      'Demo parsing needs @laihoe/demoparser2. Install it with ' +
        '`npm install @laihoe/demoparser2` on the backend host, then restart. ' +
        `(original error: ${err.message})`
    );
    throw loadError;
  }
}

export function isAvailable() {
  try {
    parser();
    return true;
  } catch {
    return false;
  }
}

export function version() {
  try {
    return require('@laihoe/demoparser2/package.json').version || 'unknown';
  } catch {
    return 'unavailable';
  }
}

// Per-tick props.
//
// `inventory` is deliberately NOT here. It returns an array per player per
// tick, so a full match asks for over a million small arrays and that single
// prop dominates everything else a parse allocates. The loadout only matters
// once per round, so it is fetched separately at the freezetime ticks below.
// Same reasoning for `balance` and `current_equip_value`: both are buy-time
// facts, not per-tick ones.
const TICK_PROPS = [
  'X',
  'Y',
  'Z',
  'pitch',
  'yaw',
  'health',
  'armor_value',
  'active_weapon_name',
  'is_alive',
  'team_num',
  'flash_duration',
  'is_scoped',
  'is_ducking',
  'has_helmet',
  'is_defusing',
  'in_air'
];

// Older parser builds reject unknown props, so a rejected sweep retries with
// just these, which have existed for as long as the binding has.
const CORE_PROPS = [
  'X',
  'Y',
  'Z',
  'pitch',
  'yaw',
  'health',
  'armor_value',
  'active_weapon_name',
  'is_alive',
  'team_num'
];

/** Read once per round, at freezetime end: what each player bought. */
const BUY_PROPS = ['inventory', 'balance', 'current_equip_value', 'team_num'];

let propMode = null; // 'full' | 'core', decided on the first sweep of a demo

/**
 * Uniform reader over whichever shape parseTicks returns.
 *
 * structOfArrays gives back one array per prop instead of one object per row,
 * which drops the per-object overhead across a million-plus rows. Not every
 * build honors the flag, so this normalizes both shapes to an indexed reader
 * and the callers never learn which one they got.
 */
function readTicks(file, props, ticks, { structOfArrays = true } = {}) {
  const p = parser();
  let raw;
  if (propMode !== 'core') {
    try {
      raw = p.parseTicks(file, props, ticks, null, structOfArrays);
      propMode = 'full';
    } catch (err) {
      if (propMode === 'full') throw err;
      propMode = 'core';
    }
  }
  if (raw === undefined) {
    raw = p.parseTicks(file, CORE_PROPS, ticks, null, structOfArrays);
  }
  return tickReader(raw);
}

export function tickReader(raw) {
  // Array of row objects: the classic shape.
  if (Array.isArray(raw)) {
    return { length: raw.length, at: (i) => raw[i] };
  }
  // Struct of arrays: { X: [...], Y: [...], tick: [...], ... }
  const cols = {};
  let length = 0;
  for (const [key, value] of Object.entries(raw || {})) {
    if (Array.isArray(value)) {
      cols[key] = value;
      if (value.length > length) length = value.length;
    }
  }
  const keys = Object.keys(cols);
  // One reused view object rather than a fresh one per row: callers consume
  // each row immediately, and allocating a million short-lived objects here
  // would undo the point of asking for columns.
  const view = {};
  return {
    length,
    at(i) {
      for (const k of keys) view[k] = cols[k][i];
      return view;
    }
  };
}

function readEvents(file, names) {
  const p = parser();
  try {
    return p.parseEvents(file, names, ['X', 'Y', 'Z', 'yaw', 'pitch'], ['total_rounds_played']);
  } catch {
    // Extra-field support varies by build; the bare form is always accepted.
    try {
      return p.parseEvents(file, names);
    } catch {
      return [];
    }
  }
}

/** Everything that is not utility, a knife or the bomb counts as a gun. */
const NOT_A_GUN =
  /grenade|molotov|incgrenade|firebomb|inferno|decoy|flash|knife|bayonet|karambit|c4|world|taser|zeus/i;

export function isGunName(weapon) {
  const w = String(weapon || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '');
  if (!w) return false;
  return !NOT_A_GUN.test(w);
}

const sid = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Coerce numbers that demoparser sometimes hands back as numeric strings. */
const numish = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
};

/**
 * Map round_end.winner (and friends) onto T / CT.
 * Demoparser may return 2/3, "2"/"3", or "T"/"CT".
 */
function sideFromWinnerField(raw) {
  if (raw === 2 || raw === '2') return 'T';
  if (raw === 3 || raw === '3') return 'CT';
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === 't' || s === 'terrorist' || s === 'terrorists') return 'T';
  if (s === 'ct' || s === 'counterterrorist' || s === 'counter-terrorist' || s.includes('counter')) {
    return 'CT';
  }
  return null;
}

/** CS2 round_end.reason → winning side when the winner field is unusable. */
function sideFromWinReason(reason) {
  const r = numish(reason);
  // Common Source 2 / CS2 win reasons.
  if (r === 1 /* TargetBombed */ || r === 9 /* CTsEliminated */) return 'T';
  if (r === 7 /* BombDefused */ || r === 8 /* TerroristsEliminated */) return 'CT';
  return null;
}

/** Majority team_num (2=T, 3=CT) for one roster side at a buy tick. */
function sideFromBuys(rosterTeam, buyTick, roster, buys) {
  let t = 0;
  let ct = 0;
  for (const pl of roster) {
    if (pl.team !== rosterTeam) continue;
    const snap = buys.get(`${buyTick}:${pl.steamId}`);
    const n = snap?.teamNum;
    if (n === 2) t++;
    else if (n === 3) ct++;
  }
  if (t === 0 && ct === 0) return null;
  return t >= ct ? 'T' : 'CT';
}

function eventsByName(all) {
  const out = new Map();
  for (const e of all || []) {
    const key = e.event_name || e.name || '';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(e);
  }
  return out;
}

/**
 * Build the match roster from rows already in hand. Team membership is pinned
 * from the first half and kept for the whole match: the round name identifies
 * *teams*, so a player must not change group when the sides swap at halftime.
 *
 * This reads the first batch's rows rather than making a call of its own —
 * every parseTicks call re-reads the whole demo, so a "cheap" one-tick lookup
 * would cost a full extra pass over hundreds of megabytes.
 */
function rosterFromRows(reader) {
  const seen = new Map();
  for (let i = 0; i < reader.length; i++) {
    const r = reader.at(i);
    const steam = sid(r.steamid);
    if (!steam || steam === '0') continue;
    if (!seen.has(steam)) {
      seen.set(steam, {
        steamId: steam,
        name: r.name || `Player ${seen.size + 1}`,
        teamNum: num(r.team_num),
        health: num(r.health)
      });
    }
  }
  const all = [...seen.values()];

  // A coach or a benched player sits on a team in the tick rows without ever
  // holding a pawn, so a side can come back with six or seven names. They have
  // no health at freezetime, which is what separates them from the five who
  // are actually playing. Taking a blind slice instead (the old fallback) put
  // the same player in both groups and left the rest of the match unowned.
  const pickSide = (teamNum) => {
    const side = all.filter((p) => p.teamNum === teamNum);
    if (side.length <= 5) return side;
    const alive = side.filter((p) => p.health > 0);
    return (alive.length >= 5 ? alive : side).slice(0, 5);
  };
  const group1 = pickSide(2); // T at the start
  const group2 = pickSide(3); // CT at the start

  // Demos that do not label sides at this tick still get ten distinct names.
  if (group1.length < 5 || group2.length < 5) {
    const taken = new Set([...group1, ...group2].map((p) => p.steamId));
    const rest = all.filter((p) => !taken.has(p.steamId));
    while (group1.length < 5 && rest.length) group1.push(rest.shift());
    while (group2.length < 5 && rest.length) group2.push(rest.shift());
  }

  const players = [];
  group1.forEach((p, i) => players.push({ ...p, team: 1, slot: i }));
  group2.forEach((p, i) => players.push({ ...p, team: 2, slot: 5 + i }));
  for (const p of players) p.id = shortIdFor(p.steamId || p.name);
  return players;
}

function teamNameFor(players, fallback) {
  // Demos rarely carry a clan name; a stable, readable label beats an empty
  // one, so fall back to the first player's handle.
  return players[0]?.clanName || players[0]?.name || fallback;
}

function flagsFor(row, hasBomb) {
  let f = 0;
  if (row.is_alive !== false && num(row.health) > 0) f |= FLAG_ALIVE;
  if (row.is_ducking) f |= FLAG_DUCKING;
  if (row.is_scoped) f |= FLAG_SCOPED;
  if (row.is_defusing) f |= FLAG_DEFUSING;
  if (row.in_air) f |= FLAG_AIRBORNE;
  if (row.has_helmet) f |= FLAG_HAS_HELMET;
  if (hasBomb) f |= FLAG_HAS_BOMB;
  return f;
}

function inventoryOf(row) {
  const inv = row.inventory;
  if (Array.isArray(inv)) return inv.map((w) => String(w));
  if (typeof inv === 'string' && inv) return inv.split(',').map((s) => s.trim());
  const active = row.active_weapon_name;
  return active ? [String(active)] : [];
}

// Rounds are parsed in GROUPS, not one at a time. Every parseTicks call reads
// and decodes the whole demo file, so asking for one round at a time costs
// O(rounds x file size): on a 24 round, 300 MB demo that is over 7 GB of
// redundant decoding. Fewer, larger passes are faster wherever they fit.
//
// They do not always fit. A batch materializes `ticks x 10 players` rows of 16
// props in the JS heap at once, so the old fixed 200 000 made a whole match one
// pass -- fastest when the memory is there, and an instant OOM kill when it is
// not. On a 4 GB host that was the difference between a parse and a SIGKILL.
// The size is now derived from the cgroup limit, and jobs.js halves it and
// retries if the kernel still steps in. An explicit env value overrides both.
const BATCH_TICKS = Number(process.env.AIM4_PARSE_BATCH_TICKS) || deriveBatchTicks();

/**
 * Group consecutive rounds so each group spans at most `maxTicks`.
 * Exported so the grouping can be tested directly: a bug here would silently
 * drop rounds from a parse rather than fail.
 */
export function batchSpans(spans, maxTicks) {
  const batches = [];
  let current = [];
  let start = 0;
  for (const span of spans) {
    if (!current.length) {
      current = [span];
      start = span.startTick;
      continue;
    }
    if (span.officialEndTick - start > maxTicks) {
      batches.push(current);
      current = [span];
      start = span.startTick;
    } else {
      current.push(span);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/** The one expensive call: every tick of every round in the batch. */
function readBatchRows(file, batch) {
  const from = batch[0].startTick;
  const to = batch[batch.length - 1].officialEndTick;
  const wanted = [];
  for (let t = from; t <= to; t++) wanted.push(t);
  return readTicks(file, TICK_PROPS, wanted);
}

/**
 * What each side bought, read at one tick per round rather than every tick.
 * This is the only call that asks for `inventory`, and it asks for roughly
 * twenty ticks instead of a hundred thousand.
 */
function readBuys(file, spans) {
  const ticks = spans.map((s) => s.freezeEndTick || s.startTick);
  const buys = new Map(); // `${tick}:${steamid}` -> snapshot
  let reader;
  try {
    reader = readTicks(file, BUY_PROPS, ticks, { structOfArrays: false });
  } catch {
    return buys; // economy falls back to its defaults rather than failing the parse
  }
  for (let i = 0; i < reader.length; i++) {
    const r = reader.at(i);
    const steam = sid(r.steamid);
    if (!steam) continue;
    buys.set(`${num(r.tick)}:${steam}`, {
      money: num(r.balance),
      equipValue: num(r.current_equip_value),
      loadout: inventoryOf(r),
      teamNum: numish(r.team_num)
    });
  }
  return buys;
}

/**
 * Distribute one batch's rows into a binary buffer per round, in a single
 * pass. Each pack carries the freezetime money/equipment the economy
 * classifier needs alongside its tick buffer.
 */
function packBatch(reader, batch, roster, tickRate) {
  const slotOf = new Map(roster.map((p) => [p.steamId, p.slot]));

  const packs = batch.map((span) => {
    const tickCount = span.officialEndTick - span.startTick + 1;
    const buffer = new ArrayBuffer(HEADER_BYTES + tickCount * TICK_BYTES);
    const view = new DataView(buffer);
    writeHeader(view, {
      tickCount,
      firstTick: span.startTick,
      stride: 1,
      tickRate,
      playerCount: Math.min(PLAYER_SLOTS, roster.length)
    });
    return {
      span,
      buffer,
      view,
      tickCount,
      weapons: ['none'],
      weaponIndex: new Map([['none', 0]])
    };
  });

  const weaponId = (pack, raw) => {
    // Stem the same way as viewer icons so "AK-47" / ak_47 / weapon_ak47 match.
    const w = bareWeapon(raw) || 'none';
    let i = pack.weaponIndex.get(w);
    if (i === undefined) {
      i = pack.weapons.length;
      // The dictionary index is a uint8 in the record; a round never comes
      // close to 255 distinct weapons, but clamp rather than corrupt it.
      if (i > 255) return 0;
      pack.weapons.push(w);
      pack.weaponIndex.set(w, i);
    }
    return i;
  };

  const state = {};

  for (let i = 0; i < reader.length; i++) {
    const r = reader.at(i);
    const steam = sid(r.steamid);
    const slot = slotOf.get(steam);
    if (slot === undefined) continue;
    const tick = num(r.tick);

    // A batch holds a handful of rounds, so a linear probe is cheaper than
    // maintaining an index, and it tolerates rows arriving out of order.
    let pack = null;
    for (const p of packs) {
      if (tick >= p.span.startTick && tick <= p.span.officialEndTick) {
        pack = p;
        break;
      }
    }
    if (!pack) continue;

    const row = tick - pack.span.startTick;
    if (row < 0 || row >= pack.tickCount) continue;

    const weaponName = r.active_weapon_name;
    state.x = num(r.X);
    state.y = num(r.Y);
    state.z = num(r.Z);
    state.yaw = num(r.yaw);
    state.pitch = num(r.pitch);
    state.health = num(r.health);
    state.armor = num(r.armor_value);
    state.weapon = weaponId(pack, weaponName);
    // Without per-tick inventory, the bomb carrier is inferred from what the
    // player is holding. It only affects the droplet marker.
    state.flags = flagsFor(r, String(weaponName || '').includes('c4'));
    state.flash = num(r.flash_duration);
    // Engine team_num each tick (2=T, 3=CT) — same source sparkoo/demoinfocs uses.
    state.teamNum = numish(r.team_num);
    writeRecord(pack.view, row, slot, state);
  }

  return packs;
}

// ---- grenades -------------------------------------------------------------
//
// Two sources are needed and neither is enough alone:
//
//   parseGrenades(file, null, false)
//     One row per live PROJECTILE per tick — the flight path. Rows carry
//     `grenade_entity_id`, `grenade_type` (the entity class, e.g.
//     "CSmokeGrenadeProjectile"), `steamid` (thrower), `name` (the THROWER's
//     display name, not the grenade) and x/y/z. The third argument drops the
//     grenades sitting in players' inventories, which are ~90% of the rows and
//     report the carrier's position, not a trajectory.
//
//   the *_detonate events
//     The exact tick and world point the thing went off, keyed by the same
//     entity id. Needed because a projectile entity usually outlives its
//     detonation: a smoke projectile keeps reporting its resting position for
//     the whole 18 seconds it is smoking, and an HE projectile lingers for
//     seconds after the blast.
//
// Entity ids are recycled within a match, so samples are also split into
// separate flights wherever there is a gap in the tick stream.

/** Detonation events, and the grenade type each one belongs to. */
const DETONATION_EVENTS = [
  ['smokegrenade_detonate', 'smokegrenade'],
  ['hegrenade_detonate', 'hegrenade'],
  ['flashbang_detonate', 'flashbang'],
  ['decoy_started', 'decoy'],
  // The inferno is its own entity, so this one rarely pairs by id; molotovs
  // fall back to their last projectile sample, which is the point of impact.
  ['inferno_startburn', 'molotov']
];

const GRENADE_TYPES = new Set([
  'flashbang',
  'smokegrenade',
  'hegrenade',
  'molotov',
  'incgrenade',
  'decoy'
]);

/** A break longer than this in one entity's samples means a recycled id. */
const FLIGHT_GAP_TICKS = 16;

/** World units are ~0.2 radar pixels; one decimal is well under a pixel. */
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Path simplification tolerance, world units. One radar pixel is ~5 units, so
 * six is under a pixel of error at any sane zoom.
 */
const PATH_EPSILON = 6;

/** demoparser projectile rows -> one entry per thrown grenade. */
export function buildFlights(rows) {
  const byEntity = new Map();
  for (const r of rows || []) {
    const id = r.grenade_entity_id ?? r.entity_id;
    if (id === undefined || id === null) continue;
    if (!byEntity.has(id)) byEntity.set(id, []);
    byEntity.get(id).push(r);
  }

  const flights = [];
  for (const [id, samples] of byEntity) {
    samples.sort((a, b) => num(a.tick) - num(b.tick));
    let run = [];
    const flush = () => {
      if (run.length) flights.push(flightFrom(id, run));
      run = [];
    };
    for (const s of samples) {
      if (run.length && num(s.tick) - num(run[run.length - 1].tick) > FLIGHT_GAP_TICKS) flush();
      run.push(s);
    }
    flush();
  }
  flights.sort((a, b) => a.throwTick - b.throwTick);
  return flights;
}

function flightFrom(entityId, samples) {
  const first = samples[0];
  return {
    entityId,
    type: normalizeGrenadeType(first.grenade_type ?? first.name),
    steamId: sid(first.steamid ?? first.thrower_steamid),
    throwTick: num(first.tick),
    endTick: num(samples[samples.length - 1].tick),
    path: samples.map((s) => ({
      tick: num(s.tick),
      x: num(s.x ?? s.X),
      y: num(s.y ?? s.Y),
      z: num(s.z ?? s.Z)
    }))
  };
}

/** Detonations keyed by projectile entity id, and by type for the fallback. */
function detonationsFrom(byName) {
  const byEntity = new Map();
  const byType = new Map();
  for (const [evName, type] of DETONATION_EVENTS) {
    for (const e of byName.get(evName) || []) {
      const det = {
        type,
        tick: num(e.tick),
        steamId: sid(e.user_steamid),
        x: num(e.x ?? e.user_X),
        y: num(e.y ?? e.user_Y),
        z: num(e.z ?? e.user_Z)
      };
      const id = e.entityid ?? e.entity_id;
      if (id !== undefined && id !== null) {
        if (!byEntity.has(id)) byEntity.set(id, []);
        byEntity.get(id).push(det);
      }
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(det);
    }
  }
  for (const list of byEntity.values()) list.sort((a, b) => a.tick - b.tick);
  for (const list of byType.values()) list.sort((a, b) => a.tick - b.tick);
  return { byEntity, byType };
}

/** The detonation belonging to a flight: same entity, same type, in its window. */
function detonationFor(flight, byEntity) {
  for (const det of byEntity.get(flight.entityId) || []) {
    if (det.type !== flight.type) continue;
    if (det.tick < flight.throwTick - 4 || det.tick > flight.endTick + 4) continue;
    return det;
  }
  return null;
}

/**
 * A flight plus its detonation, in the shape the viewer draws. The path is
 * cut at the detonation so a smoke does not appear to fly for 18 seconds, and
 * simplified so a round's worth of trajectories stays a few kilobytes.
 */
function grenadeEventFrom(flight, det, idOf, sideOf) {
  const detonateTick = det ? det.tick : flight.endTick;
  const path = simplifyPath(
    flight.path.filter((p) => p.tick <= detonateTick),
    PATH_EPSILON
  );
  const last = path[path.length - 1];
  const at = det ? { x: round1(det.x), y: round1(det.y), z: round1(det.z) } : last || null;
  // The detonation point is authoritative; make sure the line reaches it.
  if (at && last && Math.hypot(at.x - last.x, at.y - last.y) > PATH_EPSILON) {
    path.push({ tick: detonateTick, ...at });
  }
  const side = sideOf(flight.steamId);
  return {
    type: flight.type === 'molotov' && side === 'CT' ? 'incgrenade' : flight.type,
    player: idOf(flight.steamId),
    throwTick: flight.throwTick,
    detonateTick,
    from: path[0] || null,
    at,
    path
  };
}

/**
 * Throws rebuilt from events alone, for demos that carry no projectile rows.
 * A grenade weapon_fire is paired with the first unclaimed detonation of the
 * same type from the same player inside that grenade's fuse window. Without
 * projectile samples the path is a straight line, so a nade that bounced off a
 * wall draws through it.
 */
function flightsFromFire(byName, dets, tickRate) {
  // Seconds a throw may stay unaccounted for before its detonation is assumed
  // to belong to someone else. Flashes and HEs run a fixed fuse from the
  // throw; smokes, decoys and fire pop on landing, and a lofted smoke can be
  // in the air for the better part of ten seconds.
  const fuse = {
    flashbang: 3,
    hegrenade: 3,
    smokegrenade: 12,
    decoy: 12,
    molotov: 8,
    incgrenade: 8
  };
  const claimed = new Set();
  const out = [];

  for (const e of byName.get('weapon_fire') || []) {
    const type = normalizeGrenadeType(e.weapon);
    if (!GRENADE_TYPES.has(type)) continue;
    const fireTick = num(e.tick);
    const steamId = sid(e.user_steamid);
    // Molotovs and incendiaries both burn as "molotov" in the event stream.
    const detType = type === 'incgrenade' ? 'molotov' : type;
    const window = (fuse[type] || 3) * tickRate;

    let hit = null;
    for (const det of dets.byType.get(detType) || []) {
      if (det.tick < fireTick || det.tick > fireTick + window) continue;
      if (det.steamId && steamId && det.steamId !== steamId) continue;
      const key = `${detType}:${det.tick}:${det.x}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      hit = det;
      break;
    }
    if (!hit) continue;

    const from = {
      tick: fireTick,
      x: round1(num(e.user_X ?? e.X)),
      y: round1(num(e.user_Y ?? e.Y)),
      z: round1(num(e.user_Z ?? e.Z))
    };
    out.push({
      entityId: -1,
      type,
      steamId,
      throwTick: fireTick,
      endTick: hit.tick,
      path: [from, { tick: hit.tick, x: round1(hit.x), y: round1(hit.y), z: round1(hit.z) }]
    });
  }
  return out;
}

/**
 * Ramer-Douglas-Peucker, but the error measured is how far the *viewer* would
 * be from the truth, not perpendicular distance to a line.
 *
 * The viewer walks a path by tick, so a dropped sample costs the distance
 * between where the grenade really was and where interpolating between the
 * two kept samples puts it at that moment. That metric keeps two things plain
 * perpendicular RDP throws away: the deceleration of a lofted throw (the
 * ground track is a straight line, but the grenade does not cover it at a
 * constant rate) and a bounce that comes straight back down its own track (the
 * corner sits exactly on the line, so its perpendicular distance is zero).
 *
 * A 7-second lofted smoke is ~460 samples and simplifies to a handful.
 */
export function simplifyPath(points, epsilon) {
  if (!points || points.length <= 2) return (points || []).map(roundPoint);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const a = points[lo];
    const b = points[hi];
    const span = b.tick - a.tick;
    let worst = -1;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      const f = span > 0 ? (p.tick - a.tick) / span : 0;
      const d = Math.hypot(p.x - (a.x + (b.x - a.x) * f), p.y - (a.y + (b.y - a.y) * f));
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worst > epsilon) {
      keep[worstAt] = 1;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(roundPoint(points[i]));
  return out;
}

function roundPoint(p) {
  return { tick: p.tick, x: round1(p.x), y: round1(p.y), z: round1(p.z) };
}

/** Match viewer dictionary keys regardless of demoparser spelling. */
function normalizeGrenadeType(name) {
  const raw = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '')
    .replace(/[\s_-]+/g, '');
  if (!raw) return 'grenade';
  if (raw.includes('smoke')) return 'smokegrenade';
  if (raw.includes('flash')) return 'flashbang';
  if (raw.includes('molotov') || raw.includes('firebomb')) return 'molotov';
  if (raw.includes('incen')) return 'incgrenade';
  if (raw.includes('decoy')) return 'decoy';
  if (raw === 'he' || raw.includes('hegrenade') || raw.includes('frag')) return 'hegrenade';
  return raw;
}

/**
 * Freezetime kept in the replay timeline. CS2 buy time is ~20s and tactical
 * timeouts can stretch it much further; the viewer only wants a short lead-in
 * before live action (matches FREEZE_SECONDS in roundClock.js).
 */
const MAX_FREEZE_SECONDS = 3;

/** True when round_end carries a real winner or win reason (not a stub event). */
function roundEndLooksReal(end) {
  const winner = end?.winner;
  const reason = end?.reason;
  const hasWinner =
    winner != null &&
    winner !== '' &&
    winner !== 0 &&
    String(winner).toLowerCase() !== 'null' &&
    String(winner).toLowerCase() !== 'none';
  const hasReason =
    reason != null && reason !== '' && String(reason).toLowerCase() !== 'null';
  return hasWinner || hasReason;
}

/**
 * Round boundaries from the event stream.
 *
 * Drops ghost / restore stubs (round_end with no freeze_end, no winner, or no
 * live play). When total_rounds_played repeats, keeps the latest end for that
 * number — the earlier one is usually an aborted round that got restored.
 * Overlapping spans are resolved so a stub cannot steal the next round's ticks.
 */
function buildRoundSpans(byName, lastTick) {
  const starts = (byName.get('round_start') || []).map((e) => num(e.tick));
  const freezeEnds = (byName.get('round_freeze_end') || []).map((e) => num(e.tick));
  const ends = byName.get('round_end') || [];
  const officials = (byName.get('round_officially_ended') || []).map((e) => num(e.tick));

  const raw = [];
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i];
    if (!roundEndLooksReal(end)) continue;

    const endTick = num(end.tick);
    if (endTick <= 0) continue;

    const startTick = starts.filter((t) => t <= endTick).pop();
    if (startTick == null) continue;

    // A real round always fires round_freeze_end. Falling back to startTick
    // used to keep warmup / restore stubs that then overlapped the next round
    // and swallowed its tick data (empty "ghost" rounds in the viewer).
    const freezeEndTick = freezeEnds.find((t) => t > startTick && t <= endTick);
    if (freezeEndTick == null) continue;
    if (endTick <= freezeEndTick) continue;

    const officialEndTick =
      officials.find((t) => t >= endTick) ?? Math.min(endTick + 320, lastTick);

    raw.push({
      startTick,
      freezeEndTick,
      endTick,
      officialEndTick: Math.max(officialEndTick, endTick),
      winnerRaw: end.winner,
      reason: end.reason,
      totalRoundsPlayed: numish(end.total_rounds_played)
    });
  }

  // Restored rounds often emit two round_ends with the same total_rounds_played.
  // Keep the last one for each index.
  const byTrp = new Map();
  const unnumbered = [];
  for (const span of raw) {
    const trp = span.totalRoundsPlayed;
    if (trp > 0) byTrp.set(trp, span);
    else unnumbered.push(span);
  }
  const deduped =
    byTrp.size > 0
      ? [...unnumbered, ...[...byTrp.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)].sort(
          (a, b) => a.startTick - b.startTick || a.endTick - b.endTick
        )
      : raw;

  const spans = [];
  for (const span of deduped) {
    const prev = spans.at(-1);
    if (prev && span.startTick < prev.endTick) {
      // Prefer the later, more specific span when lifetimes overlap.
      if (span.startTick >= prev.startTick) spans[spans.length - 1] = span;
      continue;
    }
    spans.push(span);
  }

  spans.forEach((span, i) => {
    span.round = i + 1;
  });
  return spans;
}

/** Cap buy-time / timeout padding so each round's timeline starts ≤3s before live. */
function trimFreezeSpans(spans, tickRate) {
  const rate = Math.max(1, tickRate || 64);
  const maxFreeze = Math.max(1, Math.round(MAX_FREEZE_SECONDS * rate));
  return spans.map((span) => {
    const freezeLen = span.freezeEndTick - span.startTick;
    if (freezeLen <= maxFreeze) return span;
    return { ...span, startTick: span.freezeEndTick - maxFreeze };
  });
}

/**
 * True when the packed buffer has at least one player with a real position.
 * Empty packs are restore/warmup ghosts that survived event filtering.
 */
function packHasPlayers(pack) {
  const { view, tickCount } = pack;
  if (!tickCount) return false;
  const rows = [
    0,
    Math.floor(tickCount * 0.25),
    Math.floor(tickCount * 0.5),
    Math.floor(tickCount * 0.75),
    tickCount - 1
  ];
  const tmp = {};
  for (const row of rows) {
    if (row < 0 || row >= tickCount) continue;
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      readRecord(view, row, slot, tmp);
      if ((tmp.x !== 0 || tmp.y !== 0 || tmp.z !== 0) && (tmp.alive || tmp.health > 0)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} file  absolute path to a .dem
 * @param {{onProgress?: (p: {stage: string, round?: number, total?: number}) => void}} [opts]
 */
export async function parseDemo(file, opts = {}) {
  const p = parser();
  const progress = opts.onProgress || (() => {});
  propMode = null;

  progress({ stage: 'header' });
  let header = {};
  try {
    header = p.parseHeader(file) || {};
  } catch {
    header = {};
  }
  const mapRaw = header.map_name || header.map || '';
  const map = mapCodeFromName(mapRaw);
  if (!map) {
    throw new Error(
      `Unsupported map "${mapRaw || 'unknown'}". Replays cover Ancient, Dust2, ` +
        'Inferno, Cache, Mirage, Nuke and Anubis.'
    );
  }
  const tickRate = Math.round(num(header.tickrate) || num(header.tick_rate) || 64) || 64;

  progress({ stage: 'events' });
  const all = readEvents(file, [
    'round_start',
    'round_freeze_end',
    'round_end',
    'round_officially_ended',
    'player_death',
    'weapon_fire',
    'player_hurt',
    'bomb_planted',
    'bomb_defused',
    'bomb_exploded',
    // Who is carrying the C4. The per-tick flag only fires while the bomb is
    // the active weapon, so these are what the viewer actually marks with.
    'bomb_dropped',
    'bomb_pickup',
    // Ground pickups / drops so mid-round inventory can track utility & guns.
    'item_pickup',
    'item_remove',
    ...DETONATION_EVENTS.map(([name]) => name)
  ]);
  const byName = eventsByName(all);

  const lastTick = Math.max(
    0,
    ...all.map((e) => num(e.tick)),
    num(header.playback_ticks)
  );
  const spans = trimFreezeSpans(buildRoundSpans(byName, lastTick), tickRate);
  if (!spans.length) throw new Error('No completed rounds found in this demo.');

  const roster = rosterFromRows(
    readTicks(file, CORE_PROPS, [spans[0].freezeEndTick || spans[0].startTick || 1], {
      structOfArrays: false
    })
  );
  if (roster.length < 10) {
    throw new Error(`Expected 10 players, found ${roster.length}. Is this a competitive demo?`);
  }
  const bySteam = new Map(roster.map((p) => [p.steamId, p]));
  const idOf = (steam) => bySteam.get(steam)?.id || '';

  const team1Players = roster.filter((p) => p.team === 1);
  const team2Players = roster.filter((p) => p.team === 2);
  const team1Name = teamNameFor(team1Players, 'Team 1');
  const team2Name = teamNameFor(team2Players, 'Team 2');

  progress({ stage: 'grenades' });
  const detonations = detonationsFrom(byName);
  let flights = [];
  try {
    // `false` = projectiles only. Carried grenades report the holder's
    // position for the whole match and are ~90% of the rows.
    flights = buildFlights(p.parseGrenades(file, null, false) || []);
  } catch {
    flights = [];
  }
  if (!flights.length) flights = flightsFromFire(byName, detonations, tickRate);

  const inSpan = (e, span) => {
    const t = num(e.tick);
    return t >= span.startTick && t <= span.officialEndTick;
  };

  // Side (team_num) of team 1 in the first round, so round_end's winner id can
  // be mapped back to a team through the halftime swap.
  const roundsPerHalf = 12;

  // Buys first: one cheap call covering every round's freezetime tick.
  progress({ stage: 'buys' });
  const buys = readBuys(file, spans);

  const batches = batchSpans(spans, BATCH_TICKS);
  const rounds = [];
  let packedCount = 0;

  for (const batch of batches) {
    progress({ stage: 'round', round: packedCount + 1, total: spans.length });

    let reader = readBatchRows(file, batch);
    const packs = packBatch(reader, batch, roster, tickRate);
    // Drop the batch's rows before building records: they are by far the
    // largest thing alive, and the records below allocate again.
    reader = null;

    for (const pack of packs) {
    if (!packHasPlayers(pack)) continue;

    const span = pack.span;
    const { buffer, weapons } = pack;
    const buyTick = span.freezeEndTick || span.startTick;

    // Sides come from this round's freezetime team_num, not a half heuristic.
    // round_end.winner is often "T"/"CT" (or 2/3); never trust a bare num() of it.
    // Sides for this round from freezetime team_num (not a half heuristic).
    const team1Side =
      sideFromBuys(1, buyTick, roster, buys) || (span.round > roundsPerHalf ? 'CT' : 'T');
    const team2Side = team1Side === 'T' ? 'CT' : 'T';
    // Molotov and incendiary share one projectile class; the thrower's side
    // is what separates them.
    const sideOfSteam = (steam) =>
      bySteam.get(steam)?.team === 2 ? team2Side : team1Side;

    const grenades = [];
    for (const flight of flights) {
      if (flight.throwTick < span.startTick || flight.throwTick > span.officialEndTick) continue;
      grenades.push(
        grenadeEventFrom(flight, detonationFor(flight, detonations.byEntity), idOf, sideOfSteam)
      );
    }

    const kills = (byName.get('player_death') || [])
      .filter((e) => inSpan(e, span))
      .map((e) => ({
        tick: num(e.tick),
        attacker: idOf(sid(e.attacker_steamid)),
        victim: idOf(sid(e.user_steamid)),
        assister: idOf(sid(e.assister_steamid)),
        weapon: String(e.weapon || '').replace(/^weapon_/, ''),
        headshot: !!e.headshot,
        noscope: !!e.noscope,
        throughSmoke: !!e.thrusmoke,
        penetrated: num(e.penetrated) > 0,
        attackerBlind: !!e.attackerblind
      }));

    const shots = (byName.get('weapon_fire') || [])
      .filter((e) => inSpan(e, span))
      .map((e) => ({
        tick: num(e.tick),
        player: idOf(sid(e.user_steamid)),
        weapon: String(e.weapon || '').replace(/^weapon_/, ''),
        x: num(e.user_X ?? e.X),
        y: num(e.user_Y ?? e.Y),
        z: num(e.user_Z ?? e.Z),
        yaw: num(e.user_yaw ?? e.yaw),
        pitch: num(e.user_pitch ?? e.pitch)
      }));

    const bomb = [];
    for (const [evName, type] of [
      ['bomb_planted', 'planted'],
      ['bomb_defused', 'defused'],
      ['bomb_exploded', 'exploded'],
      ['bomb_dropped', 'dropped'],
      ['bomb_pickup', 'pickup']
    ]) {
      for (const e of byName.get(evName) || []) {
        if (!inSpan(e, span)) continue;
        bomb.push({
          type,
          tick: num(e.tick),
          player: idOf(sid(e.user_steamid)),
          site: e.site === 1 || e.site === 'B' ? 'B' : 'A',
          x: num(e.user_X ?? e.X),
          y: num(e.user_Y ?? e.Y),
          z: num(e.user_Z ?? e.Z)
        });
      }
    }
    // Read as a chain (pickup -> dropped -> pickup -> planted), so order matters.
    bomb.sort((a, b) => a.tick - b.tick);
    const plantTick = bomb.find((b) => b.type === 'planted')?.tick ?? null;

    // Post-freezetime only — buys already sit in the freezetime loadout.
    const freezeCut = span.freezeEndTick || span.startTick;
    const items = [];
    for (const [evName, op] of [
      ['item_pickup', 'pickup'],
      ['item_remove', 'remove']
    ]) {
      for (const e of byName.get(evName) || []) {
        if (!inSpan(e, span)) continue;
        const t = num(e.tick);
        if (t <= freezeCut) continue;
        const item = String(e.item || e.weapon || '').replace(/^weapon_/, '');
        if (!item) continue;
        const player = idOf(sid(e.user_steamid));
        if (!player) continue;
        items.push({ tick: t, player, item, op });
      }
    }
    items.sort((a, b) => a.tick - b.tick);

    let winnerSide =
      sideFromWinnerField(span.winnerRaw) || sideFromWinReason(span.reason);
    if (!winnerSide) {
      const wNum = numish(span.winnerRaw);
      if (wNum === 2) winnerSide = 'T';
      else if (wNum === 3) winnerSide = 'CT';
    }
    if (!winnerSide) {
      if (bomb.some((b) => b.type === 'exploded')) winnerSide = 'T';
      else if (bomb.some((b) => b.type === 'defused')) winnerSide = 'CT';
    }
    if (!winnerSide) winnerSide = team1Side === 'T' ? 'CT' : 'T'; // last resort: avoid painting every round T
    const winner = winnerSide === team1Side ? 1 : 2;

    // Per-player round stats.
    // Accuracy needs shots and hits counted over the same population, so both
    // sides drop utility and knives: a thrown flashbang is a weapon_fire and an
    // inferno tick is a player_hurt, and neither is a shot anybody aimed.
    const hurts = (byName.get('player_hurt') || []).filter((e) => inSpan(e, span));
    // Compact hurt log for coach (sole-damager checks). Skip world / self.
    const damage = [];
    for (const e of hurts) {
      const hp = num(e.dmg_health);
      if (!(hp > 0)) continue;
      const attacker = idOf(sid(e.attacker_steamid));
      const victim = idOf(sid(e.user_steamid));
      if (!attacker || !victim || attacker === victim) continue;
      damage.push({
        tick: num(e.tick),
        attacker,
        victim,
        hp,
        weapon: String(e.weapon || '').replace(/^weapon_/, '')
      });
    }
    damage.sort((a, b) => a.tick - b.tick);

    const stats = {};
    for (const pl of roster) {
      const snap = buys.get(`${buyTick}:${pl.steamId}`) || {};
      const myHurts = hurts.filter((e) => idOf(sid(e.attacker_steamid)) === pl.id);
      const gunHurts = myHurts.filter((e) => isGunName(e.weapon));
      const myShots = shots.filter((s) => s.player === pl.id);
      const gunShots = myShots.filter((s) => isGunName(s.weapon));

      // One trigger pull can raise several damage events: a shotgun lands
      // nine pellets, and a bullet that penetrates hits two people. Accuracy
      // is shots that landed, not damage instances, so the events are
      // collapsed onto the tick they fired on — no weapon in the game cycles
      // fast enough to shoot twice inside one tick.
      const landed = new Set();
      const headshotTicks = new Set();
      const awpLanded = new Set();
      for (const e of gunHurts) {
        const at = num(e.tick);
        landed.add(at);
        if (String(e.hitgroup) === 'head' || num(e.hitgroup) === 1) headshotTicks.add(at);
        if (String(e.weapon || '') === 'awp') awpLanded.add(at);
      }

      stats[pl.id] = {
        kills: kills.filter((k) => k.attacker === pl.id).length,
        deaths: kills.filter((k) => k.victim === pl.id).length,
        assists: kills.filter((k) => k.assister === pl.id).length,
        damage: myHurts.reduce((sum, e) => sum + num(e.dmg_health), 0),
        shots: myShots.length,
        gunShots: gunShots.length,
        hits: landed.size,
        headshots: headshotTicks.size,
        awpShots: myShots.filter((s) => s.weapon === 'awp').length,
        awpHits: awpLanded.size,
        money: snap.money || 0,
        equipValue: snap.equipValue || 0,
        loadout: snap.loadout || []
      };
    }

    const sideOf = (team) =>
      roster
        .filter((pl) => pl.team === team)
        .map((pl) => stats[pl.id] || { money: 0, equipValue: 0, loadout: [] });
    const isPistolRound = isPistolRoundNumber(span.round, roundsPerHalf);
    const econFor = (team) => {
      const side = sideOf(team);
      return classifyEconomy({
        equipValue: side.reduce((s, x) => s + (x.equipValue || 0), 0),
        money: side.reduce((s, x) => s + (x.money || 0), 0),
        loadouts: side.map((x) => x.loadout || []),
        isPistolRound
      });
    };

    rounds.push({
      round: span.round,
      winner,
      winnerSide,
      team1Side,
      team2Side,
      econ1: econFor(1),
      econ2: econFor(2),
      startTick: span.startTick,
      freezeEndTick: span.freezeEndTick,
      plantTick,
      endTick: span.endTick,
      officialEndTick: span.officialEndTick,
      players: roster.map((pl) => ({
        id: pl.id,
        name: pl.name,
        steamId: pl.steamId,
        team: pl.team,
        slot: pl.slot
      })),
      weapons,
      ticks: buffer,
      events: {
        kills,
        shots,
        grenades,
        bomb,
        damage,
        items
      },
      stats
    });

      packedCount++;
      progress({ stage: 'round', round: packedCount, total: spans.length });
    }
  }

  // Event / pack filters may drop ghosts mid-list; keep round numbers dense.
  rounds.forEach((r, i) => {
    r.round = i + 1;
  });

  if (!rounds.length) throw new Error('No playable rounds found in this demo.');

  progress({ stage: 'done', total: rounds.length });

  return {
    schemaVersion: SCHEMA_VERSION,
    parser: { name, version: version() },
    map,
    mapRaw,
    tickRate,
    team1: { id: shortIdFor(team1Name), name: team1Name },
    team2: { id: shortIdFor(team2Name), name: team2Name },
    rounds,
    source: {
      demoFile: header.demo_file_stamp || '',
      server: header.server_name || ''
    }
  };
}
