// ---------------------------------------------------------------------------
// replays/roundFilter.js
// Query engine over round *names*. The whole point of the naming scheme is
// that a filter never reads a round's contents: the collector takes a list of
// filenames, parses each stem (a regex, no I/O), and returns the matches. The
// backend runs this against a directory listing; the client runs the exact
// same code against the index it already holds, so both agree on results.
// ---------------------------------------------------------------------------

import { buyBucket, econHasAwp, isEqualBuyRound, parseRoundId } from './roundId.js';

/**
 * @typedef {object} RoundQuery
 * @property {string[]} [maps]        map codes, any-of
 * @property {string[]} [teams]       team ids, matches either side
 * @property {string[]} [players]     player ids, all must appear (see playerMode)
 * @property {'all'|'any'} [playerMode='all']
 * @property {string|string[]} [wonBy] team id(s) that must have won (legacy)
 * @property {'selected'|'opponent'} [wonByMode]
 *   Relative to `teams`: winner is a selected team, or the other side.
 *   When both sides of a round are in `teams`, either mode matches.
 * @property {number[]} [economies]   buy buckets, matched on either side (5→4)
 * @property {number} [econA]         one side of an unordered economy pair
 * @property {number} [econB]         other side of an unordered economy pair
 * @property {boolean} [hasAwpA]      econA side must have had an AWP (digit 5)
 * @property {boolean} [hasAwpB]      econB side must have had an AWP (digit 5)
 * @property {boolean} [equalBuy]     pistol/half/full vs same (AWP ignored)
 * @property {number[]} [teamEconomies] econ buckets for `teamEconomyOf` only
 * @property {string} [teamEconomyOf] team id the `teamEconomies` filter applies to
 * @property {number} [roundMin=1]
 * @property {number} [roundMax=99]
 * @property {string} [search]        free text over the raw name
 */

function awpOk(econCode, wantAwp) {
  return !wantAwp || econHasAwp(econCode);
}

/**
 * One seating of the unordered Team1/Team2 filter onto filename sides.
 * Buy and Has AWP constraints travel together on each filter slot.
 */
function econOrientationOk(eLeft, eRight, buyLeft, buyRight, awpLeft, awpRight) {
  if (Number.isFinite(buyLeft) && buyBucket(eLeft) !== buyBucket(buyLeft)) return false;
  if (Number.isFinite(buyRight) && buyBucket(eRight) !== buyBucket(buyRight)) return false;
  return awpOk(eLeft, awpLeft) && awpOk(eRight, awpRight);
}

/**
 * True when (e1,e2) matches buy pair (a,b) in either order.
 * Digits 5 (full+AWP) count as Full buy (4). Optional hasAwp flags require
 * the matching side's stored digit to be 5.
 */
function matchesEconPair(e1, e2, a, b, awpA = false, awpB = false) {
  const buyA = Number.isFinite(a) ? a : undefined;
  const buyB = Number.isFinite(b) ? b : undefined;
  if (buyA === undefined && buyB === undefined && !awpA && !awpB) return true;
  return (
    econOrientationOk(e1, e2, buyA, buyB, awpA, awpB) ||
    econOrientationOk(e1, e2, buyB, buyA, awpB, awpA)
  );
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

/**
 * Compile a query into a reusable predicate.
 *
 * The collector runs one query against every round name in the library, and
 * building the filter Sets (maps, teams, wonBy, economies) inside the match
 * put a handful of throwaway allocations on every one of those rounds — a
 * million-odd objects per filter click at library scale. They only depend on
 * the query, so build them once here.
 *
 * @param {RoundQuery} query
 * @returns {(meta: object) => boolean}
 */
export function compileQuery(query = {}) {
  const maps = asSet(query.maps);
  const teams = asSet(query.teams);
  const roundMin = query.roundMin ?? 1;
  const roundMax = query.roundMax ?? 99;
  const wonByMode =
    query.wonByMode === 'selected' || query.wonByMode === 'opponent' ? query.wonByMode : '';

  // Legacy: wonBy may be one id or several (merged team aliases).
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

  const economies = asSet(query.economies);
  const asEcon = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const econA = asEcon(query.econA);
  const econB = asEcon(query.econB);
  const hasAwpA = Boolean(query.hasAwpA);
  const hasAwpB = Boolean(query.hasAwpB);
  const anyEconPair = econA !== undefined || econB !== undefined || hasAwpA || hasAwpB;
  const equalBuy = Boolean(query.equalBuy);

  const teamEconomyOf =
    query.teamEconomyOf && query.teamEconomies?.length ? query.teamEconomyOf : '';
  const teamEconomies = teamEconomyOf ? query.teamEconomies : null;

  const players = query.players?.length ? [...query.players] : null;
  const playerMode = query.playerMode === 'any' ? 'any' : 'all';
  const search = query.search ? String(query.search).trim().toLowerCase() : '';

  return (meta) => {
    if (!meta) return false;

    if (maps && !maps.has(meta.map)) return false;
    if (meta.round < roundMin || meta.round > roundMax) return false;
    if (teams && !teams.has(meta.team1) && !teams.has(meta.team2)) return false;

    const winner = meta.winner === 1 ? meta.team1 : meta.team2;

    // Relative winner: "selected team" vs "opponent", keyed off the teams
    // filter. If both sides are selected (e.g. Vitality vs G2), either choice
    // matches — one selected side always wins and the other always loses.
    if (wonByMode && teams) {
      const t1 = teams.has(meta.team1);
      const t2 = teams.has(meta.team2);
      if (!(t1 && t2)) {
        if (wonByMode === 'selected' && !teams.has(winner)) return false;
        if (wonByMode === 'opponent' && teams.has(winner)) return false;
      }
    }

    if (wonBy && !wonBy.has(winner)) return false;

    if (economies) {
      const b1 = buyBucket(meta.econ1);
      const b2 = buyBucket(meta.econ2);
      if (!economies.has(b1) && !economies.has(b2)) return false;
    }

    // Unordered pair: "full buy vs eco" matches either seating of the two teams.
    if (anyEconPair && !matchesEconPair(meta.econ1, meta.econ2, econA, econB, hasAwpA, hasAwpB)) {
      return false;
    }

    if (equalBuy && !isEqualBuyRound(meta.econ1, meta.econ2)) return false;

    // Economy of one specific team, rather than "either side".
    if (teamEconomyOf) {
      const raw =
        teamEconomyOf === meta.team1
          ? meta.econ1
          : teamEconomyOf === meta.team2
            ? meta.econ2
            : null;
      if (raw === null || !teamEconomies.includes(buyBucket(raw))) return false;
    }

    if (players) {
      const present = meta.players || [];
      let hits = 0;
      for (const p of players) if (present.includes(p)) hits += 1;
      if (playerMode === 'all' ? hits !== players.length : hits === 0) return false;
    }

    if (search && !meta.id.toLowerCase().includes(search)) return false;

    return true;
  };
}

/** Does one parsed round meet the query? One-shot form of compileQuery. */
export function matchesQuery(meta, query = {}) {
  return compileQuery(query)(meta);
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
  const matches = compileQuery(query);
  const out = [];
  for (const raw of names) {
    if (out.length >= limit) break;
    const { stem, demoId, file } = splitStoredName(raw);
    const meta = parseRoundId(stem);
    if (meta && matches(meta)) out.push({ ...meta, demoId, file });
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
    bump(economies, buyBucket(r.econ1));
    bump(economies, buyBucket(r.econ2));
    for (const p of r.players) bump(players, p);
  }
  return { total: rounds.length, maps, teams, players, economies };
}
