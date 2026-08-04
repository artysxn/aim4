// ---------------------------------------------------------------------------
// replays/shared/utilityMetrics.js
// How much work a player's utility actually did.
//
// Everything here comes from data already on disk, so adding these columns is a
// stats-index rebuild and never a demo reparse:
//
//   damage events   tick, attacker, victim, hp, weapon   -> HE and fire damage
//   grenade events  type, player, throwTick, detonateTick -> throw counts
//   tick buffer     per-player `flash` byte, 20ths of a second -> blind time
//
// The two headline numbers are deliberately per-THROW rather than per-round:
// "94 damage per HE" says something about the player, where "31 HE damage per
// round" mostly says how many they bought.
//
// Self and team damage never count. A molotov that pushes your own team off a
// site is not utility effectiveness, and counting it would reward exactly the
// wrong thing.
// ---------------------------------------------------------------------------

import { readHeader, readRecord } from './tickFormat.js';

/** Weapons whose player_hurt events count as utility damage. */
const HE_WEAPONS = new Set(['hegrenade']);
const FIRE_WEAPONS = new Set(['molotov', 'incgrenade', 'inferno', 'firebomb']);

/** A flash's contribution is measured in this window after it detonates. */
export const FLASH_SAMPLE_SECONDS = 0.5;
/** Blindness below this is a flicker, not a flash. Matches CS's own "blind" bar. */
export const FLASH_MIN_SECONDS = 0.5;

const bare = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^weapon_/, '');

export function isHeWeapon(weapon) {
  return HE_WEAPONS.has(bare(weapon));
}

export function isFireWeapon(weapon) {
  return FIRE_WEAPONS.has(bare(weapon));
}

export function isUtilityWeapon(weapon) {
  return isHeWeapon(weapon) || isFireWeapon(weapon);
}

function toDataView(buffer) {
  if (!buffer) return null;
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function rowForTick(header, tick) {
  if (!header || !Number.isFinite(tick)) return -1;
  const stride = Math.max(1, header.stride || 1);
  const row = Math.round((tick - header.firstTick) / stride);
  if (row < 0 || row >= header.tickCount) return -1;
  return row;
}

/** Team (1 or 2) for each player id in this round. */
function teamOf(meta) {
  const map = new Map();
  for (const p of meta?.players || []) map.set(p.id, p.team);
  return map;
}

const scratch = {};

/**
 * One player's remaining blind time at a tick row, in seconds.
 *
 * readRecord already converts the stored 20ths-of-a-second byte, so `flash` is
 * seconds by the time it arrives here. Dividing by FLASH_SCALE again is the
 * obvious mistake and a quiet one: every flash reads 20x short, drops under the
 * "was this really a flash" floor, and the whole column reports zero.
 *
 * The stored byte saturates at 255, so a flash longer than 12.75 s reads as
 * 12.75. No real flash reaches that.
 */
function flashSecondsAt(view, row, slot) {
  if (row < 0) return 0;
  readRecord(view, row, slot, scratch);
  return scratch.flash || 0;
}

/**
 * Blind seconds one flashbang put on every player it reached, by player id.
 *
 * Measured as the RISE in each player's blind timer across the detonation, not
 * the absolute value. Two flashes landing together would otherwise both claim
 * the full duration, and a player already blind would inflate whoever flashed
 * them second.
 *
 * Deliberately side-agnostic. Utility effectiveness only wants the enemies, but
 * the coach needs both sides to say whether a flash did more to its own team
 * than to theirs, and measuring that twice in two places would let the two
 * answers drift apart.
 *
 * @param {object} args
 * @param {Array<{id: string, slot: number}>} args.players
 * @param {number} args.detonateTick
 * @param {number} args.tickRate
 * @param {(slot: number, tick: number) => number} args.flashAt  blind seconds left
 * @param {number} [args.minSeconds]  floor below which a flicker is not a flash
 * @returns {Map<string, number>} player id -> blind seconds gained
 */
export function flashBlindRise({
  players,
  detonateTick,
  tickRate,
  flashAt,
  minSeconds = FLASH_MIN_SECONDS
}) {
  const out = new Map();
  const det = Number(detonateTick);
  if (!Number.isFinite(det) || typeof flashAt !== 'function') return out;
  const windowEnd = det + Math.max(1, Math.round(FLASH_SAMPLE_SECONDS * (tickRate || 64)));

  for (const player of players || []) {
    if (!player?.id || player.slot == null) continue;
    const baseline = flashAt(player.slot, det - 1);
    let peak = 0;
    for (let tick = det; tick <= windowEnd; tick++) {
      const value = flashAt(player.slot, tick);
      if (value > peak) peak = value;
    }
    const gained = peak - baseline;
    if (gained >= minSeconds) out.set(player.id, gained);
  }
  return out;
}

/**
 * Blind seconds this flashbang put on each enemy.
 *
 * @returns {number} total enemy blind seconds attributable to this flash
 */
function blindFromFlash(view, header, meta, grenade, teams, tickRate) {
  const throwerTeam = teams.get(grenade.player);
  if (!throwerTeam) return 0;

  const rise = flashBlindRise({
    players: meta.players || [],
    detonateTick: grenade.detonateTick,
    tickRate,
    flashAt: (slot, tick) => flashSecondsAt(view, rowForTick(header, tick), slot)
  });

  let total = 0;
  for (const [id, seconds] of rise) {
    // Team flashes are not effectiveness. Neither is flashing yourself.
    if (teams.get(id) === throwerTeam) continue;
    total += seconds;
  }
  return total;
}

/**
 * Per-player and per-team utility effectiveness for one round.
 *
 * @param {object} meta         round meta (players, events, tickRate, sides)
 * @param {ArrayBuffer|DataView|Uint8Array} tickBuffer  stride-1 ticks
 * @returns {{players: Record<string, object>, teams: {1: object, 2: object}}}
 */
export function utilityFromRound(meta, tickBuffer) {
  const players = {};
  const teams = {
    1: { heDamage: 0, fireDamage: 0, utilDamage: 0 },
    2: { heDamage: 0, fireDamage: 0, utilDamage: 0 }
  };
  if (!meta?.players?.length) return { players, teams };

  for (const p of meta.players) {
    players[p.id] = {
      heThrown: 0,
      heDamage: 0,
      fireThrown: 0,
      fireDamage: 0,
      flashesThrown: 0,
      enemyBlindSeconds: 0,
      flashesLanded: 0
    };
  }

  const team = teamOf(meta);
  const tickRate = meta.tickRate || 64;

  // ---- damage, split by what threw it -------------------------------------
  for (const d of meta.events?.damage || []) {
    const hp = Number(d.hp) || 0;
    if (hp <= 0) continue;
    const attacker = players[d.attacker];
    if (!attacker) continue;
    // Team damage and self damage are not effectiveness.
    const at = team.get(d.attacker);
    const vt = team.get(d.victim);
    if (!at || !vt || at === vt) continue;

    if (isHeWeapon(d.weapon)) {
      attacker.heDamage += hp;
      teams[at].heDamage += hp;
      teams[at].utilDamage += hp;
    } else if (isFireWeapon(d.weapon)) {
      attacker.fireDamage += hp;
      teams[at].fireDamage += hp;
      teams[at].utilDamage += hp;
    }
  }

  // ---- throws, and what the flashes achieved ------------------------------
  const view = toDataView(tickBuffer);
  const header = view ? readHeader(view) : null;

  for (const g of meta.events?.grenades || []) {
    const thrower = players[g.player];
    if (!thrower) continue;
    const type = String(g.type || '').toLowerCase();

    if (type === 'hegrenade') {
      thrower.heThrown += 1;
    } else if (type === 'molotov' || type === 'incgrenade') {
      thrower.fireThrown += 1;
    } else if (type === 'flashbang') {
      thrower.flashesThrown += 1;
      if (view && header) {
        const blind = blindFromFlash(view, header, meta, g, team, tickRate);
        if (blind > 0) {
          thrower.enemyBlindSeconds += blind;
          thrower.flashesLanded += 1;
        }
      }
    }
  }

  return { players, teams };
}

/**
 * Fold per-round utility counters into the per-player averages the database
 * shows. Kept separate from the round pass so the same aggregation works over
 * one match or the whole library.
 */
export function utilityAverages(totals) {
  const div = (a, b) => (b > 0 ? a / b : 0);
  return {
    /** Damage per HE actually thrown. The headline number. */
    heDamagePerNade: div(totals.heDamage, totals.heThrown),
    /** Damage per molotov / incendiary thrown. */
    fireDamagePerNade: div(totals.fireDamage, totals.fireThrown),
    /** Enemy blind seconds per flashbang thrown, counting the duds. */
    blindPerFlash: div(totals.enemyBlindSeconds, totals.flashesThrown),
    /** Share of flashes that blinded at least one enemy. */
    flashHitRate: div(totals.flashesLanded, totals.flashesThrown),
    /** All utility damage per round played. Team column uses the same shape. */
    utilDamagePerRound: div(totals.heDamage + totals.fireDamage, totals.rounds)
  };
}

export const UTILITY_FIELDS = Object.freeze([
  'heThrown',
  'heDamage',
  'fireThrown',
  'fireDamage',
  'flashesThrown',
  'flashesLanded',
  'enemyBlindSeconds'
]);

/** Add one round's counters into a running total. */
export function addUtility(into, from) {
  for (const key of UTILITY_FIELDS) into[key] = (into[key] || 0) + (from[key] || 0);
  return into;
}
