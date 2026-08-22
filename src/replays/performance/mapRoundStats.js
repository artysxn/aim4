// ---------------------------------------------------------------------------
// replays/performance/mapRoundStats.js
// Performance > Maps: one row per round type in the library, per map, per side.
//
// The Team Overview asks how often a team runs a call. The reader here is one
// player, so the question is a different one: how do I play when that call is
// on. Rating and swing are this player's over exactly those rounds, the
// winrate is the team's, and both are split by whether we ran the call or the
// other side ran it at us.
//
// Every bucket is filled in one walk. Tags sit on the row for both sides at
// once (roundTags.js), so a round the player spent on CT feeds the CT table's
// "ran" column and the T table's "faced" column in the same pass, and nothing
// re-reads a round file.
// ---------------------------------------------------------------------------

import { hasRoundLibrary, roundTypeRows } from '../analytics/roundLibrary.js';
import { rowTags } from '../analytics/roundTags.js';
import { MAP_CODES } from '../shared/roundId.js';
import { aggregatePlayers, demoTimestamp, rowPasses } from '../shared/statsMath.js';
import { lastDemoIds } from './performanceMath.js';

/** Maps the round library can read, in the site's map order. */
export const MAP_ROUND_CODES = MAP_CODES.filter((code) => hasRoundLibrary(code));

/**
 * Round files one timeline link carries, newest first. Same cap the antistrat
 * document uses: a "Default / Other" bucket runs to hundreds of rounds, and
 * every file name is ~58 characters of query string.
 */
export const LINK_FILES_MAX = 40;

/**
 * The toolbar filter minus map and side.
 *
 * A section here IS a map and a table IS a side, so re-applying either would
 * only blank the tables the reader asked to see. Side is also the wrong shape:
 * it is relative to the player's team, and half of every table is deliberately
 * the rounds they spent on the other one.
 */
export function mapGridFilter(ui = {}) {
  const econ = ui.econ === '' || ui.econ == null ? null : Number(ui.econ);
  return {
    maps: [],
    side: '',
    econ: Number.isFinite(econ) ? econ : null,
    dateFrom: ui.dateFrom || '',
    dateTo: ui.dateTo || '',
    rankOwn: ui.rankOwn || '',
    rankOpp: ui.rankOpp || ''
  };
}

function emptyCell() {
  return { rounds: 0, wins: 0, winrate: null, rating: null, swing: null, files: [] };
}

/**
 * @typedef {object} RoundTypeCell
 * @property {number} rounds
 * @property {number} wins
 * @property {number|null} winrate  percent, the team's, over these rounds
 * @property {number|null} rating   Rating 3.0 for this player, over these rounds
 * @property {number|null} swing    this player's PRW swing
 * @property {string[]} files       newest first, capped for a timeline link
 *
 * @typedef {object} RoundTypeRow
 * @property {string} key
 * @property {string} label
 * @property {string} desc
 * @property {RoundTypeCell} ran     we were the side making this call
 * @property {RoundTypeCell} faced   the other side made it at us
 */

/**
 * @param {{ demos?: Array }} payload  a payload scoped to this player
 * @param {string} playerId
 * @param {object} ui                 the toolbar state
 * @param {Map} players
 * @param {Map} demos
 * @returns {Record<string, { T: RoundTypeRow[], CT: RoundTypeRow[] }>} keyed by map code
 */
export function mapRoundGrid(payload, playerId, ui = {}, players, demos) {
  const active = mapGridFilter(ui);
  const allowed = lastDemoIds(payload, playerId, Number(ui.last) || 0, active, players, demos);

  /** `map|side|key|r|f` -> the rounds that landed in it. */
  const bags = new Map();
  const grab = (key) => {
    let bag = bags.get(key);
    if (!bag) {
      bag = { rows: [], wins: 0, files: [] };
      bags.set(key, bag);
    }
    return bag;
  };

  for (const demo of payload?.demos || []) {
    const code = String(demo.map || '').toUpperCase();
    if (!hasRoundLibrary(code)) continue;
    if (!allowed.has(demo.id)) continue;
    const seat = (demo.players || []).find((p) => p.id === playerId);
    if (!seat) continue;
    const team = seat.team === 2 ? 2 : 1;
    const at = demoTimestamp(demo);
    for (const row of demo.rounds || []) {
      if (!row?.rl) continue;
      if (!row.p?.[playerId]) continue;
      if (!rowPasses(row, active, team, players, demos)) continue;
      const won = row.w === team;
      const file = String(row.f || '').trim();
      for (const side of ['T', 'CT']) {
        const tags = rowTags(row, side);
        if (!tags.length) continue;
        // Whoever played this side in this round is the one making the call.
        const runner = (row.s1 || 'T') === side ? 1 : 2;
        const lane = runner === team ? 'r' : 'f';
        for (const tag of tags) {
          const bag = grab(`${code}|${side}|${tag.k}|${lane}`);
          bag.rows.push(row);
          if (won) bag.wins++;
          if (file) bag.files.push({ file, at });
        }
      }
    }
  }

  const cellOf = (bag) => {
    if (!bag?.rows.length) return emptyCell();
    // Rows are already filtered, so the aggregate takes no filter of its own —
    // same call playerStats makes, so the numbers match the Summary chapter.
    const p = aggregatePlayers(bag.rows, players, {}, demos).find((x) => x.id === playerId);
    const files = [...bag.files]
      .sort((a, b) => b.at - a.at)
      .map((x) => x.file);
    return {
      rounds: bag.rows.length,
      wins: bag.wins,
      winrate: (bag.wins / bag.rows.length) * 100,
      rating: Number.isFinite(p?.rating) ? p.rating : null,
      swing: Number.isFinite(p?.prwSwing) ? p.prwSwing : null,
      files: [...new Set(files)].slice(0, LINK_FILES_MAX)
    };
  };

  const out = {};
  for (const code of MAP_ROUND_CODES) {
    out[code] = { T: [], CT: [] };
    for (const side of ['T', 'CT']) {
      out[code][side] = roundTypeRows(code, side).map((def) => ({
        key: def.key,
        label: def.label,
        desc: def.desc,
        ran: cellOf(bags.get(`${code}|${side}|${def.key}|r`)),
        faced: cellOf(bags.get(`${code}|${side}|${def.key}|f`))
      }));
    }
  }
  return out;
}
