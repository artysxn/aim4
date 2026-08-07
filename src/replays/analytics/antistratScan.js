// ---------------------------------------------------------------------------
// Teams antistrat: the scan engine.
//
// Walks every included round of the scouted team on one map, loading round
// meta + stride-16 ticks, and reduces them to the report's numbers. Geometry
// questions go through the map's zone network (positions / zones / areas, key
// zones, bomb sites); grenade naming goes through the private utility
// database within UTILITY_MATCH_UNITS of a stored landing spot.
//
// Everything here is client-side and read-only; the panel feeds the result to
// the document builder. Clocks count down from 1:55 ("1:35" = 20s elapsed).
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchRoundTicks, fetchZones } from '../api.js';
import { TickTrack } from '../tickStore.js';
import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { phaseBounds } from '../coach/roundPhases.js';
import { openingSituation } from '../shared/openingSituation.js';
import { buyBucket } from '../shared/roundId.js';
import { teamNameKey } from '../shared/statsMath.js';
import { loadCoachSmokes, matchCoachSmoke } from '../coach/coachSmokes.js';
import { ensureRegionHierarchy } from '../zones/regionHierarchy.js';
import { ensureKeyZones, keyZonesFor } from '../zones/keyZones.js';
import {
  bombSiteAtPoint,
  bombSiteCenters,
  bombSitePieces,
  ensureBombSites
} from '../zones/bombSites.js';
import { positionsAtPoint } from '../zones/pointInZone.js';
import { pieceBounds } from '../zones/zoneGeom.js';
import { FORMATIONS, formatFormation, clockSeconds } from './patternDefs.js';
import { loadRadar } from '../viewer/radarRenderer.js';
import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';

/** Grenade must land within this of a stored spot to take its name. */
export const UTILITY_MATCH_UNITS = 100;
/** "Near" a key zone / site piece, in world units past its bounds. */
const NEAR_PAD = 250;
/** Two teammates within this of each other chain into one core. */
const CORE_LINK_UNITS = 600;
/** Seconds between position samples (ticks are fetched at stride 16). */
const SAMPLE_SECONDS = 2;
/** Advantage window after the opening kill (5v4 / 4v5 reads). */
const ADVANTAGE_WINDOW_SECONDS = 20;
/** Afterplant / retake positions are read this long after the plant. */
const POSTPLANT_SECONDS = 8;

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function fmtClock(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function normNade(type) {
  const t = String(type || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  if (t === 'incgrenade' || t === 'firebomb' || t === 'inferno') return 'molotov';
  return t;
}

const NADE_KINDS = ['smokegrenade', 'molotov', 'flashbang', 'hegrenade'];
const NADE_LABEL = {
  smokegrenade: 'Smokes',
  molotov: 'Molotovs',
  flashbang: 'Flashes',
  hegrenade: 'HE grenades'
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Distance from a point to a piece's bounding box (0 inside the box). */
function distToPiece(x, y, piece) {
  const b = pieceBounds(piece);
  if (!b) return Infinity;
  const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

function nearAnyPiece(x, y, pieces, pad = NEAR_PAD) {
  for (const p of pieces) {
    if (distToPiece(x, y, p) <= pad) return true;
  }
  return false;
}

function avgPairDistance(points) {
  if (points.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      sum += Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      n++;
    }
  }
  return n ? sum / n : null;
}

/** Largest chain-linked cluster (union by ≤ CORE_LINK_UNITS pair distance). */
function coreOf(points) {
  const n = points.length;
  if (!n) return { size: 0, cx: 0, cy: 0, members: [] };
  const parent = points.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) <= CORE_LINK_UNITS) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  let best = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  let cx = 0;
  let cy = 0;
  for (const i of best) {
    cx += points[i].x;
    cy += points[i].y;
  }
  return {
    size: best.length,
    cx: best.length ? cx / best.length : 0,
    cy: best.length ? cy / best.length : 0,
    members: best.map((i) => points[i])
  };
}

/** Top entries of a string→count map: [{name, count}] sorted desc. */
function topCounts(map, limit = 6) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function bump(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

// ---------------------------------------------------------------------------
// Per-round feature extraction
// ---------------------------------------------------------------------------

/**
 * Reduce one round to the features the aggregators read. Sampling walks the
 * live round once at SAMPLE_SECONDS resolution; every later question indexes
 * into that series instead of touching ticks again.
 */
function roundFeatures({ meta, track, row, teamIdx, network, utilDb, mapCode }) {
  const timing = timingFor(meta);
  const tickRate = timing.tickRate || 64;
  const t0 = timing.freezeEndTick;
  const endTick = Math.min(timing.endTick, t0 + ROUND_SECONDS * tickRate);
  const elapsedOf = (tick) => (tick - t0) / tickRate;
  const clockOf = (tick) => ROUND_SECONDS - elapsedOf(tick);

  const sides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const side = sides[teamIdx] === 'CT' ? 'CT' : 'T';
  const roster = meta.players || [];
  const ours = roster.filter((p) => p.team === teamIdx);
  const ourIds = new Set(ours.map((p) => p.id));
  if (!ours.length) return null;

  const ownEcon = buyBucket(teamIdx === 1 ? row.e1 : row.e2);
  const oppEcon = buyBucket(teamIdx === 1 ? row.e2 : row.e1);
  const won = row.w === teamIdx;

  // Kills, cross-team only, with a world point where the parser kept one.
  const deadAt = new Map();
  const kills = [];
  for (const k of [...(meta.events?.kills || [])].sort((a, b) => (a.tick || 0) - (b.tick || 0))) {
    if (k.victim) deadAt.set(k.victim, k.tick || 0);
    const at = roster.find((p) => p.id === k.attacker)?.team || 0;
    const vt = roster.find((p) => p.id === k.victim)?.team || 0;
    if (!at || !vt || at === vt) continue;
    kills.push({
      tick: k.tick || 0,
      clock: clockOf(k.tick || 0),
      attacker: k.attacker,
      victim: k.victim,
      x: Number.isFinite(k._wx) ? k._wx : null,
      y: Number.isFinite(k._wy) ? k._wy : null,
      attackerOurs: ourIds.has(k.attacker),
      victimOurs: ourIds.has(k.victim)
    });
  }
  const aliveAt = (id, tick) => !deadAt.has(id) || deadAt.get(id) > tick;

  // Sample series over the live round.
  const series = [];
  if (track) {
    const states = [];
    for (let tick = t0; tick <= endTick; tick += SAMPLE_SECONDS * tickRate) {
      track.sampleAll(tick, states);
      const pts = [];
      for (const p of ours) {
        const s = states[p.slot];
        if (!s || !s.alive || !aliveAt(p.id, tick)) continue;
        if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
        const names = network ? positionsAtPoint(s.x, s.y, network).map((z) => z.name) : [];
        pts.push({ id: p.id, x: s.x, y: s.y, pos: names[0] || '' });
      }
      series.push({ tick, elapsed: elapsedOf(tick), pts });
    }
  }
  const sampleAt = (tick) => {
    if (!series.length) return null;
    let best = series[0];
    for (const s of series) {
      if (Math.abs(s.tick - tick) < Math.abs(best.tick - tick)) best = s;
    }
    return best;
  };

  // Backfill kill points from the victim's nearest sample when the event
  // carried no world position (only possible for our own victims).
  for (const k of kills) {
    if (k.x !== null || !track) continue;
    const p = roster.find((x) => x.id === k.victim);
    if (!p) continue;
    const s = track.sample(p.slot, k.tick, {});
    if (Number.isFinite(s.x) && Number.isFinite(s.y) && (s.x || s.y)) {
      k.x = s.x;
      k.y = s.y;
    }
  }

  // First visit tick per named position (new-ground reads).
  const firstVisit = new Map();
  for (const s of series) {
    for (const p of s.pts) {
      if (p.pos && !firstVisit.has(p.pos)) firstVisit.set(p.pos, s.tick);
    }
  }

  // Our grenades, named against the utility database.
  const nades = [];
  for (const g of meta.events?.grenades || []) {
    if (!ourIds.has(g.player)) continue;
    const type = normNade(g.type);
    if (!NADE_KINDS.includes(type)) continue;
    const det = Number(g.detonateTick ?? g.throwTick);
    const x = Number(g.at?.x);
    const y = Number(g.at?.y);
    if (!Number.isFinite(det) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const db = utilDb?.utilities?.length
      ? matchCoachSmoke(utilDb.utilities, x, y, UTILITY_MATCH_UNITS, type)
      : null;
    const zone = network ? positionsAtPoint(x, y, network).map((z) => z.name)[0] || '' : '';
    nades.push({
      type,
      tick: det,
      clock: clockOf(Number(g.throwTick ?? det)),
      x,
      y,
      name: db?.name || ''
    , zone });
  }
  nades.sort((a, b) => a.tick - b.tick);

  // Plant, with a site letter where geometry allows one.
  const bombEv = (meta.events?.bomb || []).find((b) => b?.type === 'planted');
  const plantTick = Number.isFinite(meta.plantTick) ? meta.plantTick : bombEv?.tick ?? null;
  let plantSite = null;
  if (plantTick != null && network) {
    const px = Number(bombEv?.x);
    const py = Number(bombEv?.y);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      plantSite = bombSiteAtPoint(px, py, network, { mapCode });
      if (!plantSite) {
        const centers = bombSiteCenters(network, { mapCode });
        const da = centers.a ? Math.hypot(centers.a.x - px, centers.a.y - py) : Infinity;
        const db = centers.b ? Math.hypot(centers.b.x - px, centers.b.y - py) : Infinity;
        plantSite = da === Infinity && db === Infinity ? null : da <= db ? 'a' : 'b';
      }
    }
  }

  const bounds = phaseBounds(meta);
  const situation = openingSituation(meta, teamIdx);
  const firstKill = kills[0] || null;

  const sitePieces = network
    ? { a: bombSitePieces(network, 'a', { mapCode }), b: bombSitePieces(network, 'b', { mapCode }) }
    : { a: [], b: [] };
  const keyPieces = network
    ? { a: keyZonesFor(network, 'a'), b: keyZonesFor(network, 'b') }
    : { a: [], b: [] };
  const towardPieces = {
    a: [...sitePieces.a, ...keyPieces.a],
    b: [...sitePieces.b, ...keyPieces.b]
  };

  /** Players of ours in / near (pad) a site's key ground at a sample. */
  const towardCount = (sample, site, pad = NEAR_PAD) => {
    if (!sample) return 0;
    let n = 0;
    for (const p of sample.pts) {
      if (nearAnyPiece(p.x, p.y, towardPieces[site], pad)) n++;
    }
    return n;
  };

  /** First tick with `count`+ of ours inside either site's pieces. */
  const siteEntry = (count) => {
    for (const s of series) {
      for (const site of ['a', 'b']) {
        let inside = 0;
        for (const p of s.pts) {
          if (nearAnyPiece(p.x, p.y, sitePieces[site], 0)) inside++;
        }
        if (inside >= count) return { tick: s.tick, clock: ROUND_SECONDS - s.elapsed, site };
      }
    }
    return null;
  };

  return {
    file: row.f,
    demoId: row.d,
    round: row.n,
    side,
    won,
    ownEcon,
    oppEcon,
    situation,
    kills,
    firstKill,
    nades,
    plantTick,
    plantClock: plantTick != null ? clockOf(plantTick) : null,
    plantSite,
    bounds,
    tickRate,
    t0,
    endTick,
    series,
    sampleAt,
    firstVisit,
    towardCount,
    siteEntry,
    elapsedOf,
    clockOf,
    hasTicks: Boolean(track)
  };
}

// ---------------------------------------------------------------------------
// Pace classification (patternDefs criteria, on extracted features)
// ---------------------------------------------------------------------------

/** T-side pace of one round, or 'other' when nothing matches. */
export function classifyPace(r) {
  if (r.side !== 'T') return '';
  const deadBy = (clock) => r.kills.filter((k) => k.clock >= clock).length;
  const plantedBy = (clock) => r.plantClock !== null && r.plantClock >= clock;
  const entry3 = r.siteEntry(3);
  const entry4 = r.siteEntry(4);
  const entry2 = r.siteEntry(2);
  const enteredBy = (entry, clock) => Boolean(entry && entry.clock >= clock);
  const killAtOrBefore = (clock) => r.kills.some((k) => k.clock >= clock);

  if (plantedBy(93) || enteredBy(entry3, 93) || deadBy(93) >= 3) return 'rush';
  if ((plantedBy(80) || enteredBy(entry3, 80) || deadBy(80) >= 3) && !killAtOrBefore(102)) {
    return 'pop';
  }
  if ((plantedBy(75) || enteredBy(entry4, 75) || deadBy(75) >= 4) && !killAtOrBefore(88)) {
    return 'contact';
  }

  const count = (type) => r.nades.filter((n) => n.type === type).length;
  const committed = r.sampleAt(r.t0 + 60 * r.tickRate);
  const committedN = committed
    ? Math.max(r.towardCount(committed, 'a'), r.towardCount(committed, 'b'))
    : 0;
  if (
    count('molotov') >= 2 &&
    count('smokegrenade') >= 2 &&
    count('flashbang') >= 2 &&
    committedN >= 4
  ) {
    return 'full-exec';
  }

  const early2 = enteredBy(entry2, 77);
  if (!early2) {
    const nadesBy = (clock) => r.nades.filter((n) => n.clock >= clock);
    const quiet =
      nadesBy(85).filter((n) => n.type === 'smokegrenade').length <= 2 &&
      nadesBy(85).filter((n) => n.type === 'molotov').length <= 2 &&
      nadesBy(85).filter((n) => n.type === 'flashbang').length <= 2 &&
      !r.kills.some((k) => k.clock >= 80);
    return quiet ? 'slow-default' : 'default';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Aggregators (one per report category)
// ---------------------------------------------------------------------------

function refOf(r) {
  return { file: r.file, round: r.round };
}

function aggUtility(rounds) {
  const out = { sides: {}, note: '' };
  for (const side of ['T', 'CT']) {
    const set = rounds.filter(
      (r) => r.side === side && r.ownEcon === 4 && r.oppEcon === 4
    );
    if (!set.length) continue;
    const kinds = {};
    for (const kind of NADE_KINDS) {
      const byName = new Map();
      const clocks = new Map();
      let thrown = 0;
      for (const r of set) {
        for (const n of r.nades) {
          if (n.type !== kind) continue;
          thrown++;
          const label = n.name || (n.zone ? `${n.zone} (unnamed)` : '');
          if (!label) continue;
          bump(byName, label);
          if (!clocks.has(label)) clocks.set(label, []);
          clocks.get(label).push(n.clock);
        }
      }
      kinds[kind] = {
        label: NADE_LABEL[kind],
        avgPerRound: round1(thrown / set.length),
        top: topCounts(byName).map((t) => {
          const cs = clocks.get(t.name) || [];
          const avg = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null;
          return { ...t, share: pct(t.count, set.length), clock: avg !== null ? fmtClock(avg) : '' };
        })
      };
    }
    out.sides[side] = { rounds: set.length, kinds };
  }
  return out;
}

function aggAdvantage(rounds, want) {
  const set = rounds.filter((r) =>
    want === '5v4'
      ? r.situation === '5v4' || r.situation === '5v3'
      : r.situation === '4v5' || r.situation === '3v5'
  );
  const out = { rounds: set.length };
  if (!set.length) return out;

  // Preferred bombsite, T rounds: the plant, falling back to a 2-man entry.
  const tSet = set.filter((r) => r.side === 'T');
  const sites = new Map();
  for (const r of tSet) {
    const site = r.plantSite || r.siteEntry(2)?.site || null;
    if (site) bump(sites, site.toUpperCase());
  }
  const siteN = [...sites.values()].reduce((a, b) => a + b, 0);
  out.site = siteN
    ? { a: pct(sites.get('A') || 0, siteN), b: pct(sites.get('B') || 0, siteN), basis: siteN }
    : null;

  // Tempo, control and spacing around the opening kill.
  const tempos = [];
  const newGround = [];
  const distAt = [];
  const distAfter = [];
  const towardA = [];
  const towardB = [];
  for (const r of set) {
    if (!r.firstKill || !r.hasTicks) continue;
    const k = r.firstKill.tick;
    const after = k + ADVANTAGE_WINDOW_SECONDS * r.tickRate;

    let formed = null;
    for (const s of r.series) {
      if (s.tick < k) continue;
      if (coreOf(s.pts).size >= 3) {
        formed = (s.tick - k) / r.tickRate;
        break;
      }
    }
    if (formed !== null) tempos.push(formed);

    let fresh = 0;
    for (const [, tick] of r.firstVisit) {
      if (tick > k && tick <= after) fresh++;
    }
    newGround.push(fresh);

    const s0 = r.sampleAt(k);
    const s1 = r.sampleAt(after);
    const d0 = s0 ? avgPairDistance(s0.pts) : null;
    const d1 = s1 ? avgPairDistance(s1.pts) : null;
    if (d0 !== null) distAt.push(d0);
    if (d0 !== null && d1 !== null) distAfter.push(d1 - d0);
    if (s1) {
      towardA.push(r.towardCount(s1, 'a'));
      towardB.push(r.towardCount(s1, 'b'));
    }
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  out.tempoSeconds = tempos.length ? round1(avg(tempos)) : null;
  out.newGround = newGround.length ? round1(avg(newGround)) : null;
  out.avgDistance = distAt.length ? Math.round(avg(distAt)) : null;
  out.addedDistance = distAfter.length ? Math.round(avg(distAfter)) : null;
  out.towardA = towardA.length ? round1(avg(towardA)) : null;
  out.towardB = towardB.length ? round1(avg(towardB)) : null;
  out.window = ADVANTAGE_WINDOW_SECONDS;
  return out;
}

function aggForce(rounds) {
  const out = {};
  for (const side of ['T', 'CT']) {
    const set = rounds.filter((r) => r.side === side && r.ownEcon === 3);
    if (!set.length) continue;
    if (side === 'T') {
      const sites = new Map();
      const clocks = [];
      for (const r of set) {
        const site = r.plantSite || r.siteEntry(2)?.site || null;
        if (site) bump(sites, site.toUpperCase());
        const c = r.plantClock ?? r.siteEntry(2)?.clock ?? null;
        if (c !== null) clocks.push(c);
      }
      clocks.sort((a, b) => b - a);
      const basis = [...sites.values()].reduce((a, b) => a + b, 0);
      out.T = {
        rounds: set.length,
        site: basis
          ? { a: pct(sites.get('A') || 0, basis), b: pct(sites.get('B') || 0, basis), basis }
          : null,
        medianClock: clocks.length ? fmtClock(clocks[Math.floor(clocks.length / 2)]) : ''
      };
    } else {
      let leanA = 0;
      let leanB = 0;
      const clocks = [];
      for (const r of set) {
        const s = r.sampleAt(r.t0 + 35 * r.tickRate);
        if (s) {
          const a = r.towardCount(s, 'a');
          const b = r.towardCount(s, 'b');
          if (a > b) leanA++;
          else if (b > a) leanB++;
        }
        if (r.firstKill) clocks.push(r.firstKill.clock);
      }
      clocks.sort((a, b) => b - a);
      out.CT = {
        rounds: set.length,
        leanA: pct(leanA, set.length),
        leanB: pct(leanB, set.length),
        medianClock: clocks.length ? fmtClock(clocks[Math.floor(clocks.length / 2)]) : ''
      };
    }
  }
  return out;
}

function aggFirstEngagement(rounds) {
  const clocks = [];
  const killers = new Map();
  const zones = new Map();
  const points = [];
  for (const r of rounds) {
    const k = r.firstKill;
    if (!k) continue;
    clocks.push(k.clock);
    if (k.attackerOurs) bump(killers, k.attacker);
    if (k.x !== null && k.y !== null) {
      points.push({ x: k.x, y: k.y, ours: k.attackerOurs });
    }
  }
  clocks.sort((a, b) => b - a);
  return {
    rounds: clocks.length,
    medianClock: clocks.length ? fmtClock(clocks[Math.floor(clocks.length / 2)]) : '',
    avgClock: clocks.length
      ? fmtClock(clocks.reduce((a, b) => a + b, 0) / clocks.length)
      : '',
    killers,
    zones,
    points,
    wonShare: pct(rounds.filter((r) => r.firstKill?.attackerOurs).length, clocks.length)
  };
}

/** Resolve first-engagement killer ids to names and zone the points. */
function finishFirstEngagement(agg, roster, network) {
  const nameOf = new Map(roster.map((p) => [p.id, p.name || p.id]));
  const killers = topCounts(agg.killers).map((k) => ({
    name: nameOf.get(k.name) || k.name,
    count: k.count
  }));
  const zones = new Map();
  for (const p of agg.points) {
    if (!network) continue;
    const names = positionsAtPoint(p.x, p.y, network).map((z) => z.name);
    if (names[0]) bump(zones, names[0]);
  }
  return { ...agg, killers, zones: topCounts(zones) };
}

function aggPatterns(rounds, roster) {
  const t = rounds.filter((r) => r.side === 'T' && r.hasTicks);
  const early = (r) => r.series.filter((s) => s.tick < r.bounds.midStartTick);

  const stackRounds = (site) =>
    t.filter((r) => early(r).some((s) => r.towardCount(s, site) >= 4));
  const bStack = stackRounds('b');
  const aStack = stackRounds('a');
  const setCalls = new Set([...bStack, ...aStack].map((r) => r.file));
  const defaults = t.filter((r) => !setCalls.has(r.file));

  const winrate = (list) => pct(list.filter((r) => r.won).length, list.length);

  // 2v2+ before 1:35: four distinct players across both teams in the kill log.
  const earlyFights = rounds.filter((r) => {
    const inWindow = r.kills.filter((k) => k.clock >= 95);
    const oursIn = new Set();
    const theirsIn = new Set();
    for (const k of inWindow) {
      (k.attackerOurs ? oursIn : theirsIn).add(k.attacker);
      (k.victimOurs ? oursIn : theirsIn).add(k.victim);
    }
    return oursIn.size >= 2 && theirsIn.size >= 2 && oursIn.size + theirsIn.size >= 4;
  });

  // CT spot consistency in full buy vs full buy.
  const nameOf = new Map(roster.map((p) => [p.id, p.name || p.id]));
  const ctSet = rounds.filter(
    (r) => r.side === 'CT' && r.ownEcon === 4 && r.oppEcon === 4 && r.hasTicks
  );
  const perPlayer = new Map();
  for (const r of ctSet) {
    const s = r.sampleAt(r.t0 + 30 * r.tickRate);
    if (!s) continue;
    for (const p of s.pts) {
      if (!p.pos) continue;
      if (!perPlayer.has(p.id)) perPlayer.set(p.id, { total: 0, spots: new Map() });
      const rec = perPlayer.get(p.id);
      rec.total++;
      bump(rec.spots, p.pos);
    }
  }
  const ctSpots = [];
  for (const [id, rec] of perPlayer) {
    if (rec.total < 2) continue;
    const [top] = topCounts(rec.spots, 1);
    if (!top) continue;
    ctSpots.push({
      name: nameOf.get(id) || id,
      spot: top.name,
      share: pct(top.count, rec.total),
      rounds: rec.total
    });
  }
  ctSpots.sort((a, b) => b.share - a.share);

  return {
    tRounds: t.length,
    bStack: { rounds: bStack.map(refOf), share: pct(bStack.length, t.length) },
    aStack: { rounds: aStack.map(refOf), share: pct(aStack.length, t.length) },
    compare: {
      defaults: { count: defaults.length, winrate: winrate(defaults) },
      setCalls: {
        count: setCalls.size,
        winrate: winrate([...bStack, ...aStack].filter((r, i, arr) => arr.indexOf(r) === i))
      }
    },
    earlyFights: {
      rounds: earlyFights.map(refOf),
      share: pct(earlyFights.length, rounds.length)
    },
    ctSpots: ctSpots.filter((s) => s.share >= 50),
    ctSpotsAll: ctSpots
  };
}

function aggPostplant(rounds, side) {
  // side 'T' → afterplants (our plant), side 'CT' → retakes (planted on us).
  const out = {};
  for (const site of ['a', 'b']) {
    const set = rounds.filter(
      (r) => r.side === side && r.plantTick != null && r.plantSite === site && r.hasTicks
    );
    if (!set.length) continue;
    const spots = new Map();
    const distinct = [];
    for (const r of set) {
      const s = r.sampleAt(r.plantTick + POSTPLANT_SECONDS * r.tickRate);
      if (!s) continue;
      const seen = new Set();
      for (const p of s.pts) {
        if (!p.pos) continue;
        bump(spots, p.pos);
        seen.add(p.pos);
      }
      distinct.push(seen.size);
    }
    out[site] = {
      rounds: set.length,
      top: topCounts(spots),
      avgZones: distinct.length
        ? round1(distinct.reduce((x, y) => x + y, 0) / distinct.length)
        : null
    };
  }
  return out;
}

function aggRetakeWinrates(rounds) {
  const out = {};
  for (const site of ['a', 'b']) {
    const set = rounds.filter(
      (r) => r.side === 'CT' && r.ownEcon === 4 && r.plantTick != null && r.plantSite === site
    );
    if (!set.length) continue;
    const spots = new Map();
    for (const r of set) {
      if (!r.hasTicks) continue;
      const s = r.sampleAt(r.plantTick + POSTPLANT_SECONDS * r.tickRate);
      for (const p of s?.pts || []) if (p.pos) bump(spots, p.pos);
    }
    out[site] = {
      rounds: set.length,
      winrate: pct(set.filter((r) => r.won).length, set.length),
      top: topCounts(spots, 4)
    };
  }
  return out;
}

function aggPhase(rounds, phase) {
  const t = rounds.filter((r) => r.side === 'T' && r.hasTicks);
  const windowOf = (r) => {
    const from = phase === 'early' ? r.t0 : phase === 'mid' ? r.bounds.midStartTick : r.bounds.lateStartTick;
    const to = phase === 'early' ? r.bounds.midStartTick : phase === 'mid' ? r.bounds.lateStartTick : r.endTick;
    return { from, to };
  };

  let utilPush = 0;
  let dryPush = 0;
  let basis = 0;
  const coreSizes = [];
  const coreDists = [];

  for (const r of t) {
    const { from, to } = windowOf(r);
    if (to <= from) continue;
    basis++;
    const inWin = (tick) => tick >= from && tick < to;
    const nades = r.nades.filter((n) => inWin(n.tick));
    const samples = r.series.filter((s) => inWin(s.tick) && s.pts.length);
    const killsIn = r.kills.filter((k) => inWin(k.tick));

    if (nades.length >= 3 && samples.length >= 2) {
      const mx = nades.reduce((a, n) => a + n.x, 0) / nades.length;
      const my = nades.reduce((a, n) => a + n.y, 0) / nades.length;
      const c0 = coreOf(samples[0].pts);
      const c1 = coreOf(samples[samples.length - 1].pts);
      const approached =
        c0.size > 0 &&
        c1.size > 0 &&
        Math.hypot(c0.cx - mx, c0.cy - my) - Math.hypot(c1.cx - mx, c1.cy - my) >= 200;
      const foughtNear = killsIn.some(
        (k) =>
          k.x !== null && nades.some((n) => Math.hypot(n.x - k.x, n.y - k.y) <= CORE_LINK_UNITS)
      );
      if (approached || foughtNear) utilPush++;
    } else if (!nades.length && samples.length >= 2) {
      const c0 = coreOf(samples[0].pts);
      const c1 = coreOf(samples[samples.length - 1].pts);
      const moved = c0.size > 0 && c1.size > 0 && Math.hypot(c1.cx - c0.cx, c1.cy - c0.cy) >= 300;
      if (moved || killsIn.length) dryPush++;
    }

    for (const k of killsIn) {
      const s = r.sampleAt(k.tick);
      if (!s || !s.pts.length) continue;
      coreSizes.push(coreOf(s.pts).size);
      const d = avgPairDistance(s.pts);
      if (d !== null) coreDists.push(d);
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    basis,
    utilPush,
    dryPush,
    avgCoreSize: coreSizes.length ? round1(avg(coreSizes)) : null,
    avgCoreDistance: coreDists.length ? Math.round(avg(coreDists)) : null
  };
}

function aggPistols(rounds, mapCode, laneSets, network) {
  const t = rounds.filter((r) => r.side === 'T' && r.ownEcon === 0);
  const ct = rounds.filter((r) => r.side === 'CT' && r.ownEcon === 0);
  const list = t.map((r) => {
    const formation = laneFormation(r, mapCode, laneSets);
    const pace = classifyPace(r);
    const site = r.plantSite || r.siteEntry(2)?.site || null;
    return {
      round: r.round,
      file: r.file,
      formation: formation || '',
      pace,
      site: site ? site.toUpperCase() : '',
      won: r.won
    };
  });
  const ctList = ct.map((r) => {
    const snap = snapshotSample(r, mapCode);
    const a = snap ? r.towardCount(snap, 'a', 0) : 0;
    const b = snap ? r.towardCount(snap, 'b', 0) : 0;
    const alive = snap ? snap.pts.length : 0;
    return {
      round: r.round,
      file: r.file,
      a,
      b,
      ee: Math.max(0, alive - a - b),
      won: r.won
    };
  });
  return { t: list, ct: ctList };
}

function snapshotSample(r, mapCode) {
  const snap = clockSeconds(FORMATIONS[mapCode]?.snapshot || '');
  if (snap === null) return null;
  return r.sampleAt(r.t0 + (ROUND_SECONDS - snap) * r.tickRate);
}

/**
 * Lane region names from patternDefs, resolved to the network's position
 * names (case-insensitive). area → zones → positions, zone → positions.
 */
function resolveLaneSets(mapCode, network) {
  const def = FORMATIONS[mapCode];
  if (!def || !network) return null;
  const lower = (s) => String(s || '').trim().toLowerCase();
  const posByName = new Map((network.positions || []).map((p) => [lower(p.name), p]));
  const zoneByName = new Map((network.zones || []).map((z) => [lower(z.name), z]));
  const areaByName = new Map((network.areas || []).map((a) => [lower(a.name), a]));
  const posById = new Map((network.positions || []).map((p) => [p.id, p]));
  const zoneById = new Map((network.zones || []).map((z) => [z.id, z]));

  const sets = def.t.map((lane) => {
    const names = new Set();
    for (const ref of lane.regions) {
      const key = lower(ref.name);
      if (ref.kind === 'position') {
        if (posByName.has(key)) names.add(lower(posByName.get(key).name));
      } else if (ref.kind === 'zone') {
        const z = zoneByName.get(key);
        for (const pid of z?.positionIds || []) {
          const p = posById.get(pid);
          if (p) names.add(lower(p.name));
        }
      } else {
        const a = areaByName.get(key);
        for (const zid of a?.zoneIds || []) {
          const z = zoneById.get(zid);
          for (const pid of z?.positionIds || []) {
            const p = posById.get(pid);
            if (p) names.add(lower(p.name));
          }
        }
      }
    }
    return names;
  });
  if (sets.every((s) => !s.size)) return null;
  return sets;
}

/** T formation notation at the snapshot clock, or '' when unresolvable. */
function laneFormation(r, mapCode, laneSets) {
  if (!laneSets) return '';
  const snap = snapshotSample(r, mapCode);
  if (!snap || !snap.pts.length) return '';
  const counts = laneSets.map(() => 0);
  for (const p of snap.pts) {
    const key = String(p.pos || '').toLowerCase();
    let hit = -1;
    if (key) hit = laneSets.findIndex((s) => s.has(key));
    if (hit === -1) {
      // No named ground under the player: closest lane by its pieces' bounds.
      // Falls back to mid-most lane when geometry gives nothing.
      hit = Math.min(1, laneSets.length - 1);
    }
    counts[hit]++;
  }
  return formatFormation(mapCode, counts);
}

function aggPositions(rounds, roster, mapCode) {
  const nameOf = new Map(roster.map((p) => [p.id, p.name || p.id]));
  const matches = new Map();
  for (const r of rounds) bump(matches, r.demoId);
  const perMatch = new Map();
  for (const r of rounds) {
    for (const s of r.series.slice(0, 1)) {
      for (const p of s.pts) {
        if (!perMatch.has(p.id)) perMatch.set(p.id, new Set());
        perMatch.get(p.id).add(r.demoId);
      }
    }
  }
  const totalMatches = matches.size;
  const frequent = [...perMatch.entries()].filter(
    ([, set]) => totalMatches && set.size / totalMatches >= 0.75
  );

  const spotOf = (side, sampler) => {
    const bySpot = new Map();
    for (const r of rounds) {
      if (r.side !== side || !r.hasTicks) continue;
      const s = sampler(r);
      if (!s) continue;
      for (const p of s.pts) {
        if (!p.pos) continue;
        if (!bySpot.has(p.id)) bySpot.set(p.id, new Map());
        bump(bySpot.get(p.id), p.pos);
      }
    }
    return bySpot;
  };
  const tSpots = spotOf('T', (r) => snapshotSample(r, mapCode));
  const ctSpots = spotOf('CT', (r) => r.sampleAt(r.t0 + 30 * r.tickRate));

  return frequent.map(([id, set]) => ({
    name: nameOf.get(id) || id,
    matches: set.size,
    t: topCounts(tSpots.get(id) || new Map(), 1)[0]?.name || '',
    ct: topCounts(ctSpots.get(id) || new Map(), 1)[0]?.name || ''
  }));
}

function aggPace(rounds) {
  const buys = rounds.filter((r) => r.side === 'T' && r.ownEcon >= 2 && r.hasTicks);
  const dist = new Map();
  for (const r of buys) bump(dist, classifyPace(r) || 'other');
  return { basis: buys.length, dist: [...dist.entries()].map(([k, n]) => ({ pace: k, count: n, share: pct(n, buys.length) })) };
}

// ---------------------------------------------------------------------------
// Heatmap (first engagements over the radar)
// ---------------------------------------------------------------------------

/**
 * Radar PNG with engagement dots, as a data URI the docs sanitizer accepts.
 * Green: the scouted team took the first kill. Red: they gave it up.
 */
export async function renderHeatmapDataUri(mapCode, points, size = 480) {
  if (!points?.length) return '';
  let img = null;
  try {
    img = await loadRadar(mapCode);
  } catch {
    return '';
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(img, 0, 0, size, size);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, 0, size, size);

  const pt = {};
  for (const p of points) {
    worldToRadar(mapCode, p.x, p.y, pt);
    const x = (pt.x / RADAR_SIZE) * size;
    const y = (pt.y / RADAR_SIZE) * size;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const grad = ctx.createRadialGradient(x, y, 1, x, y, 14);
    const color = p.ours ? '88, 214, 141' : '231, 76, 60';
    grad.addColorStop(0, `rgba(${color}, 0.8)`);
    grad.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();
  }
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

async function eachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  const running = [];
  for (let n = 0; n < Math.max(1, limit); n++) running.push(worker());
  await Promise.all(running);
}

/**
 * @param {object} args
 * @param {object} args.payload   the pattern finder stats payload
 * @param {string} args.teamKey   scouted team (teamNameKey)
 * @param {string} args.mapCode
 * @param {string[]} args.demoIds included matches
 * @param {(done: number, total: number) => void} [args.onProgress]
 */
export async function runAntistratScan({ payload, teamKey, mapCode, demoIds, onProgress }) {
  const wanted = new Set(demoIds);
  const jobs = [];
  const roster = [];
  const seenPlayers = new Set();
  for (const demo of payload?.demos || []) {
    if (!wanted.has(demo.id)) continue;
    const k1 = teamNameKey(demo.name1, demo.t1);
    const k2 = teamNameKey(demo.name2, demo.t2);
    const teamIdx = k1 === teamKey ? 1 : k2 === teamKey ? 2 : 0;
    if (!teamIdx) continue;
    for (const p of demo.players || []) {
      if (p.team === teamIdx && p.id && !seenPlayers.has(p.id)) {
        seenPlayers.add(p.id);
        roster.push({ id: p.id, name: p.name || p.id });
      }
    }
    for (const row of demo.rounds || []) {
      if (row.m !== mapCode || !row.f) continue;
      jobs.push({ row, teamIdx });
    }
  }
  if (!jobs.length) throw new Error('No rounds of that team on this map.');

  let network = null;
  try {
    network = await fetchZones(mapCode);
    ensureRegionHierarchy(network);
    ensureKeyZones(network);
    ensureBombSites(network);
  } catch {
    network = null;
  }
  const utilDb = await loadCoachSmokes(mapCode);
  const laneSets = resolveLaneSets(mapCode, network);

  const rounds = [];
  let done = 0;
  await eachLimit(jobs, 3, async (job) => {
    let feats = null;
    try {
      const meta = await fetchRoundMeta(job.row.f);
      let track = null;
      try {
        track = new TickTrack(await fetchRoundTicks(job.row.f, 16));
      } catch {
        track = null;
      }
      feats = roundFeatures({
        meta,
        track,
        row: job.row,
        teamIdx: job.teamIdx,
        network,
        utilDb,
        mapCode
      });
    } catch {
      feats = null;
    }
    if (feats) rounds.push(feats);
    done++;
    onProgress?.(done, jobs.length);
  });
  if (!rounds.length) throw new Error('None of the selected rounds could be read.');
  rounds.sort((a, b) => a.demoId.localeCompare(b.demoId) || a.round - b.round);

  const firstEngagement = finishFirstEngagement(aggFirstEngagement(rounds), roster, network);

  return {
    mapCode,
    rounds: rounds.length,
    ticked: rounds.filter((r) => r.hasTicks).length,
    zonesReady: Boolean(network?.positions?.length),
    utilityDb: Boolean(utilDb?.utilities?.length),
    sections: {
      pistols: aggPistols(rounds, mapCode, laneSets, network),
      positions: aggPositions(rounds, roster, mapCode),
      pace: aggPace(rounds),
      utility: aggUtility(rounds),
      fiveVfour: aggAdvantage(rounds, '5v4'),
      fourVfive: aggAdvantage(rounds, '4v5'),
      force: aggForce(rounds),
      firstEngagement,
      patterns: aggPatterns(rounds, roster),
      afterplants: aggPostplant(rounds, 'T'),
      retakes: {
        zones: aggPostplant(rounds, 'CT'),
        winrates: aggRetakeWinrates(rounds)
      },
      tEarly: aggPhase(rounds, 'early'),
      tMid: aggPhase(rounds, 'mid'),
      tLate: aggPhase(rounds, 'late')
    }
  };
}
