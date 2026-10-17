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
// The map in three parts
// ---------------------------------------------------------------------------

/**
 * The part of the map a point belongs to, the way a sheet splits it: 'A',
 * 'B' or 'mid' (Dust2's long is A). Nuke has no mid between its sites, so it
 * is split by its T lanes ("Outside", "Lobby"). '' when nothing places it.
 */
export function areaAt(r, x, y, pos, mapCode, laneSets) {
  const lanes = FORMATIONS[mapCode]?.t || [];
  const laneArea = () => {
    const l = laneOfPos(pos, laneSets);
    const lane = l >= 0 ? lanes[l] : null;
    if (!lane) return '';
    const short = String(lane.short || '').trim();
    if (/^[AB]$/i.test(short)) return short.toUpperCase();
    if (lane.key === 'long') return 'A';
    return lane.key === 'mid' ? 'mid' : short || lane.label || '';
  };
  const site = (pad) => (Number.isFinite(x) && Number.isFinite(y) ? r.siteNear(x, y, pad)?.toUpperCase() || '' : '');
  if (mapCode === 'NUK') return laneArea() || site();
  return site() || laneArea() || site(900) || (Number.isFinite(x) ? 'mid' : '');
}

/** Still five on five this many seconds into the round. */
export function fiveOnFive(r, elapsed) {
  if (r.kills.some((k) => ROUND_SECONDS - k.clock <= elapsed)) return false;
  const s = sampleAtElapsed(r, elapsed);
  return Boolean(s && s.pts.length >= 5 && (s.opp?.length ?? 5) >= 5);
}

/** Nobody hurt between two points of the round (seconds since it went live). */
export const quietBetween = (r, from, to) => !(r.damage || []).some((d) => d.elapsed >= from && d.elapsed <= to);

// ---------------------------------------------------------------------------
// T: the core showing itself, and the rest of the map while it does
// ---------------------------------------------------------------------------

/** A teammate fighting, or throwing for him, this close in time to a duel... */
export const SUPPORT_SECONDS = 4;
/** ...from or onto ground this close to him, or the same named position. */
export const SUPPORT_UNITS = 700;
/** Utility out of spawn in the first seconds of the round supports nobody. */
const SPAWN_UTILITY_SECONDS = 3;
/** What the rest of the map does is read over this long after the core shows. */
const REST_SECONDS = 10;
const MOVED_UNITS = 400;

/** Our end of a hit: who, and where they stood. */
const ourEnd = (d) =>
  d.attackerOurs ? { id: d.attacker, x: d.ax, y: d.ay } : { id: d.victim, x: d.vx, y: d.vy };

/**
 * The first time a T group shows itself: one of ours in a duel while a
 * teammate fights next to him or throws utility for him (from or onto his
 * ground, within a few seconds), with three or more of ours in it once the
 * players standing with him are counted. Before the plant only.
 *
 * @returns {null | { tick: number, elapsed: number, area: string, pos: string, ids: string[], x: number, y: number }}
 */
export function coreShowOf(r, mapCode, laneSets) {
  return memo(r, `core:${mapCode}`, () => {
    if (!r.series?.length || !r.damage?.length) return null;
    const plantAt = plantElapsed(r);
    const duels = r.damage.filter((d) => d.attackerOurs !== d.victimOurs && (plantAt === null || d.elapsed < plantAt));
    for (const d of duels) {
      const me = ourEnd(d);
      if (!Number.isFinite(me.x) || !Number.isFinite(me.y)) continue;
      const s = r.sampleAt(d.tick);
      const pos = s?.pts.find((p) => p.id === me.id)?.pos || '';
      const near = (x, y, zone) =>
        Number.isFinite(x) && Number.isFinite(y) && (Math.hypot(x - me.x, y - me.y) <= SUPPORT_UNITS || Boolean(pos && zone === pos));
      const support = new Set();
      for (const o of duels) {
        if (Math.abs(o.elapsed - d.elapsed) > SUPPORT_SECONDS) continue;
        const them = ourEnd(o);
        if (them.id === me.id) continue;
        const zone = r.sampleAt(o.tick)?.pts.find((p) => p.id === them.id)?.pos || '';
        if (near(them.x, them.y, zone)) support.add(them.id);
      }
      for (const n of r.nades) {
        if (n.player === me.id || !(throwElapsed(n) > SPAWN_UTILITY_SECONDS)) continue;
        if (Math.abs(throwElapsed(n) - d.elapsed) > SUPPORT_SECONDS && Math.abs(n.at - d.elapsed) > SUPPORT_SECONDS) continue;
        if (near(n.fx, n.fy, n.fromZone) || near(n.x, n.y, n.zone)) support.add(n.player);
      }
      if (!support.size) continue;
      const group = new Set([me.id, ...support]);
      for (const p of s?.pts || []) if (dist(p, me) <= ALONE_UNITS) group.add(p.id);
      if (group.size < 3) continue;
      return {
        tick: d.tick,
        elapsed: d.elapsed,
        area: areaAt(r, me.x, me.y, pos, mapCode, laneSets),
        pos,
        ids: [...group],
        x: me.x,
        y: me.y
      };
    }
    return null;
  });
}

/**
 * What a player of ours did over the next seconds of the round: went to the
 * core (ended up on its part of the map), pushed (fought, went alone onto
 * held ground, or stepped onto a site), left the part of the map he was on,
 * or held it.
 */
function playAfter(r, id, from, core, mapCode, laneSets, seconds = REST_SECONDS) {
  const start = sampleAtElapsed(r, from)?.pts.find((p) => p.id === id);
  if (!start) return null;
  const area = areaAt(r, start.x, start.y, start.pos, mapCode, laneSets);
  const to = from + seconds;
  const fought = (r.damage || []).some(
    (d) => d.elapsed > from && d.elapsed <= to && d.attackerOurs !== d.victimOurs && ourEnd(d).id === id
  );
  const moved = aggressiveMovesOf(r).some((m) => m.id === id && m.elapsed > from && m.elapsed <= to);
  const wasOnSite = Boolean(r.siteNear(start.x, start.y, 0));
  let last = start;
  let stepped = false;
  for (const s of r.series) {
    if (s.elapsed <= from) continue;
    if (s.elapsed > to) break;
    const p = s.pts.find((x) => x.id === id);
    if (!p) break;
    last = p;
    if (!wasOnSite && r.siteNear(p.x, p.y, 0)) stepped = true;
  }
  const lastArea = areaAt(r, last.x, last.y, last.pos, mapCode, laneSets);
  if (lastArea === core && area !== core) return { id, area, pos: start.pos, does: 'leave', to: lastArea };
  if (fought || moved || stepped) return { id, area, pos: start.pos, does: 'push', to: lastArea };
  if (lastArea && lastArea !== area && dist(start, last) >= MOVED_UNITS) return { id, area, pos: start.pos, does: 'leave', to: lastArea };
  return { id, area, pos: start.pos, does: 'hold', to: area };
}

/** Everyone of ours outside the core group when it showed itself, and what they did next. */
export function restOfMapAt(r, show, mapCode, laneSets) {
  if (!show) return [];
  return memo(r, `rest:${mapCode}`, () => {
    const s = r.sampleAt(show.tick);
    const inGroup = new Set(show.ids);
    return (s?.pts || [])
      .filter((p) => !inGroup.has(p.id))
      .map((p) => playAfter(r, p.id, s.elapsed, show.area, mapCode, laneSets))
      .filter((x) => x && x.area);
  });
}

// ---------------------------------------------------------------------------
// T: what a lurker does with his lurk
// ---------------------------------------------------------------------------

/** Seconds around the commit that count as "with the hit". */
const WITH_HIT_SECONDS = 5;
/** Alone on the other side of the map for this long before the commit is a lurk. */
const LURK_SECONDS = 8;
/** Lurking is read from here on: before it everyone is still leaving spawn. */
const LURK_FROM = 15;
/** ...and has to still be going on this close to the hit: earlier it was map control. */
const LURK_HELD_UNTIL = 25;

/**
 * Each lurker of a round and what he did with it. A lurker spent eight
 * seconds or more before the commit alone (no teammate within ALONE_UNITS)
 * on the side of the map of the site the round did not go to. From there he either went
 * at a bombsite himself (onto its ground, alone onto ground the CTs held
 * near it, or into a fight there), held and then left once the team went
 * elsewhere, stayed on his ground, or died holding it.
 *
 * `at` is when he pushed, left his ground for the hit, or died (seconds
 * since the round went live), `arrive` when a rotation reached the hit;
 * `when` places a push against the team's commit.
 *
 * @returns {Array<{ id: string, area: string, pos: string, from: number, does: 'push'|'rotate'|'stay'|'died', at: number|null, arrive: number|null, when: 'before'|'with'|'after'|'', where: string }>}
 */
export function lurkPlaysOf(r, mapCode, laneSets) {
  return memo(r, `lurkPlay:${mapCode}`, () => {
    const commit = commitElapsed(r);
    const hit = roundSite(r);
    if (commit === null || !hit || !r.series?.length) return [];
    /** id -> samples alone away from the hit, before the commit */
    const alone = new Map();
    for (const s of r.series) {
      if (s.elapsed < LURK_FROM) continue;
      if (s.elapsed >= commit) break;
      for (const p of s.pts) {
        const area = areaAt(r, p.x, p.y, p.pos, mapCode, laneSets);
        // A lurk is on a bombsite's side of the map: alone in mid is mid
        // control. Nuke has no mid, so any lane counts there.
        if (!area || area === hit || (mapCode !== 'NUK' && area !== 'A' && area !== 'B')) continue;
        if (s.pts.some((q) => q.id !== p.id && dist(p, q) <= ALONE_UNITS)) continue;
        if (!alone.has(p.id)) alone.set(p.id, []);
        alone.get(p.id).push({ elapsed: s.elapsed, p, area });
      }
    }
    const when = (t) => (t < commit - WITH_HIT_SECONDS ? 'before' : t <= commit + WITH_HIT_SECONDS ? 'with' : 'after');
    const out = [];
    for (const [id, samples] of alone) {
      if (samples.length < LURK_SECONDS) continue;
      const area = tally(samples, (x) => x.area)[0][0];
      const mine = samples.filter((x) => x.area === area);
      if (mine.length < LURK_SECONDS || mine[mine.length - 1].elapsed < commit - LURK_HELD_UNTIL) continue;
      const pos = tally(mine, (x) => x.p.pos)[0]?.[0] || '';
      const from = mine[0].elapsed;
      const death = r.kills.find((k) => k.victim === id);
      const deadAt = death ? ROUND_SECONDS - death.clock : Infinity;
      const until = Math.min(deadAt, commit + 20);
      // Rotated: two samples running on the hit's side of the map. He left
      // his ground the last time he was seen on it before that.
      let left = null;
      let arrive = null;
      let lastHome = from;
      let there = 0;
      for (const s of r.series) {
        if (s.elapsed <= from || s.elapsed > until) continue;
        const p = s.pts.find((x) => x.id === id);
        if (!p) break;
        const a = areaAt(r, p.x, p.y, p.pos, mapCode, laneSets);
        if (a === area) lastHome = s.elapsed;
        if (a === hit) {
          if (++there === 2) {
            arrive = s.elapsed - 1;
            left = lastHome;
            break;
          }
        } else there = 0;
      }
      const end = left ?? until;
      const otherSite = (x, y, pad) => {
        const site = Number.isFinite(x) ? r.siteNear(x, y, pad) : null;
        return site && site.toUpperCase() !== hit ? site : null;
      };
      // At a bombsite while still lurking: onto the site itself, alone onto
      // held ground in front of it, or into a fight there. The first of them.
      let push = null;
      const take = (t, where) => {
        if (t >= from && t <= end && (!push || t < push.at)) push = { at: t, where };
      };
      for (const s of r.series) {
        if (s.elapsed < from || s.elapsed > end) continue;
        const p = s.pts.find((x) => x.id === id);
        const site = p && otherSite(p.x, p.y, 0);
        if (site && inPieces(p.x, p.y, r.sitePieces?.[site])) {
          take(s.elapsed, p.pos);
          break;
        }
      }
      for (const m of aggressiveMovesOf(r)) {
        if (m.id !== id) continue;
        const p = r.sampleAt(m.tick)?.pts.find((x) => x.id === id);
        if (p && otherSite(p.x, p.y)) take(m.elapsed, m.zone);
      }
      for (const d of r.damage || []) {
        if (d.attackerOurs === d.victimOurs || ourEnd(d).id !== id || d.elapsed < from) continue;
        const e = ourEnd(d);
        if (otherSite(e.x, e.y)) {
          take(d.elapsed, r.sampleAt(d.tick)?.pts.find((x) => x.id === id)?.pos || '');
          break;
        }
      }
      const base = { id, area, pos, from, arrive: null, where: '' };
      if (push) out.push({ ...base, does: 'push', at: push.at, when: when(push.at), where: push.where });
      else if (left !== null) out.push({ ...base, does: 'rotate', at: left, arrive, when: when(left) });
      else if (deadAt <= commit + 20) out.push({ ...base, does: 'died', at: deadAt, when: when(deadAt) });
      else out.push({ ...base, does: 'stay', at: null, when: '' });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// CT: utility thrown as an answer
// ---------------------------------------------------------------------------

/** A smoke or molotov is an answer to what happened this long before it left the hand... */
export const REACT_SECONDS = 4;
/** ...near the thrower or where it lands. */
export const REACT_UNITS = 800;
/** How the team moved after it is read this long after the throw. */
const AFTER_SECONDS = 6;
const STILL_UNITS = 300;

/**
 * Every smoke and molotov of ours, with what it may have been an answer to:
 * a death anywhere on the map, damage given or taken by one of ours near the
 * thrower or the landing spot, or the other team's utility landing there.
 *
 * @returns {Array<{ n: object, t: number, deaths: object[], hits: object[], util: object[], reactive: boolean }>}
 */
export function reactionsOf(r) {
  return memo(r, 'reactions', () => {
    const out = [];
    for (const n of r.nades) {
      if (n.type !== 'smokegrenade' && n.type !== 'molotov') continue;
      const t = throwElapsed(n);
      if (!Number.isFinite(t)) continue;
      const before = (e) => e <= t + 0.5 && e >= t - REACT_SECONDS;
      const near = (x, y) =>
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        ((Number.isFinite(n.fx) && Math.hypot(x - n.fx, y - n.fy) <= REACT_UNITS) || Math.hypot(x - n.x, y - n.y) <= REACT_UNITS);
      const deaths = r.kills.filter((k) => before(ROUND_SECONDS - k.clock));
      const hits = (r.damage || []).filter((d) => {
        if (!before(d.elapsed) || d.attackerOurs === d.victimOurs) return false;
        const e = ourEnd(d);
        return near(e.x, e.y) || near(d.attackerOurs ? d.vx : d.ax, d.attackerOurs ? d.vy : d.ay);
      });
      const util = (r.enemyNades || []).filter((e) => before(e.at) && near(e.x, e.y));
      out.push({ n, t, deaths, hits, util, reactive: Boolean(deaths.length || hits.length || util.length) });
    }
    return out;
  });
}

/**
 * What the team did in the part of the map a piece of utility went into, over
 * the seconds after it: more of ours there (rotating in), fewer (rotating
 * out), the same and barely moving (standing still), or the same but moving.
 */
export function teamAfter(r, t, x, y, zone, mapCode, laneSets) {
  const area = areaAt(r, x, y, zone, mapCode, laneSets);
  const a = sampleAtElapsed(r, t);
  const b = sampleAtElapsed(r, t + AFTER_SECONDS);
  if (!a || !b || !area) return '';
  const both = a.pts.filter((p) => b.pts.some((q) => q.id === p.id));
  if (both.length < 2) return '';
  const inArea = (s) =>
    both.filter((p) => {
      const q = s.pts.find((x) => x.id === p.id);
      return q && areaAt(r, q.x, q.y, q.pos, mapCode, laneSets) === area;
    }).length;
  const was = inArea(a);
  const now = inArea(b);
  if (now > was) return 'in';
  if (now < was) return 'out';
  const moved = median(both.map((p) => dist(p, b.pts.find((q) => q.id === p.id))));
  return moved !== null && moved < STILL_UNITS ? 'still' : 'shift';
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
