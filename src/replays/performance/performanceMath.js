// ---------------------------------------------------------------------------
// replays/performance/performanceMath.js
// Pure helpers for the Performance page: resolve a player, last-N matches,
// metric cards, role grids, rating series. Aggregation still goes through
// statsMath so the numbers match Database.
// ---------------------------------------------------------------------------

import { MAPS, MAP_CODES } from '../shared/roundId.js';
import {
  aggregatePlayers,
  allRows,
  demoPassesDate,
  demoTimestamp,
  rowPasses
} from '../shared/statsMath.js';
import { attachPlayerRoles } from '../roles/assignRoles.js';
import { normalizePlayerName } from '../shared/teamStandings.js';

/** Map pool for the roles grid. Same seven as the library (no Overpass). */
export const PERF_MAPS = MAP_CODES.map((code) => ({
  code,
  name: MAPS[code]?.name || code
}));

export const LAST_MATCH_OPTS = [
  { value: 10, label: 'Last 10' },
  { value: 20, label: 'Last 20' },
  { value: 50, label: 'Last 50' },
  { value: 0, label: 'All' }
];

const PEER_MIN_ROUNDS = 20;

export function stripAt(name) {
  return String(name || '')
    .trim()
    .replace(/^@+/, '');
}

/**
 * Exact in-game name match against the account username.
 * Several demos can share a handle; the one with the most maps wins, then name.
 */
export function findPlayerByUsername(players, username) {
  const want = normalizePlayerName(stripAt(username));
  if (!want) return null;
  const hits = (players || []).filter((p) => normalizePlayerName(p.name) === want);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.maps?.length || 0) - (a.maps?.length || 0) || a.name.localeCompare(b.name));
  return hits[0];
}

export function kprOf(p) {
  if (!p?.rounds) return null;
  return p.kills / p.rounds;
}

/** Demos this player sat in, newest first, after the date window. */
export function playerDemos(payload, playerId, dateFilter = {}) {
  return (payload?.demos || [])
    .filter((d) => (d.players || []).some((p) => p.id === playerId))
    .filter((d) => demoPassesDate(d, dateFilter))
    .sort((a, b) => demoTimestamp(b) - demoTimestamp(a) || String(b.id).localeCompare(String(a.id)));
}

/** Newest `n` demo ids that still have a passing round (0 = all). */
export function lastDemoIds(payload, playerId, n, filter = {}, players = null, demos = null) {
  const list = playerDemos(payload, playerId, filter);
  const matched = [];
  for (const demo of list) {
    const seat = (demo.players || []).find((p) => p.id === playerId);
    if (!seat) continue;
    const team = seat.team === 2 ? 2 : 1;
    if (!players) {
      matched.push(demo);
      continue;
    }
    const hit = (demo.rounds || []).some(
      (row) => row.p?.[playerId] && rowPasses(row, filter, team, players, demos)
    );
    if (hit) matched.push(demo);
  }
  const slice = n > 0 ? matched.slice(0, n) : matched;
  return new Set(slice.map((d) => d.id));
}

export function statsFilterFrom(ui) {
  const econ = ui.econ === '' || ui.econ == null ? null : Number(ui.econ);
  return {
    maps: ui.map ? [ui.map] : [],
    side: ui.side || '',
    econ: Number.isFinite(econ) ? econ : null,
    dateFrom: ui.dateFrom || '',
    dateTo: ui.dateTo || ''
  };
}

/**
 * Rows for this player after map / side / buy / date / last-N.
 */
export function playerRows(payload, playerId, ui, players, demos) {
  const active = statsFilterFrom(ui);
  const allowed = lastDemoIds(payload, playerId, Number(ui.last) || 0, active, players, demos);
  const out = [];
  for (const row of allRows(payload)) {
    if (!allowed.has(row.d)) continue;
    if (!row.p?.[playerId]) continue;
    const seat = players.get(`${row.d}:${playerId}`);
    if (!seat) continue;
    const team = seat.team === 2 ? 2 : 1;
    if (!rowPasses(row, active, team, players, demos)) continue;
    out.push(row);
  }
  return out;
}

export function playerStats(payload, playerId, ui, players, demos) {
  const rows = playerRows(payload, playerId, ui, players, demos);
  return aggregatePlayers(rows, players, {}, demos).find((p) => p.id === playerId) || null;
}

function mean(values) {
  const list = values.filter((n) => Number.isFinite(n));
  if (!list.length) return null;
  return list.reduce((s, n) => s + n, 0) / list.length;
}

export const CARD_METRICS = [
  { key: 'kd', label: 'K/D', fmt: 'num2', read: (p) => p?.kd },
  { key: 'swing', label: 'Swing', fmt: 'signed', read: (p) => p?.prwSwing },
  { key: 'kpr', label: 'KPR', fmt: 'num2', read: (p) => kprOf(p) },
  { key: 'xk', label: 'xK', fmt: 'num2', read: (p) => p?.xk },
  { key: 'tfw', label: 'Fight win', fmt: 'pct', read: (p) => p?.tfw },
  { key: 'pfw', label: 'PFW', fmt: 'pct', read: (p) => p?.pfw }
];

/** Library averages for the summary cards (peers with enough rounds). */
export function peerAverages(payload, ui, players, demos) {
  const active = statsFilterFrom(ui);
  const rows = allRows(payload).filter((row) => {
    const demo = demos.get(row.d);
    if (!demoPassesDate(demo, active)) return false;
    if (active.maps?.length && !active.maps.includes(row.m)) return false;
    return true;
  });
  const list = aggregatePlayers(rows, players, active, demos).filter((p) => p.rounds >= PEER_MIN_ROUNDS);
  const out = {};
  for (const m of CARD_METRICS) out[m.key] = mean(list.map(m.read));
  return out;
}

/** Trailing moving average. Window 1 returns the series unchanged. */
export function smoothSeries(values, window = 5) {
  const w = Math.max(1, Number(window) || 1);
  return values.map((_, i) => {
    const from = Math.max(0, i - w + 1);
    const slice = values.slice(from, i + 1).filter((n) => Number.isFinite(n));
    if (!slice.length) return null;
    return slice.reduce((s, n) => s + n, 0) / slice.length;
  });
}

/**
 * Catmull-Rom spline as SVG cubics. `points` are `{ x, y }` in viewBox space.
 */
export function curvePath(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (pts.length < 2) return '';
  const fmt = (n) => n.toFixed(1);
  let d = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  if (pts.length === 2) {
    return `${d} L${fmt(pts[1].x)} ${fmt(pts[1].y)}`;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return d;
}

/**
 * One point per match, oldest first.
 */
export function matchSeries(payload, playerId, ui, players, demos) {
  const active = statsFilterFrom(ui);
  const allowed = lastDemoIds(payload, playerId, Number(ui.last) || 0, active, players, demos);
  const points = [];
  for (const demo of payload?.demos || []) {
    if (!allowed.has(demo.id)) continue;
    const seat = (demo.players || []).find((p) => p.id === playerId);
    if (!seat) continue;
    const team = seat.team === 2 ? 2 : 1;
    const rows = (demo.rounds || []).filter((row) => rowPasses(row, active, team, players, demos));
    const p = aggregatePlayers(rows, players, {}, demos).find((x) => x.id === playerId);
    if (!p?.rounds) continue;
    let mine = 0;
    let theirs = 0;
    for (const row of rows) {
      if (row.w === team) mine++;
      else if (row.w === 1 || row.w === 2) theirs++;
    }
    const opp = team === 1 ? demo.name2 : demo.name1;
    points.push({
      demoId: demo.id,
      when: demoTimestamp(demo),
      rating: p.rating,
      kd: p.kd,
      swing: p.prwSwing,
      kpr: kprOf(p),
      xk: p.xk,
      tfw: p.tfw,
      pfw: p.pfw,
      map: demo.map || '',
      opponent: opp || '',
      result: demo.winner === team ? 'W' : demo.winner ? 'L' : '',
      scoreLabel: `${mine}:${theirs}`,
      scoreSort: mine - theirs,
      stats: p
    });
  }
  points.sort((a, b) => a.when - b.when || String(a.demoId).localeCompare(String(b.demoId)));
  return points;
}

function roleLabel(row, side) {
  if (side === 'CT') return row.posCT || row.roleCT || '';
  return row.posT || row.roleT || '';
}

function mapSideRows(payload, map, side, dateFilter, players, demos) {
  const active = { maps: [map], side, dateFrom: dateFilter.dateFrom || '', dateTo: dateFilter.dateTo || '' };
  const out = [];
  for (const row of allRows(payload)) {
    if (row.m !== map) continue;
    const demo = demos.get(row.d);
    if (!demoPassesDate(demo, active)) continue;
    out.push(row);
  }
  return { rows: out, active };
}

/**
 * 7 maps × T and 7 × CT. Rating / swing are this player's numbers on that
 * map+side. Peer rating is everyone whose stored role on that map+side matches.
 */
export function roleGrid(payload, playerId, ui, players, demos) {
  const out = { T: [], CT: [] };
  const dateFilter = { dateFrom: ui.dateFrom || '', dateTo: ui.dateTo || '' };
  for (const side of ['T', 'CT']) {
    for (const map of PERF_MAPS) {
      const mine = playerStats(payload, playerId, { ...ui, map: map.code, side }, players, demos);
      const withRole = attachPlayerRoles(mine ? [mine] : [], payload, { maps: [map.code] })[0];
      const position = roleLabel(withRole || {}, side);
      let peer = null;
      if (position) {
        const { rows, active } = mapSideRows(payload, map.code, side, dateFilter, players, demos);
        const tagged = attachPlayerRoles(aggregatePlayers(rows, players, active, demos), payload, {
          maps: [map.code]
        });
        const ratings = tagged
          .filter((p) => p.id !== playerId && roleLabel(p, side) === position && p.rounds >= 8)
          .map((p) => p.rating);
        peer = mean(ratings);
      }
      out[side].push({
        map: map.code,
        mapName: map.name,
        position,
        rating: mine?.rating ?? null,
        swing: mine?.prwSwing ?? null,
        rounds: mine?.rounds || 0,
        peer
      });
    }
  }
  return out;
}
