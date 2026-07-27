// ---------------------------------------------------------------------------
// Aggregate rating-style stats over early/mid/late phase windows for one player.
//
// Combat is taken only from matching phase windows, then rolled up per round so
// KPR / DPR / ADR use that round count as the "R" (same idea as Statistics).
// Geography filters use user-drawn shapes (see shapeFilters.js), applied async.
// ---------------------------------------------------------------------------

import { PHASES } from '../roles/phaseCombat.js';
import {
  P,
  PLAYER_SLOTS,
  aggregatePlayers,
  bucketRating,
  rowPasses
} from '../shared/statsMath.js';
import { filterWindowsByShapes } from './shapeFilters.js';

/**
 * @typedef {object} AnalyticsFilter
 * @property {string} playerId
 * @property {string} map
 * @property {'T'|'CT'|''} [side]
 * @property {number|null} [econ]
 * @property {number|null} [oppEcon]
 * @property {boolean} [hasAwp]
 * @property {boolean} [oppHasAwp]
 * @property {''|'won'|'lost'} [result]
 * @property {''|'won'|'lost'} [opening]  opening duel for the focus player
 * @property {Set<string>|string[]} [phases]  empty ⇒ all
 * @property {Array<object>} [shapes]  enabled drawn selections
 * @property {'all'|'any'} [shapeMatch]  AND / OR across enabled shapes
 */

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
export function analyticsRowPasses(row, filter, team) {
  if (!filter.map || row.m !== filter.map) return false;
  if (!row.p?.[filter.playerId] && !row.ph?.[filter.playerId]) return false;
  if (!rowPasses(row, filter, team)) return false;
  if (!resultPasses(row, team, filter.result || '')) return false;
  if (!openingPasses(row, filter.playerId, filter.opening || '')) return false;
  return true;
}

/**
 * Matching phase windows (sync — no shape geometry yet).
 * @returns {Array<{ row, phase, window, team, file: string, playerId: string }>}
 */
export function matchingWindows(payload, filter) {
  if (!filter?.playerId || !filter?.map) return [];
  const phases = selectedPhases(filter);
  const out = [];
  for (const demo of payload?.demos || []) {
    const team = teamOfPlayer(demo, filter.playerId);
    if (!team) continue;
    for (const row of demo.rounds || []) {
      if (!analyticsRowPasses(row, filter, team)) continue;
      const bag = row.ph?.[filter.playerId];
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
          playerId: filter.playerId
        });
      }
    }
  }
  return out;
}

/**
 * Matching windows with optional drawn-shape filters applied.
 */
export async function matchingWindowsAsync(payload, filter, tickCache = new Map()) {
  const base = matchingWindows(payload, filter);
  const shapes = filter?.shapes || [];
  const active = shapes.filter((s) => s && s.enabled !== false && s.geometry);
  if (!active.length) return base;
  return filterWindowsByShapes(base, active, tickCache, filter.shapeMatch || 'all');
}

/**
 * Collapse matching phase windows into one combat line per distinct round.
 */
function roundLinesFromWindows(windows, playerId) {
  /** @type {Map<string, { file: string, demoId: string, round: number, line: number[], phases: Set<string> }>} */
  const byFile = new Map();

  for (const w of windows) {
    let g = byFile.get(w.file);
    if (!g) {
      g = {
        file: w.file,
        demoId: w.demoId,
        round: w.round,
        line: emptyLine(),
        phases: new Set()
      };
      byFile.set(w.file, g);
    }
    g.phases.add(w.phase);
    const src = w.window.p;
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      if (i === P.KAST) continue;
      g.line[i] += Number(src[i]) || 0;
    }
    if (src[P.KAST]) g.line[P.KAST] = 1;
  }

  for (const g of byFile.values()) {
    const row = windows.find((w) => w.file === g.file)?.row;
    const whole = row?.p?.[playerId];
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

  return [...byFile.values()];
}

function aggregateFromWindows(windows, playerId) {
  const roundRows = roundLinesFromWindows(windows, playerId);
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

  return {
    windows,
    files: roundRows.map((g) => g.file),
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
    awpAccuracy: div(awpHits, awpShots) * 100
  };
}

/**
 * Aggregate stats over matching phase windows (sync, ignores shapes).
 */
export function aggregateAnalytics(payload, filter) {
  return aggregateFromWindows(matchingWindows(payload, filter), filter.playerId);
}

/**
 * Aggregate with drawn-shape filters.
 */
export async function aggregateAnalyticsAsync(payload, filter, tickCache = new Map()) {
  const windows = await matchingWindowsAsync(payload, filter, tickCache);
  return aggregateFromWindows(windows, filter.playerId);
}

/**
 * Full-round player leaderboard for a set of matching round files.
 * Uses whole-round combat (same rating math as Statistics).
 *
 * @param {object} payload
 * @param {string[]} files
 */
export function leaderboardFromFiles(payload, files) {
  const want = new Set((files || []).filter(Boolean));
  if (!want.size) return [];

  /** @type {Map<string, { name: string, team: number, demoId: string }>} */
  const players = new Map();
  const rows = [];
  for (const demo of payload?.demos || []) {
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
  return aggregatePlayers(rows, players, { files: [...want] });
}

/** Unique players across a stats payload. */
export function listPlayers(payload) {
  /** @type {Map<string, { id: string, name: string, maps: Set<string> }>} */
  const byId = new Map();
  for (const demo of payload?.demos || []) {
    const map = demo.map || '';
    for (const p of demo.players || []) {
      if (!p.id) continue;
      let cur = byId.get(p.id);
      if (!cur) {
        cur = { id: p.id, name: p.name || p.id, maps: new Set() };
        byId.set(p.id, cur);
      }
      if (p.name) cur.name = p.name;
      if (map) cur.maps.add(map);
      for (const row of demo.rounds || []) {
        if (row.p?.[p.id] || row.ph?.[p.id]) {
          if (row.m) cur.maps.add(row.m);
        }
      }
    }
  }
  return [...byId.values()]
    .map((p) => ({ id: p.id, name: p.name, maps: [...p.maps].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
