// ---------------------------------------------------------------------------
// Round library totals straight off the stats payload.
//
// Tags are already on the rows (see roundTags.js), so counting them costs one
// walk and no round files. Two readings come out of the same walk: what one
// team does with each round type, and what the whole library does with it —
// the second is the only thing that makes the first mean anything, since "we
// ran 9 A Fakes" is a different sentence depending on whether the average team
// runs 2 or 20.
// ---------------------------------------------------------------------------

import { teamNameKey } from '../shared/statsMath.js';
import { hasRoundLibrary, roundTypeRows } from './roundLibrary.js';
import { rowTags } from './roundTags.js';

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function emptyBag() {
  return { rounds: 0, wins: 0 };
}

const rate = (bag) => pct(bag.wins, bag.rounds);

/**
 * @typedef {object} RoundTypeStatRow
 * @property {string} key
 * @property {string} label
 * @property {{ rounds: number, wins: number, winrate: number|null, share: number|null }} ours
 *   The team running the call on this side.
 * @property {{ rounds: number, wins: number, winrate: number|null }} faced
 *   The same call arriving at them from the other side.
 * @property {{ rounds: number, wins: number, winrate: number|null, share: number|null }} league
 *   Every team in the payload, this call on this side.
 * @property {number|null} index
 *   Our share of rounds divided by the library's. 1 is average, 2 is twice as
 *   often, null when the library has never run it.
 */

/**
 * @param {{ demos?: Array }} payload  a stats payload (team-scoped or full)
 * @param {{ mapCode: string, teamName: string }} opts
 * @returns {{
 *   mapCode: string,
 *   demos: number,
 *   ourDemos: number,
 *   sides: Record<'T'|'CT', { ourRounds: number, facedRounds: number, leagueRounds: number, types: RoundTypeStatRow[] }>
 * }|null}
 */
export function roundListStats(payload, { mapCode, teamName }) {
  const code = String(mapCode || '').toUpperCase();
  const defs = { T: roundTypeRows(code, 'T'), CT: roundTypeRows(code, 'CT') };
  if (!defs.T.length && !defs.CT.length) return null;
  const want = teamNameKey(teamName || '');

  /** @type {Record<string, { our: Map, faced: Map, league: Map, ourRounds: number, facedRounds: number, leagueRounds: number }>} */
  const acc = {};
  for (const side of ['T', 'CT']) {
    acc[side] = {
      our: new Map(),
      faced: new Map(),
      league: new Map(),
      ourRounds: 0,
      facedRounds: 0,
      leagueRounds: 0
    };
  }
  const grab = (map, key) => {
    if (!map.has(key)) map.set(key, emptyBag());
    return map.get(key);
  };

  let demos = 0;
  let ourDemos = 0;
  for (const d of payload?.demos || []) {
    if (String(d.map || '').toUpperCase() !== code) continue;
    demos++;
    const ours = teamNameKey(d.name1, d.t1) === want ? 1 : teamNameKey(d.name2, d.t2) === want ? 2 : 0;
    if (ours) ourDemos++;
    for (const row of d.rounds || []) {
      if (!row?.rl) continue;
      for (const side of ['T', 'CT']) {
        const tags = rowTags(row, side);
        if (!tags.length) continue;
        // Whoever played this side in this round is the one running the call.
        const runner = (row.s1 || 'T') === side ? 1 : 2;
        const bagSide = acc[side];
        bagSide.leagueRounds++;
        for (const tag of tags) {
          const bag = grab(bagSide.league, tag.k);
          bag.rounds++;
          if (row.w === runner) bag.wins++;
        }
        if (!ours) continue;
        const weRan = ours === runner;
        if (weRan) bagSide.ourRounds++;
        else bagSide.facedRounds++;
        for (const tag of tags) {
          const bag = grab(weRan ? bagSide.our : bagSide.faced, tag.k);
          bag.rounds++;
          if (row.w === ours) bag.wins++;
        }
      }
    }
  }

  const sides = {};
  for (const side of ['T', 'CT']) {
    const b = acc[side];
    const types = defs[side].map((def) => {
      const ourBag = b.our.get(def.key) || emptyBag();
      const facedBag = b.faced.get(def.key) || emptyBag();
      const leagueBag = b.league.get(def.key) || emptyBag();
      const ourShare = pct(ourBag.rounds, b.ourRounds);
      const leagueShare = pct(leagueBag.rounds, b.leagueRounds);
      return {
        key: def.key,
        label: def.label,
        desc: def.desc,
        ours: { ...ourBag, winrate: rate(ourBag), share: ourShare },
        faced: { ...facedBag, winrate: rate(facedBag) },
        league: { ...leagueBag, winrate: rate(leagueBag), share: leagueShare },
        index: leagueShare ? Math.round((ourShare / leagueShare) * 100) / 100 : null
      };
    });
    sides[side] = {
      ourRounds: b.ourRounds,
      facedRounds: b.facedRounds,
      leagueRounds: b.leagueRounds,
      types
    };
  }

  return { mapCode: code, demos, ourDemos, sides };
}

/**
 * Every map in the payload the round library can read, most played first.
 *
 * The team overview shows the whole database when no map chip is picked, and
 * "the whole database" is exactly this list — a map with no library has no
 * round types to win or lose with.
 *
 * @param {{ demos?: Array }} payload
 * @param {string} [teamName]  when given, only maps this team has played
 * @returns {string[]}
 */
export function libraryMaps(payload, teamName = '') {
  const want = teamName ? teamNameKey(teamName) : '';
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const d of payload?.demos || []) {
    const code = String(d.map || '').toUpperCase();
    if (!code || !hasRoundLibrary(code)) continue;
    if (want && teamNameKey(d.name1, d.t1) !== want && teamNameKey(d.name2, d.t2) !== want) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => code);
}
