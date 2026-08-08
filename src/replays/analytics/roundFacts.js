// ---------------------------------------------------------------------------
// Round library: the facts one round hands to the round-type classifiers.
//
// A round type ("A Fake", "Lobby crunch") is a statement about what one side
// did: which utility landed where, how many bodies went which way, and when.
// This module reduces a round file (meta + ticks) to exactly those questions,
// once, for BOTH sides — the scouted team is T in half its rounds and CT in
// the other half, and a report has to measure a call from both ends.
//
// Geography is read by NAME against the map's region hierarchy. The round
// definitions are written the way a coach says them ("the A Anchor zone", "the
// A Main position"), and coaches do not keep positions and zones apart, so a
// name is resolved against positions, zones and areas alike and the union of
// the footprints wins. On stacked maps (Nuke) a body's floor comes from its
// world Z, so "down on the B layer" is a level test rather than a name.
//
// Times are seconds since the round went live. Clocks count down from 1:55,
// so 1:35 is 20 seconds in — `clockAt` converts.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { pointInPiece } from '../zones/zoneGeom.js';
import { mapHasStackedFloors, regionLevelForZ } from '../zones/zoneLevel.js';
import { bombSitePieces } from '../zones/bombSites.js';
import { keyZonesFor } from '../zones/keyZones.js';
import { matchCoachSmoke } from '../coach/coachSmokes.js';
import { isGun } from '../viewer/equipmentIcons.js';

/** Seconds between position samples. */
export const SAMPLE_SECONDS = 1;
/** A detonation takes a stored spot's name within this many units of it. */
export const UTILITY_MATCH_UNITS = 250;
/** How long a smoke stays up, for the rules that ask "while it is up". */
export const SMOKE_SECONDS = 18;

const NADE_KINDS = new Set(['smokegrenade', 'molotov', 'flashbang', 'hegrenade']);

/** "1:35" -> 20 seconds after the round went live. */
export function secondsAtClock(clock) {
  const m = /^(\d+)[:.](\d{1,2})$/.exec(String(clock || '').trim());
  if (!m) return null;
  return ROUND_SECONDS - (Number(m[1]) * 60 + Number(m[2]));
}

/** 20 seconds in -> "1:35". Negative or past the end clamps to the range. */
export function clockAt(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const left = Math.max(0, Math.min(ROUND_SECONDS, Math.round(ROUND_SECONDS - seconds)));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function normNade(type) {
  const t = String(type || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  if (t === 'incgrenade' || t === 'firebomb' || t === 'inferno') return 'molotov';
  return t;
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Separator inside cache keys, so ['A','BC'] never collides with ['AB','C']. */
const SEP = '\u0001';

// ---------------------------------------------------------------------------
// Named regions
// ---------------------------------------------------------------------------

/**
 * Resolve region names to the positions they cover.
 *
 * A name is looked up as a position, as a zone, and as an area, and everything
 * it hits contributes its footprint. That is deliberate: the definitions call
 * the same ground "the Lobby zone" in one line and "the Lobby position" in the
 * next, and a classifier that insisted on the distinction would silently never
 * fire on a map painted the other way round.
 *
 * @param {{positions?: Array, zones?: Array, areas?: Array}} network
 */
export function createRegionIndex(network, mapCode = '') {
  const positions = Array.isArray(network?.positions) ? network.positions : [];
  const zones = Array.isArray(network?.zones) ? network.zones : [];
  const areas = Array.isArray(network?.areas) ? network.areas : [];
  const byId = new Map(positions.map((p) => [p.id, p]));
  const stacked = mapHasStackedFloors(mapCode);

  /** @type {Map<string, Array>} name key -> position records */
  const cache = new Map();

  /** Position records covered by one name (position, zone or area). */
  function positionsNamed(name) {
    const want = norm(name);
    if (!want) return [];
    const out = new Map();
    for (const p of positions) {
      if (norm(p.name) === want) out.set(p.id, p);
    }
    for (const z of zones) {
      if (norm(z.name) !== want) continue;
      for (const id of z.positionIds || []) {
        const p = byId.get(id);
        if (p) out.set(p.id, p);
      }
    }
    for (const a of areas) {
      if (norm(a.name) !== want) continue;
      for (const zid of a.zoneIds || []) {
        const z = zones.find((x) => x.id === zid);
        for (const id of z?.positionIds || []) {
          const p = byId.get(id);
          if (p) out.set(p.id, p);
        }
      }
    }
    return [...out.values()];
  }

  /** Position records covered by any of the names, cached by the name list. */
  function resolve(names) {
    const list = Array.isArray(names) ? names : [names];
    const key = list.map(norm).sort().join(SEP);
    if (cache.has(key)) return cache.get(key);
    const out = new Map();
    for (const name of list) {
      for (const p of positionsNamed(name)) out.set(p.id, p);
    }
    const value = [...out.values()];
    cache.set(key, value);
    return value;
  }

  /** True when the world point falls inside any position of `names`. */
  function inside(names, x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const list = resolve(names);
    if (!list.length) return false;
    const level = stacked ? regionLevelForZ(mapCode, z) : null;
    for (const pos of list) {
      if (level && (pos.level || 'default') !== level) continue;
      for (const piece of pos.pieces || []) {
        if (pointInPiece(x, y, piece)) return true;
      }
    }
    return false;
  }

  /** True when every listed name resolves to at least one painted position. */
  function known(names) {
    const list = Array.isArray(names) ? names : [names];
    return list.some((n) => positionsNamed(n).length > 0);
  }

  /** The floor a world Z sits on ('default' on maps without a split). */
  function levelOf(z) {
    return stacked ? regionLevelForZ(mapCode, z) : 'default';
  }

  /**
   * The bombsite polygon and the key zones around it, which are painted in the
   * Sites editor rather than the region hierarchy and so have no names to
   * resolve. "On the A site or the key zones near it" is one of the CT setups,
   * and it is the only way to ask that question.
   */
  const siteCache = new Map();
  function sitePieces(letter) {
    const key = String(letter || 'a').toLowerCase();
    if (!siteCache.has(key)) {
      siteCache.set(key, [
        ...bombSitePieces(network, key, { mapCode }),
        ...keyZonesFor(network, key)
      ]);
    }
    return siteCache.get(key);
  }

  /** True inside the bombsite polygon or one of its key zones. */
  function insideSite(letter, x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const level = stacked ? regionLevelForZ(mapCode, z) : null;
    for (const piece of sitePieces(letter)) {
      if (level && (piece.level || 'default') !== level) continue;
      if (pointInPiece(x, y, piece)) return true;
    }
    return false;
  }

  return { inside, insideSite, known, levelOf, resolve, stacked };
}

// ---------------------------------------------------------------------------
// Per-side facts
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SideNade
 * @property {string} type   smokegrenade | molotov | flashbang | hegrenade
 * @property {string} name   stored utility name ('' when unmatched)
 * @property {string} player thrower id
 * @property {number} at     detonation seconds after the round went live
 * @property {number} thrown throw seconds
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * @typedef {object} SideFacts
 * @property {'T'|'CT'} side
 * @property {1|2} teamIdx
 * @property {SideNade[]} nades
 * @property {(names: string[], sec: number) => number} countIn
 * @property {(names: string[], sec: number) => Set<string>} playersIn
 * @property {(names: string[], from: number, to: number) => Set<string>} playersDuring
 * @property {(names: string[], min: number, from?: number, to?: number) => number|null} firstSecWith
 */

function seriesSample(series, sec) {
  if (!series.length) return null;
  const i = Math.round(sec / SAMPLE_SECONDS);
  if (i < 0) return series[0];
  return series[Math.min(series.length - 1, i)];
}

/**
 * Reduce one round to per-side facts.
 *
 * @param {object} args
 * @param {object} args.meta      round meta (events, players, timing)
 * @param {import('../tickStore.js').TickTrack|null} args.track
 * @param {object|null} args.network   region hierarchy for the map
 * @param {Array} [args.utilities]     stored utility spots (named landings)
 * @param {string} args.mapCode
 * @returns {{ mapCode: string, regions: object, T: SideFacts, CT: SideFacts }|null}
 */
export function buildRoundFacts({ meta, track, network, utilities = [], mapCode }) {
  if (!meta || !track) return null;
  const timing = timingFor(meta);
  const tickRate = timing.tickRate || 64;
  const t0 = timing.freezeEndTick;
  const endTick = Math.min(timing.endTick, t0 + ROUND_SECONDS * tickRate);
  const lastSec = Math.max(0, (endTick - t0) / tickRate);
  const secOf = (tick) => (tick - t0) / tickRate;

  const regions = createRegionIndex(network, mapCode);
  const roster = meta.players || [];
  const sideOfTeam = {
    1: meta.team1Side === 'CT' ? 'CT' : 'T',
    2: meta.team2Side === 'CT' ? 'CT' : 'T'
  };
  const teamOf = new Map(roster.map((p) => [p.id, p.team]));
  const sideOf = new Map(roster.map((p) => [p.id, sideOfTeam[p.team] || '']));
  const weapons = (meta.weapons || []).map((w) => norm(w).replace(/^weapon_/, ''));

  // Death ticks, so a body stops counting toward "players in the zone" once it
  // drops. Where it fell still matters to the definitions that count fights,
  // which read the kill list rather than the samples.
  const deadAt = new Map();
  for (const k of meta.events?.kills || []) {
    if (k.victim && !deadAt.has(k.victim)) deadAt.set(k.victim, k.tick || 0);
  }

  // One pass over the ticks builds the sample series for all ten players.
  /** @type {Array<{ sec: number, pts: Array<{ id: string, side: string, x: number, y: number, z: number, awp: boolean }> }>} */
  const series = [];
  const states = [];
  for (let tick = t0; tick <= endTick; tick += SAMPLE_SECONDS * tickRate) {
    track.sampleAll(tick, states);
    const pts = [];
    for (const p of roster) {
      const s = states[p.slot];
      if (!s || !s.alive) continue;
      if (deadAt.has(p.id) && deadAt.get(p.id) <= tick) continue;
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      pts.push({
        id: p.id,
        side: sideOf.get(p.id) || '',
        x: s.x,
        y: s.y,
        z: s.z,
        awp: weapons[s.weapon] === 'awp'
      });
    }
    series.push({ sec: secOf(tick), pts });
  }

  // Grenades, named against the stored utility spots.
  /** @type {{ T: SideNade[], CT: SideNade[] }} */
  const nadesBySide = { T: [], CT: [] };
  for (const g of meta.events?.grenades || []) {
    const type = normNade(g.type);
    if (!NADE_KINDS.has(type)) continue;
    const side = sideOf.get(g.player);
    if (side !== 'T' && side !== 'CT') continue;
    const x = Number(g.at?.x);
    const y = Number(g.at?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const detTick = Number(g.detonateTick ?? g.throwTick);
    if (!Number.isFinite(detTick)) continue;
    const spot = utilities?.length
      ? matchCoachSmoke(utilities, x, y, UTILITY_MATCH_UNITS, type)
      : null;
    nadesBySide[side].push({
      type,
      name: norm(spot?.name),
      player: g.player,
      at: secOf(detTick),
      thrown: secOf(Number(g.throwTick ?? detTick)),
      x,
      y,
      z: Number(g.at?.z) || 0,
      // Where it was released, for the rules that ask who threw it from where.
      fx: Number.isFinite(g.from?.x) ? g.from.x : null,
      fy: Number.isFinite(g.from?.y) ? g.from.y : null,
      fz: Number(g.from?.z) || 0
    });
  }
  for (const side of ['T', 'CT']) nadesBySide[side].sort((a, b) => a.at - b.at);

  // Cross-side contacts: kills and damage, each stamped with where the loser
  // stood. "Took a fight with a player in Lobby" is a damage question, and the
  // damage list is the only place a non-fatal exchange survives.
  const contacts = [];
  const pushContact = (tick, attacker, victim, weapon, kill = false) => {
    const aSide = sideOf.get(attacker);
    const vSide = sideOf.get(victim);
    if (!aSide || !vSide || aSide === vSide) return;
    contacts.push({
      sec: secOf(tick),
      attacker,
      victim,
      aSide,
      vSide,
      weapon: String(weapon || ''),
      kill,
      // "Damage without grenades, or death to gunfire" needs the two apart:
      // a molotov ticking on someone is not taking a fight with them.
      gun: isGun(weapon)
    });
  };
  for (const k of meta.events?.kills || []) {
    if (k.attacker && k.victim) pushContact(k.tick || 0, k.attacker, k.victim, k.weapon, true);
  }
  for (const d of meta.events?.damage || []) {
    if (d.attacker && d.victim) pushContact(d.tick || 0, d.attacker, d.victim, d.weapon);
  }
  contacts.sort((a, b) => a.sec - b.sec);

  /**
   * Where a player stood at a moment.
   *
   * Falls back to the last sample they appear in, because the caller that
   * needs this most is "was the man you killed standing in Lobby" — and by the
   * sample nearest the kill he is already off the series.
   */
  function pointAt(id, sec) {
    const sample = seriesSample(series, sec);
    const now = sample?.pts.find((p) => p.id === id);
    if (now) return now;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].sec > sec) continue;
      const was = series[i].pts.find((p) => p.id === id);
      if (was) return was;
    }
    return null;
  }

  function makeSide(side) {
    const teamIdx = sideOfTeam[1] === side ? 1 : 2;
    const ids = roster.filter((p) => teamOf.get(p.id) === teamIdx).map((p) => p.id);
    const idSet = new Set(ids);

    /** Our bodies alive at `sec`. Cached: every predicate below starts here. */
    const ptsCache = new Map();
    function ptsAt(sec) {
      if (ptsCache.has(sec)) return ptsCache.get(sec);
      const pts = (seriesSample(series, sec)?.pts || []).filter((p) => idSet.has(p.id));
      ptsCache.set(sec, pts);
      return pts;
    }

    /**
     * Ids of ours standing inside `names` at `sec`.
     *
     * Memoized, because the definitions ask this in nested loops — a staged
     * push walks the series once per candidate start second, and every pass
     * re-asks who was standing where. The answer cannot change mid-round.
     */
    const occupancy = new Map();
    function playersIn(names, sec) {
      const key = `${(Array.isArray(names) ? names : [names]).join(SEP)}@${sec}`;
      const hit = occupancy.get(key);
      if (hit) return new Set(hit);
      const out = new Set();
      for (const p of ptsAt(sec)) {
        if (regions.inside(names, p.x, p.y, p.z)) out.add(p.id);
      }
      occupancy.set(key, out);
      return new Set(out);
    }

    const countIn = (names, sec) => playersIn(names, sec).size;

    /** Ids of ours that were inside `names` at any sample in [from, to]. */
    function playersDuring(names, from, to) {
      const out = new Set();
      for (const s of series) {
        if (s.sec < from || s.sec > to) continue;
        for (const p of s.pts) {
          if (!idSet.has(p.id)) continue;
          if (regions.inside(names, p.x, p.y, p.z)) out.add(p.id);
        }
      }
      return out;
    }

    /** First second in [from, to] with `min`+ of ours inside `names`. */
    function firstSecWith(names, min, from = 0, to = lastSec) {
      for (const s of series) {
        if (s.sec < from || s.sec > to) continue;
        if (countIn(names, s.sec) >= min) return s.sec;
      }
      return null;
    }

    /** Ids of ours standing on the lower floor at `sec`. */
    function playersLower(sec) {
      const out = new Set();
      if (!regions.stacked) return out;
      for (const p of ptsAt(sec)) {
        if (regions.levelOf(p.z) === 'lower') out.add(p.id);
      }
      return out;
    }

    /** How many of ours are alive at `sec`. */
    const aliveCount = (sec) => ptsAt(sec).length;

    /** Ids of ours inside the bombsite polygon or its key zones at `sec`. */
    function playersInSite(letter, sec) {
      const out = new Set();
      for (const p of ptsAt(sec)) {
        if (regions.insideSite(letter, p.x, p.y, p.z)) out.add(p.id);
      }
      return out;
    }

    /**
     * Players of ours who were on `fromNames` and later on `toNames`, both
     * inside the window. "Went through FalleN into B" is this question, and it
     * is not the same as "was in B": the route is the call.
     *
     * @returns {Array<{ id: string, leftAt: number, arrivedAt: number }>}
     */
    function transitions(fromNames, toNames, { from = 0, to = lastSec } = {}) {
      /** @type {Map<string, number>} id -> last second seen on the way in */
      const seen = new Map();
      /** @type {Map<string, { id: string, leftAt: number, arrivedAt: number }>} */
      const done = new Map();
      for (const s of series) {
        if (s.sec < from || s.sec > to) continue;
        for (const p of s.pts) {
          if (!idSet.has(p.id)) continue;
          if (regions.inside(fromNames, p.x, p.y, p.z)) {
            if (!done.has(p.id)) seen.set(p.id, s.sec);
            continue;
          }
          if (!seen.has(p.id) || done.has(p.id)) continue;
          if (regions.inside(toNames, p.x, p.y, p.z)) {
            done.set(p.id, { id: p.id, leftAt: seen.get(p.id), arrivedAt: s.sec });
          }
        }
      }
      return [...done.values()].sort((a, b) => a.arrivedAt - b.arrivedAt);
    }

    /**
     * A group of `min` of ours all within `radius` of each other at `sec`.
     * Greedy from each player outward, which is enough for the trio-sized
     * groups the definitions ask about.
     */
    function cluster(min, radius, sec) {
      const pts = ptsAt(sec);
      for (let i = 0; i < pts.length; i++) {
        const group = [pts[i]];
        for (let j = 0; j < pts.length; j++) {
          if (j === i) continue;
          const near = group.every(
            (g) => Math.hypot(g.x - pts[j].x, g.y - pts[j].y) <= radius
          );
          if (near) group.push(pts[j]);
        }
        if (group.length >= min) return new Set(group.map((p) => p.id));
      }
      return null;
    }

    /** Detonations of ours of `type` that landed inside `names`. */
    function nadesIn(type, names) {
      return nadesBySide[side].filter(
        (n) => (!type || n.type === type) && regions.inside(names, n.x, n.y, n.z)
      );
    }

    /** Detonations of ours of `type` released from inside `names`. */
    function nadesFrom(type, names) {
      return nadesBySide[side].filter(
        (n) =>
          (!type || n.type === type) &&
          n.fx !== null &&
          regions.inside(names, n.fx, n.fy, n.fz)
      );
    }

    /** Detonations of ours of `type` that landed OUTSIDE `names`. */
    function nadesNotIn(type, names) {
      return nadesBySide[side].filter(
        (n) => (!type || n.type === type) && !regions.inside(names, n.x, n.y, n.z)
      );
    }

    /** Detonations of ours carrying a stored spot name. */
    function nadesNamed(name) {
      const want = norm(name);
      return nadesBySide[side].filter((n) => n.name === want);
    }

    /**
     * Fights this side had with the other.
     *
     * @param {object} [opts]
     * @param {number} [opts.from]
     * @param {number} [opts.to]
     * @param {string[]} [opts.enemyIn]  only fights against a body standing here
     * @param {Set<string>} [opts.ours]  only fights taken by these players
     * @param {boolean} [opts.gunOnly]   drop grenade damage
     * @param {boolean} [opts.killsOnly] only fatal contacts
     * @param {'a'|'b'} [opts.enemyInSite]  enemy on that bombsite or its key zones
     */
    function fights({
      from = 0,
      to = lastSec,
      enemyIn = null,
      ours = null,
      gunOnly = false,
      killsOnly = false,
      enemyInSite = null
    } = {}) {
      const out = [];
      for (const c of contacts) {
        if (c.sec < from || c.sec > to) continue;
        if (gunOnly && !c.gun) continue;
        if (killsOnly && !c.kill) continue;
        const ourId = c.aSide === side ? c.attacker : c.vSide === side ? c.victim : '';
        if (!ourId || !idSet.has(ourId)) continue;
        if (ours && !ours.has(ourId)) continue;
        const enemyId = c.aSide === side ? c.victim : c.attacker;
        if (enemyIn || enemyInSite) {
          const at = pointAt(enemyId, c.sec);
          if (!at) continue;
          const hit =
            (enemyIn && regions.inside(enemyIn, at.x, at.y, at.z)) ||
            (enemyInSite && regions.insideSite(enemyInSite, at.x, at.y, at.z));
          if (!hit) continue;
        }
        out.push({
          sec: c.sec,
          ours: ourId,
          enemy: enemyId,
          gun: c.gun,
          kill: c.kill,
          killedThem: c.kill && c.attacker === ourId
        });
      }
      return out;
    }

    /** True when this player had an AWP out at `sec`. */
    function heldAwp(id, sec) {
      return ptsAt(sec).some((p) => p.id === id && p.awp);
    }

    /** Seconds into the round this player died, or null if they survived. */
    function deathSec(id) {
      return deadAt.has(id) ? secOf(deadAt.get(id)) : null;
    }

    /** The id that held an AWP for the most samples up to `to`, or ''. */
    function awper(to = lastSec) {
      const held = new Map();
      for (const s of series) {
        if (s.sec > to) break;
        for (const p of s.pts) {
          if (idSet.has(p.id) && p.awp) held.set(p.id, (held.get(p.id) || 0) + 1);
        }
      }
      let best = '';
      let bestN = 0;
      for (const [id, n] of held) {
        if (n > bestN) {
          best = id;
          bestN = n;
        }
      }
      return best;
    }

    return {
      side,
      teamIdx,
      ids,
      lastSec,
      nades: nadesBySide[side],
      series,
      regions,
      ptsAt,
      pointAt,
      playersIn,
      countIn,
      playersDuring,
      playersLower,
      playersInSite,
      transitions,
      cluster,
      firstSecWith,
      aliveCount,
      nadesIn,
      nadesFrom,
      nadesNotIn,
      nadesNamed,
      fights,
      awper,
      heldAwp,
      deathSec,
      /** Every death of ours, in order, as seconds. */
      deaths: roster
        .filter((p) => idSet.has(p.id) && deadAt.has(p.id))
        .map((p) => secOf(deadAt.get(p.id)))
        .sort((a, b) => a - b)
    };
  }

  const T = makeSide('T');
  const CT = makeSide('CT');
  // Some calls are defined by what the OTHER side did — "no bblock smoke was
  // thrown by CTs" is a T-side round type — so each side can reach across.
  T.enemy = CT;
  CT.enemy = T;
  return { mapCode, regions, lastSec, T, CT };
}

// ---------------------------------------------------------------------------
// Shared predicates the definitions lean on
// ---------------------------------------------------------------------------

/**
 * Earliest window of `span` seconds holding at least the required count from
 * every group. "All of this in quick succession" is exactly this question, and
 * every group has to be satisfied by events inside the SAME window, not by
 * three windows that happen to each contain one thing.
 *
 * @param {Array<{ need: number, times: number[] }>} groups
 * @param {number} span  seconds
 * @returns {{ start: number, end: number }|null}
 */
export function burstWindow(groups, span) {
  if (!groups.length) return null;
  for (const g of groups) {
    if (!Array.isArray(g.times) || g.times.length < g.need) return null;
  }
  // Only a window that starts on an actual event can be the earliest one.
  const starts = [...new Set(groups.flatMap((g) => g.times))].sort((a, b) => a - b);
  for (const start of starts) {
    const end = start + span;
    let ok = true;
    for (const g of groups) {
      if (g.times.filter((t) => t >= start && t <= end).length < g.need) {
        ok = false;
        break;
      }
    }
    if (ok) {
      // Report the window the events actually occupy, not the nominal span.
      const inside = groups.flatMap((g) => g.times.filter((t) => t >= start && t <= end));
      return { start, end: Math.max(...inside) };
    }
  }
  return null;
}

/** Longest run of consecutive samples in [from, to] where `test(sec)` holds. */
export function longestRun(series, from, to, test) {
  let best = 0;
  let run = 0;
  let bestStart = null;
  let start = null;
  for (const s of series) {
    if (s.sec < from || s.sec > to) continue;
    if (test(s.sec)) {
      if (start === null) start = s.sec;
      run += SAMPLE_SECONDS;
      if (run > best) {
        best = run;
        bestStart = start;
      }
    } else {
      run = 0;
      start = null;
    }
  }
  return { seconds: best, start: bestStart };
}
