// ---------------------------------------------------------------------------
// replays/shared/statsMath.js
// Turns per-round stat rows into the player and team tables.
//
// Pure functions over a compact row format, with no I/O, so the same code runs
// on the server (aggregating a whole library out of the cached index) and in
// the browser (re-aggregating one demo as the viewer scrubs through it).
//
// A row is one round. Everything a table needs is on it, which is what keeps
// the stats page off the round files: the index is built once per demo and
// every question after that is answered by summing numbers already in memory.
// ---------------------------------------------------------------------------

import { buyBucket, econHasAwp } from './roundId.js';

/** Per-player, per-round counters, in the order the index packs them. */
export const P = {
  KILLS: 0,
  DEATHS: 1,
  ASSISTS: 2,
  DAMAGE: 3,
  SHOTS: 4,
  HITS: 5,
  HEADSHOTS: 6,
  AWP_SHOTS: 7,
  AWP_HITS: 8,
  KAST: 9
};
export const PLAYER_SLOTS = 10;

/** HLTV 2.0, as published. KAST is the percentage, not the fraction. */
export function ratingOf({ kast, kpr, dpr, impact, adr }) {
  return 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;
}

export function impactOf({ kpr, apr }) {
  return 2.13 * kpr + 0.42 * apr - 0.41;
}

const div = (a, b) => (b > 0 ? a / b : 0);

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * @typedef {object} StatsFilter
 * @property {string[]} [maps]      map codes
 * @property {string[]} [files]     round names; when set, nothing else is considered
 * @property {'T'|'CT'|''} [side]   the side the subject played
 * @property {number|null} [econ]   the subject's buy bucket (5 counts as 4)
 * @property {number|null} [oppEcon] the other team's buy bucket
 * @property {boolean} [hasAwp]     subject side must have had an AWP
 * @property {boolean} [oppHasAwp]  opponent side must have had an AWP
 * @property {''|'won'|'lost'} [result]  subject won / lost the round
 * @property {''|'5v4'|'4v5'|'even'} [advantage]  opening situation for subject
 */

/**
 * Does a round pass, from the point of view of one team (1 or 2)?
 * Side and economy are relative to that team, so the same round can pass for
 * the T side and fail for the CT side.
 *
 * @param {object} row
 * @param {StatsFilter} [filter]
 * @param {number} [team]
 * @param {Map<string, {team: number}>} [players]  keyed demoId:playerId — needed for advantage
 */
export function rowPasses(row, filter = {}, team = 0, players = null) {
  if (filter.files?.length && !filter.files.includes(row.f)) return false;
  if (filter.maps?.length && !filter.maps.includes(row.m)) return false;
  if (!team) return true;
  const side = team === 1 ? row.s1 : row.s2;
  if (filter.side && side !== filter.side) return false;
  const own = team === 1 ? row.e1 : row.e2;
  const opp = team === 1 ? row.e2 : row.e1;
  if (
    filter.econ !== null &&
    filter.econ !== undefined &&
    buyBucket(own) !== buyBucket(filter.econ)
  ) {
    return false;
  }
  if (
    filter.oppEcon !== null &&
    filter.oppEcon !== undefined &&
    buyBucket(opp) !== buyBucket(filter.oppEcon)
  ) {
    return false;
  }
  if (filter.hasAwp && !econHasAwp(own)) return false;
  if (filter.oppHasAwp && !econHasAwp(opp)) return false;

  if (filter.result === 'won' && row.w !== team) return false;
  if (filter.result === 'lost' && row.w === team) return false;

  if (filter.advantage) {
    const okTeam = row.ok && players ? players.get(`${row.d}:${row.ok}`)?.team : 0;
    const odTeam = row.od && players ? players.get(`${row.d}:${row.od}`)?.team : 0;
    const gotOk = okTeam === team;
    const gotOd = odTeam === team;
    if (filter.advantage === '5v4' && !gotOk) return false;
    if (filter.advantage === '4v5' && !gotOd) return false;
    if (filter.advantage === 'even' && (gotOk || gotOd)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

function emptyBucket() {
  return { rounds: 0, kills: 0, deaths: 0, assists: 0, damage: 0, kast: 0 };
}

function addBucket(b, line) {
  b.rounds++;
  b.kills += line[P.KILLS];
  b.deaths += line[P.DEATHS];
  b.assists += line[P.ASSISTS];
  b.damage += line[P.DAMAGE];
  b.kast += line[P.KAST] ? 1 : 0;
}

/** Rating and its inputs for one bucket of rounds. */
export function bucketRating(b) {
  if (!b.rounds) return { rounds: 0, rating: 0, kast: 0, kpr: 0, dpr: 0, apr: 0, impact: 0, adr: 0 };
  const kpr = div(b.kills, b.rounds);
  const dpr = div(b.deaths, b.rounds);
  const apr = div(b.assists, b.rounds);
  const kast = div(b.kast, b.rounds) * 100;
  const adr = div(b.damage, b.rounds);
  const impact = impactOf({ kpr, apr });
  return { rounds: b.rounds, rating: ratingOf({ kast, kpr, dpr, impact, adr }), kast, kpr, dpr, apr, impact, adr };
}

/**
 * Aim4 Rating.
 * 0.40·Rating + 0.45·Rating(full vs full) + 0.15·Impact + Swing/6
 * (Swing is signed, so the ± is built in.)
 */
export function aim4Rating({ rating, ratingFull, impact, swing }) {
  if (!Number.isFinite(rating) || !Number.isFinite(impact)) return null;
  const rFull = Number.isFinite(ratingFull) ? ratingFull : rating;
  const sw = Number.isFinite(swing) ? swing : 0;
  return 0.4 * rating + 0.45 * rFull + 0.15 * impact + sw / 6;
}

/**
 * Aim4 Opening Rating.
 * 1.00 + (OPKD/100 − Swing/8 + OPATT)
 */
export function aim4OpeningRating({ opkd, swing, opatt }) {
  const ok = Number.isFinite(opkd) ? opkd : 0;
  const sw = Number.isFinite(swing) ? swing : 0;
  const att = Number.isFinite(opatt) ? opatt : 0;
  return 1 + ok / 100 - sw / 8 + att;
}

/**
 * One table row per player, pooled across demos.
 *
 * `players` is keyed `demoId:playerId`, not by player id alone: the same
 * person is team 1 in one demo and team 2 in the next, and their side, their
 * opponent's buy and whether they won all hang off that.
 *
 * @param {Array} rows          per-round rows
 * @param {Map<string, {name: string, team: number}>} players
 * @param {StatsFilter} filter
 * @param {Map<string, {t1?: string, t2?: string, name1?: string, name2?: string}>|null} [demos]
 */
export function aggregatePlayers(rows, players, filter = {}, demos = null) {
  /** @type {Map<string, any>} */
  const acc = new Map();

  const seat = (id, name) => {
    let s = acc.get(id);
    if (!s) {
      s = {
        id,
        name: name || id,
        all: emptyBucket(),
        T: emptyBucket(),
        CT: emptyBucket(),
        won: emptyBucket(),
        lost: emptyBucket(),
        /** Full buy vs full buy (bucket 4, AWP digit 5 → 4). */
        fullVsFull: emptyBucket(),
        shots: 0,
        hits: 0,
        headshots: 0,
        awpShots: 0,
        awpHits: 0,
        openKills: 0,
        openDeaths: 0,
        swingSum: 0,
        swingRounds: 0,
        psdtSum: 0,
        psdtRounds: 0,
        dtSum: 0,
        dtRounds: 0,
        /** @type {Map<string, {name: string, rounds: number}>} */
        teamRounds: new Map()
      };
      acc.set(id, s);
    }
    return s;
  };

  for (const row of rows) {
    for (const id of Object.keys(row.p)) {
      const who = players.get(`${row.d}:${id}`);
      const team = who?.team;
      if (!team) continue;
      if (!rowPasses(row, filter, team, players)) continue;
      const line = row.p[id];
      const s = seat(id, who.name);
      const side = team === 1 ? row.s1 : row.s2;
      addBucket(s.all, line);
      if (side === 'T' || side === 'CT') addBucket(s[side], line);
      addBucket(row.w === team ? s.won : s.lost, line);
      const ownEcon = team === 1 ? row.e1 : row.e2;
      const oppEcon = team === 1 ? row.e2 : row.e1;
      if (buyBucket(ownEcon) === 4 && buyBucket(oppEcon) === 4) {
        addBucket(s.fullVsFull, line);
      }
      s.shots += line[P.SHOTS];
      s.hits += line[P.HITS];
      s.headshots += line[P.HEADSHOTS];
      s.awpShots += line[P.AWP_SHOTS];
      s.awpHits += line[P.AWP_HITS];
      if (row.ok === id) s.openKills++;
      if (row.od === id) s.openDeaths++;
      if (row.sw && Number.isFinite(row.sw[id])) {
        s.swingSum += row.sw[id];
        s.swingRounds++;
      }
      const mv = row.mv?.[id];
      if (mv && Number.isFinite(mv.psdt)) {
        s.psdtSum += mv.psdt;
        s.psdtRounds++;
      }
      if (mv && Number.isFinite(mv.dt)) {
        s.dtSum += mv.dt;
        s.dtRounds++;
      }
      const demo = demos?.get(row.d);
      if (demo) {
        const shortId = team === 1 ? demo.t1 : demo.t2;
        const displayName = team === 1 ? demo.name1 : demo.name2;
        const key = teamNameKey(displayName, shortId) || `${row.d}:${team}`;
        const label =
          String(displayName || '').trim() ||
          String(shortId || '').trim() ||
          `Team ${team}`;
        let tr = s.teamRounds.get(key);
        if (!tr) {
          tr = { name: label, rounds: 0 };
          s.teamRounds.set(key, tr);
        }
        tr.rounds++;
      }
    }
  }

  const out = [];
  for (const s of acc.values()) {
    if (!s.all.rounds) continue;
    const all = bucketRating(s.all);
    const fullVsFull = bucketRating(s.fullVsFull);
    const swing = s.swingRounds ? s.swingSum / s.swingRounds : null;
    const opkd = s.openKills - s.openDeaths;
    const opatt = all.rounds ? (s.openKills + s.openDeaths) / all.rounds : null;
    const ratingFull = fullVsFull.rounds ? fullVsFull.rating : all.rating;
    const a4r = aim4Rating({
      rating: all.rating,
      ratingFull,
      impact: all.impact,
      swing
    });
    const a4or = aim4OpeningRating({ opkd, swing, opatt });
    const teams = [...s.teamRounds.values()].sort(
      (a, b) => b.rounds - a.rounds || a.name.localeCompare(b.name)
    );
    const teamLabel = !teams.length ? '' : teams.length === 1 ? teams[0].name : 'Multiple';
    out.push({
      id: s.id,
      name: s.name,
      teams,
      teamLabel,
      rounds: all.rounds,
      kills: s.all.kills,
      deaths: s.all.deaths,
      assists: s.all.assists,
      damage: s.all.damage,
      kd: s.all.deaths ? s.all.kills / s.all.deaths : s.all.kills,
      adr: all.adr,
      adrWon: div(s.won.damage, s.won.rounds),
      adrLost: div(s.lost.damage, s.lost.rounds),
      shots: s.shots,
      hits: s.hits,
      headshots: s.headshots,
      accuracy: div(s.hits, s.shots) * 100,
      awpShots: s.awpShots,
      awpHits: s.awpHits,
      awpAccuracy: div(s.awpHits, s.awpShots) * 100,
      kast: all.kast,
      impact: all.impact,
      rating: all.rating,
      ratingT: bucketRating(s.T).rating,
      ratingCT: bucketRating(s.CT).rating,
      ratingWon: bucketRating(s.won).rating,
      ratingLost: bucketRating(s.lost).rating,
      ratingFullVsFull: fullVsFull.rounds ? fullVsFull.rating : null,
      ratingFullVsFullRounds: fullVsFull.rounds,
      a4r,
      a4or,
      openKills: s.openKills,
      openDeaths: s.openDeaths,
      /** Opening kill differential (OK − OD). */
      opkd,
      /** Opening attempts per round: (OK + OD) / rounds. */
      opatt,
      /** Opening duel win rate, percent. */
      opkRate:
        s.openKills + s.openDeaths > 0
          ? (s.openKills / (s.openKills + s.openDeaths)) * 100
          : null,
      prwSwing: swing,
      prwSwingTotal: s.swingSum,
      prwSwingRounds: s.swingRounds,
      /** Avg pulled-string distance travelled / round. */
      psdt: s.psdtRounds ? s.psdtSum / s.psdtRounds : null,
      psdtTotal: s.psdtSum,
      psdtRounds: s.psdtRounds,
      /** Avg raw distance travelled / round. */
      dt: s.dtRounds ? s.dtSum / s.dtRounds : null,
      dtTotal: s.dtSum,
      dtRounds: s.dtRounds
    });
  }
  out.sort((a, b) => (b.a4r ?? b.rating) - (a.a4r ?? a.rating));
  return out;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Normalize a team display name for merging across demos. */
function teamNameKey(name, shortId = '') {
  const norm = String(name || '')
    .trim()
    .toLowerCase();
  // Empty / placeholder names stay on the short id so unrelated demos don't merge.
  if (!norm || norm === 'team 1' || norm === 'team 2') return shortId || norm || '';
  return norm;
}

/**
 * One table row per team name. The same label across demos (even with different
 * short ids) is one aggregated row.
 *
 * @param {Array} rows
 * @param {Map<string, {name: string, team: number, demoId: string}>} players
 * @param {Map<string, {t1: string, t2: string, name1: string, name2: string, winner: number}>} demos
 * @param {StatsFilter} filter
 */
export function aggregateTeams(rows, players, demos, filter = {}) {
  const acc = new Map();

  const seat = (key, name) => {
    let s = acc.get(key);
    if (!s) {
      s = {
        key,
        name,
        nameCounts: new Map(),
        shortIds: new Set(),
        rounds: 0,
        won: 0,
        openKills: 0,
        openDeaths: 0,
        openKillWon: 0,
        openDeathWon: 0,
        demoIds: new Set(),
        playerIds: new Set(),
        prwSum: 0,
        prwN: 0,
        posSum: 0,
        posN: 0,
        /** @type {Map<string, { posSum: number, posN: number, baseCt: number, baseT: number }>} */
        posByMap: new Map()
      };
      acc.set(key, s);
    }
    const label = String(name || '').trim();
    if (label) s.nameCounts.set(label, (s.nameCounts.get(label) || 0) + 1);
    return s;
  };

  for (const row of rows) {
    const demo = demos.get(row.d);
    if (!demo) continue;
    for (const team of [1, 2]) {
      const shortId = team === 1 ? demo.t1 : demo.t2;
      const displayName = team === 1 ? demo.name1 : demo.name2;
      const key = teamNameKey(displayName, shortId);
      if (!key) continue;
      if (!rowPasses(row, filter, team, players)) continue;
      const s = seat(key, displayName || shortId);
      if (shortId) s.shortIds.add(shortId);
      s.rounds++;
      s.demoIds.add(row.d);
      if (row.w === team) s.won++;

      const okTeam = row.ok ? players.get(`${row.d}:${row.ok}`)?.team : 0;
      const odTeam = row.od ? players.get(`${row.d}:${row.od}`)?.team : 0;
      if (okTeam === team) {
        s.openKills++;
        if (row.w === team) s.openKillWon++;
      }
      if (odTeam === team) {
        s.openDeaths++;
        if (row.w === team) s.openDeathWon++;
      }
      for (const id of Object.keys(row.p)) {
        if (players.get(`${row.d}:${id}`)?.team === team) s.playerIds.add(id);
      }

      const prw = team === 1 ? row.prw1 : row.prw2;
      if (Number.isFinite(prw)) {
        s.prwSum += prw;
        s.prwN++;
      }
      const pos = team === 1 ? row.pos1 : row.pos2;
      if (Number.isFinite(pos)) {
        s.posSum += pos;
        s.posN++;
        const map = row.m || '';
        if (map) {
          let m = s.posByMap.get(map);
          if (!m) {
            m = { posSum: 0, posN: 0 };
            s.posByMap.set(map, m);
          }
          m.posSum += pos;
          m.posN++;
        }
      }
    }
  }

  // Player ratings under the same filter, so the team average and its hover
  // breakdown agree with the players table.
  const playerRows = aggregatePlayers(rows, players, filter, demos);
  const byPlayer = new Map(playerRows.map((p) => [p.id, p]));

  const out = [];
  for (const s of acc.values()) {
    if (!s.rounds) continue;

    let bestName = s.name || s.key;
    let bestCount = -1;
    for (const [label, count] of s.nameCounts) {
      if (count > bestCount || (count === bestCount && label.localeCompare(bestName) < 0)) {
        bestName = label;
        bestCount = count;
      }
    }

    // Map record is a property of the whole demo, not of the filtered rounds:
    // a map is won or lost once, however few of its rounds survive a filter.
    let mapWins = 0;
    let mapLosses = 0;
    for (const demoId of s.demoIds) {
      const demo = demos.get(demoId);
      if (!demo?.winner) continue;
      const side1 = teamNameKey(demo.name1, demo.t1);
      const side2 = teamNameKey(demo.name2, demo.t2);
      const asTeam = side1 === s.key ? 1 : side2 === s.key ? 2 : 0;
      if (!asTeam) continue;
      if (demo.winner === asTeam) mapWins++;
      else mapLosses++;
    }

    const members = [...s.playerIds]
      .map((id) => byPlayer.get(id))
      .filter(Boolean)
      .sort((a, b) => b.rating - a.rating);
    const avgRating = members.length
      ? members.reduce((sum, m) => sum + m.rating, 0) / members.length
      : 0;

    out.push({
      key: s.key,
      name: bestName,
      rounds: s.rounds,
      roundsWon: s.won,
      roundsLost: s.rounds - s.won,
      roundWinrate: div(s.won, s.rounds) * 100,
      avgRating,
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        rating: m.rating,
        prwSwing: m.prwSwing
      })),
      mapWins,
      mapLosses,
      maps: mapWins + mapLosses,
      mapWinrate: div(mapWins, mapWins + mapLosses) * 100,
      roundDiff: s.won - (s.rounds - s.won),
      openKills: s.openKills,
      openDeaths: s.openDeaths,
      opkRate: div(s.openKills, s.openKills + s.openDeaths) * 100,
      conv5v4: div(s.openKillWon, s.openKills) * 100,
      conv5v4Won: s.openKillWon,
      conv5v4Lost: s.openKills - s.openKillWon,
      conv4v5: div(s.openDeathWon, s.openDeaths) * 100,
      conv4v5Won: s.openDeathWon,
      conv4v5Lost: s.openDeaths - s.openDeathWon,
      prw: s.prwN ? s.prwSum / s.prwN : null,
      prwRounds: s.prwN,
      possession: s.posN ? s.posSum / s.posN : null,
      possessionRounds: s.posN,
      possessionByMap: [...s.posByMap.entries()].map(([map, m]) => ({
        map,
        possession: m.posN ? m.posSum / m.posN : null,
        rounds: m.posN
      }))
    });
  }
  out.sort((a, b) => b.avgRating - a.avgRating);
  return out;
}

/** Rebuild the lookup maps a payload needs, on either side of the wire. */
export function indexMaps(payload) {
  const players = new Map();
  const demos = new Map();
  for (const d of payload.demos || []) {
    demos.set(d.id, d);
    for (const p of d.players || []) {
      players.set(`${d.id}:${p.id}`, { name: p.name, team: p.team });
    }
  }
  return { players, demos };
}

/** Every row across a payload's demos, flattened. */
export function allRows(payload) {
  const out = [];
  for (const d of payload.demos || []) {
    for (const r of d.rounds || []) out.push(r);
  }
  return out;
}
