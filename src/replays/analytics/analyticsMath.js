// ---------------------------------------------------------------------------
// Aggregate rating-style stats over early/mid/late phase windows for one player.
// Each matching phase window counts as one sample (like one round in Statistics).
// ---------------------------------------------------------------------------

import { PHASES } from '../roles/phaseCombat.js';
import { P, bucketRating, rowPasses } from '../shared/statsMath.js';

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
 * @property {Set<string>|string[]} [phases]  empty ⇒ all
 * @property {Set<string>|string[]} [positions]
 * @property {Set<string>|string[]} [zones]
 * @property {Set<string>|string[]} [areas]
 */

function asSet(v) {
  if (!v) return new Set();
  return v instanceof Set ? v : new Set(v);
}

function emptyBucket() {
  return { rounds: 0, kills: 0, deaths: 0, assists: 0, damage: 0, kast: 0 };
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

function locationPasses(window, filter) {
  const positions = asSet(filter.positions);
  const zones = asSet(filter.zones);
  const areas = asSet(filter.areas);
  if (positions.size && !positions.has(window.pos || '')) return false;
  if (zones.size && !zones.has(window.zone || '')) return false;
  if (areas.size && !areas.has(window.area || '')) return false;
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
  return true;
}

/**
 * Matching phase windows for one player under the current filters.
 * @returns {Array<{ row, phase, window, team, file: string }>}
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
        if (!locationPasses(window, filter)) continue;
        out.push({
          row,
          phase,
          window,
          team,
          file: row.f,
          demoId: row.d,
          round: row.n
        });
      }
    }
  }
  return out;
}

/**
 * Aggregate stats over matching phase windows.
 */
export function aggregateAnalytics(payload, filter) {
  const windows = matchingWindows(payload, filter);
  const bucket = emptyBucket();
  let shots = 0;
  let hits = 0;
  let headshots = 0;
  let awpShots = 0;
  let awpHits = 0;
  const files = new Set();

  for (const w of windows) {
    const line = w.window.p;
    addBucket(bucket, line);
    shots += line[P.SHOTS] || 0;
    hits += line[P.HITS] || 0;
    headshots += line[P.HEADSHOTS] || 0;
    awpShots += line[P.AWP_SHOTS] || 0;
    awpHits += line[P.AWP_HITS] || 0;
    if (w.file) files.add(w.file);
  }

  const rating = bucketRating(bucket);
  const div = (a, b) => (b > 0 ? a / b : 0);

  return {
    windows,
    files: [...files],
    samples: rating.rounds,
    rounds: files.size,
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
 * Frequency of dominant locations across matching windows (ignore location filters).
 */
export function locationBreakdown(payload, filter) {
  const base = {
    ...filter,
    positions: new Set(),
    zones: new Set(),
    areas: new Set()
  };
  const windows = matchingWindows(payload, base);
  const pos = new Map();
  const zone = new Map();
  const area = new Map();
  const bump = (map, id) => {
    if (!id) return;
    map.set(id, (map.get(id) || 0) + 1);
  };
  for (const w of windows) {
    bump(pos, w.window.pos);
    bump(zone, w.window.zone);
    bump(area, w.window.area);
  }
  const rank = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, count }));
  return { pos: rank(pos), zone: rank(zone), area: rank(area), samples: windows.length };
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
      // Also count maps from rounds they appear in.
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
