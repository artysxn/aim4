// ---------------------------------------------------------------------------
// replays/performance/performanceMath.js
// Pure helpers for the Performance page: resolve a player, last-N matches,
// metric cards, role grids, rating series. Aggregation still goes through
// statsMath so the numbers match Database.
// ---------------------------------------------------------------------------

import { MAPS, MAP_CODES } from '../shared/roundId.js';
import {
  aggregatePlayers,
  aggregateTeams,
  allRows,
  demoPassesDate,
  demoTimestamp,
  rowPasses,
  teamNameKey
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
/** A team needs more than a part-half before its rates mean anything. */
export const TEAM_PEER_MIN_ROUNDS = 30;

/** Two decimals, or an em dash. The Performance page's number formats. */
export const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '\u2014');
export const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '\u2014');
export const pct = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '\u2014');
export const signed = (n) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}` : '\u2014');

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
    dateTo: ui.dateTo || '',
    rankOwn: ui.rankOwn || '',
    rankOpp: ui.rankOpp || ''
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
  { key: 'kd', label: 'K/D', fmt: 'num2', band: 'kd', read: (p) => p?.kd },
  { key: 'swing', label: 'Swing', fmt: 'signed', band: 'swing', read: (p) => p?.prwSwing },
  { key: 'kpr', label: 'KPR', fmt: 'num2', band: 'kpr', read: (p) => kprOf(p) },
  { key: 'xk', label: 'xK', fmt: 'num2', band: 'xk', read: (p) => p?.xk },
  { key: 'tfw', label: 'Fight win', fmt: 'pct', band: 'pct', read: (p) => p?.tfw },
  { key: 'pfw', label: 'PFW', fmt: 'pct', band: 'pct', read: (p) => p?.pfw },
  // Opening duels, on the same band as the team page's OPK card: it is the same
  // metric read from the other end, and two bands would make the player's card
  // and their team's disagree about what a good number looks like.
  { key: 'opkRate', label: 'OPK', fmt: 'pct', band: 'winrate', read: (p) => p?.opkRate }
];

// ---------------------------------------------------------------------------
// Teams
//
// A team's page answers a different question from a player's. Nobody asks how
// well a team fragged; they ask whether it wins, and then which part of a round
// it wins or loses in. So the hero is the match record and the cards walk in
// from there: rounds, then the model's view of those rounds, then the three
// moments a round turns on (the opening duel and the two man-advantages), then
// what the team does with utility.
//
// Every number here comes from statsMath's team aggregation — the same rows the
// Database's Teams tab shows — so a team's page and its table row can never
// disagree.
// ---------------------------------------------------------------------------

/** The hero metric: matches won, not rounds. */
export const TEAM_HERO = {
  key: 'mapWinrate',
  label: 'Win rate',
  read: (t) => t?.mapWinrate
};

export const TEAM_CARD_METRICS = [
  { key: 'roundWinrate', label: 'Round WR', fmt: 'pct', band: 'winrate', read: (t) => t?.roundWinrate },
  { key: 'prw', label: 'PRW', fmt: 'pct', band: 'winrate', read: (t) => t?.prw },
  { key: 'opkRate', label: 'OPK WR', fmt: 'pct', band: 'winrate', read: (t) => t?.opkRate },
  { key: 'conv5v4', label: '5v4', fmt: 'pct', band: 'winrate', read: (t) => t?.conv5v4 },
  { key: 'conv4v5', label: '4v5', fmt: 'pct', band: 'winrate', read: (t) => t?.conv4v5 },
  { key: 'utilDmg', label: 'Util dmg', fmt: 'num1', band: 'utilDmg', read: (t) => t?.utilDmgPerRound },
  { key: 'ac', label: 'AC%', fmt: 'pct', band: 'winrate', read: (t) => t?.ac }
];

/** Which side (1 or 2) a team played in a demo, or 0 if it is not in it. */
export function teamSideOf(demo, key) {
  if (!demo || !key) return 0;
  if (teamNameKey(demo.name1, demo.t1) === key) return 1;
  if (teamNameKey(demo.name2, demo.t2) === key) return 2;
  return 0;
}

/** Demos this team played, newest first, after the date window. */
export function teamDemos(payload, teamKey, dateFilter = {}) {
  const key = teamNameKey(teamKey);
  return (payload?.demos || [])
    .filter((d) => teamSideOf(d, key) !== 0)
    .filter((d) => demoPassesDate(d, dateFilter))
    .sort((a, b) => demoTimestamp(b) - demoTimestamp(a) || String(b.id).localeCompare(String(a.id)));
}

/** Newest `n` demo ids for this team that still have a passing round (0 = all). */
export function lastTeamDemoIds(payload, teamKey, n, filter = {}, players = null, demos = null) {
  const key = teamNameKey(teamKey);
  const list = teamDemos(payload, teamKey, filter);
  const matched = [];
  for (const demo of list) {
    const side = teamSideOf(demo, key);
    if (!side) continue;
    if (!players) {
      matched.push(demo);
      continue;
    }
    const hit = (demo.rounds || []).some((row) => rowPasses(row, filter, side, players, demos));
    if (hit) matched.push(demo);
  }
  const slice = n > 0 ? matched.slice(0, n) : matched;
  return new Set(slice.map((d) => d.id));
}

/** Rows for this team after map / side / buy / date / last-N. */
export function teamRows(payload, teamKey, ui, players, demos) {
  const key = teamNameKey(teamKey);
  const active = statsFilterFrom(ui);
  const allowed = lastTeamDemoIds(payload, teamKey, Number(ui.last) || 0, active, players, demos);
  const out = [];
  for (const row of allRows(payload)) {
    if (!allowed.has(row.d)) continue;
    const demo = demos.get(row.d);
    const side = teamSideOf(demo, key);
    if (!side) continue;
    if (!rowPasses(row, active, side, players, demos)) continue;
    out.push(row);
  }
  return out;
}

/**
 * The aggregated row for one team.
 *
 * aggregateTeams returns every team present in `rows`, and a team's own rounds
 * necessarily carry its opponents too, so the row has to be picked out by key
 * rather than assumed to be the only one.
 */
export function teamStats(payload, teamKey, ui, players, demos) {
  const key = teamNameKey(teamKey);
  const rows = teamRows(payload, teamKey, ui, players, demos);
  if (!rows.length) return null;
  const all = aggregateTeams(rows, players, demos, {});
  return all.find((t) => t.key === key) || null;
}

/** One point per match for a team, oldest first. */
export function teamMatchSeries(payload, teamKey, ui, players, demos) {
  const key = teamNameKey(teamKey);
  const active = statsFilterFrom(ui);
  const allowed = lastTeamDemoIds(payload, teamKey, Number(ui.last) || 0, active, players, demos);
  const points = [];
  for (const demo of payload?.demos || []) {
    if (!allowed.has(demo.id)) continue;
    const side = teamSideOf(demo, key);
    if (!side) continue;
    const rows = (demo.rounds || []).filter((row) => rowPasses(row, active, side, players, demos));
    if (!rows.length) continue;
    const t = aggregateTeams(rows, players, demos, {}).find((x) => x.key === key);
    if (!t?.rounds) continue;
    let mine = 0;
    let theirs = 0;
    for (const row of rows) {
      if (row.w === side) mine++;
      else if (row.w === 1 || row.w === 2) theirs++;
    }
    const opp = side === 1 ? demo.name2 : demo.name1;
    const won = demo.winner === side;
    points.push({
      demoId: demo.id,
      when: demoTimestamp(demo),
      // The per-match "win rate" is the match itself: 100 or 0. Averaged over a
      // series that is exactly the record, and it keeps the hero metric and the
      // chart on one scale.
      mapWinrate: demo.winner ? (won ? 100 : 0) : null,
      roundWinrate: t.roundWinrate,
      prw: t.prw,
      opkRate: t.opkRate,
      conv5v4: t.conv5v4,
      conv4v5: t.conv4v5,
      utilDmg: t.utilDmgPerRound,
      ac: t.ac,
      map: demo.map || '',
      opponent: opp || '',
      result: demo.winner ? (won ? 'W' : 'L') : '',
      scoreLabel: `${mine}:${theirs}`,
      scoreSort: mine - theirs,
      stats: t
    });
  }
  points.sort((a, b) => a.when - b.when || String(a.demoId).localeCompare(String(b.demoId)));
  return points;
}

/**
 * Library averages for the team cards.
 *
 * Teams with too few rounds are dropped for the same reason players are: a side
 * that played nine rounds of one half is noise, and it drags the line every
 * real team is being measured against.
 */
export function teamPeerAverages(payload, ui, players, demos) {
  const active = statsFilterFrom(ui);
  const rows = allRows(payload).filter((row) => {
    const demo = demos.get(row.d);
    if (!demoPassesDate(demo, active)) return false;
    if (active.maps?.length && !active.maps.includes(row.m)) return false;
    return true;
  });
  const list = aggregateTeams(rows, players, demos, {}).filter(
    (t) => t.rounds >= TEAM_PEER_MIN_ROUNDS
  );
  const out = {};
  for (const m of [TEAM_HERO, ...TEAM_CARD_METRICS]) out[m.key] = mean(list.map(m.read));
  return out;
}

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
      opkRate: p.openKills + p.openDeaths > 0 ? p.opkRate : null,
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
      let peerSwing = null;
      if (position) {
        const { rows, active } = mapSideRows(payload, map.code, side, dateFilter, players, demos);
        const tagged = attachPlayerRoles(aggregatePlayers(rows, players, active, demos), payload, {
          maps: [map.code]
        });
        const peers = tagged.filter(
          (p) => p.id !== playerId && roleLabel(p, side) === position && p.rounds >= 8
        );
        peer = mean(peers.map((p) => p.rating));
        peerSwing = mean(peers.map((p) => p.prwSwing));
      }
      out[side].push({
        map: map.code,
        mapName: map.name,
        position,
        rating: mine?.rating ?? null,
        swing: mine?.prwSwing ?? null,
        rounds: mine?.rounds || 0,
        peer,
        peerSwing
      });
    }
  }
  return out;
}
