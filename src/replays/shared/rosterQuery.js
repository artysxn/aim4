// ---------------------------------------------------------------------------
// replays/shared/rosterQuery.js
// Reading the roster catalogue. Shared so the browser and the server answer
// "which demos feature this player" with the same function.
// ---------------------------------------------------------------------------

import { normalizePlayerName } from './teamStandings.js';
import { teamNameKey } from './statsMath.js';

/** Demo ids featuring a player, newest first. */
export function demosForPlayer(roster, playerId) {
  const at = (roster?.players || []).findIndex((p) => p.i === playerId);
  if (at < 0) return [];
  const out = [];
  for (const d of roster.demos || []) {
    for (let i = 0; i < d.p.length; i += 2) {
      if (d.p[i] === at) {
        out.push(d);
        break;
      }
    }
  }
  out.sort((a, b) => b.u - a.u);
  return out.map((d) => d.id);
}

/** Demo ids for a team, matched on short id or normalized display name. */
export function demosForTeam(roster, teamKey) {
  const want = teamNameKey(String(teamKey || ''));
  if (!want) return [];
  const out = (roster?.demos || []).filter(
    (d) =>
      d.t1 === teamKey ||
      d.t2 === teamKey ||
      teamNameKey(d.n1, d.t1) === want ||
      teamNameKey(d.n2, d.t2) === want
  );
  out.sort((a, b) => b.u - a.u);
  return out.map((d) => d.id);
}

/**
 * Players for the typeahead, most-played first. Replaces `listPlayers(payload)`,
 * which could not answer until the whole library had been downloaded.
 */
export function rosterPlayers(roster, query = '', limit = 20) {
  const needle = normalizePlayerName(String(query || ''));
  const list = (roster?.players || []).map((p) => ({
    id: p.i,
    name: p.n,
    maps: p.c
  }));
  const hits = needle
    ? list.filter((p) => normalizePlayerName(p.name).includes(needle))
    : list;
  return hits.sort((a, b) => b.maps - a.maps || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Teams for the typeahead, clustered by normalized display name. */
export function rosterTeams(roster, query = '', limit = 20) {
  const needle = normalizePlayerName(String(query || ''));
  /** @type {Map<string, { key: string, name: string, maps: number }>} */
  const byKey = new Map();
  for (const d of roster?.demos || []) {
    for (const [id, name] of [
      [d.t1, d.n1],
      [d.t2, d.n2]
    ]) {
      const key = teamNameKey(name, id);
      if (!key) continue;
      const label = String(name || id || '').trim();
      let hit = byKey.get(key);
      if (!hit) {
        hit = { key: label || key, name: label || key, maps: 0 };
        byKey.set(key, hit);
      }
      hit.maps += 1;
    }
  }
  const list = [...byKey.values()];
  const hits = needle
    ? list.filter((t) => normalizePlayerName(t.name).includes(needle))
    : list;
  return hits.sort((a, b) => b.maps - a.maps || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Player ids that appear on a team, for the team → player picker. */
export function rosterTeamPlayers(roster, teamKey) {
  const want = teamNameKey(String(teamKey || ''));
  const ids = new Set();
  for (const d of roster?.demos || []) {
    const t1 = teamNameKey(d.n1, d.t1);
    const t2 = teamNameKey(d.n2, d.t2);
    const side = d.t1 === teamKey || t1 === want ? 1 : d.t2 === teamKey || t2 === want ? 2 : 0;
    if (!side) continue;
    for (let i = 0; i < d.p.length; i += 2) {
      if (d.p[i + 1] === side) ids.add(d.p[i]);
    }
  }
  return [...ids]
    .map((at) => roster.players[at])
    .filter(Boolean)
    .map((p) => ({ id: p.i, name: p.n, maps: p.c }))
    .sort((a, b) => b.maps - a.maps || a.name.localeCompare(b.name));
}
