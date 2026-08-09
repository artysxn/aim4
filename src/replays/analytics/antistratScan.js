// ---------------------------------------------------------------------------
// Teams antistrat: the scan engine.
//
// Walks every included round of the scouted team on one map, loading round
// meta + stride-16 ticks (sampled at 1s), and reduces them to the report's
// numbers. Geometry questions go through the map's zone network (positions /
// zones / areas, key zones, bomb sites); grenade naming goes through the
// private utility database within UTILITY_MATCH_UNITS of a stored spot; role
// names come from the roles system (demo.roles), so they match the Roles &
// Positions editor. Clocks count down from 1:55 ("1:35" = 20s elapsed).
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchRoundTicks, fetchZones } from '../api.js';
import { TickTrack } from '../tickStore.js';
import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { phaseBounds, phaseAtTick } from '../coach/roundPhases.js';
import { openingSituation } from '../shared/openingSituation.js';
import { buyBucket } from '../shared/roundId.js';
import { tagTrigger, teamNameKey } from '../shared/statsMath.js';
import { loadCoachSmokes, matchCoachSmoke } from '../coach/coachSmokes.js';
import { roleForPlayer } from '../roles/computeRoles.js';
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
import {
  regionGroupLabel,
  requiredRegionGroups,
  requiredUtilityNames,
  roundTypeRows
} from './roundLibrary.js';
import { rowTags } from './roundTags.js';
import { createRegionIndex } from './roundFacts.js';

/** Grenade must land within this of a stored spot to take its name. */
export const UTILITY_MATCH_UNITS = 100;
/** "Near" a key zone / site piece, in world units past its bounds. */
const NEAR_PAD = 250;
/** Two teammates within this of each other chain into one core. */
const CORE_LINK_UNITS = 600;
/** Seconds between position samples (ticks are fetched at stride 16). */
const SAMPLE_SECONDS = 1;
/** Advantage window after the opening kill (5v4 / 4v5 reads). */
const ADVANTAGE_WINDOW_SECONDS = 20;
/** Spacing series length after the opening kill, in seconds. */
const SPACING_SECONDS = 30;
/** Afterplant / retake positions are read this long after the plant. */
const POSTPLANT_SECONDS = 8;
/** A set call commits between 1:50 and 1:20 on the round clock. */
const SETCALL_FROM = 110;
const SETCALL_TO = 80;
/** Widest first-kill spread allowed inside one merged set call, in seconds. */
const SETCALL_CLOCK_SPAN = 8;
/** Field separator inside a utility signature key. */
const UTIL_SEP = '\u0001';

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

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
export const NADE_LABEL = {
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
  if (!b || !Number.isFinite(b.minX)) return Infinity;
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dy = Math.max(b.minY - y, 0, y - b.maxY);
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
  if (!n) return { size: 0, cx: 0, cy: 0 };
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
    cy: best.length ? cy / best.length : 0
  };
}

function topCounts(map, limit = 6) {
  return [...map.entries()]
    .map(([name, count]) => ({ name: String(name), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function bump(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

// ---------------------------------------------------------------------------
// Per-round feature extraction
// ---------------------------------------------------------------------------

function roundFeatures({ meta, track, row, teamIdx, opponent, context, network, utilDb, mapCode }) {
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

  const bounds = phaseBounds(meta);
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
      weapon: k.weapon || '',
      x: Number.isFinite(k._wx) ? k._wx : null,
      y: Number.isFinite(k._wy) ? k._wy : null,
      attackerOurs: ourIds.has(k.attacker),
      victimOurs: ourIds.has(k.victim)
    });
  }
  const aliveAt = (id, tick) => !deadAt.has(id) || deadAt.get(id) > tick;

  // Sample series over the live round, 1s resolution. Points carry whether the
  // body had the AWP out, which is what puts the ⊕ on a formation and what
  // separates the AWPer's two heatmaps.
  const weaponNames = (meta.weapons || []).map((w) =>
    String(w || '').toLowerCase().replace(/^weapon_/, '')
  );
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
        pts.push({
          id: p.id,
          x: s.x,
          y: s.y,
          pos: names[0] || '',
          awp: weaponNames[s.weapon] === 'awp'
        });
      }
      series.push({ tick, elapsed: elapsedOf(tick), pts });
    }
  }
  const sampleAt = (tick) => {
    if (!series.length) return null;
    const i = Math.round((tick - t0) / (SAMPLE_SECONDS * tickRate));
    return series[Math.max(0, Math.min(series.length - 1, i))] || null;
  };

  // Backfill kill points from the victim's tick sample when the event carried
  // no world position.
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

  // The opening kill gets named ground on both ends (for the Openings report):
  // where the shooter stood, and where the victim dropped.
  const firstKill = kills[0] || null;
  if (firstKill && network) {
    firstKill.attackerZone = '';
    firstKill.victimZone =
      firstKill.x !== null
        ? positionsAtPoint(firstKill.x, firstKill.y, network).map((z) => z.name)[0] || ''
        : '';
    if (track) {
      const shooter = roster.find((x) => x.id === firstKill.attacker);
      if (shooter) {
        const s = track.sample(shooter.slot, firstKill.tick, {});
        if (Number.isFinite(s.x) && Number.isFinite(s.y) && (s.x || s.y)) {
          firstKill.attackerZone =
            positionsAtPoint(s.x, s.y, network).map((z) => z.name)[0] || '';
        }
      }
    }
  }

  // First visit tick per named position (new-ground reads).
  const firstVisit = new Map();
  for (const s of series) {
    for (const p of s.pts) {
      if (p.pos && !firstVisit.has(p.pos)) firstVisit.set(p.pos, s.tick);
    }
  }

  // Our grenades, named against the utility database, phase-stamped.
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
      // Seconds since the round went live, at the detonation. The clock below
      // is the throw, counting down; anything filtering on when a piece of
      // utility was UP wants this one.
      at: elapsedOf(det),
      clock: clockOf(Number(g.throwTick ?? det)),
      phase: phaseAtTick(det, bounds),
      player: g.player,
      x,
      y,
      fx: Number.isFinite(g.from?.x) ? g.from.x : null,
      fy: Number.isFinite(g.from?.y) ? g.from.y : null,
      name: db?.name || '',
      sx: Number.isFinite(db?.detonate?.x) ? db.detonate.x : null,
      sy: Number.isFinite(db?.detonate?.y) ? db.detonate.y : null,
      zone
    });
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

  /** Players of ours in / near (pad) a site's ground (site + key zones). */
  const towardCount = (sample, site, pad = NEAR_PAD) => {
    if (!sample) return 0;
    let n = 0;
    for (const p of sample.pts) {
      if (nearAnyPiece(p.x, p.y, towardPieces[site], pad)) n++;
    }
    return n;
  };

  // Which site the T side committed to. On our own T rounds this is the call;
  // on CT rounds it is what we were hit by, and since only our own players are
  // sampled it has to come from the plant, or failing that from where the
  // round's fighting happened.
  let hitSite = plantSite;
  if (!hitSite) {
    let nearA = 0;
    let nearB = 0;
    for (const k of kills) {
      if (k.x === null) continue;
      if (nearAnyPiece(k.x, k.y, towardPieces.a)) nearA++;
      if (nearAnyPiece(k.x, k.y, towardPieces.b)) nearB++;
    }
    hitSite = nearA > nearB ? 'a' : nearB > nearA ? 'b' : null;
  }

  /** First sample with `count`+ of ours inside either site's pieces. */
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

  // Round library tags ride in on the stats row: they were computed once when
  // the index was built, for both sides of the round, so they need no ticks
  // here and mean the same thing whichever team is being scouted.
  const tags = row.rl ? { T: rowTags(row, 'T'), CT: rowTags(row, 'CT') } : null;

  return {
    file: row.f,
    demoId: row.d,
    round: row.n,
    // Where the round sits in its half, and the score going into it.
    inHalf: context?.inHalf || 0,
    ourHalf: context?.ourHalf || 0,
    theirHalf: context?.theirHalf || 0,
    opponent,
    side,
    won,
    tags,
    ownEcon,
    oppEcon,
    situation: openingSituation(meta, teamIdx),
    kills,
    firstKill,
    nades,
    plantTick,
    plantClock: plantTick != null ? clockOf(plantTick) : null,
    plantSite,
    hitSite,
    bounds,
    tickRate,
    t0,
    endTick,
    series,
    sampleAt,
    firstVisit,
    towardCount,
    siteEntry,
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

/** The site a T round committed to: the plant, else the first 2-man entry. */
function paceSite(r) {
  return r.plantSite || r.siteEntry(2)?.site || null;
}

// ---------------------------------------------------------------------------
// Aggregators (one per report category)
// ---------------------------------------------------------------------------

const filesOf = (list) => list.map((r) => r.file);

/** Named label for a grenade: database name first, zone fallback. */
const nadeLabel = (n) => n.name || n.zone || '';

/** Round-type key to label for one map and side, Default included. */
function typeLabels(mapCode, side) {
  const out = new Map();
  for (const def of roundTypeRows(mapCode, side)) out.set(def.key, def.label);
  return out;
}

/**
 * Most rounds one grenade record keeps a file list for. Matches the document
 * renderer's own link cap, and keeps the embedded JSON small enough that a
 * report with two utility maps on it still saves.
 */
const UTIL_FILES_MAX = 40;

/**
 * A grenade seen once per round: its rounds, a capped file list to link, and
 * which round types those rounds were tagged as.
 */
function utilRecord(fields) {
  return { ...fields, seen: new Set(), files: [], byType: new Map() };
}

/**
 * Fold one round into a record. Counting is over every round; the file list
 * and the per-type positions stop at the cap, because the whole structure ends
 * up inside a document attribute.
 */
function addUtilRound(rec, file, tags) {
  if (rec.seen.has(file)) return;
  rec.seen.add(file);
  const at = rec.files.length < UTIL_FILES_MAX ? rec.files.push(file) - 1 : -1;
  for (const tag of tags || []) {
    if (!rec.byType.has(tag.k)) rec.byType.set(tag.k, { n: 0, idx: [] });
    const bag = rec.byType.get(tag.k);
    bag.n++;
    if (at >= 0) bag.idx.push(at);
  }
}

/**
 * Which round types a record's rounds were tagged as, biggest first.
 *
 * `idx` are positions in the record's file list rather than repeated file
 * names: a round can carry several tags, so the lists overlap.
 *
 * @param {{ seen: Set<string>, byType: Map<string, { n: number, idx: number[] }> }} rec
 * @param {Map<string, string>} labels
 */
function typeBreakdown(rec, labels) {
  const total = rec.seen.size;
  return [...rec.byType.entries()]
    .map(([key, bag]) => ({
      key,
      label: labels.get(key) || key,
      rounds: bag.n,
      share: pct(bag.n, total),
      idx: bag.idx
    }))
    .sort((a, b) => b.rounds - a.rounds || a.label.localeCompare(b.label));
}

/**
 * Every named grenade on one side, one record per throw.
 *
 * The written averages above stay a full-buy-vs-full-buy read, but the map
 * carries the whole side, because the widget is where the slicing happens now:
 * the reader sets a buy and a stretch of the round and the counts recompute.
 * Aggregating here would fix a picture the reader wants to move.
 *
 * Throws are flat — `[nameIdx, typeIdx, x, y, t, roundIdx, ...]` — and rounds
 * are listed once with their buys and their tags, so nothing is repeated per
 * grenade.
 */
function liveUtility(rounds, side, labels) {
  const set = rounds.filter((r) => r.side === side);
  if (!set.length) return null;
  const names = [];
  const nameIdx = new Map();
  const indexOf = (name) => {
    if (!nameIdx.has(name)) {
      nameIdx.set(name, names.length);
      names.push(name);
    }
    return nameIdx.get(name);
  };
  const roundList = [];
  const throws = [];
  for (const r of set) {
    const hits = r.nades.filter((n) => nadeLabel(n));
    if (!hits.length) continue;
    const at = roundList.length;
    roundList.push({
      f: r.file,
      own: r.ownEcon,
      opp: r.oppEcon,
      w: r.won ? 1 : 0,
      k: (r.tags?.[side] || []).map((t) => t.k).filter((k) => k !== 'default')
    });
    for (const n of hits) {
      const x = n.sx !== null ? n.sx : n.x;
      const y = n.sy !== null ? n.sy : n.y;
      // Same rule as the heat points: an unreadable throw is left out, never
      // carried as a null that the sliders would read as second zero.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(n.at)) continue;
      throws.push(
        indexOf(nadeLabel(n)),
        NADE_KINDS.indexOf(n.type),
        Math.round(x),
        Math.round(y),
        Math.round(n.at),
        at
      );
    }
  }
  if (!throws.length) return null;
  const types = {};
  for (const [key, label] of labels) types[key] = label;
  return { names, kinds: NADE_KINDS, rounds: roundList, throws, types };
}

function aggUtility(rounds, mapCode) {
  const out = { sides: {} };
  for (const side of ['T', 'CT']) {
    const labels = typeLabels(mapCode, side);
    const set = rounds.filter((r) => r.side === side && r.ownEcon === 4 && r.oppEcon === 4);
    if (!set.length) continue;
    const avg = {};
    for (const kind of NADE_KINDS) {
      let thrown = 0;
      for (const r of set) thrown += r.nades.filter((n) => n.type === kind).length;
      avg[kind] = round1(thrown / set.length);
    }
    // One record per (name, type, phase) with a landing point, for the
    // hoverable utility map. Database spots keep their stored coordinates;
    // zone-named landings average out.
    const byKey = new Map();
    for (const r of set) {
      for (const n of r.nades) {
        const label = nadeLabel(n);
        if (!label) continue;
        const key = `${label}\0${n.type}\0${n.phase}`;
        if (!byKey.has(key)) {
          byKey.set(
            key,
            utilRecord({
              clocks: [],
              xs: [],
              ys: [],
              name: label,
              type: n.type,
              phase: n.phase,
              spot: n.sx !== null && n.sy !== null ? { x: n.sx, y: n.sy } : null
            })
          );
        }
        const rec = byKey.get(key);
        rec.clocks.push(n.clock);
        rec.xs.push(n.x);
        rec.ys.push(n.y);
        // Once per round, however many of this grenade landed there: the
        // question the map answers is "which rounds does this piece show up
        // in", and a double smoke is still one round.
        addUtilRound(rec, r.file, r.tags?.[side]);
      }
    }
    const items = [...byKey.values()]
      .map((rec) => ({
        name: rec.name,
        type: rec.type,
        phase: rec.phase,
        rounds: rec.seen.size,
        share: pct(rec.seen.size, set.length),
        clock: fmtClock(avgOf(rec.clocks)),
        x: Math.round(rec.spot ? rec.spot.x : avgOf(rec.xs)),
        y: Math.round(rec.spot ? rec.spot.y : avgOf(rec.ys)),
        files: rec.files,
        types: typeBreakdown(rec, labels).slice(0, 6)
      }))
      .filter((t) => t.share >= 10)
      .sort((a, b) => b.share - a.share)
      .slice(0, 48);
    out.sides[side] = {
      rounds: set.length,
      files: filesOf(set),
      avg,
      items,
      live: liveUtility(rounds, side, labels)
    };
  }
  return out;
}

/** A piece of utility has to appear this often before it can be a tell. */
export const TELL_MIN_ROUNDS = 5;
/** And this much of those rounds has to be the same call. */
export const TELL_MIN_SHARE = 80;

/**
 * Utility that gives the round away.
 *
 * One grenade, one landing spot, and almost always the same call behind it:
 * a Blue smoke that is a B Execute in eight of nine rounds is a read the
 * moment it lands. Phases are merged (a tell is a tell whenever it comes) and
 * so are buys, because the point is prediction, not economy.
 *
 * Default / Other can never be the answer — "they smoke Blue and then do
 * nothing in particular" is not something to call a timeout over.
 */
export function aggTells(rounds, mapCode) {
  const out = { sides: {}, minRounds: TELL_MIN_ROUNDS, minShare: TELL_MIN_SHARE };
  for (const side of ['T', 'CT']) {
    const labels = typeLabels(mapCode, side);
    const set = rounds.filter((r) => r.side === side);
    if (!set.length) continue;
    const byKey = new Map();
    for (const r of set) {
      for (const n of r.nades) {
        const label = nadeLabel(n);
        if (!label) continue;
        const key = `${label}\0${n.type}`;
        if (!byKey.has(key)) byKey.set(key, utilRecord({ name: label, type: n.type }));
        addUtilRound(byKey.get(key), r.file, r.tags?.[side]);
      }
    }
    const tells = [];
    for (const rec of byKey.values()) {
      if (rec.seen.size < TELL_MIN_ROUNDS) continue;
      const ranked = typeBreakdown(rec, labels).filter((t) => t.key !== 'default');
      const top = ranked[0];
      if (!top || top.share < TELL_MIN_SHARE) continue;
      tells.push({
        name: rec.name,
        type: rec.type,
        rounds: rec.seen.size,
        label: top.label,
        hits: top.rounds,
        share: top.share,
        files: rec.files,
        hitFiles: top.idx.map((i) => rec.files[i]),
        // What the rest of those rounds were, for the row's tail.
        others: ranked.slice(1, 3).map((t) => ({ label: t.label, rounds: t.rounds }))
      });
    }
    tells.sort((a, b) => b.share - a.share || b.rounds - a.rounds);
    if (tells.length) out.sides[side] = { rounds: set.length, tells };
  }
  return out;
}

function spacingSeries(set) {
  const sums = new Array(SPACING_SECONDS + 1).fill(0);
  const counts = new Array(SPACING_SECONDS + 1).fill(0);
  const killMarks = new Array(SPACING_SECONDS + 1).fill(0);
  const deathMarks = new Array(SPACING_SECONDS + 1).fill(0);
  const perRound = [];
  for (const r of set) {
    if (!r.firstKill || !r.hasTicks) continue;
    const k0 = r.firstKill.tick;
    const values = [];
    for (let s = 0; s <= SPACING_SECONDS; s++) {
      const sample = r.sampleAt(k0 + s * r.tickRate);
      const d = sample ? avgPairDistance(sample.pts) : null;
      values.push(d !== null ? Math.round(d) : null);
      if (d !== null) {
        sums[s] += d;
        counts[s]++;
      }
    }
    for (const k of r.kills) {
      if (k.tick <= k0) continue;
      const s = Math.round((k.tick - k0) / r.tickRate);
      if (s < 0 || s > SPACING_SECONDS) continue;
      if (k.attackerOurs) killMarks[s]++;
      else deathMarks[s]++;
    }
    if (perRound.length < 80) {
      perRound.push({ label: `vs ${r.opponent} R${r.round}`, file: r.file, values });
    }
  }
  return {
    avg: sums.map((v, i) => (counts[i] ? Math.round(v / counts[i]) : null)),
    kills: killMarks,
    deaths: deathMarks,
    rounds: perRound,
    n: perRound.length
  };
}

function advantageBlock(set, side) {
  const out = { rounds: set.length, files: filesOf(set) };
  if (!set.length) return out;

  if (side === 'T') {
    const sites = new Map();
    for (const r of set) {
      const site = paceSite(r);
      if (site) bump(sites, site.toUpperCase());
    }
    const basis = [...sites.values()].reduce((a, b) => a + b, 0);
    out.site = basis
      ? { a: pct(sites.get('A') || 0, basis), b: pct(sites.get('B') || 0, basis), basis }
      : null;

    // Per committed site: seconds from the opening kill until a 3-man core is
    // on that site's ground.
    out.siteCore = {};
    for (const letter of ['a', 'b']) {
      const secs = [];
      for (const r of set) {
        if (!r.firstKill || !r.hasTicks || paceSite(r) !== letter) continue;
        for (const s of r.series) {
          if (s.tick < r.firstKill.tick) continue;
          if (r.towardCount(s, letter) >= 3) {
            secs.push((s.tick - r.firstKill.tick) / r.tickRate);
            break;
          }
        }
      }
      if (secs.length) out.siteCore[letter] = { seconds: round1(avgOf(secs)), rounds: secs.length };
    }
  }

  const tempos = [];
  const newGround = [];
  const distAt = [];
  for (const r of set) {
    if (!r.firstKill || !r.hasTicks) continue;
    const k = r.firstKill.tick;
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
      if (tick > k && tick <= k + ADVANTAGE_WINDOW_SECONDS * r.tickRate) fresh++;
    }
    newGround.push(fresh);

    const s0 = r.sampleAt(k);
    const d0 = s0 ? avgPairDistance(s0.pts) : null;
    if (d0 !== null) distAt.push(d0);
  }
  out.tempoSeconds = tempos.length ? round1(avgOf(tempos)) : null;
  out.newGround = newGround.length ? round1(avgOf(newGround)) : null;
  out.avgDistance = distAt.length ? Math.round(avgOf(distAt)) : null;
  out.window = ADVANTAGE_WINDOW_SECONDS;
  out.spacing = spacingSeries(set);
  return out;
}

function aggAdvantage(rounds, want) {
  const match = (r) =>
    want === '5v4'
      ? r.situation === '5v4' || r.situation === '5v3'
      : r.situation === '4v5' || r.situation === '3v5';
  return {
    T: advantageBlock(rounds.filter((r) => r.side === 'T' && match(r)), 'T'),
    CT: advantageBlock(rounds.filter((r) => r.side === 'CT' && match(r)), 'CT')
  };
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
        const site = paceSite(r);
        if (site) bump(sites, site.toUpperCase());
        const c = r.plantClock ?? r.siteEntry(2)?.clock ?? null;
        if (c !== null) clocks.push(c);
      }
      clocks.sort((a, b) => b - a);
      const basis = [...sites.values()].reduce((a, b) => a + b, 0);
      out.T = {
        rounds: set.length,
        files: filesOf(set),
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
        files: filesOf(set),
        leanA: pct(leanA, set.length),
        leanB: pct(leanB, set.length),
        medianClock: clocks.length ? fmtClock(clocks[Math.floor(clocks.length / 2)]) : ''
      };
    }
  }
  return out;
}

function aggFirstEngagement(rounds, nameOf, network) {
  const out = {};
  for (const side of ['T', 'CT']) {
    const set = rounds.filter((r) => r.side === side && r.firstKill);
    if (!set.length) continue;
    const clocks = [];
    const points = [];
    /** @type {Map<string, { count: number, zones: Map<string, { count: number, clocks: number[] }> }>} */
    const killers = new Map();
    let oursFirst = 0;
    for (const r of set) {
      const k = r.firstKill;
      clocks.push(k.clock);
      // The opening kill's own clock is what the slider cuts on: an opening at
      // 1:45 and one at 0:50 are different rounds, and this is where you see it.
      if (k.x !== null && k.y !== null) {
        points.push({
          x: k.x,
          y: k.y,
          t: ROUND_SECONDS - k.clock,
          own: r.ownEcon,
          opp: r.oppEcon
        });
      }
      if (!k.attackerOurs) continue;
      oursFirst++;
      if (!killers.has(k.attacker)) killers.set(k.attacker, { count: 0, zones: new Map() });
      const rec = killers.get(k.attacker);
      rec.count++;
      if (k.x !== null && network) {
        const zone = positionsAtPoint(k.x, k.y, network).map((z) => z.name)[0] || '';
        if (zone) {
          if (!rec.zones.has(zone)) rec.zones.set(zone, { count: 0, clocks: [] });
          const z = rec.zones.get(zone);
          z.count++;
          z.clocks.push(k.clock);
        }
      }
    }
    clocks.sort((a, b) => b - a);
    out[side] = {
      rounds: set.length,
      medianClock: fmtClock(clocks[Math.floor(clocks.length / 2)]),
      avgClock: fmtClock(avgOf(clocks)),
      wonShare: pct(oursFirst, set.length),
      heat: packPoints(points),
      killers: [...killers.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 6)
        .map(([id, rec]) => ({
          name: nameOf.get(id) || id,
          count: rec.count,
          zones: [...rec.zones.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 3)
            .map(([zone, z]) => ({
              name: zone,
              count: z.count,
              clock: fmtClock(avgOf(z.clocks))
            }))
        }))
    };
  }
  return out;
}

function aggPatterns(rounds, nameOf) {
  const t = rounds.filter((r) => r.side === 'T' && r.hasTicks);
  const early = (r) => r.series.filter((s) => s.tick < r.bounds.midStartTick);

  const stackRounds = (site) => t.filter((r) => early(r).some((s) => r.towardCount(s, site) >= 4));
  const bStack = stackRounds('b');
  const aStack = stackRounds('a');
  const setCallList = [...new Set([...bStack, ...aStack])];
  const setCallFiles = new Set(setCallList.map((r) => r.file));
  const defaults = t.filter((r) => !setCallFiles.has(r.file));
  const winrate = (list) => pct(list.filter((r) => r.won).length, list.length);

  const earlyFights = rounds.filter((r) => {
    const inWindow = r.kills.filter((k) => k.clock >= 95);
    const oursIn = new Set();
    const theirsIn = new Set();
    for (const k of inWindow) {
      (k.attackerOurs ? oursIn : theirsIn).add(k.attacker);
      (k.victimOurs ? oursIn : theirsIn).add(k.victim);
    }
    return oursIn.size >= 2 && theirsIn.size >= 2;
  });

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
    const share = pct(top.count, rec.total);
    if (share >= 50) {
      ctSpots.push({ name: nameOf.get(id) || id, spot: top.name, share, rounds: rec.total });
    }
  }
  ctSpots.sort((a, b) => b.share - a.share);

  return {
    tRounds: t.length,
    bStack: { count: bStack.length, share: pct(bStack.length, t.length), files: filesOf(bStack) },
    aStack: { count: aStack.length, share: pct(aStack.length, t.length), files: filesOf(aStack) },
    compare: {
      defaults: { count: defaults.length, winrate: winrate(defaults), files: filesOf(defaults) },
      setCalls: {
        count: setCallList.length,
        winrate: winrate(setCallList),
        files: filesOf(setCallList)
      }
    },
    earlyFights: {
      count: earlyFights.length,
      share: pct(earlyFights.length, rounds.length),
      files: filesOf(earlyFights)
    },
    ctSpots
  };
}

function aggTFormations(rounds, mapCode, laneSets) {
  const set = rounds.filter((r) => {
    const pace = classifyPace(r);
    return pace === 'default' || pace === 'slow-default';
  });
  const byForm = new Map();
  for (const r of set) {
    const f = laneFormation(r, mapCode, laneSets);
    if (!f) continue;
    if (!byForm.has(f)) byForm.set(f, []);
    byForm.get(f).push(r);
  }
  return {
    basis: set.length,
    files: filesOf(set),
    rows: [...byForm.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([formation, list]) => ({
        formation,
        count: list.length,
        share: pct(list.length, set.length),
        files: filesOf(list)
      }))
  };
}

/**
 * The afterplant window, relative to the plant: five seconds before it, and
 * the forty the bomb takes to go off.
 */
export const PLANT_SPAN = { from: -5, to: 40 };

function aggPostplant(rounds, side) {
  const out = {};
  for (const site of ['a', 'b']) {
    const set = rounds.filter(
      (r) => r.side === side && r.plantTick != null && r.plantSite === site && r.hasTicks
    );
    if (!set.length) continue;
    const zoneRounds = new Map();
    const distinct = [];
    const points = [];
    for (const r of set) {
      const s = r.sampleAt(r.plantTick + POSTPLANT_SECONDS * r.tickRate);
      if (!s) continue;
      const seen = new Set();
      for (const p of s.pts) {
        if (p.pos) seen.add(p.pos);
      }
      for (const z of seen) bump(zoneRounds, z);
      distinct.push(seen.size);
      // The heat runs on the bomb, not the round clock: from five seconds
      // before the plant to the forty it takes to go off. Sampled across the
      // whole of it so the sliders have a window to cut rather than one frame.
      for (let rel = PLANT_SPAN.from; rel <= PLANT_SPAN.to; rel += 2) {
        const at = r.sampleAt(r.plantTick + rel * r.tickRate);
        if (!at) continue;
        for (const p of at.pts) {
          points.push({ x: p.x, y: p.y, t: rel, own: r.ownEcon, opp: r.oppEcon });
        }
      }
    }
    out[site] = {
      rounds: set.length,
      files: filesOf(set),
      avgZones: distinct.length ? round1(avgOf(distinct)) : null,
      heat: packPoints(points),
      span: PLANT_SPAN,
      top: topCounts(zoneRounds).map((t) => ({ name: t.name, share: pct(t.count, set.length) }))
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
    const zoneRounds = new Map();
    for (const r of set) {
      if (!r.hasTicks) continue;
      const s = r.sampleAt(r.plantTick + POSTPLANT_SECONDS * r.tickRate);
      const seen = new Set();
      for (const p of s?.pts || []) if (p.pos) seen.add(p.pos);
      for (const z of seen) bump(zoneRounds, z);
    }
    out[site] = {
      rounds: set.length,
      files: filesOf(set),
      winrate: pct(set.filter((r) => r.won).length, set.length),
      top: topCounts(zoneRounds, 4).map((t) => ({ name: t.name, share: pct(t.count, set.length) }))
    };
  }
  return out;
}

function aggPhase(rounds, phase, side = 'T') {
  const t = rounds.filter((r) => r.side === side && r.hasTicks);
  const windowOf = (r) => ({
    from: phase === 'early' ? r.t0 : phase === 'mid' ? r.bounds.midStartTick : r.bounds.lateStartTick,
    to: phase === 'early' ? r.bounds.midStartTick : phase === 'mid' ? r.bounds.lateStartTick : r.endTick
  });

  let utilPush = 0;
  let dryPush = 0;
  let basis = 0;
  const coreSizes = [];
  const coreDists = [];
  const groundRounds = new Map();
  const utilTotals = { smokegrenade: 0, molotov: 0, flashbang: 0, hegrenade: 0 };
  let killsFor = 0;
  let killsAgainst = 0;

  for (const r of t) {
    const { from, to } = windowOf(r);
    if (to <= from) continue;
    basis++;
    const inWin = (tick) => tick >= from && tick < to;
    const nades = r.nades.filter((n) => inWin(n.tick));
    const samples = r.series.filter((s) => inWin(s.tick) && s.pts.length);
    const killsIn = r.kills.filter((k) => inWin(k.tick));

    for (const n of nades) utilTotals[n.type]++;
    killsFor += killsIn.filter((k) => k.attackerOurs).length;
    killsAgainst += killsIn.filter((k) => k.victimOurs).length;

    const ground = new Set();
    for (const s of samples) {
      for (const p of s.pts) if (p.pos) ground.add(p.pos);
    }
    for (const z of ground) bump(groundRounds, z);

    if (nades.length >= 3 && samples.length >= 2) {
      const mx = avgOf(nades.map((n) => n.x));
      const my = avgOf(nades.map((n) => n.y));
      const c0 = coreOf(samples[0].pts);
      const c1 = coreOf(samples[samples.length - 1].pts);
      const approached =
        c0.size > 0 &&
        c1.size > 0 &&
        Math.hypot(c0.cx - mx, c0.cy - my) - Math.hypot(c1.cx - mx, c1.cy - my) >= 200;
      const foughtNear = killsIn.some(
        (k) => k.x !== null && nades.some((n) => Math.hypot(n.x - k.x, n.y - k.y) <= CORE_LINK_UNITS)
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

  return {
    basis,
    utilPush,
    dryPush,
    avgCoreSize: coreSizes.length ? round1(avgOf(coreSizes)) : null,
    avgCoreDistance: coreDists.length ? Math.round(avgOf(coreDists)) : null,
    ground: topCounts(groundRounds, 5).map((t2) => ({
      name: t2.name,
      share: pct(t2.count, basis)
    })),
    util: basis
      ? {
          smokes: round1(utilTotals.smokegrenade / basis),
          molotovs: round1(utilTotals.molotov / basis),
          flashes: round1(utilTotals.flashbang / basis),
          he: round1(utilTotals.hegrenade / basis)
        }
      : null,
    killsFor: basis ? round1(killsFor / basis) : null,
    killsAgainst: basis ? round1(killsAgainst / basis) : null
  };
}

function snapshotSample(r, mapCode) {
  const snap = clockSeconds(FORMATIONS[mapCode]?.snapshot || '');
  if (snap === null) return null;
  return r.sampleAt(r.t0 + (ROUND_SECONDS - snap) * r.tickRate);
}

/**
 * Where a T pistol was heading at the snapshot, before it committed.
 *
 * The lean is a headcount toward each site at the formation clock: whoever has
 * more bodies pointed at them is the site the round is showing.
 */
export function pistolLean(r, mapCode) {
  const snap = snapshotSample(r, mapCode);
  if (!snap) return '';
  const a = r.towardCount(snap, 'a');
  const b = r.towardCount(snap, 'b');
  if (a === b) return '';
  return a > b ? 'A' : 'B';
}

function aggPistols(rounds, mapCode, laneSets) {
  const t = rounds.filter((r) => r.side === 'T' && r.ownEcon === 0);
  const ct = rounds.filter((r) => r.side === 'CT' && r.ownEcon === 0);
  const namesOf = (r, kind) =>
    [...new Set(r.nades.filter((n) => n.type === kind && n.name).map((n) => n.name))];
  const tRows = t.map((r) => {
    // Where they showed, and where the bomb actually went. A round that shows
    // one site and plants the other is the turnaround.
    const shown = pistolLean(r, mapCode);
    const site = paceSite(r)?.toUpperCase() || '';
    return {
      opponent: r.opponent,
      file: r.file,
      formation: laneFormation(r, mapCode, laneSets) || '',
      pace: classifyPace(r),
      site,
      shown,
      planted: Boolean(r.plantTick != null && r.plantSite),
      turnaround: Boolean(shown && site && shown !== site),
      smokes: namesOf(r, 'smokegrenade'),
      molotovs: namesOf(r, 'molotov'),
      won: r.won
    };
  });
  const read = tRows.filter((x) => x.shown && x.site);
  const turned = read.filter((x) => x.turnaround);
  return {
    ctOrder: (FORMATIONS[mapCode]?.ct || []).map((c) => c.label),
    turnaround: read.length
      ? {
          rounds: read.length,
          turned: turned.length,
          share: pct(turned.length, read.length),
          wins: turned.filter((x) => x.won).length,
          winrate: pct(turned.filter((x) => x.won).length, turned.length),
          heldWinrate: pct(
            read.filter((x) => !x.turnaround && x.won).length,
            read.length - turned.length
          ),
          files: turned.map((x) => x.file)
        }
      : null,
    t: tRows,
    ct: ct.map((r) => {
      const snap = snapshotSample(r, mapCode);
      const a = snap ? r.towardCount(snap, 'a', 0) : 0;
      const b = snap ? r.towardCount(snap, 'b', 0) : 0;
      const alive = snap ? snap.pts.length : 0;
      return {
        opponent: r.opponent,
        file: r.file,
        a,
        b,
        ee: Math.max(0, alive - a - b),
        won: r.won
      };
    })
  };
}

/** Lane region names from patternDefs, resolved to network position names. */
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

/** Per-lane player counts at the snapshot clock, or null without geometry. */
function laneCountsAt(r, mapCode, laneSets) {
  if (!laneSets) return null;
  const snap = snapshotSample(r, mapCode);
  if (!snap || !snap.pts.length) return null;
  const counts = laneSets.map(() => 0);
  // Which lane the AWP stood in at the snapshot, for the ⊕ on the notation.
  let awpLane = -1;
  for (const p of snap.pts) {
    const key = String(p.pos || '').toLowerCase();
    let hit = key ? laneSets.findIndex((s) => s.has(key)) : -1;
    if (hit === -1) hit = Math.min(1, laneSets.length - 1);
    counts[hit]++;
    if (p.awp && awpLane === -1) awpLane = hit;
  }
  counts.awpLane = awpLane;
  return counts;
}

/** T formation notation at the snapshot clock, or '' when unresolvable. */
function laneFormation(r, mapCode, laneSets) {
  const counts = laneCountsAt(r, mapCode, laneSets);
  return counts ? formatFormation(mapCode, counts, counts.awpLane) : '';
}

/** "4 B, 1 Mid" from lane counts, zeros skipped. */
function laneSpread(mapCode, counts) {
  if (!counts) return '';
  const lanes = FORMATIONS[mapCode]?.t || [];
  return counts
    .map((n, i) => (n && lanes[i] ? `${n} ${lanes[i].short}` : ''))
    .filter(Boolean)
    .join(', ');
}

const WEAPON_GROUPS = [
  ['AWP', new Set(['awp'])],
  ['Scout', new Set(['ssg08'])],
  ['Rifle', new Set(['ak47', 'm4a1', 'm4a1_silencer', 'm4a4', 'famas', 'galilar', 'aug', 'sg556'])],
  ['SMG', new Set(['mp9', 'mac10', 'mp7', 'mp5sd', 'ump45', 'p90', 'bizon'])],
  [
    'Pistol',
    new Set([
      'glock', 'usp_silencer', 'hkp2000', 'p250', 'fiveseven', 'tec9', 'cz75a', 'deagle',
      'revolver', 'elite'
    ])
  ],
  ['Shotgun', new Set(['nova', 'xm1014', 'mag7', 'sawedoff'])],
  ['MG', new Set(['m249', 'negev'])]
];

function weaponClass(weapon) {
  const w = String(weapon || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  if (!w) return 'Rifle';
  for (const [label, set] of WEAPON_GROUPS) {
    if (set.has(w)) return label;
  }
  if (/knife|bayonet|karambit/.test(w)) return 'Knife';
  if (/grenade|molotov|inc|inferno|decoy/.test(w)) return 'Grenade';
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** "1:52" or "1:44-1:39" from a list of countdown clocks. */
function clockRange(clocks) {
  if (!clocks.length) return '';
  const hi = Math.max(...clocks);
  const lo = Math.min(...clocks);
  return Math.round(hi) === Math.round(lo)
    ? fmtClock(hi)
    : `${fmtClock(hi)}-${fmtClock(lo)}`;
}

/**
 * Openings: rounds that stay alive deep (lateround starts 50s+ in) but open
 * with a kill by the scouted team inside the first 20 seconds. Merged by
 * weapon class + shooter ground + victim ground. CT keeps only AWP openings.
 */
function aggOpenings(rounds) {
  const out = {};
  for (const side of ['T', 'CT']) {
    const set = rounds.filter((r) => {
      const k = r.firstKill;
      if (r.side !== side || !k || !k.attackerOurs) return false;
      if (k.clock < 95) return false;
      if ((r.bounds.lateStartTick - r.t0) / r.tickRate < 50) return false;
      if (side === 'CT' && weaponClass(k.weapon) !== 'AWP') return false;
      return true;
    });
    if (!set.length) continue;
    /** @type {Map<string, { rounds: object[], clocks: number[] }>} */
    const groups = new Map();
    for (const r of set) {
      const k = r.firstKill;
      const key = `${weaponClass(k.weapon)}\0${k.attackerZone || ''}\0${k.victimZone || ''}`;
      if (!groups.has(key)) groups.set(key, { rounds: [], clocks: [] });
      const g = groups.get(key);
      g.rounds.push(r);
      g.clocks.push(k.clock);
    }
    out[side] = {
      rounds: set.length,
      files: filesOf(set),
      groups: [...groups.entries()]
        .sort((a, b) => b[1].rounds.length - a[1].rounds.length)
        .slice(0, 14)
        .map(([key, g]) => {
          const [weapon, from, to] = key.split('\0');
          return {
            count: g.rounds.length,
            weapon,
            from,
            to,
            clocks: clockRange(g.clocks),
            files: filesOf(g.rounds)
          };
        })
    };
  }
  return out;
}

/**
 * Set calls: T buy rounds that are not defaults and that commit inside the
 * set-call window. Two rounds merge only when the site, pace, lane spread AND
 * the exact named utility all match, and even then only while their first
 * kills sit within SETCALL_CLOCK_SPAN seconds of each other. A minute-wide
 * "first kill somewhere in here" bucket is not one call, it is a dozen.
 */
function aggSetCalls(rounds, mapCode, laneSets) {
  /** The moment the round commits: a 2-man site entry, else the first kill. */
  const commitClock = (r) => {
    const entry = r.siteEntry(2);
    if (entry) return entry.clock;
    return Number.isFinite(r.firstKill?.clock) ? r.firstKill.clock : null;
  };

  const set = rounds.filter((r) => {
    if (r.side !== 'T' || r.ownEcon < 2 || !r.hasTicks) return false;
    const pace = classifyPace(r);
    if (!pace || pace === 'default' || pace === 'slow-default') return false;
    const c = commitClock(r);
    return c !== null && c <= SETCALL_FROM && c >= SETCALL_TO;
  });
  if (!set.length) return { rounds: 0, files: [], groups: [] };

  /** @type {Map<string, { rounds: object[], counts: number[]|null, util: string[] }>} */
  const groups = new Map();
  for (const r of set) {
    const pace = classifyPace(r);
    const site = paceSite(r)?.toUpperCase() || '';
    const counts = laneCountsAt(r, mapCode, laneSets);
    // Only named utility, and only what was thrown before the window closes.
    const util = [
      ...new Set(
        r.nades
          .filter((n) => n.name && n.clock >= SETCALL_TO)
          .map((n) => `${n.name}${UTIL_SEP}${n.type}`)
      )
    ].sort();
    const key = `${site}\0${pace}\0${counts ? counts.join('-') : ''}\0${util.join('|')}`;
    if (!groups.has(key)) groups.set(key, { rounds: [], counts, util });
    groups.get(key).rounds.push(r);
  }

  const rows = [];
  for (const [key, g] of groups) {
    const [site, pace] = key.split('\0');
    const util = g.util.map((u) => {
      const [name, type] = u.split(UTIL_SEP);
      return { name, type };
    });
    // Walk the group from the earliest first kill and cut a new cluster the
    // moment the spread would exceed the span.
    const timed = g.rounds
      .filter((r) => Number.isFinite(r.firstKill?.clock))
      .sort((a, b) => b.firstKill.clock - a.firstKill.clock);
    const untimed = g.rounds.filter((r) => !Number.isFinite(r.firstKill?.clock));
    const clusters = [];
    let cur = [];
    for (const r of timed) {
      if (cur.length && cur[0].firstKill.clock - r.firstKill.clock > SETCALL_CLOCK_SPAN) {
        clusters.push(cur);
        cur = [];
      }
      cur.push(r);
    }
    if (cur.length) clusters.push(cur);
    if (untimed.length) clusters.push(untimed);

    for (const list of clusters) {
      rows.push({
        count: list.length,
        site,
        pace,
        spread: laneSpread(mapCode, g.counts),
        util,
        clocks: clockRange(list.map((r) => r.firstKill?.clock).filter(Number.isFinite)),
        files: filesOf(list)
      });
    }
  }
  rows.sort((a, b) => b.count - a.count);
  return { rounds: set.length, files: filesOf(set), groups: rows.slice(0, 20) };
}

/**
 * CT full buy vs full buy, split by which site the Ts hit: how often the
 * defense holds, and how it does once the bomb is actually down.
 */
/** How often the CT spread is sampled across the round. */
const CT_SPREAD_STEP = 8;

/**
 * Where the CT side's bodies are, every 8 seconds.
 *
 * One row per sample and one record per round, so the widget can average
 * whichever slice of buys the reader asks for rather than being handed a fixed
 * table. Counts are toward each site rather than inside it: a CT walking to B
 * is defending B before he arrives.
 */
export function aggCtSpread(rounds) {
  const set = rounds.filter((r) => r.side === 'CT' && r.hasTicks);
  if (!set.length) return null;
  const marks = [];
  for (let sec = 0; sec <= ROUND_SECONDS; sec += CT_SPREAD_STEP) marks.push(sec);
  const out = [];
  for (const r of set) {
    // Flat per round: [aliveA, aliveB, alive, ...] one triple per mark.
    const counts = [];
    let any = false;
    for (const sec of marks) {
      const s = r.sampleAt(r.t0 + sec * r.tickRate);
      if (!s || sec > r.endTick / r.tickRate - r.t0 / r.tickRate) {
        counts.push(-1, -1, -1);
        continue;
      }
      const a = r.towardCount(s, 'a');
      const b = r.towardCount(s, 'b');
      counts.push(a, b, s.pts.length);
      any = true;
    }
    if (!any) continue;
    out.push({ own: r.ownEcon, opp: r.oppEcon, w: r.won ? 1 : 0, c: counts });
  }
  if (!out.length) return null;
  return { step: CT_SPREAD_STEP, marks, rounds: out };
}

function aggCtSiteDefense(rounds) {
  const set = rounds.filter((r) => r.side === 'CT' && r.ownEcon === 4 && r.oppEcon === 4);
  const out = { rounds: set.length, sites: {}, unresolved: 0 };
  if (!set.length) return out;
  for (const site of ['a', 'b']) {
    const list = set.filter((r) => r.hitSite === site);
    if (!list.length) continue;
    const planted = list.filter((r) => r.plantTick != null);
    out.sites[site] = {
      rounds: list.length,
      share: pct(list.length, set.length),
      winrate: pct(list.filter((r) => r.won).length, list.length),
      plantedRounds: planted.length,
      plantedWinrate: pct(planted.filter((r) => r.won).length, planted.length),
      files: filesOf(list)
    };
  }
  out.unresolved = set.filter((r) => !r.hitSite).length;
  return out;
}

/**
 * Named round types of one side, measured from both ends.
 *
 * A call is two numbers, not one: how often it works when the scouted team
 * runs it, and how often it works against them when someone else does. The
 * first comes from their rounds on that side, the second from their rounds on
 * the other side of the same call — the tags describe the round, not the team,
 * so both readings come out of the same bag.
 *
 * @param {Array} rounds
 * @param {string} mapCode
 * @param {'T'|'CT'} side  which side the round types belong to
 */
function aggRoundList(rounds, mapCode, side) {
  const defs = roundTypeRows(mapCode, side);
  if (!defs.length) return null;
  const own = rounds.filter((r) => r.side === side);
  const faced = rounds.filter((r) => r.side !== side);

  /** Average of every timing mark the matched rounds recorded. */
  const marksOf = (list) => {
    /** @type {Map<string, number[]>} */
    const bag = new Map();
    for (const { tag } of list) {
      for (const [name, sec] of Object.entries(tag.m || {})) {
        if (!Number.isFinite(sec)) continue;
        if (!bag.has(name)) bag.set(name, []);
        bag.get(name).push(sec);
      }
    }
    return [...bag.entries()]
      .map(([name, secs]) => ({
        name,
        clock: fmtClock(ROUND_SECONDS - avgOf(secs)),
        seconds: round1(avgOf(secs)),
        rounds: secs.length
      }))
      .sort((a, b) => a.seconds - b.seconds);
  };

  const bucket = (list, basis) => {
    const wins = list.filter(({ r }) => r.won).length;
    // When the read came true, across the rounds it came true in.
    const triggers = list.map(({ tag }) => tagTrigger(tag)).filter((x) => x !== null);
    const at = triggers.length ? avgOf(triggers) : null;
    return {
      rounds: list.length,
      wins,
      losses: list.length - wins,
      winrate: pct(wins, list.length),
      share: pct(list.length, basis),
      files: list.map(({ r }) => r.file),
      when: at === null ? null : { seconds: round1(at), clock: fmtClock(ROUND_SECONDS - at) },
      marks: marksOf(list)
    };
  };

  const types = [];
  for (const def of defs) {
    const pick = (set) => {
      const out = [];
      for (const r of set) {
        const tag = (r.tags?.[side] || []).find((t) => t.k === def.key);
        if (tag) out.push({ r, tag });
      }
      return out;
    };
    // Every definition earns a row, run or not. A call this side never made is
    // as much of a read as one they made nine times, and dropping the empties
    // is what makes a thin side (CT libraries are smaller) look like a missing
    // section rather than a short one.
    types.push({
      key: def.key,
      label: def.label,
      desc: def.desc,
      for: bucket(pick(own), own.length),
      against: bucket(pick(faced), faced.length)
    });
  }
  const named = (set) =>
    set.filter((r) => (r.tags?.[side] || []).some((t) => t.k !== 'default')).length;
  return {
    side,
    ownRounds: own.length,
    facedRounds: faced.length,
    ownNamed: named(own),
    facedNamed: named(faced),
    tagged: rounds.filter((r) => r.tags).length,
    types
  };
}

/**
 * The three rounds of a half whose buy is decided for you.
 *
 * Every half runs through the same fork, and how a team plays it is a habit
 * worth writing down:
 *
 *   First gun round  they won the pistol and the follow-up, so this is the
 *                    first time both sides have money. Default or set call?
 *   Second-round     they lost the pistol and forced into it.
 *   Break force      they won the pistol, lost the second round to the other
 *                    side's force, and are now forcing at 1-1 themselves.
 *
 * Each one carries its winrate, because the shape only matters once you know
 * whether it works.
 */
const BUY_CONTEXTS = [
  {
    key: 'firstGun',
    label: 'First gun round',
    // Round 3 at 2-0 or round 4 at 3-0, both sides on a real buy.
    test: (r) =>
      r.ownEcon >= 4 &&
      r.oppEcon >= 4 &&
      ((r.inHalf === 3 && r.ourHalf === 2 && r.theirHalf === 0) ||
        (r.inHalf === 4 && r.ourHalf === 3 && r.theirHalf === 0))
  },
  {
    key: 'secondForce',
    label: 'Second-round force',
    test: (r) => r.inHalf === 2 && r.ownEcon === 3 && r.ourHalf === 0 && r.theirHalf === 1
  },
  {
    key: 'breakForce',
    label: 'Break force',
    test: (r) => r.inHalf === 3 && r.ownEcon === 3 && r.ourHalf === 1 && r.theirHalf === 1
  }
];

function aggBuyContext(rounds, mapCode) {
  const out = { sides: {} };
  for (const side of ['T', 'CT']) {
    const labels = typeLabels(mapCode, side);
    const buckets = [];
    for (const ctx of BUY_CONTEXTS) {
      const set = rounds.filter((r) => r.side === side && ctx.test(r));
      if (!set.length) continue;
      const wins = set.filter((r) => r.won).length;
      // A set call is any named round type; everything else is a default.
      let named = 0;
      const calls = new Map();
      for (const r of set) {
        const tags = (r.tags?.[side] || []).filter((t) => t.k !== 'default');
        if (tags.length) named++;
        for (const tag of tags) {
          if (!calls.has(tag.k)) calls.set(tag.k, { rounds: 0, wins: 0, files: [] });
          const rec = calls.get(tag.k);
          rec.rounds++;
          if (r.won) rec.wins++;
          if (rec.files.length < LINK_FILES_CAP) rec.files.push(r.file);
        }
      }
      buckets.push({
        key: ctx.key,
        label: ctx.label,
        rounds: set.length,
        wins,
        winrate: pct(wins, set.length),
        files: filesOf(set),
        setShare: pct(named, set.length),
        defaultShare: pct(set.length - named, set.length),
        calls: [...calls.entries()]
          .map(([key, rec]) => ({
            key,
            label: labels.get(key) || key,
            rounds: rec.rounds,
            winrate: pct(rec.wins, rec.rounds),
            files: rec.files
          }))
          .sort((a, b) => b.rounds - a.rounds || a.label.localeCompare(b.label))
          .slice(0, 4)
      });
    }
    if (buckets.length) out.sides[side] = buckets;
  }
  return Object.keys(out.sides).length ? out : null;
}

/**
 * The rounds where the other side could not buy: what our money bought us.
 *
 * Split by what THEY had, not what we had, because that is the call being
 * made — an anti-eco is a different round from an anti-force even though our
 * own buy is the same. Every bucket carries its winrate, because a team that
 * loses a third of its anti-ecos is the finding.
 */
const ANTI_BUYS = [
  { key: 'eco', label: 'Anti-eco', econs: [0, 1] },
  { key: 'force', label: 'Anti-force', econs: [2, 3] }
];

function aggAntiBuy(rounds, mapCode, laneSets) {
  const out = { sides: {} };
  for (const side of ['T', 'CT']) {
    const labels = typeLabels(mapCode, side);
    const buckets = [];
    for (const bucket of ANTI_BUYS) {
      // Ours has to be a real buy, or it is not an anti-anything.
      const set = rounds.filter(
        (r) => r.side === side && r.ownEcon >= 4 && bucket.econs.includes(r.oppEcon)
      );
      if (!set.length) continue;
      const wins = set.filter((r) => r.won).length;
      const clocks = [];
      const sites = new Map();
      let leanA = 0;
      let leanB = 0;
      const calls = new Map();
      for (const r of set) {
        if (side === 'T') {
          const site = paceSite(r);
          if (site) bump(sites, site.toUpperCase());
          const c = r.plantClock ?? r.siteEntry(2)?.clock ?? null;
          if (c !== null) clocks.push(c);
        } else {
          const s = r.sampleAt(r.t0 + 35 * r.tickRate);
          if (s) {
            const a = r.towardCount(s, 'a');
            const b = r.towardCount(s, 'b');
            if (a > b) leanA++;
            else if (b > a) leanB++;
          }
          if (r.firstKill) clocks.push(r.firstKill.clock);
        }
        for (const tag of r.tags?.[side] || []) {
          if (tag.k === 'default') continue;
          if (!calls.has(tag.k)) calls.set(tag.k, { rounds: 0, wins: 0, files: [] });
          const rec = calls.get(tag.k);
          rec.rounds++;
          if (r.won) rec.wins++;
          if (rec.files.length < LINK_FILES_CAP) rec.files.push(r.file);
        }
      }
      clocks.sort((a, b) => b - a);
      const basis = [...sites.values()].reduce((a, b) => a + b, 0);
      buckets.push({
        key: bucket.key,
        label: bucket.label,
        rounds: set.length,
        wins,
        winrate: pct(wins, set.length),
        files: filesOf(set),
        formation: side === 'T' ? topFormation(set, mapCode, laneSets) : '',
        site:
          side === 'T' && basis
            ? { a: pct(sites.get('A') || 0, basis), b: pct(sites.get('B') || 0, basis) }
            : null,
        lean: side === 'CT' ? { a: pct(leanA, set.length), b: pct(leanB, set.length) } : null,
        medianClock: clocks.length ? fmtClock(clocks[Math.floor(clocks.length / 2)]) : '',
        calls: [...calls.entries()]
          .map(([key, rec]) => ({
            key,
            label: labels.get(key) || key,
            rounds: rec.rounds,
            winrate: pct(rec.wins, rec.rounds),
            files: rec.files
          }))
          .sort((a, b) => b.rounds - a.rounds || a.label.localeCompare(b.label))
          .slice(0, 4)
      });
    }
    if (buckets.length) out.sides[side] = buckets;
  }
  return Object.keys(out.sides).length ? out : null;
}

/** The formation this set of rounds most often showed at the snapshot. */
function topFormation(set, mapCode, laneSets) {
  const seen = new Map();
  for (const r of set) {
    const f = laneFormation(r, mapCode, laneSets);
    if (f) bump(seen, f);
  }
  return topCounts(seen, 1)[0]?.name || '';
}

/** How far ahead an enemy call has to be before ours can be a reply to it. */
export const RESPONSE_LEAD_SECONDS = 5;
/** And how many rounds it has to have happened in before it is a habit. */
export const RESPONSE_MIN_ROUNDS = 4;
/** As a share of the rounds their call happened in. */
export const RESPONSE_MIN_SHARE = 50;

/**
 * Calls this team makes in answer to the other side's.
 *
 * A tag's marks are its criteria, so the latest of them is the second the read
 * came true (see `tagTrigger`). Ours is a response when theirs was already
 * complete a clear five seconds earlier: long enough that the round could have
 * been called off the back of it, rather than the two simply happening.
 *
 * Both directions of the round are already tagged, so this needs no extra
 * reading — it is the same bag looked at as a pair.
 */
export function aggResponses(rounds, mapCode, side) {
  const labels = typeLabels(mapCode, side);
  const other = side === 'T' ? 'CT' : 'T';
  const theirLabels = typeLabels(mapCode, other);
  const own = rounds.filter((r) => r.side === side && r.tags);
  if (!own.length) return null;

  // Keyed on THEIR call, because that is the condition. "When they do this, we
  // do that" is a rate out of the rounds they did it in, not out of ours.
  /** @type {Map<string, { seen: Set<string>, replies: Map<string, { seen: Set<string>, files: string[], wins: number }> }>} */
  const byTheirs = new Map();
  let answered = 0;
  for (const r of own) {
    const ours = (r.tags[side] || []).filter((t) => t.k !== 'default');
    const theirs = (r.tags[other] || []).filter((t) => t.k !== 'default');
    if (!theirs.length) continue;
    let anyReply = false;
    for (const theirTag of theirs) {
      const lead = tagTrigger(theirTag);
      if (lead === null) continue;
      if (!byTheirs.has(theirTag.k)) {
        byTheirs.set(theirTag.k, { seen: new Set(), replies: new Map() });
      }
      const rec = byTheirs.get(theirTag.k);
      rec.seen.add(r.file);
      for (const tag of ours) {
        const at = tagTrigger(tag);
        if (at === null || lead > at - RESPONSE_LEAD_SECONDS) continue;
        if (!rec.replies.has(tag.k)) {
          rec.replies.set(tag.k, { seen: new Set(), files: [], wins: 0 });
        }
        const reply = rec.replies.get(tag.k);
        if (reply.seen.has(r.file)) continue;
        reply.seen.add(r.file);
        if (reply.files.length < LINK_FILES_CAP) reply.files.push(r.file);
        if (r.won) reply.wins++;
        anyReply = true;
      }
    }
    if (anyReply) answered++;
  }

  const calls = [];
  for (const [key, rec] of byTheirs) {
    // A habit, not a coincidence: it has to have happened enough times AND be
    // what they usually do. Four rounds out of eight is a read; two out of
    // three is noise, and four out of twenty is just their most common round.
    const to = [...rec.replies.entries()]
      .map(([ourKey, reply]) => ({
        key: ourKey,
        label: labels.get(ourKey) || ourKey,
        rounds: reply.seen.size,
        wins: reply.wins,
        winrate: pct(reply.wins, reply.seen.size),
        share: pct(reply.seen.size, rec.seen.size),
        files: reply.files
      }))
      .filter((x) => x.rounds >= RESPONSE_MIN_ROUNDS && x.share >= RESPONSE_MIN_SHARE)
      .sort((a, b) => b.share - a.share || b.rounds - a.rounds);
    if (!to.length) continue;
    calls.push({
      key,
      label: theirLabels.get(key) || key,
      rounds: rec.seen.size,
      to: to.slice(0, 5)
    });
  }
  calls.sort((a, b) => b.to[0].share - a.to[0].share || a.label.localeCompare(b.label));

  if (!calls.length) return null;
  return {
    side,
    other,
    rounds: own.length,
    answered,
    lead: RESPONSE_LEAD_SECONDS,
    minRounds: RESPONSE_MIN_ROUNDS,
    minShare: RESPONSE_MIN_SHARE,
    calls
  };
}

/** Most rounds a response row keeps a link for. */
const LINK_FILES_CAP = 40;

function aggPositions(mains, rolesOf) {
  return mains.map((m) => ({
    name: m.name,
    matches: m.matches,
    tRole: rolesOf(m.id, 'T') || '',
    ctRole: rolesOf(m.id, 'CT') || ''
  }));
}

function aggPace(rounds, allPaceKeys) {
  const buys = rounds.filter((r) => r.side === 'T' && r.ownEcon >= 2 && r.hasTicks);
  const byPace = new Map();
  for (const r of buys) {
    const pace = classifyPace(r) || 'other';
    if (!byPace.has(pace)) byPace.set(pace, []);
    byPace.get(pace).push(r);
  }
  const rows = [];
  for (const key of [...allPaceKeys, 'other']) {
    const list = byPace.get(key) || [];
    let siteA = 0;
    let siteB = 0;
    if (key === 'rush' || key === 'pop' || key === 'contact') {
      for (const r of list) {
        const site = paceSite(r);
        if (site === 'a') siteA++;
        else if (site === 'b') siteB++;
      }
    }
    rows.push({
      pace: key,
      count: list.length,
      share: pct(list.length, buys.length),
      siteA,
      siteB,
      files: filesOf(list)
    });
  }
  return { basis: buys.length, rows };
}

const PLAYER_POINT_CAP = 6000;
/**
 * Samples one live heatmap embeds. Points are ~16 bytes each once packed, so
 * this is ~48KB per widget and a report with ten of them stays well inside the
 * document's budget.
 */
const HEAT_POINT_CAP = 3000;
/** Rounds holding the AWP before a player earns his own AWP heatmap. */
const AWP_ROUNDS_MIN = 5;
/** Throws one nade-path widget carries. */
const NADE_PATH_CAP = 600;

function aggPlayers(rounds, mains, rolesOf) {
  const out = [];
  for (const m of mains) {
    const player = { name: m.name, tRole: rolesOf(m.id, 'T') || '', ctRole: rolesOf(m.id, 'CT') || '', sides: {} };
    for (const side of ['T', 'CT']) {
      // Every buy, not just full buys: the widget filters, so the document
      // carries the whole picture and the reader picks the slice.
      const set = rounds.filter((r) => r.side === side && r.hasTicks);
      if (!set.length) continue;
      const full = set.filter((r) => r.ownEcon === 4);
      const phases = {
        early: { samples: 0, spots: new Map(), points: [] },
        mid: { samples: 0, spots: new Map(), points: [] },
        late: { samples: 0, spots: new Map(), points: [] },
        all: { points: [] }
      };
      /** Flat throws: [kind, fromX, fromY, toX, toY, t, buys] each. */
      const paths = [];
      /** Every sample, timed and buy-stamped, for the live heatmap. */
      const heat = [];
      /** The same, but only from rounds he actually held the AWP in. */
      const awpHeat = [];
      let awpRounds = 0;
      let present = 0;
      for (const r of set) {
        let seen = false;
        const heldAwp = r.series.some((s) => s.pts.some((x) => x.id === m.id && x.awp));
        if (heldAwp) awpRounds++;
        for (const s of r.series) {
          const p = s.pts.find((x) => x.id === m.id);
          if (!p) continue;
          seen = true;
          const phase = phaseAtTick(s.tick, r.bounds);
          // The heatmap skips spawn noise: nothing from the first 7s of the
          // early round. Position time-shares keep the full phase.
          const heatable = phase !== 'early' || s.elapsed >= 7;
          if (heatable) {
            const sample = { x: p.x, y: p.y, t: s.elapsed, own: r.ownEcon, opp: r.oppEcon };
            heat.push(sample);
            if (heldAwp) awpHeat.push(sample);
          }
          // The written position shares stay on full buys, which is the read
          // they have always been.
          if (r.ownEcon !== 4) continue;
          const bag = phases[phase];
          bag.samples++;
          if (p.pos) bump(bag.spots, p.pos);
          if (heatable && bag.points.length < PLAYER_POINT_CAP) {
            bag.points.push({ x: p.x, y: p.y });
          }
          if (heatable && phases.all.points.length < PLAYER_POINT_CAP) {
            phases.all.points.push({ x: p.x, y: p.y });
          }
        }
        for (const n of r.nades) {
          if (n.player !== m.id) continue;
          // Every throw, flat and timed, so the widget can cut it the same way
          // the heatmap cuts samples: origin, landing, when, and both buys.
          if (
            paths.length < NADE_PATH_CAP * 7 &&
            Number.isFinite(n.x) &&
            Number.isFinite(n.y) &&
            Number.isFinite(n.at)
          ) {
            paths.push(
              NADE_KINDS.indexOf(n.type),
              Number.isFinite(n.fx) ? Math.round(n.fx) : Math.round(n.x),
              Number.isFinite(n.fy) ? Math.round(n.fy) : Math.round(n.y),
              Math.round(n.x),
              Math.round(n.y),
              Math.round(n.at),
              r.ownEcon * 8 + r.oppEcon
            );
          }
        }
        if (seen) present++;
      }
      if (!present) continue;

      /** @type {Map<string, { rounds: Set<string>, clocks: number[], type: string }>} */
      const util = new Map();
      for (const r of full) {
        for (const n of r.nades) {
          if (n.player !== m.id || !n.name) continue;
          if (!util.has(n.name)) util.set(n.name, { rounds: new Set(), clocks: [], type: n.type });
          const rec = util.get(n.name);
          rec.rounds.add(r.file);
          rec.clocks.push(n.clock);
        }
      }

      player.sides[side] = {
        rounds: present,
        fullRounds: full.length,
        heat: packPoints(heat),
        // Only an actual AWPer gets the second map. One round with a picked-up
        // AWP is not a role.
        awp: awpRounds >= AWP_ROUNDS_MIN ? { rounds: awpRounds, heat: packPoints(awpHeat) } : null,
        phases: {
          early: phaseSpots(phases.early),
          mid: phaseSpots(phases.mid),
          late: phaseSpots(phases.late),
          all: { points: phases.all.points }
        },
        paths,
        utility: [...util.entries()]
          .map(([name, rec]) => ({
            name,
            type: rec.type,
            share: pct(rec.rounds.size, set.length),
            clock: fmtClock(avgOf(rec.clocks))
          }))
          .filter((u) => u.share >= 15)
          .sort((a, b) => b.share - a.share)
          .slice(0, 8)
      };
    }
    out.push(player);
  }
  return out;
}

/**
 * Points for a live heatmap, flat and quantised.
 *
 * `[x, y, t, buys, ...]` per sample: world position rounded to the unit (the
 * heat blurs by 14 radar pixels, so anything finer is thrown away anyway), the
 * second it happened, and the two buys packed into one digit pair. Flat
 * because this ends up inside a document attribute and every repeated JSON key
 * is bytes on the wire.
 *
 * Over the cap it strides rather than truncating: half a round's movement is a
 * worse picture than all of it at half the resolution.
 */
export function packPoints(list, cap = HEAT_POINT_CAP) {
  // Anything unreadable is dropped here rather than carried. JSON turns NaN
  // into null, null compares as zero, and a sample that claims to have
  // happened at the start of the round is worse than one that is missing.
  const clean = list.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.t)
  );
  const step = clean.length > cap ? Math.ceil(clean.length / cap) : 1;
  const out = [];
  for (let i = 0; i < clean.length; i += step) {
    const p = clean[i];
    out.push(Math.round(p.x), Math.round(p.y), Math.round(p.t), (p.own || 0) * 8 + (p.opp || 0));
  }
  return out;
}

function phaseSpots(bag) {
  const spots = [...bag.spots.entries()]
    .map(([name, count]) => ({ name, share: pct(count, bag.samples) }))
    .filter((s) => s.share >= 10)
    .sort((a, b) => b.share - a.share)
    .slice(0, 3);
  return { spots, points: bag.points };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * What the round library is missing on this map.
 *
 * The definitions name ground and utility spots; anything not painted or not
 * stored under that name makes the rules built on it silently unreachable, so
 * the report says which rather than reporting zeroes as findings.
 */
function roundLibraryReadiness(mapCode, network, utilDb, rounds) {
  const wantRegions = requiredRegionGroups(mapCode);
  if (!wantRegions.length) return null;
  const index = createRegionIndex(network, mapCode);
  const stored = new Set(
    (utilDb?.utilities || []).map((u) => String(u?.name || '').trim().toLowerCase())
  );
  return {
    // A group is one piece of ground under whichever name the map paints it,
    // so only a group where nothing resolves is actually missing.
    missingRegions: wantRegions.filter((group) => !index.known(group)).map(regionGroupLabel),
    missingUtility: requiredUtilityNames(mapCode).filter((name) => !stored.has(name)),
    untagged: rounds.filter((r) => !r.tags).length
  };
}

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
 * @param {string[]} args.paceKeys  pace type keys, report order
 * @param {(done: number, total: number) => void} [args.onProgress]
 */
export async function runAntistratScan({
  payload,
  teamKey,
  mapCode,
  demoIds,
  paceKeys,
  onProgress
}) {
  const wanted = new Set(demoIds);
  const jobs = [];
  /** @type {Map<string, { id: string, name: string, matches: number, last: number }>} */
  const playerStats = new Map();
  const nameOf = new Map();
  const includedDemos = [];
  /** Scouted team's short ids across demos, for analyzer deep links. */
  const focusIds = new Set();
  for (const demo of payload?.demos || []) {
    if (!wanted.has(demo.id)) continue;
    const k1 = teamNameKey(demo.name1, demo.t1);
    const k2 = teamNameKey(demo.name2, demo.t2);
    const teamIdx = k1 === teamKey ? 1 : k2 === teamKey ? 2 : 0;
    if (!teamIdx) continue;
    includedDemos.push({ demo, teamIdx });
    const shortId = teamIdx === 1 ? demo.t1 : demo.t2;
    if (shortId) focusIds.add(shortId);
    const opponent = (teamIdx === 1 ? demo.name2 : demo.name1) || 'Unknown';
    for (const p of demo.players || []) {
      if (p.team !== teamIdx || !p.id) continue;
      nameOf.set(p.id, p.name || p.id);
      const rec = playerStats.get(p.id) || { id: p.id, name: p.name || p.id, matches: 0, last: 0 };
      rec.matches++;
      rec.last = Math.max(rec.last, demo.uploadedAt || 0);
      playerStats.set(p.id, rec);
    }
    // Where each round sits in its half, and the score going into it. A
    // pistol is both sides on nothing, which is what resets the count: it
    // survives MR12, MR24 and overtime without knowing which it is.
    let pistolAt = 0;
    let ourHalf = 0;
    let theirHalf = 0;
    const ordered = [...(demo.rounds || [])].sort((a, b) => (a.n || 0) - (b.n || 0));
    for (const row of ordered) {
      if (buyBucket(row.e1) === 0 && buyBucket(row.e2) === 0) {
        pistolAt = row.n;
        ourHalf = 0;
        theirHalf = 0;
      }
      const context = {
        inHalf: pistolAt ? row.n - pistolAt + 1 : 0,
        ourHalf,
        theirHalf
      };
      if (row.m === mapCode && row.f) jobs.push({ row, teamIdx, opponent, context });
      if (row.w === teamIdx) ourHalf++;
      else if (row.w) theirHalf++;
    }
  }
  if (!jobs.length) throw new Error('No rounds of that team on this map.');

  // The five most-played players, most recent first on ties.
  const mains = [...playerStats.values()]
    .sort((a, b) => b.matches - a.matches || b.last - a.last)
    .slice(0, 5);

  /**
   * Majority role per player per side across the included demos.
   * `roleForPlayer` hands back `{ position, label, tactical }`, so the vote is
   * on the label: that is the string the Roles & Positions editor shows.
   */
  const rolesOf = (playerId, side) => {
    const votes = new Map();
    for (const { demo } of includedDemos) {
      const role = roleForPlayer(demo.roles, mapCode, side, playerId);
      const label = typeof role === 'string' ? role : role?.label || role?.position || '';
      if (label) bump(votes, label);
    }
    return topCounts(votes, 1)[0]?.name || '';
  };

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
        opponent: job.opponent,
        context: job.context,
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

  return {
    mapCode,
    rounds: rounds.length,
    ticked: rounds.filter((r) => r.hasTicks).length,
    zonesReady: Boolean(network?.positions?.length),
    utilityDb: Boolean(utilDb?.utilities?.length),
    roundLibrary: roundLibraryReadiness(mapCode, network, utilDb, rounds),
    focusIds: [...focusIds],
    tFullBuy: filesOf(rounds.filter((r) => r.side === 'T' && r.ownEcon === 4)),
    ctFullBuy: filesOf(rounds.filter((r) => r.side === 'CT' && r.ownEcon === 4)),
    sections: {
      pistols: aggPistols(rounds, mapCode, laneSets),
      positions: aggPositions(mains, rolesOf),
      pace: aggPace(rounds, paceKeys || []),
      utility: aggUtility(rounds, mapCode),
      tells: aggTells(rounds, mapCode),
      fiveVfour: aggAdvantage(rounds, '5v4'),
      fourVfive: aggAdvantage(rounds, '4v5'),
      force: aggForce(rounds),
      antiBuy: aggAntiBuy(rounds, mapCode, laneSets),
      buyContext: aggBuyContext(rounds, mapCode),
      firstEngagement: aggFirstEngagement(rounds, nameOf, network),
      patterns: aggPatterns(rounds, nameOf),
      openings: aggOpenings(rounds),
      setCalls: aggSetCalls(rounds, mapCode, laneSets),
      ctSites: aggCtSiteDefense(rounds),
      ctSpread: aggCtSpread(rounds),
      tFormations: aggTFormations(rounds, mapCode, laneSets),
      afterplants: aggPostplant(rounds, 'T'),
      retakes: {
        zones: aggPostplant(rounds, 'CT'),
        winrates: aggRetakeWinrates(rounds)
      },
      tRoundList: aggRoundList(rounds, mapCode, 'T'),
      ctRoundList: aggRoundList(rounds, mapCode, 'CT'),
      responses: {
        T: aggResponses(rounds, mapCode, 'T'),
        CT: aggResponses(rounds, mapCode, 'CT')
      },
      tEarly: { T: aggPhase(rounds, 'early', 'T'), CT: aggPhase(rounds, 'early', 'CT') },
      tMid: { T: aggPhase(rounds, 'mid', 'T'), CT: aggPhase(rounds, 'mid', 'CT') },
      tLate: { T: aggPhase(rounds, 'late', 'T'), CT: aggPhase(rounds, 'late', 'CT') },
      players: aggPlayers(rounds, mains, rolesOf)
    }
  };
}
