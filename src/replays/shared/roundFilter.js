// ---------------------------------------------------------------------------
// replays/roundFilter.js
// Query engine over round *names*. The whole point of the naming scheme is
// that a filter never reads a round's contents: the collector takes a list of
// filenames, parses each stem (a regex, no I/O), and returns the matches. The
// backend runs this against a directory listing; the client runs the exact
// same code against the index it already holds, so both agree on results.
// ---------------------------------------------------------------------------

import { parseRoundId } from './roundId.js';

/**
 * @typedef {object} RoundQuery
 * @property {string[]} [maps]        map codes, any-of
 * @property {string[]} [teams]       team ids, matches either side
 * @property {string[]} [players]     player ids, all must appear (see playerMode)
 * @property {'all'|'any'} [playerMode='all']
 * @property {string} [wonBy]         team id that must have won
 * @property {number[]} [economies]   econ buckets, matched on either side
 * @property {number} [econA]         one side of an unordered economy pair
 * @property {number} [econB]         other side of an unordered economy pair
 * @property {number[]} [teamEconomies] econ buckets for `teamEconomyOf` only
 * @property {string} [teamEconomyOf] team id the `teamEconomies` filter applies to
 * @property {number} [roundMin=1]
 * @property {number} [roundMax=99]
 * @property {string} [search]        free text over the raw name
 */

/** True when (e1,e2) matches (a,b) in either order. Missing sides are wildcards. */
function matchesEconPair(e1, e2, a, b) {
  const hasA = Number.isFinite(a);
  const hasB = Number.isFinite(b);
  if (!hasA && !hasB) return true;
  if (hasA && hasB) return (e1 === a && e2 === b) || (e1 === b && e2 === a);
  const only = hasA ? a : b;
  return e1 === only || e2 === only;
}

const asSet = (v) => (v && v.length ? new Set(v) : null);

/**
 * Split a stored filename into its round id and its provenance suffix.
 *
 * Round names are the database key, but two demos can legitimately produce
 * the same one (a rematch of the same five-on-five, same map, same round
 * number, same result). Storage appends "~<demoId>" to keep them apart. The
 * suffix is stripped before parsing, so filtering still reads names only.
 */
export function splitStoredName(raw) {
  const noExt = String(raw).replace(/\.[a-z0-9]+$/i, '');
  const cut = noExt.indexOf('~');
  return cut === -1
    ? { stem: noExt, demoId: '', file: noExt }
    : { stem: noExt.slice(0, cut), demoId: noExt.slice(cut + 1), file: noExt };
}

/** Does one parsed round meet the query? */
export function matchesQuery(meta, query = {}) {
  if (!meta) return false;

  const maps = asSet(query.maps);
  if (maps && !maps.has(meta.map)) return false;

  const roundMin = query.roundMin ?? 1;
  const roundMax = query.roundMax ?? 99;
  if (meta.round < roundMin || meta.round > roundMax) return false;

  const teams = asSet(query.teams);
  if (teams && !teams.has(meta.team1) && !teams.has(meta.team2)) return false;

  // wonBy may be one id or several (merged team aliases).
  const wonBy = asSet(
    Array.isArray(query.wonBy)
      ? query.wonBy
      : query.wonBy
        ? String(query.wonBy)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null
  );
  if (wonBy) {
    const winner = meta.winner === 1 ? meta.team1 : meta.team2;
    if (!wonBy.has(winner)) return false;
  }

  const economies = asSet(query.economies);
  if (economies && !economies.has(meta.econ1) && !economies.has(meta.econ2)) return false;

  // Unordered pair: "full buy vs eco" matches either seating of the two teams.
  const asEcon = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  if (!matchesEconPair(meta.econ1, meta.econ2, asEcon(query.econA), asEcon(query.econB))) {
    return false;
  }

  // Economy of one specific team, rather than "either side".
  if (query.teamEconomyOf && query.teamEconomies?.length) {
    const side =
      query.teamEconomyOf === meta.team1
        ? meta.econ1
        : query.teamEconomyOf === meta.team2
          ? meta.econ2
          : null;
    if (side === null || !query.teamEconomies.includes(side)) return false;
  }

  if (query.players?.length) {
    const present = new Set(meta.players);
    const mode = query.playerMode === 'any' ? 'any' : 'all';
    const hits = query.players.filter((p) => present.has(p));
    if (mode === 'all' ? hits.length !== query.players.length : hits.length === 0) return false;
  }

  if (query.search) {
    const q = String(query.search).trim().toLowerCase();
    if (q && !meta.id.toLowerCase().includes(q)) return false;
  }

  return true;
}

/**
 * Collector. Takes raw names (with or without an extension) and returns
 * parsed matches, newest round order preserved by the caller's sort.
 *
 * @param {string[]} names
 * @param {RoundQuery} query
 * @param {{limit?: number}} [opts]
 */
export function collectRounds(names, query = {}, opts = {}) {
  const limit = opts.limit ?? Infinity;
  const out = [];
  for (const raw of names) {
    if (out.length >= limit) break;
    const { stem, demoId, file } = splitStoredName(raw);
    const meta = parseRoundId(stem);
    if (meta && matchesQuery(meta, query)) out.push({ ...meta, demoId, file });
  }
  return out;
}

/** Sort helper: match order in a real game (map, then round number). */
export function sortRounds(rounds) {
  return [...rounds].sort(
    (a, b) => a.map.localeCompare(b.map) || a.round - b.round || a.id.localeCompare(b.id)
  );
}

/**
 * Facet counts for the filter UI, computed from names alone so the sidebar
 * can show "Ancient (24)" without touching a single round file.
 */
export function summarize(rounds) {
  const bump = (obj, key) => {
    obj[key] = (obj[key] || 0) + 1;
  };
  const maps = {};
  const teams = {};
  const players = {};
  const economies = {};
  for (const r of rounds) {
    bump(maps, r.map);
    bump(teams, r.team1);
    bump(teams, r.team2);
    bump(economies, r.econ1);
    bump(economies, r.econ2);
    for (const p of r.players) bump(players, p);
  }
  return { total: rounds.length, maps, teams, players, economies };
}
