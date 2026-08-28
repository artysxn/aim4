// ---------------------------------------------------------------------------
// replays/pistolFix.js
// Two pistol-round defects, repaired from stored data. No reparse.
//
// 1. KNIFE ROUND GLUED INTO ROUND 1. Some demos open with a knife round the
//    parser folded into round 1: nine players die with knives, the survivors
//    win the choice, and then — inside the same stored round — the real
//    pistol round begins. The tell needs no weapon data at all: within one
//    real round the alive count only ever falls, so a round where it falls
//    and then RETURNS TO FULL is two rounds glued together. The refill tick
//    is the pistol round's freeze start; everything before it is trimmed
//    from the ticks, the events, and the per-player stats.
//
// 2. MISSING PISTOL ROUND. Some demos are cut so the pistol round is absent
//    and the parser numbered the second round "1" — which forces its economy
//    digit to pistol (see economy.js) and pollutes every pistol statistic
//    with rifle rounds. The tell: at freeze end of stored round 1 somebody
//    is HOLDING a primary, which cannot happen in a real round 1. The fix
//    renumbers every round up by one, reclassifies the false pistol's
//    economy from its stored money and equipment values, and flags the demo
//    so round 1 shows as unavailable rather than silently absent.
//
// The same detections run in two places: on a NormalizedDemo before
// materialize (every future parse arrives fixed) and over a stored library
// demo's files (the past is repaired in place). Both shapes carry identical
// fields, which is why one module serves both.
// ---------------------------------------------------------------------------

import {
  FLAG_ALIVE,
  HEADER_BYTES,
  PLAYER_SLOTS,
  RECORD_BYTES,
  TICK_BYTES,
  readHeader,
  writeHeader
} from '../../src/replays/shared/tickFormat.js';
import { classifyEconomy, pistolsOnly } from '../demoparser/economy.js';

/** The refill must happen early: a knife round plus its choice screen is over
 *  inside a couple of minutes, and anything later is not one. */
const KNIFE_WINDOW_S = 240;
/** Deaths required before a refill counts. A knife round kills nine; asking
 *  for four keeps a lone disconnect/rejoin from reading as one. */
const MIN_KNIFE_DEATHS = 4;
/** Raw position delta (quarter-units) that counts as "moved" for freeze-end
 *  detection: 32 raw = 8 game units, more than any freeze-time twitch. */
const MOVE_RAW = 32;
/** Freeze length assumed when movement never shows up (headless fallback). */
const FALLBACK_FREEZE_S = 18;

function view(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (Buffer.isBuffer(buffer)) {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
}

const rowOf = (v, header, tick) =>
  Math.floor((tick - header.firstTick) / (header.stride || 1));
const tickOf = (header, row) => header.firstTick + row * (header.stride || 1);

function aliveCount(v, row) {
  let n = 0;
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    const o = HEADER_BYTES + row * TICK_BYTES + slot * RECORD_BYTES;
    if (v.getUint8(o + 13) & FLAG_ALIVE) n++;
  }
  return n;
}

/**
 * The pistol round's freeze-start tick inside a glued knife+pistol round,
 * or 0 when the round is a single round like it should be.
 */
export function findKnifeCut(meta, buffer) {
  const v = view(buffer);
  const header = readHeader(v);
  if (!header.tickCount) return 0;
  const rate = header.tickRate || meta.tickRate || 64;
  const lastRow = Math.min(header.tickCount - 1, Math.floor((KNIFE_WINDOW_S * rate) / (header.stride || 1)));

  const full = aliveCount(v, 0);
  if (full < 8) return 0; // partial data; do not guess

  let minAlive = full;
  for (let row = 1; row <= lastRow; row++) {
    const alive = aliveCount(v, row);
    if (alive < minAlive) minAlive = alive;
    if (minAlive <= full - MIN_KNIFE_DEATHS && alive >= full) {
      // Everyone is back: this row is the restart. Confirm against the meta —
      // the deaths we just walked past must exist as pre-cut kills, and a
      // knife round's kills are knives (world kills allowed: fall damage).
      const cutTick = tickOf(header, row);
      const before = (meta.events?.kills || []).filter((k) => k.tick < cutTick);
      if (before.length < MIN_KNIFE_DEATHS) return 0;
      const knifeish = before.filter((k) => {
        const w = String(k.weapon || '').replace(/^weapon_/, '').toLowerCase();
        return !w || w.includes('knife') || w === 'world';
      });
      if (knifeish.length < before.length * 0.6) return 0;
      return cutTick;
    }
  }
  return 0;
}

/**
 * When the trimmed round actually goes live: the first tick after `fromTick`
 * where two players have left their freeze positions. Players cannot walk
 * during CS2 freeze time, so the first real movement IS the freeze end.
 */
export function findFreezeEnd(meta, buffer, fromTick) {
  const v = view(buffer);
  const header = readHeader(v);
  const rate = header.tickRate || meta.tickRate || 64;
  const stride = header.stride || 1;
  const startRow = Math.max(0, rowOf(v, header, fromTick));
  const settleRow = Math.min(header.tickCount - 1, startRow + Math.ceil(rate / stride)); // +1s: spawns settle
  const lastRow = Math.min(header.tickCount - 1, startRow + Math.ceil((90 * rate) / stride));

  const base = [];
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    const o = HEADER_BYTES + settleRow * TICK_BYTES + slot * RECORD_BYTES;
    base.push({ x: v.getInt16(o, true), y: v.getInt16(o + 2, true), alive: v.getUint8(o + 13) & FLAG_ALIVE });
  }

  for (let row = settleRow + 1; row <= lastRow; row++) {
    let moved = 0;
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      if (!base[slot].alive) continue;
      const o = HEADER_BYTES + row * TICK_BYTES + slot * RECORD_BYTES;
      if (
        Math.abs(v.getInt16(o, true) - base[slot].x) > MOVE_RAW ||
        Math.abs(v.getInt16(o + 2, true) - base[slot].y) > MOVE_RAW
      ) {
        moved++;
        if (moved >= 2) return tickOf(header, row);
      }
    }
  }
  return fromTick + FALLBACK_FREEZE_S * rate;
}

/** A new tick buffer starting at `cutTick`. The header moves with it. */
export function trimTicks(buffer, cutTick) {
  const v = view(buffer);
  const header = readHeader(v);
  const stride = header.stride || 1;
  const dropRows = Math.max(0, rowOf(v, header, cutTick));
  const keepRows = header.tickCount - dropRows;
  if (dropRows <= 0 || keepRows <= 0) return null;

  const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  const out = Buffer.alloc(HEADER_BYTES + keepRows * TICK_BYTES);
  writeHeader(new DataView(out.buffer, out.byteOffset, out.byteLength), {
    recordBytes: header.recordBytes,
    tickCount: keepRows,
    firstTick: header.firstTick + dropRows * stride,
    stride,
    tickRate: header.tickRate,
    playerCount: header.playerCount,
    slots: header.slots
  });
  src.copy(out, HEADER_BYTES, HEADER_BYTES + dropRows * TICK_BYTES);
  return out;
}

/**
 * Remove the knife phase from a round's meta: events before the cut go, and
 * the per-player stats give back exactly what those events had added.
 */
export function trimMeta(meta, cutTick, freezeEndTick) {
  const events = meta.events || {};
  const keep = (list) => (list || []).filter((e) => (e.tick ?? e.throwTick ?? 0) >= cutTick);
  const dropped = {
    kills: (events.kills || []).filter((k) => k.tick < cutTick),
    shots: (events.shots || []).filter((s) => s.tick < cutTick),
    damage: (events.damage || []).filter((d) => d.tick < cutTick)
  };

  const stats = meta.stats || {};
  const bump = (id, field, by) => {
    // Only give back what a field actually holds: creating a zeroed field a
    // parser never wrote would flip statsIndex's "does this round have hit
    // data" detection.
    if (!id || !stats[id] || stats[id][field] === undefined) return;
    stats[id][field] = Math.max(0, stats[id][field] - by);
  };
  for (const k of dropped.kills) {
    bump(k.attacker, 'kills', 1);
    bump(k.victim, 'deaths', 1);
    bump(k.assister, 'assists', 1);
    if (k.headshot) bump(k.attacker, 'headshots', 1);
  }
  for (const s of dropped.shots) bump(s.player, 'shots', 1);
  for (const d of dropped.damage) {
    bump(d.attacker, 'damage', d.hp || 0);
    bump(d.attacker, 'hits', 1);
  }

  meta.events = {
    ...events,
    kills: keep(events.kills),
    shots: keep(events.shots),
    damage: events.damage ? keep(events.damage) : events.damage,
    grenades: (events.grenades || []).filter((g) => (g.throwTick ?? 0) >= cutTick),
    bomb: keep(events.bomb),
    items: events.items ? keep(events.items) : events.items
  };
  meta.startTick = cutTick;
  meta.freezeEndTick = freezeEndTick;
  meta.pistolFix = { ...(meta.pistolFix || {}), knifeTrimmed: true };
  return meta;
}

/**
 * What each team is HOLDING shortly after freeze end, as weapon names.
 * Enough to answer "is anyone carrying a primary" — the missing-pistol tell.
 */
export function heldLoadouts(meta, buffer, tick) {
  const v = view(buffer);
  const header = readHeader(v);
  const row = Math.max(0, Math.min(header.tickCount - 1, rowOf(v, header, tick)));
  const dict = meta.weapons || [];
  const out = [];
  for (const p of meta.players || []) {
    const slot = p.slot ?? 0;
    const o = HEADER_BYTES + row * TICK_BYTES + slot * RECORD_BYTES;
    if (!(v.getUint8(o + 13) & FLAG_ALIVE)) continue;
    const name = dict[v.getUint8(o + 12)] || '';
    if (name) out.push([name]);
  }
  return out;
}

/**
 * True when stored round 1 cannot be a real pistol round: somebody is holding
 * something better than a pistol right after the buy. Sampled twice, because
 * a player can still be on their knife two seconds in.
 */
export function detectMissingPistol(meta, buffer) {
  const rate = meta.tickRate || 64;
  const freezeEnd = meta.freezeEndTick ?? meta.startTick ?? 0;
  for (const offset of [2, 6]) {
    const held = heldLoadouts(meta, buffer, freezeEnd + offset * rate);
    if (held.length >= 6 && !pistolsOnly(held)) return true;
  }
  return false;
}

/**
 * The economy digits this round should have carried, from the money and
 * equipment values the parser stored per player. isPistolRound is false by
 * definition here: that lie is the thing being corrected.
 */
export function reclassifyEcon(meta) {
  const side = (team) => {
    let equipValue = 0;
    let money = 0;
    for (const p of meta.players || []) {
      if (p.team !== team) continue;
      const st = meta.stats?.[p.id] || {};
      equipValue += st.equipValue || 0;
      money += st.money || 0;
    }
    return classifyEconomy({ equipValue, money, loadouts: [], isPistolRound: false });
  };
  return { econ1: side(1), econ2: side(2) };
}

// ---------------------------------------------------------------------------
// The two entry points.
// ---------------------------------------------------------------------------

/**
 * Repair a NormalizedDemo in place before materialize. Every future parse
 * passes through here, so new demos never carry either defect.
 * @returns {{ knifeTrimmed: boolean, missingPistol: boolean }}
 */
export function fixNormalizedDemo(demo) {
  const outcome = { knifeTrimmed: false, missingPistol: false };
  if (!demo?.rounds?.length) return outcome;

  const first = demo.rounds.find((r) => r.round === 1) || demo.rounds[0];
  if (first?.ticks) {
    const cut = findKnifeCut(first, first.ticks);
    if (cut) {
      const trimmed = trimTicks(first.ticks, cut);
      if (trimmed) {
        const freezeEnd = findFreezeEnd(first, trimmed, cut);
        trimMeta(first, cut, freezeEnd);
        first.ticks = trimmed.buffer.slice(trimmed.byteOffset, trimmed.byteOffset + trimmed.byteLength);
        outcome.knifeTrimmed = true;
      }
    }

    if (detectMissingPistol(first, first.ticks)) {
      const { econ1, econ2 } = reclassifyEcon(first);
      first.econ1 = econ1;
      first.econ2 = econ2;
      for (const r of demo.rounds) r.round += 1;
      // Rides on the round entry into the viewer, which renders a disabled
      // "01" chip ahead of it: absence explained beats absence noticed.
      first.pistolMissingBefore = true;
      demo.pistolFix = { ...(demo.pistolFix || {}), missingPistol: true };
      outcome.missingPistol = true;
    }
  }
  return outcome;
}

/**
 * Repair one stored library demo in place: round 1's meta and ticks, every
 * round's number when the pistol is missing, and the demo record.
 *
 * @param {object} io  { readRoundMeta, readRoundTicks, writeRoundMeta,
 *                       writeMaterialized } — demoStore's own functions.
 * @returns {Promise<{ knifeTrimmed: boolean, missingPistol: boolean, changed: boolean }>}
 */
export async function fixStoredDemo(io, user, record, { force = false } = {}) {
  const outcome = { knifeTrimmed: false, missingPistol: false, changed: false };
  if (!record?.rounds?.length) return outcome;
  if (record.pistolFix?.checkedAt && !force) return outcome; // already examined

  const entries = record.rounds;
  const firstEntry = entries.find((r) => r.round === 1) || entries[0];
  if (!firstEntry?.file) return outcome;

  const meta = await io.readRoundMeta(user, firstEntry.file);
  const rawTicks = await io.readRoundTicks(user, firstEntry.file, 1);
  if (!meta || !rawTicks) return outcome;
  let ticks = Buffer.isBuffer(rawTicks) ? rawTicks : Buffer.from(rawTicks);

  const nextRecord = { ...record };

  // -- knife phase --------------------------------------------------------
  const cut = findKnifeCut(meta, ticks);
  if (cut) {
    const trimmed = trimTicks(ticks, cut);
    if (trimmed) {
      const freezeEnd = findFreezeEnd(meta, trimmed, cut);
      trimMeta(meta, cut, freezeEnd);
      ticks = trimmed;
      firstEntry.startTick = cut;
      firstEntry.freezeEndTick = freezeEnd;
      await io.writeMaterialized(user, nextRecord, new Map([
        [`rounds/${firstEntry.file}.json`, Buffer.from(JSON.stringify(meta))],
        [`rounds/${firstEntry.file}.bin`, ticks]
      ]));
      outcome.knifeTrimmed = true;
      outcome.changed = true;
    }
  }

  // -- missing pistol ------------------------------------------------------
  if (detectMissingPistol(meta, ticks)) {
    const { econ1, econ2 } = reclassifyEcon(meta);
    meta.econ1 = econ1;
    meta.econ2 = econ2;
    meta.round = (meta.round || 1) + 1;
    meta.pistolFix = { ...(meta.pistolFix || {}), renumbered: true };
    await io.writeRoundMeta(user, firstEntry.file, meta);

    for (const entry of entries) {
      if (entry === firstEntry) {
        entry.econ1 = econ1;
        entry.econ2 = econ2;
        entry.pistolMissingBefore = true;
      } else if (entry.file) {
        const m = await io.readRoundMeta(user, entry.file);
        if (m) {
          m.round = (m.round || entry.round) + 1;
          m.pistolFix = { ...(m.pistolFix || {}), renumbered: true };
          await io.writeRoundMeta(user, entry.file, m);
        }
      }
      entry.round += 1;
    }
    nextRecord.pistolFix = { ...(nextRecord.pistolFix || {}), missingPistol: true };
    outcome.missingPistol = true;
    outcome.changed = true;
  }

  nextRecord.pistolFix = { ...(nextRecord.pistolFix || {}), checkedAt: Date.now() };
  await io.writeRecord(user, nextRecord);
  return outcome;
}
