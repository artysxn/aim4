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
import { mapCodeFromName, shortIdFor } from '../../../src/replays/shared/roundId.js';
import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  writeHeader,
  writeRecord,
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

const sid = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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
        teamNum: num(r.team_num)
      });
    }
  }
  const all = [...seen.values()];
  const sideA = all.filter((p) => p.teamNum === 2); // T at the start
  const sideB = all.filter((p) => p.teamNum === 3); // CT at the start
  const group1 = sideA.length === 5 ? sideA : all.slice(0, 5);
  const group2 = sideB.length === 5 ? sideB : all.slice(5, 10);

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
// redundant decoding.
//
// The default is high enough that a normal match is a single pass. Now that
// `inventory` is out of the per-tick props, the rows themselves are cheap and
// the dominant cost is re-decoding the file, so FEWER passes is both faster
// and lighter. Lower this only if a very long match runs out of memory; it
// trades memory for repeated decoding, not the other way around.
const BATCH_TICKS = Number(process.env.AIM4_PARSE_BATCH_TICKS || 200000);

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
      loadout: inventoryOf(r)
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
    const w = raw ? String(raw).replace(/^weapon_/, '') : 'none';
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
    writeRecord(pack.view, row, slot, state);
  }

  return packs;
}

/**
 * Group grenade trajectory samples into per-grenade flight paths, sliced to a
 * round. demoparser reports one row per grenade per tick while it is in the
 * air, keyed by entity id.
 */
function grenadesForRound(allGrenades, round, idOf) {
  const byEntity = new Map();
  for (const g of allGrenades) {
    const tick = num(g.tick);
    if (tick < round.startTick || tick > round.officialEndTick) continue;
    const key = `${g.entity_id ?? 'x'}:${sid(g.thrower_steamid)}`;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(g);
  }
  const out = [];
  for (const samples of byEntity.values()) {
    samples.sort((a, b) => num(a.tick) - num(b.tick));
    const first = samples[0];
    const last = samples[samples.length - 1];
    out.push({
      type: String(first.name || 'grenade').replace(/^weapon_/, ''),
      player: idOf(sid(first.thrower_steamid)),
      throwTick: num(first.tick),
      detonateTick: num(last.tick),
      from: { x: num(first.X), y: num(first.Y), z: num(first.Z) },
      at: { x: num(last.X), y: num(last.Y), z: num(last.Z) },
      path: samples.map((s) => ({
        tick: num(s.tick),
        x: num(s.X),
        y: num(s.Y),
        z: num(s.Z)
      }))
    });
  }
  return out;
}

/** Round boundaries from the event stream. */
function buildRoundSpans(byName, lastTick) {
  const starts = (byName.get('round_start') || []).map((e) => num(e.tick));
  const freezeEnds = (byName.get('round_freeze_end') || []).map((e) => num(e.tick));
  const ends = byName.get('round_end') || [];
  const officials = (byName.get('round_officially_ended') || []).map((e) => num(e.tick));

  const spans = [];
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i];
    const endTick = num(end.tick);
    const startTick = starts.filter((t) => t <= endTick).pop() ?? (spans.at(-1)?.officialEndTick ?? 0);
    const freezeEndTick = freezeEnds.filter((t) => t > startTick && t <= endTick).shift() ?? startTick;
    const officialEndTick = officials.find((t) => t >= endTick) ?? Math.min(endTick + 320, lastTick);
    spans.push({
      round: spans.length + 1,
      startTick,
      freezeEndTick,
      endTick,
      officialEndTick,
      winnerTeamNum: num(end.winner),
      reason: num(end.reason)
    });
  }
  return spans;
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
    'bomb_exploded'
  ]);
  const byName = eventsByName(all);

  const lastTick = Math.max(
    0,
    ...all.map((e) => num(e.tick)),
    num(header.playback_ticks)
  );
  const spans = buildRoundSpans(byName, lastTick);
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

  let grenades = [];
  try {
    grenades = p.parseGrenades(file) || [];
  } catch {
    grenades = [];
  }

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
    const span = pack.span;
    const { buffer, weapons } = pack;
    const buyTick = span.freezeEndTick || span.startTick;

    // team 1 starts on T (team_num 2) and swaps at the half.
    const swapped = span.round > roundsPerHalf;
    const team1Side = swapped ? 3 : 2;
    const winner = span.winnerTeamNum === team1Side ? 1 : 2;

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
      ['bomb_exploded', 'exploded']
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
    const plantTick = bomb.find((b) => b.type === 'planted')?.tick ?? null;

    // Per-player round stats.
    const stats = {};
    for (const pl of roster) {
      const snap = buys.get(`${buyTick}:${pl.steamId}`) || {};
      stats[pl.id] = {
        kills: kills.filter((k) => k.attacker === pl.id).length,
        deaths: kills.filter((k) => k.victim === pl.id).length,
        assists: kills.filter((k) => k.assister === pl.id).length,
        damage: (byName.get('player_hurt') || [])
          .filter((e) => inSpan(e, span) && idOf(sid(e.attacker_steamid)) === pl.id)
          .reduce((sum, e) => sum + num(e.dmg_health), 0),
        shots: shots.filter((s) => s.player === pl.id).length,
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
        grenades: grenadesForRound(grenades, span, idOf),
        bomb
      },
      stats
    });

      packedCount++;
      progress({ stage: 'round', round: packedCount, total: spans.length });
    }
  }

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
