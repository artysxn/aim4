// ---------------------------------------------------------------------------
// replays/eye/roundQuery.js
// The question aim4 eye asks of a team's rounds, answered exactly.
//
// The model never counts anything itself. It writes a query in this small
// JSON language, this file runs it over the same per-round reads the antistrat
// uses (antistratScan `roundFeatures`: who stood where every second, every
// grenade, kill and hit, the plant), and the numbers that come back are the
// only numbers it may quote.
//
//   {
//     "side": "T" | "CT" | "any",                 whose side the team was on
//     "buy": "full" | "force" | "half" | "eco" | "pistol" | "any",   the team's buy
//     "vs_buy": same,                             the other team's buy
//     "where": [ condition, ... ],                all must hold
//     "group_by": "site" | "won" | "pace" | "plant" | "first_kill" | "buy" | "side"
//   }
//
// Conditions (times are the round clock, "1:55" down to "0:00"):
//
//   { "players_in": { "zone": "Silo", "who": "team"|"opponent", "min": 1, "max": 5,
//                     "from": "1:55", "to": "1:20" } }
//       at some second in the window, at least min (at most max) of them
//       stood in that zone at the same time
//   { "utility": { "who": "team"|"opponent", "type": "smoke"|"molotov"|"flash"|"he"|"any",
//                  "zone": "Heaven", "from": "1:55", "to": "0:00", "min": 1 } }
//       grenades thrown in the window (landing in the zone, when one is named)
//   { "kill": { "by": "team"|"opponent", "zone": "...", "from", "to", "min": 1 } }
//   { "first_kill": { "by": "team"|"opponent", "zone": "..." } }
//   { "site": "A" | "B" | "none" }      where the round went (T: the hit, CT: the hit faced)
//   { "plant": true | false }
//   { "won": true | false }
//   { "pace": "rush"|"pop"|"contact"|"full-exec"|"default"|"slow-default"|"other" }  (T rounds)
//   { "not": condition }
//
// A zone is any name the map's zone network has: a position ("Silo"), a zone
// that groups positions, or an area. Unknown names are reported back so the
// model can look the map's names up and try again, rather than silently
// matching nothing.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { classifyPace, paceSite } from '../analytics/antistratScan.js';

// "bought" is half, force or full: the pool the antistrat's pace section counts,
// so a document's "Rush 11% (12 rounds)" can be checked with the same rounds.
const BUYS = { pistol: [0], eco: [1], half: [2], force: [3], full: [4], bought: [2, 3, 4] };
const NADE_TYPES = { smoke: 'smokegrenade', molotov: 'molotov', flash: 'flashbang', he: 'hegrenade' };
const GROUPS = new Set(['site', 'won', 'pace', 'plant', 'first_kill', 'buy', 'side']);
const MAX_FILES = 150;

export class QueryError extends Error {}

/** "1:20" or 80 (seconds left) to seconds since the round went live. */
export function elapsedOfClock(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  let left = null;
  if (typeof value === 'number') left = value;
  else {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value));
    if (m) left = Number(m[1]) * 60 + Number(m[2]);
    else if (/^\s*\d+(\.\d+)?\s*$/.test(String(value))) left = Number(value);
  }
  if (left === null || !Number.isFinite(left)) throw new QueryError(`"${value}" is not a round clock like "1:20".`);
  return Math.max(0, Math.min(ROUND_SECONDS, ROUND_SECONDS - left));
}

/**
 * Every name a zone network answers to, mapped to the position names inside it.
 * Positions, zones (groups of positions) and areas (groups of zones).
 */
export function zoneIndex(network) {
  const byName = new Map();
  const add = (name, positions) => {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return;
    if (!byName.has(key)) byName.set(key, { name: String(name).trim(), positions: new Set() });
    for (const p of positions) byName.get(key).positions.add(p);
  };
  const posById = new Map((network?.positions || []).map((p) => [p.id, p.name]));
  for (const p of network?.positions || []) if (!p.hidden) add(p.name, [p.name]);
  const zonePositions = new Map();
  for (const z of network?.zones || []) {
    const names = (z.positionIds || []).map((id) => posById.get(id)).filter(Boolean);
    zonePositions.set(z.id, names);
    add(z.name, names);
  }
  for (const a of network?.areas || []) {
    const names = (a.zoneIds || []).flatMap((id) => zonePositions.get(id) || []);
    const direct = (a.positionIds || []).map((id) => posById.get(id)).filter(Boolean);
    add(a.name, [...names, ...direct]);
  }
  return byName;
}

/** The names a map's network knows, for the model to choose from. */
export function zoneNames(network) {
  const posById = new Map((network?.positions || []).map((p) => [p.id, p.name]));
  return {
    positions: [...new Set((network?.positions || []).filter((p) => !p.hidden).map((p) => p.name))].sort(),
    zones: (network?.zones || []).map((z) => ({ name: z.name, positions: (z.positionIds || []).map((id) => posById.get(id)).filter(Boolean) })),
    areas: (network?.areas || []).map((a) => a.name)
  };
}

function sideOk(r, side) {
  return !side || side === 'any' || r.side === side;
}

function buyOk(econ, buy) {
  if (!buy || buy === 'any') return true;
  const want = BUYS[buy];
  if (!want) throw new QueryError(`Unknown buy "${buy}". Use full, force, half, eco, pistol, bought or any.`);
  return want.includes(econ);
}

/**
 * Compile one condition into a test of a round. Zone names are resolved
 * once, here, against the map.
 */
const KINDS = new Set(['not', 'players_in', 'utility', 'kill', 'first_kill', 'site', 'plant', 'won', 'pace']);

/**
 * Small models drop the wrapper and write `{ "zone": "Silo", "min": 1 }` for
 * `{ "players_in": { ... } }`, or `{ "type": "smoke", ... }` for utility. The
 * intent is unambiguous, so it is read the way it was meant.
 */
function normalizeCondition(cond) {
  const keys = Object.keys(cond);
  if (keys.length === 1 && KINDS.has(keys[0])) return cond;
  if (keys.some((k) => KINDS.has(k))) {
    const kind = keys.find((k) => KINDS.has(k));
    return { [kind]: cond[kind] };
  }
  if ('type' in cond && ['smoke', 'molotov', 'flash', 'he', 'any'].includes(cond.type)) return { utility: cond };
  if ('zone' in cond) return { players_in: cond };
  return cond;
}

function compile(raw, zones, unknown) {
  if (!raw || typeof raw !== 'object') throw new QueryError('A condition must be an object.');
  const cond = normalizeCondition(raw);
  const [kind, arg] = Object.entries(cond)[0] || [];
  const zoneSet = (name) => {
    if (!name) return null;
    const hit = zones.get(String(name).trim().toLowerCase());
    if (!hit) {
      unknown.add(String(name));
      return new Set();
    }
    return hit.positions;
  };
  const whoOf = (w) => {
    const v = String(w ?? 'team').toLowerCase();
    if (['team', 'us', 'ours', 'player', 'players', 'self'].includes(v)) return 'team';
    if (['opponent', 'opponents', 'enemy', 'enemies', 'them', 'other'].includes(v)) return 'opponent';
    throw new QueryError(`"who" is "team" or "opponent", not "${w}".`);
  };
  const windowOf = (a) => {
    const from = elapsedOfClock(a?.from, 0);
    const to = elapsedOfClock(a?.to, ROUND_SECONDS);
    return from <= to ? [from, to] : [to, from];
  };
  switch (kind) {
    case 'not': {
      const inner = compile(arg, zones, unknown);
      return (r) => !inner(r);
    }
    case 'players_in': {
      const set = zoneSet(arg?.zone);
      if (!set) throw new QueryError('players_in needs a zone.');
      const who = whoOf(arg.who);
      const min = Number.isFinite(arg.min) ? arg.min : 1;
      const max = Number.isFinite(arg.max) ? arg.max : 5;
      const [from, to] = windowOf(arg);
      return (r) => {
        for (const s of r.series || []) {
          if (s.elapsed < from) continue;
          if (s.elapsed > to) break;
          const pts = who === 'team' ? s.pts : s.opp || [];
          let n = 0;
          for (const p of pts) if (p.pos && set.has(p.pos)) n++;
          if (n >= min && n <= max) return true;
        }
        return false;
      };
    }
    case 'utility': {
      const who = whoOf(arg?.who);
      const type = arg?.type && arg.type !== 'any' ? NADE_TYPES[arg.type] : null;
      if (arg?.type && arg.type !== 'any' && !type) throw new QueryError(`Unknown utility "${arg.type}". Use smoke, molotov, flash, he or any.`);
      const set = zoneSet(arg?.zone);
      const min = Number.isFinite(arg?.min) ? arg.min : 1;
      const [from, to] = windowOf(arg);
      return (r) => {
        const list = who === 'team' ? r.nades : r.enemyNades || [];
        let n = 0;
        for (const g of list) {
          const t = Number.isFinite(g.throwAt) ? g.throwAt : g.at;
          if (t < from || t > to) continue;
          if (type && g.type !== type) continue;
          if (set && !set.has(g.zone) && !set.has(g.label)) continue;
          n++;
        }
        return n >= min;
      };
    }
    case 'kill': {
      const by = whoOf(arg?.by);
      const set = zoneSet(arg?.zone);
      const min = Number.isFinite(arg?.min) ? arg.min : 1;
      const [from, to] = windowOf(arg);
      return (r) =>
        r.kills.filter((k) => {
          const t = ROUND_SECONDS - k.clock;
          if (t < from || t > to) return false;
          if ((by === 'team') !== k.attackerOurs) return false;
          return !set || set.has(k.victimZone) || set.has(k.attackerZone);
        }).length >= min;
    }
    case 'first_kill': {
      const by = whoOf(arg?.by);
      const set = zoneSet(arg?.zone);
      return (r) => {
        const k = r.firstKill;
        if (!k || (by === 'team') !== k.attackerOurs) return false;
        return !set || set.has(k.victimZone) || set.has(k.attackerZone);
      };
    }
    case 'site': {
      const want = String(arg || '').toUpperCase();
      if (!['A', 'B', 'NONE'].includes(want)) throw new QueryError('site is "A", "B" or "none".');
      return (r) => (siteOf(r) || 'NONE') === want;
    }
    case 'plant':
      return (r) => (r.plantTick != null) === Boolean(arg);
    case 'won':
      return (r) => Boolean(r.won) === Boolean(arg);
    case 'pace':
      return (r) => r.side === 'T' && classifyPace(r) === String(arg);
    default:
      throw new QueryError(`Unknown condition "${kind}".`);
  }
}

const siteOf = (r) => String((r.side === 'T' ? paceSite(r) : r.hitSite) || '').toUpperCase();
const econWord = (e) => Object.entries(BUYS).find(([k, v]) => k !== 'bought' && v.includes(e))?.[0] || 'unknown';

function groupKey(r, by) {
  switch (by) {
    case 'site':
      return siteOf(r) || 'no site';
    case 'won':
      return r.won ? 'won' : 'lost';
    case 'pace':
      return r.side === 'T' ? classifyPace(r) || 'other' : 'CT round';
    case 'plant':
      return r.plantTick != null ? 'planted' : 'no plant';
    case 'first_kill':
      return !r.firstKill ? 'no kill' : r.firstKill.attackerOurs ? 'team got it' : 'opponent got it';
    case 'buy':
      return econWord(r.ownEcon);
    case 'side':
      return r.side;
    default:
      return 'all';
  }
}

/**
 * Run a query over one team's rounds on one map.
 *
 * @param {object[]} rounds   antistratScan `extract.rounds` (the team's side of each round)
 * @param {object} network    the map's zone network
 * @param {object} query
 */
export function runRoundQuery(rounds, network, query = {}) {
  const q = query || {};
  if (q.group_by && !GROUPS.has(q.group_by)) throw new QueryError(`group_by is one of ${[...GROUPS].join(', ')}.`);
  if (q.side && !['T', 'CT', 'any'].includes(q.side)) throw new QueryError('side is "T", "CT" or "any".');
  const zones = zoneIndex(network);
  const unknown = new Set();
  const tests = (q.where || []).map((c) => compile(c, zones, unknown));
  const pool = rounds.filter((r) => r.hasTicks && sideOk(r, q.side) && buyOk(r.ownEcon, q.buy) && buyOk(r.oppEcon, q.vs_buy));
  const matched = pool.filter((r) => tests.every((t) => t(r)));
  const groups = new Map();
  for (const r of matched) {
    const k = groupKey(r, q.group_by);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    // The pool in words, so a count is never compared with one taken over different rounds.
    counted: `${q.side && q.side !== 'any' ? `${q.side} side` : 'both sides'}, their buy ${q.buy || 'any'}, opponent buy ${q.vs_buy || 'any'}, rounds with positions`,
    considered: pool.length,
    matched: matched.length,
    share: pct(matched.length, pool.length),
    won: matched.filter((r) => r.won).length,
    groups: [...groups.entries()]
      .map(([key, list]) => ({ key, rounds: list.length, share: pct(list.length, matched.length), won: list.filter((r) => r.won).length }))
      .sort((a, b) => b.rounds - a.rounds || String(a.key).localeCompare(String(b.key))),
    unknownZones: [...unknown],
    files: matched.slice(0, MAX_FILES).map((r) => r.file),
    // The matched rounds as match and number, so a tool can name them and the model can open one.
    refs: matched.slice(0, MAX_FILES).map((r) => ({ demoId: r.demoId, round: r.round, won: Boolean(r.won) }))
  };
}
