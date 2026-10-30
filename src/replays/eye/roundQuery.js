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
//   { "any": [ condition, ... ] }       at least one of them holds
//
// players_in, utility, kill and first_kill take "region": 1, a place the user
// drew on the map (mapRegions.js), where they take "zone" or along with it. A
// region is tested on the point itself (where a grenade landed, where a player
// stood), so it needs no zone network. Their who and by also take "T" or "CT",
// whichever side the team read was on.
//
// players_in, utility and kill can take their window around the moment the
// team got onto a site instead of the round clock: "around": "entry" with
// "before" and "after" in seconds ({"players_in":{"zone":"A","around":"entry",
// "before":15,"after":15}} is "someone in A within 15 s of the entry"). The
// entry is the first second 2+ of the team stood on a site; a round with no
// entry never matches. "entry_site": "A"|"B" asks for an entry on that site.
//
// A zone is any name the map's zone network has: a position ("Silo"), a zone
// that groups positions, or an area. Unknown names are reported back so the
// model can look the map's names up and try again, rather than silently
// matching nothing.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { classifyPace, paceSite } from '../analytics/antistratScan.js';
import { inRegion } from './mapRegions.js';

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
const KINDS = new Set(['not', 'any', 'players_in', 'utility', 'kill', 'first_kill', 'site', 'plant', 'won', 'pace']);

/**
 * Small models drop the wrapper and write `{ "zone": "Silo", "min": 1 }` for
 * `{ "players_in": { ... } }`, or `{ "type": "smoke", ... }` for utility. The
 * intent is unambiguous, so it is read the way it was meant.
 */
export function normalizeCondition(cond) {
  const keys = Object.keys(cond);
  if (keys.length === 1 && KINDS.has(keys[0])) return cond;
  if (keys.some((k) => KINDS.has(k))) {
    const kind = keys.find((k) => KINDS.has(k));
    return { [kind]: cond[kind] };
  }
  if ('type' in cond && ['smoke', 'molotov', 'flash', 'he', 'any'].includes(cond.type)) return { utility: cond };
  if ('zone' in cond || 'region' in cond) return { players_in: cond };
  return cond;
}

/** Can a condition be told from where a round's grenades landed, without its movement? */
export function grenadeOnly(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const [kind, arg] = Object.entries(normalizeCondition(raw))[0] || [];
  if (kind === 'utility') return arg?.region != null && !arg.zone && !arg.around;
  if (kind === 'not') return grenadeOnly(arg);
  if (kind === 'any') return Array.isArray(arg) && arg.length > 0 && arg.every(grenadeOnly);
  return false;
}

/** Every region number a where list names. */
export function regionsNamed(where) {
  const out = new Set();
  const walk = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    const [kind, arg] = Object.entries(normalizeCondition(raw))[0] || [];
    if (kind === 'not') walk(arg);
    else if (kind === 'any' && Array.isArray(arg)) arg.forEach(walk);
    else if (arg?.region != null) out.add(Number(arg.region));
  };
  (Array.isArray(where) ? where : []).forEach(walk);
  return [...out];
}

/**
 * The map a where list's regions are on, or '' when it names none. A region that was never drawn, one
 * on another map, or two on different maps are said here: tested anyway, they would match nothing.
 */
export function regionMap(where, regions = [], mapCode = '') {
  const named = regionsNamed(where);
  const maps = new Set();
  for (const id of named) {
    const hit = regions.find((r) => r.id === id);
    if (!hit) throw new QueryError(`There is no region ${id}. ${regions.length ? `The user drew ${regions.map((r) => r.id).join(', ')}.` : 'The user has drawn none.'}`);
    maps.add(hit.map);
  }
  if (maps.size > 1) throw new QueryError(`Regions ${named.join(', ')} are on different maps: one query can use one map's regions.`);
  const [map = ''] = maps;
  if (map && mapCode && map !== mapCode) throw new QueryError(`Region ${named[0]} was drawn on ${map}, not ${mapCode}.`);
  return map;
}

function compile(raw, zones, unknown, regions = []) {
  if (!raw || typeof raw !== 'object') throw new QueryError('A condition must be an object.');
  const cond = normalizeCondition(raw);
  const [kind, arg] = Object.entries(cond)[0] || [];
  const regionOf = (a) => {
    if (a?.region === undefined || a?.region === null) return null;
    const hit = regions.find((r) => r.id === Number(a.region));
    if (!hit) throw new QueryError(`There is no region ${a.region}. ${regions.length ? `The user drew ${regions.map((r) => r.id).join(', ')}.` : 'The user has drawn none.'}`);
    return hit;
  };
  /** Is this `who` the team read in this round? */
  const isOurs = (who, r) => who === 'team' || who === r.side;
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
    if (v === 't' || v === 'ct') return v.toUpperCase();
    throw new QueryError(`"who" is "team", "opponent", "T" or "CT", not "${w}".`);
  };
  /** The condition's window for a round, as [from, to] seconds since the round went live, or null (no entry). */
  const windowOf = (a) => {
    const around = String(a?.around || '').toLowerCase();
    if (around && around !== 'entry') throw new QueryError('"around" is "entry" (the moment the team got onto a site).');
    if (around === 'entry') {
      const secs = (v, name) => {
        if (v === undefined || v === null || v === '') return 10;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new QueryError(`"${name}" is a number of seconds, for example 15.`);
        return Math.min(n, ROUND_SECONDS);
      };
      const before = secs(a.before, 'before');
      const after = secs(a.after, 'after');
      const site = a.entry_site ? String(a.entry_site).toLowerCase() : '';
      if (site && site !== 'a' && site !== 'b') throw new QueryError('"entry_site" is "A" or "B".');
      return (r) => {
        const e = typeof r.siteEntry === 'function' ? r.siteEntry(2) : null;
        if (!e || (site && e.site !== site)) return null;
        const at = ROUND_SECONDS - e.clock;
        return [at - before, at + after];
      };
    }
    // A region with no clock named takes the whole round: a smoke thrown after a late plant still landed there.
    const whole = a?.region != null;
    const from = a?.from == null && whole ? -Infinity : elapsedOfClock(a?.from, 0);
    const to = a?.to == null && whole ? Infinity : elapsedOfClock(a?.to, ROUND_SECONDS);
    const fixed = from <= to ? [from, to] : [to, from];
    return () => fixed;
  };
  switch (kind) {
    case 'not': {
      const inner = compile(arg, zones, unknown, regions);
      return (r) => !inner(r);
    }
    case 'any': {
      if (!Array.isArray(arg) || !arg.length) throw new QueryError('"any" is a list of conditions.');
      const tests = arg.map((c) => compile(c, zones, unknown, regions));
      return (r) => tests.some((t) => t(r));
    }
    case 'players_in': {
      const set = zoneSet(arg?.zone);
      const region = regionOf(arg);
      if (!set && !region) throw new QueryError('players_in needs a zone.');
      const who = whoOf(arg.who);
      const min = Number.isFinite(arg.min) ? arg.min : 1;
      const max = Number.isFinite(arg.max) ? arg.max : 5;
      const win = windowOf(arg);
      return (r) => {
        const w = win(r);
        if (!w) return false;
        const [from, to] = w;
        for (const s of r.series || []) {
          if (s.elapsed < from) continue;
          if (s.elapsed > to) break;
          const pts = isOurs(who, r) ? s.pts : s.opp || [];
          let n = 0;
          for (const p of pts) if ((!set || (p.pos && set.has(p.pos))) && (!region || inRegion(region, p.x, p.y, p.z))) n++;
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
      const region = regionOf(arg);
      const min = Number.isFinite(arg?.min) ? arg.min : 1;
      const win = windowOf(arg);
      return (r) => {
        const w = win(r);
        if (!w) return false;
        const [from, to] = w;
        const list = isOurs(who, r) ? r.nades : r.enemyNades || [];
        let n = 0;
        for (const g of list) {
          const t = Number.isFinite(g.throwAt) ? g.throwAt : g.at;
          if (t < from || t > to) continue;
          if (type && g.type !== type) continue;
          if (set && !set.has(g.zone) && !set.has(g.label)) continue;
          if (region && !inRegion(region, g.x, g.y, g.z)) continue;
          n++;
        }
        return n >= min;
      };
    }
    case 'kill': {
      const by = whoOf(arg?.by);
      const set = zoneSet(arg?.zone);
      const region = regionOf(arg);
      const min = Number.isFinite(arg?.min) ? arg.min : 1;
      const win = windowOf(arg);
      return (r) => {
        const w = win(r);
        if (!w) return false;
        const [from, to] = w;
        return r.kills.filter((k) => {
          const t = ROUND_SECONDS - k.clock;
          if (t < from || t > to) return false;
          if (isOurs(by, r) !== k.attackerOurs) return false;
          return placed(k, set, region);
        }).length >= min;
      };
    }
    case 'first_kill': {
      const by = whoOf(arg?.by);
      const set = zoneSet(arg?.zone);
      const region = regionOf(arg);
      return (r) => {
        const k = r.firstKill;
        if (!k || isOurs(by, r) !== k.attackerOurs) return false;
        return placed(k, set, region);
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

/** Did a kill happen on this ground? Either end of it counts: where the victim dropped or where the shooter stood. */
function placed(k, set, region) {
  if (set && !set.has(k.victimZone) && !set.has(k.attackerZone)) return false;
  return !region || inRegion(region, k.x, k.y, k.z) || inRegion(region, k.ax, k.ay);
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
  const tests = (q.where || []).map((c) => compile(c, zones, unknown, q.regions || []));
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
