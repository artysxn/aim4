// ---------------------------------------------------------------------------
// Aggregate rating-style stats over early/mid/late phase windows.
//
// Subjects: 0–5 player ids. Empty ⇒ “anyone” (map + round filters only;
// leaderboard/rounds, no pooled phase stats). Geography filters use drawn
// shapes (see shapeFilters.js).
// ---------------------------------------------------------------------------

import { PHASES } from '../roles/phaseCombat.js';
import {
  P,
  PLAYER_SLOTS,
  aggregatePlayers,
  aggregateTeams,
  bucketRating,
  indexMaps,
  rowPasses
} from '../shared/statsMath.js';
import {
  filterWindowsByShapes,
  hasNarrowTimeWindow,
  hasNarrowUtility
} from './shapeFilters.js';

/**
 * @typedef {object} AnalyticsFilter
 * @property {string} [playerId]  legacy single subject
 * @property {string[]} [playerIds]  up to 5 subjects; empty ⇒ anyone
 * @property {string} map
 * @property {'T'|'CT'|''} [side]
 * @property {number|null} [econ]
 * @property {number|null} [oppEcon]
 * @property {boolean} [hasAwp]
 * @property {boolean} [oppHasAwp]
 * @property {''|'won'|'lost'} [result]
 * @property {''|'won'|'lost'} [opening]
 * @property {string|string[]} [roundOwn]
 * @property {string|string[]} [roundOpp]
 * @property {string} [rankOwn]
 * @property {string} [rankOpp]
 * @property {Set<string>|string[]} [phases]
 * @property {Array<object>} [shapes]
 * @property {'all'|'any'} [shapeMatch]
 * @property {{ from: number, to: number }|null} [timeWindow]
 * @property {Record<string, boolean>} [utility]
 */

export const ANALYTICS_PLAYER_MAX = 5;

function asSet(v) {
  if (!v) return new Set();
  return v instanceof Set ? v : new Set(v);
}

function emptyBucket() {
  return { rounds: 0, kills: 0, deaths: 0, assists: 0, damage: 0, kast: 0 };
}

function emptyLine() {
  return new Array(PLAYER_SLOTS).fill(0);
}

function addBucket(b, line) {
  if (!line) return;
  b.rounds++;
  b.kills += line[P.KILLS] || 0;
  b.deaths += line[P.DEATHS] || 0;
  b.assists += line[P.ASSISTS] || 0;
  b.damage += line[P.DAMAGE] || 0;
  b.kast += line[P.KAST] ? 1 : 0;
}

function teamOfPlayer(entry, playerId) {
  const p = (entry.players || []).find((x) => x.id === playerId);
  return p?.team || 0;
}

function resultPasses(row, team, result) {
  if (!result) return true;
  if (!team) return false;
  const won = row.w === team;
  if (result === 'won') return won;
  if (result === 'lost') return !won;
  return true;
}

function openingPasses(row, playerId, opening) {
  if (!opening) return true;
  if (opening === 'won') return row.ok === playerId;
  if (opening === 'lost') return row.od === playerId;
  return true;
}

function selectedPhases(filter) {
  const set = asSet(filter.phases);
  if (!set.size) return [...PHASES];
  return PHASES.filter((p) => set.has(p));
}

function hasActiveShapes(filter) {
  return (filter?.shapes || []).some((s) => s && s.enabled !== false && s.geometry);
}

function needsRoundMetaFilter(filter) {
  return hasActiveShapes(filter) || hasNarrowTimeWindow(filter) || hasNarrowUtility(filter);
}

/**
 * Resolve subject list (legacy playerId supported). Empty ⇒ anyone.
 *
 * The cap is the sidebar's rule — "up to 5 subjects" — and it belongs to
 * subjects a person picked. It must NOT apply to `scanAllPlayers`, which is
 * `matchingFilesAsync` handing this function every player on the map because
 * anyone-mode still has to answer a drawn shape per player per phase. Slicing
 * that list to five turned "kill from this box, anywhere on Dust2" into "kill
 * from this box by whichever five players the first demo happened to list" —
 * a search over 7,000 rounds that could only ever return the handful those
 * five played, silently, with no sign that anything had been dropped.
 */
export function playerIdsFromFilter(filter) {
  if (Array.isArray(filter?.playerIds)) {
    const ids = [...new Set(filter.playerIds.map(String).filter(Boolean))];
    return filter.scanAllPlayers ? ids : ids.slice(0, ANALYTICS_PLAYER_MAX);
  }
  if (filter?.playerId) return [String(filter.playerId)];
  return [];
}

function teamNameKey(name, shortId = '') {
  const norm = String(name || '')
    .trim()
    .toLowerCase();
  if (!norm || norm === 'team 1' || norm === 'team 2') return shortId || norm || '';
  return norm;
}

/**
 * Player's team for a row (from demo roster).
 */
export function playerTeamOnRow(payload, row, playerId) {
  const demo = (payload?.demos || []).find((d) => d.id === row.d);
  return teamOfPlayer(demo, playerId);
}

/**
 * Does the round pass Analytics round filters for this player?
 */
export function analyticsRowPasses(row, filter, team, demo) {
  if (!filter.map || row.m !== filter.map) return false;
  const pid = filter.playerId;
  if (pid && !row.p?.[pid] && !row.ph?.[pid]) return false;
  const demos = demo ? new Map([[demo.id || row.d, demo]]) : null;
  if (!rowPasses(row, filter, team, null, demos)) return false;
  if (!resultPasses(row, team, filter.result || '')) return false;
  if (pid && !openingPasses(row, pid, filter.opening || '')) return false;
  return true;
}

/**
 * Round-level match when no subjects are selected (either team seating may pass).
 */
function roundMatchesAnyone(row, filter, demo) {
  if (!filter.map || row.m !== filter.map) return false;
  const demos = demo ? new Map([[demo.id || row.d, demo]]) : null;
  for (const team of [1, 2]) {
    if (!rowPasses(row, filter, team, null, demos)) continue;
    if (!resultPasses(row, team, filter.result || '')) continue;
    if (filter.opening === 'won') {
      if (!row.ok || teamOfPlayer(demo, row.ok) !== team) continue;
    } else if (filter.opening === 'lost') {
      if (!row.od || teamOfPlayer(demo, row.od) !== team) continue;
    }
    return true;
  }
  return false;
}

/** All player ids that appear on a map in the payload. */
export function listPlayerIdsOnMap(payload, map) {
  const ids = new Set();
  if (!map) return [];
  for (const demo of payload?.demos || []) {
    for (const row of demo.rounds || []) {
      if (row.m !== map) continue;
      for (const id of Object.keys(row.p || {})) ids.add(id);
      for (const id of Object.keys(row.ph || {})) ids.add(id);
    }
    if (demo.map === map) {
      for (const p of demo.players || []) {
        if (p?.id) ids.add(p.id);
      }
    }
  }
  return [...ids];
}

/**
 * Matching phase windows (sync — no shape geometry yet).
 * Empty playerIds ⇒ no windows (use matchingFiles* for anyone mode).
 * @returns {Array<{ row, phase, window, team, file: string, playerId: string }>}
 */
export function matchingWindows(payload, filter) {
  if (!filter?.map) return [];
  const playerIds = playerIdsFromFilter(filter);
  if (!playerIds.length) return [];
  const want = new Set(playerIds);
  const phases = selectedPhases(filter);
  const out = [];

  for (const demo of payload?.demos || []) {
    for (const p of demo.players || []) {
      if (!want.has(p.id)) continue;
      const team = p.team || 0;
      if (!team) continue;
      for (const row of demo.rounds || []) {
        const f = { ...filter, playerId: p.id };
        if (!analyticsRowPasses(row, f, team, demo)) continue;
        const bag = row.ph?.[p.id];
        if (!bag) continue;
        for (const phase of phases) {
          const window = bag[phase];
          if (!window?.p) continue;
          out.push({
            row,
            phase,
            window,
            team,
            file: row.f,
            demoId: row.d,
            round: row.n,
            playerId: p.id
          });
        }
      }
    }
  }
  return out;
}

/**
 * Matching windows with optional drawn-shape / clock / utility filters.
 */
export async function matchingWindowsAsync(payload, filter, tickCache = new Map(), opts = {}) {
  const base = matchingWindows(payload, filter);
  if (!needsRoundMetaFilter(filter)) return base;
  return filterWindowsByShapes(
    base,
    filter?.shapes || [],
    tickCache,
    filter.shapeMatch || 'all',
    filter,
    opts
  );
}

/**
 * Round files matching filters (and shapes). Works with 0 subjects (anyone).
 */
export async function matchingFilesAsync(payload, filter, tickCache = new Map(), opts = {}) {
  if (!filter?.map) return [];
  const ids = playerIdsFromFilter(filter);

  if (ids.length) {
    const windows = await matchingWindowsAsync(payload, filter, tickCache, opts);
    return [...new Set(windows.map((w) => w.file).filter(Boolean))];
  }

  if (needsRoundMetaFilter(filter)) {
    // Anyone-mode with geography: a shape is answered per player per phase, so
    // "did anyone do this here" is "did any player on the map do this here".
    // `scanAllPlayers` is what tells `playerIdsFromFilter` these are not five
    // chosen subjects but the whole roster of the map.
    const allIds = listPlayerIdsOnMap(payload, filter.map);
    const windows = await matchingWindowsAsync(
      payload,
      { ...filter, playerIds: allIds, scanAllPlayers: true },
      tickCache,
      opts
    );
    return [...new Set(windows.map((w) => w.file).filter(Boolean))];
  }

  const files = [];
  const seen = new Set();
  for (const demo of payload?.demos || []) {
    for (const row of demo.rounds || []) {
      if (!row?.f || seen.has(row.f)) continue;
      if (!roundMatchesAnyone(row, filter, demo)) continue;
      seen.add(row.f);
      files.push(row.f);
    }
  }
  return files;
}

/**
 * Collapse matching phase windows into one combat line per player×round.
 */
function roundLinesFromWindows(windows) {
  /** @type {Map<string, { file: string, demoId: string, round: number, playerId: string, line: number[], phases: Set<string> }>} */
  const byKey = new Map();

  for (const w of windows) {
    const key = `${w.file}\0${w.playerId}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        file: w.file,
        demoId: w.demoId,
        round: w.round,
        playerId: w.playerId,
        line: emptyLine(),
        phases: new Set()
      };
      byKey.set(key, g);
    }
    g.phases.add(w.phase);
    const src = w.window.p;
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      if (i === P.KAST) continue;
      g.line[i] += Number(src[i]) || 0;
    }
    if (src[P.KAST]) g.line[P.KAST] = 1;
  }

  for (const g of byKey.values()) {
    const row = windows.find((w) => w.file === g.file && w.playerId === g.playerId)?.row;
    const whole = row?.p?.[g.playerId];
    if (!whole) {
      const minHits = Math.max(g.line[P.KILLS] || 0, g.line[P.HEADSHOTS] || 0);
      if ((g.line[P.HITS] || 0) < minHits) g.line[P.HITS] = minHits;
      continue;
    }

    const share = (slot) => {
      const total = Number(whole[slot]) || 0;
      if (total <= 0) return 0;
      const wholeKills = Number(whole[P.KILLS]) || 0;
      if (wholeKills > 0 && (g.line[P.KILLS] || 0) > 0) {
        return Math.round((total * g.line[P.KILLS]) / wholeKills);
      }
      return Math.round((total * g.phases.size) / PHASES.length);
    };

    if (!(g.line[P.DAMAGE] > 0)) g.line[P.DAMAGE] = share(P.DAMAGE);
    if (!(g.line[P.HITS] > 0)) g.line[P.HITS] = share(P.HITS);
    if (!(g.line[P.AWP_HITS] > 0) && (Number(whole[P.AWP_HITS]) || 0) > 0) {
      g.line[P.AWP_HITS] = share(P.AWP_HITS);
    }

    const minHits = Math.max(g.line[P.KILLS] || 0, g.line[P.HEADSHOTS] || 0);
    if ((g.line[P.HITS] || 0) < minHits) g.line[P.HITS] = minHits;
  }

  return [...byKey.values()];
}

function emptyAggregate(files = []) {
  return {
    windows: [],
    files,
    samples: 0,
    rounds: files.length,
    kills: 0,
    deaths: 0,
    assists: 0,
    damage: 0,
    kd: 0,
    adr: 0,
    kast: 0,
    impact: 0,
    rating: 0,
    kpr: 0,
    dpr: 0,
    apr: 0,
    shots: 0,
    hits: 0,
    headshots: 0,
    accuracy: 0,
    awpShots: 0,
    awpHits: 0,
    awpAccuracy: 0,
    anyone: true
  };
}

function aggregateFromWindows(windows) {
  const roundRows = roundLinesFromWindows(windows);
  const bucket = emptyBucket();
  let shots = 0;
  let hits = 0;
  let headshots = 0;
  let awpShots = 0;
  let awpHits = 0;

  for (const g of roundRows) {
    addBucket(bucket, g.line);
    shots += g.line[P.SHOTS] || 0;
    hits += g.line[P.HITS] || 0;
    headshots += g.line[P.HEADSHOTS] || 0;
    awpShots += g.line[P.AWP_SHOTS] || 0;
    awpHits += g.line[P.AWP_HITS] || 0;
  }

  const rating = bucketRating(bucket);
  const div = (a, b) => (b > 0 ? a / b : 0);
  const files = [...new Set(roundRows.map((g) => g.file).filter(Boolean))];

  return {
    windows,
    files,
    samples: windows.length,
    rounds: rating.rounds,
    kills: bucket.kills,
    deaths: bucket.deaths,
    assists: bucket.assists,
    damage: bucket.damage,
    kd: bucket.deaths ? bucket.kills / bucket.deaths : bucket.kills,
    adr: rating.adr,
    kast: rating.kast,
    impact: rating.impact,
    rating: rating.rating,
    kpr: rating.kpr,
    dpr: rating.dpr,
    apr: rating.apr,
    shots,
    hits,
    headshots,
    accuracy: div(hits, shots) * 100,
    awpShots,
    awpHits,
    awpAccuracy: div(awpHits, awpShots) * 100,
    anyone: false
  };
}

/**
 * Aggregate stats over matching phase windows (sync, ignores shapes).
 */
export function aggregateAnalytics(payload, filter) {
  const ids = playerIdsFromFilter(filter);
  if (!ids.length) {
    return emptyAggregate(
      // sync path cannot load ticks for shapes; round filters only
      (() => {
        const files = [];
        const seen = new Set();
        for (const demo of payload?.demos || []) {
          for (const row of demo.rounds || []) {
            if (!row?.f || seen.has(row.f)) continue;
            if (!roundMatchesAnyone(row, filter, demo)) continue;
            seen.add(row.f);
            files.push(row.f);
          }
        }
        return files;
      })()
    );
  }
  return aggregateFromWindows(matchingWindows(payload, filter));
}

/**
 * Aggregate with drawn-shape filters. Anyone mode → files + empty phase stats.
 */
export async function aggregateAnalyticsAsync(payload, filter, tickCache = new Map(), opts = {}) {
  const ids = playerIdsFromFilter(filter);
  if (!ids.length) {
    const files = await matchingFilesAsync(payload, filter, tickCache, opts);
    return emptyAggregate(files);
  }
  const windows = await matchingWindowsAsync(payload, filter, tickCache, opts);
  return aggregateFromWindows(windows);
}

/**
 * Full-round player leaderboard for a set of matching round files.
 */
export function leaderboardFromFiles(payload, files) {
  const want = new Set((files || []).filter(Boolean));
  if (!want.size) return [];

  /** @type {Map<string, { name: string, team: number, demoId: string }>} */
  const players = new Map();
  const demos = new Map();
  const rows = [];
  for (const demo of payload?.demos || []) {
    demos.set(demo.id, demo);
    for (const p of demo.players || []) {
      if (!p?.id) continue;
      players.set(`${demo.id}:${p.id}`, {
        name: p.name || p.id,
        team: p.team || 0,
        demoId: demo.id
      });
    }
    for (const row of demo.rounds || []) {
      if (row?.f && want.has(row.f)) rows.push(row);
    }
  }
  return aggregatePlayers(rows, players, { files: [...want] }, demos);
}

/**
 * Full-round TEAM leaderboard for a set of matching round files. The same
 * rounds the player board shows, seated by team: rounds played, rounds won,
 * and the members' average rating over those rounds.
 */
export function teamLeaderboardFromFiles(payload, files) {
  const want = new Set((files || []).filter(Boolean));
  if (!want.size) return [];
  const { players, demos } = indexMaps(payload);
  const rows = [];
  for (const demo of payload?.demos || []) {
    for (const row of demo.rounds || []) {
      if (row?.f && want.has(row.f)) rows.push(row);
    }
  }
  return aggregateTeams(rows, players, demos, {});
}

/** Unique maps across a stats payload. */
export function listMaps(payload) {
  const maps = new Set();
  for (const demo of payload?.demos || []) {
    if (demo.map) maps.add(demo.map);
    for (const row of demo.rounds || []) {
      if (row.m) maps.add(row.m);
    }
  }
  return [...maps].sort();
}

/** Unique players across a stats payload. */
export function listPlayers(payload) {
  /** @type {Map<string, { id: string, name: string, maps: Set<string>, teamKeys: Set<string> }>} */
  const byId = new Map();
  for (const demo of payload?.demos || []) {
    const map = demo.map || '';
    for (const p of demo.players || []) {
      if (!p.id) continue;
      let cur = byId.get(p.id);
      if (!cur) {
        cur = { id: p.id, name: p.name || p.id, maps: new Set(), teamKeys: new Set() };
        byId.set(p.id, cur);
      }
      if (p.name) cur.name = p.name;
      if (map) cur.maps.add(map);
      const team = p.team === 2 ? 2 : p.team === 1 ? 1 : 0;
      if (team) {
        const shortId = team === 1 ? demo.t1 : demo.t2;
        const displayName = team === 1 ? demo.name1 : demo.name2;
        const key = teamNameKey(displayName, shortId);
        if (key) cur.teamKeys.add(key);
      }
      for (const row of demo.rounds || []) {
        if (row.p?.[p.id] || row.ph?.[p.id]) {
          if (row.m) cur.maps.add(row.m);
        }
      }
    }
  }
  return [...byId.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      maps: [...p.maps].sort(),
      teamKeys: [...p.teamKeys]
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Teams merged by display name across demos (same idea as Statistics).
 * @returns {Array<{ key: string, name: string, playerIds: string[], maps: string[] }>}
 */
export function listTeams(payload) {
  /** @type {Map<string, { key: string, name: string, nameCounts: Map<string, number>, playerIds: Set<string>, maps: Set<string> }>} */
  const byKey = new Map();

  for (const demo of payload?.demos || []) {
    const map = demo.map || '';
    for (const team of [1, 2]) {
      const shortId = team === 1 ? demo.t1 : demo.t2;
      const displayName = team === 1 ? demo.name1 : demo.name2;
      const key = teamNameKey(displayName, shortId);
      if (!key) continue;
      let cur = byKey.get(key);
      if (!cur) {
        cur = {
          key,
          name: String(displayName || shortId || key).trim() || key,
          nameCounts: new Map(),
          playerIds: new Set(),
          maps: new Set()
        };
        byKey.set(key, cur);
      }
      const label = String(displayName || '').trim();
      if (label) cur.nameCounts.set(label, (cur.nameCounts.get(label) || 0) + 1);
      if (map) cur.maps.add(map);
      for (const p of demo.players || []) {
        if (p?.id && p.team === team) cur.playerIds.add(p.id);
      }
      for (const row of demo.rounds || []) {
        if (row.m) cur.maps.add(row.m);
      }
    }
  }

  const out = [];
  for (const cur of byKey.values()) {
    if (!cur.playerIds.size) continue;
    let bestName = cur.name;
    let bestCount = -1;
    for (const [label, count] of cur.nameCounts) {
      if (count > bestCount || (count === bestCount && label.localeCompare(bestName) < 0)) {
        bestName = label;
        bestCount = count;
      }
    }
    out.push({
      key: cur.key,
      name: bestName,
      playerIds: [...cur.playerIds],
      maps: [...cur.maps].sort()
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
