// ---------------------------------------------------------------------------
// replays/analytics/antistratReads.js
// The questions the summary asks of one round, answered once.
//
// antistratScan.js reduces a round to its samples, kills and grenades. This
// file reads them the way an analyst watching the round would: where the hit
// went in and from where, who was alone, whose utility the other team could
// see coming, who boosted whom, which smokes got walked through. Every read is
// memoised on the round, so the sections that share one (the tells, the round
// types and the site rounds all ask "where did they enter") agree with each
// other by construction.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { pieceBounds } from '../zones/zoneGeom.js';
import { clockSeconds, FORMATIONS } from './patternDefs.js';
import { classifyPace, nadeLabel, paceSite } from './antistratScan.js';

/** Teammates within this of each other are together; past it a player is alone. */
export const ALONE_UNITS = 600;
/** A player this far from the rest of the team at the commit is lurking. */
export const LURK_UNITS = 1200;

/**
 * A grenade on a site's key ground only tells the other team something when it
 * comes well before the round does: this long before the plant...
 */
export const SITE_TELL_PLANT_LEAD = 15;
/** ...and with this long before the next kill, so it is seen, not fought through. */
export const SITE_TELL_KILL_GAP = 5;
/** CT utility up by 1:20 is what the Ts get to read their setup from. */
const CT_READ_BY = 35;
/** Smokes stand this long; a player inside one is walking through it. */
const SMOKE_SECONDS = 18;
const SMOKE_RADIUS = 140;
/** A body standing on a teammate's head: this close sideways, this much higher. */
const BOOST_XY = 42;
const BOOST_DZ = [45, 85];

const cache = new WeakMap();
function memo(r, key, fn) {
  let m = cache.get(r);
  if (!m) cache.set(r, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}

const median = (list) => {
  const s = list.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export { median };

function bump(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function inPieces(x, y, pieces) {
  for (const p of pieces || []) {
    const b = pieceBounds(p);
    if (b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return true;
  }
  return false;
}

/** Which lane (notation index) a named position belongs to, or -1. */
export function laneOfPos(pos, laneSets) {
  if (!laneSets || !pos) return -1;
  const key = String(pos).toLowerCase();
  return laneSets.findIndex((s) => s.has(key));
}

/** The sample nearest a number of seconds into the live round. */
export function sampleAtElapsed(r, elapsed) {
  return r.sampleAt(r.t0 + elapsed * r.tickRate);
}

/** Seconds since the round went live, from a tick. */
export const elapsedOfTick = (r, tick) => (tick - r.t0) / r.tickRate;

/** Seconds since the round went live at which a grenade left the hand. */
export const throwElapsed = (n) =>
  Number.isFinite(n.throwAt) ? n.throwAt : Number.isFinite(n.clock) ? ROUND_SECONDS - n.clock : n.at;

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

/**
 * The moment a round commits, in seconds since it went live: two players on a
 * site, the plant, or failing both the first kill.
 */
export function commitElapsed(r) {
  return memo(r, 'commit', () => {
    const entry = r.siteEntry(2);
    if (entry) return ROUND_SECONDS - entry.clock;
    if (Number.isFinite(r.plantClock)) return ROUND_SECONDS - r.plantClock;
    if (Number.isFinite(r.firstKill?.clock)) return ROUND_SECONDS - r.firstKill.clock;
    return null;
  });
}

/** The site a round went to: T the hit, CT the hit they faced. Upper case or ''. */
export function roundSite(r) {
  return ((r.side === 'T' ? paceSite(r) : r.hitSite) || '').toUpperCase();
}

const plantElapsed = (r) => (Number.isFinite(r.plantClock) ? ROUND_SECONDS - r.plantClock : null);

// ---------------------------------------------------------------------------
// Utility the other team could read the round from
// ---------------------------------------------------------------------------

/**
 * Our utility that was a read rather than part of the hit.
 *
 * Utility in the middle of the map (outside every site's key ground) can serve
 * either site, so it counts whenever it went in before the round committed.
 * Utility on a site's key ground only counts when it was thrown well before
 * the plant and nothing died for a few seconds after it: that is utility the
 * defenders saw and had time to answer, not the execute itself.
 */
export function tellUtility(r) {
  return memo(r, 'tellUtility', () => {
    // On T the round commits when two step onto a site. On CT two of them
    // stand on a site from the start, so their reads are what is up by 1:20.
    const entry = r.side === 'T' ? r.siteEntry(2) : null;
    const entryAt = entry ? ROUND_SECONDS - entry.clock : r.side === 'CT' ? CT_READ_BY : null;
    const plantAt = plantElapsed(r);
    const killTimes = r.kills.map((k) => ROUND_SECONDS - k.clock).sort((a, b) => a - b);
    const out = [];
    for (const n of r.nades) {
      if (!nadeLabel(n)) continue;
      const t = throwElapsed(n);
      if (!Number.isFinite(t)) continue;
      if (!n.region) {
        if (entryAt !== null && t >= entryAt) continue;
        if (plantAt !== null && t >= plantAt) continue;
        out.push(n);
        continue;
      }
      if (plantAt !== null && t > plantAt - SITE_TELL_PLANT_LEAD) continue;
      const next = killTimes.find((k) => k > t);
      if (next !== undefined && next - t < SITE_TELL_KILL_GAP) continue;
      out.push(n);
    }
    return out;
  });
}

/** One tell feature per piece of utility: "label\0type". */
export const utilKey = (n) => `${nadeLabel(n)}\0${n.type}`;

// ---------------------------------------------------------------------------
// Where the hit came from
// ---------------------------------------------------------------------------

/**
 * The entry onto a site: which players stepped on within a few seconds of the
 * first two, and the ground each came from. A route is the named position a
 * player stood on just before the site; two routes in different lanes is a
 * split.
 *
 * @returns {null | { site: string, tick: number, elapsed: number, players: Array<{id: string, from: string, lane: number}>, routes: Map<string, number>, route: string, split: boolean }}
 */
export function entryOf(r, laneSets) {
  return memo(r, 'entry', () => {
    const e = r.siteEntry(2);
    if (!e || !r.series.length) return null;
    const pieces = r.sitePieces?.[e.site] || [];
    const tr = r.tickRate;
    const firstOn = new Map();
    for (const s of r.series) {
      if (s.tick < e.tick - 2 * tr) continue;
      if (s.tick > e.tick + 8 * tr) break;
      for (const p of s.pts) {
        if (!firstOn.has(p.id) && inPieces(p.x, p.y, pieces)) firstOn.set(p.id, s.tick);
      }
    }
    // Three seconds back names the way in a sheet uses ("Upper", "Short");
    // one second back is only the doorway onto the site.
    const players = [];
    for (const [id, tick] of firstOn) {
      let from = '';
      for (const back of [3, 4, 2, 5, 6]) {
        if (from) break;
        const s = r.sampleAt(tick - back * tr);
        const p = s?.pts.find((x) => x.id === id);
        if (p && !inPieces(p.x, p.y, pieces) && p.pos) from = p.pos;
      }
      players.push({ id, from, lane: laneOfPos(from, laneSets) });
    }
    const routes = new Map();
    for (const p of players) bump(routes, p.from);
    const ranked = [...routes.entries()].sort((a, b) => b[1] - a[1]);
    const laneKey = (name) => {
      const l = laneOfPos(name, laneSets);
      return l >= 0 ? `lane${l}` : `pos:${name}`;
    };
    const lanesUsed = new Set(ranked.map(([name]) => laneKey(name)));
    return {
      site: e.site.toUpperCase(),
      tick: e.tick,
      elapsed: ROUND_SECONDS - e.clock,
      players,
      routes,
      route: ranked[0]?.[0] || '',
      split: lanesUsed.size >= 2 && ranked.length >= 2
    };
  });
}

/**
 * The site most of the team leaned towards ten seconds before the commit, or
 * '' when it was even. A lean that differs from the site hit is the round
 * that showed one side and went to the other.
 */
export function leanOf(r) {
  return memo(r, 'lean', () => {
    const commit = commitElapsed(r);
    if (commit === null) return '';
    const s = sampleAtElapsed(r, Math.max(5, commit - 10));
    if (!s) return '';
    const a = r.towardCount(s, 'a');
    const b = r.towardCount(s, 'b');
    if (Math.max(a, b) < 3 || a === b) return '';
    return a > b ? 'A' : 'B';
  });
}

/**
 * Lane counts ("2-1-2") read at the map's formation clock, or a second before
 * the first of ours died when that comes sooner, so a rush that lost a man
 * early still shows all five.
 */
export function formationOf(r, mapCode, laneSets) {
  return memo(r, `form:${mapCode}`, () => {
    const def = FORMATIONS[mapCode];
    if (!def || !laneSets || r.side !== 'T' || !r.series.length) return null;
    const snap = clockSeconds(def.snapshot || '');
    let at = snap === null ? 13 : ROUND_SECONDS - snap;
    // A rush or a pop is read two seconds before it hits: at the formation
    // clock a dust2 rush is still walking out of spawn.
    const pace = classifyPace(r);
    const commit = commitElapsed(r);
    if ((pace === 'rush' || pace === 'pop') && commit !== null) at = Math.max(at, commit - 2);
    // Everyone alive at the clock is read there; anyone who died before it is
    // read where they last stood, which is the lane they died in.
    const lastSeen = new Map();
    for (const s of r.series) {
      if (s.elapsed > at) break;
      if (s.elapsed < 4) continue;
      for (const p of s.pts) lastSeen.set(p.id, p);
    }
    if (!lastSeen.size) return null;
    const counts = laneSets.map(() => 0);
    for (const p of lastSeen.values()) {
      let hit = laneOfPos(p.pos, laneSets);
      if (hit === -1) hit = Math.min(1, laneSets.length - 1);
      counts[hit]++;
    }
    return counts;
  });
}

// ---------------------------------------------------------------------------
// CT shape
// ---------------------------------------------------------------------------

/** CT players on or in front of a site at 1:30: a stack is three or more. */
export function ctStackOf(r) {
  return memo(r, 'ctStack', () => {
    if (r.side !== 'CT') return '';
    const s = sampleAtElapsed(r, 25);
    if (!s) return '';
    const a = r.towardCount(s, 'a', 0);
    const b = r.towardCount(s, 'b', 0);
    if (a >= 3 && a > b) return 'A';
    if (b >= 3 && b > a) return 'B';
    return '';
  });
}

/** Where our AWP stood at a given point of the round, by named ground. */
export function awpSpotOf(r, elapsed = 20) {
  return memo(r, `awp:${elapsed}`, () => {
    const s = sampleAtElapsed(r, elapsed);
    return s?.pts.find((p) => p.awp)?.pos || '';
  });
}

/** Players of the other team on or near a site's ground in one sample. */
export function oppToward(r, sample, site, pad = 250) {
  if (!sample?.opp) return 0;
  let n = 0;
  for (const p of sample.opp) if (r.siteNear(p.x, p.y, pad) === site) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------

/**
 * One kill as an analyst would describe it: was the shooter moving or
 * holding, did a teammate's flash land on the victim just before, was a
 * teammate close by, and was the death traded.
 */
export function killRead(r, k) {
  return memo(r, `kill:${k.tick}:${k.victim}`, () => {
    const ours = k.attackerOurs;
    const tr = r.tickRate;
    const pick = (s) => (ours ? s?.pts : s?.opp)?.find((p) => p.id === k.attacker) || null;
    const now = pick(r.sampleAt(k.tick));
    const before = pick(r.sampleAt(k.tick - 2 * tr));
    const moved = now && before ? dist(now, before) : null;
    const pushing = moved !== null && moved >= 180;
    const at = now || (k.ax !== null ? { x: k.ax, y: k.ay } : null);
    const mates = at
      ? ((ours ? r.sampleAt(k.tick)?.pts : r.sampleAt(k.tick)?.opp) || []).filter(
          (p) => p.id !== k.attacker && dist(p, at) <= ALONE_UNITS
        ).length
      : 0;
    // A flash of the shooter's team that popped near the victim just before.
    const flashes = ours ? r.nades : r.enemyNades;
    const flashed =
      k.x !== null &&
      flashes.some(
        (n) =>
          n.type === 'flashbang' &&
          n.tick <= k.tick &&
          n.tick >= k.tick - 3 * tr &&
          Math.hypot(n.x - k.x, n.y - k.y) <= 900
      );
    const traded = r.kills.some((x) => x.victim === k.attacker && x.tick > k.tick && x.tick <= k.tick + 5 * tr);
    return { pushing, holding: moved !== null && moved < 80, mates, flashed, traded, awp: /awp/.test(k.weapon) };
  });
}

// ---------------------------------------------------------------------------
// Things players do
// ---------------------------------------------------------------------------

/**
 * Boosts: one of ours standing on a teammate for two samples running.
 * @returns {Array<{tick: number, elapsed: number, zone: string, top: string, bottom: string}>}
 */
export function boostsOf(r) {
  return memo(r, 'boosts', () => {
    const out = [];
    const open = new Map();
    for (const s of r.series) {
      const seen = new Set();
      for (const a of s.pts) {
        if (!Number.isFinite(a.z)) continue;
        for (const b of s.pts) {
          if (a === b || !Number.isFinite(b.z)) continue;
          const dz = a.z - b.z;
          if (dz < BOOST_DZ[0] || dz > BOOST_DZ[1]) continue;
          if (Math.hypot(a.x - b.x, a.y - b.y) > BOOST_XY) continue;
          const key = `${a.id}>${b.id}`;
          seen.add(key);
          const run = open.get(key) || { n: 0, first: s };
          run.n++;
          open.set(key, run);
          if (run.n === 2) {
            out.push({ tick: run.first.tick, elapsed: run.first.elapsed, zone: a.pos || b.pos, top: a.id, bottom: b.id });
          }
        }
      }
      for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
    }
    return out;
  });
}

/**
 * Walking through the other team's smokes while they stand.
 * @returns {Array<{tick: number, elapsed: number, zone: string, id: string}>}
 */
export function smokeBreaksOf(r) {
  return memo(r, 'smokeBreaks', () => {
    const smokes = (r.enemyNades || []).filter((n) => n.type === 'smokegrenade');
    if (!smokes.length) return [];
    const out = [];
    const done = new Set();
    // Walking into it, not being smoked where they stood: two seconds before,
    // with the smoke already up, the player was outside it.
    for (const s of r.series) {
      for (const n of smokes) {
        if (s.tick < n.tick + 3 * r.tickRate || s.tick > n.tick + SMOKE_SECONDS * r.tickRate) continue;
        const before = r.sampleAt(s.tick - 2 * r.tickRate);
        for (const p of s.pts) {
          const key = `${n.tick}:${p.id}`;
          if (done.has(key)) continue;
          if (Math.hypot(p.x - n.x, p.y - n.y) > SMOKE_RADIUS) continue;
          const prev = before?.pts.find((q) => q.id === p.id);
          if (!prev || Math.hypot(prev.x - n.x, prev.y - n.y) <= SMOKE_RADIUS * 1.5) continue;
          done.add(key);
          out.push({ tick: s.tick, elapsed: s.elapsed, zone: n.label || n.zone || p.pos, id: p.id });
        }
      }
    }
    return out;
  });
}

/**
 * Aggressive moves: one of ours walking alone onto ground the other team held
 * earlier in the round (or holds now). Alone means no teammate within
 * ALONE_UNITS; the first step onto the ground is the move.
 * @returns {Array<{id: string, tick: number, elapsed: number, zone: string}>}
 */
export function aggressiveMovesOf(r) {
  return memo(r, 'aggressive', () => {
    const held = new Set();
    const last = new Map();
    const out = [];
    for (const s of r.series) {
      for (const o of s.opp || []) if (o.pos) held.add(o.pos);
      for (const p of s.pts) {
        const prev = last.get(p.id);
        last.set(p.id, p.pos);
        if (!p.pos || prev === p.pos || !held.has(p.pos)) continue;
        const alone = !s.pts.some((q) => q.id !== p.id && dist(p, q) <= ALONE_UNITS);
        if (alone) out.push({ id: p.id, tick: s.tick, elapsed: s.elapsed, zone: p.pos });
      }
    }
    return out;
  });
}

/**
 * Players of ours lurking at the commit: far from the rest of the team, and
 * not on the ground of the site being hit.
 */
export function lurkersOf(r) {
  return memo(r, 'lurkers', () => {
    const commit = commitElapsed(r);
    if (commit === null) return new Set();
    const s = sampleAtElapsed(r, commit);
    if (!s || s.pts.length < 3) return new Set();
    const site = roundSite(r).toLowerCase();
    const out = new Set();
    for (const p of s.pts) {
      const others = s.pts.filter((q) => q !== p);
      const nearest = Math.min(...others.map((q) => dist(p, q)));
      if (nearest < LURK_UNITS) continue;
      if (site && r.siteNear(p.x, p.y) === site) continue;
      out.add(p.id);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Small aggregation helpers the sections share
// ---------------------------------------------------------------------------

export function tally(list, pick) {
  const m = new Map();
  for (const x of list) bump(m, pick(x));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

export { bump, dist };

/** Seconds elapsed of a piece of utility landing, per round type, as the round clock. */
export const clockOfElapsed = (elapsed) => ROUND_SECONDS - elapsed;

export { classifyPace, paceSite };
