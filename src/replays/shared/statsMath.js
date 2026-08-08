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
import { addAim, aimRating } from './aimMetrics.js';
import { AKPR_HOLD_SECONDS } from './awpHold.js';
import { addUtility, utilityAverages } from './utilityMetrics.js';

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
 * @property {string} [teamName]  only count rounds while the subject played under this display name
 * @property {string} [dateFrom]  inclusive start day (YYYY-MM-DD, local)
 * @property {string} [dateTo]    inclusive end day (YYYY-MM-DD, local)
 * @property {string} [roundOwn]  round-library key the subject side must have run
 * @property {string} [roundOpp]  round-library key the opposing side must have run
 */

/** Match / upload time for a demo (ms), or 0 when unknown. */
export function demoTimestamp(demo) {
  return Number(demo?.uploadedAt || demo?.parsedAt || 0) || 0;
}

/** Local midnight / end-of-day for a YYYY-MM-DD string. */
function localDayBound(ymd, end) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return end
    ? new Date(y, mo - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
}

/**
 * Does this demo fall inside filter.dateFrom / filter.dateTo (inclusive local days)?
 * Missing dates fail the filter when either bound is set.
 */
export function demoPassesDate(demo, filter = {}) {
  const from = String(filter.dateFrom || '').trim();
  const to = String(filter.dateTo || '').trim();
  if (!from && !to) return true;
  const ts = demoTimestamp(demo);
  if (!ts) return false;
  if (from) {
    const start = localDayBound(from, false);
    if (start != null && ts < start) return false;
  }
  if (to) {
    const end = localDayBound(to, true);
    if (end != null && ts > end) return false;
  }
  return true;
}

/**
 * Does a stored round-library bag carry `key` on the given absolute side?
 * Tags are packed as `{ k, m }` on the row (see roundTags.js).
 */
export function rowHasRoundTag(row, side, key) {
  if (!key) return true;
  const bag = row?.rl;
  if (!bag) return false;
  const list = side === 'CT' ? bag.ct : bag.t;
  if (!Array.isArray(list)) return false;
  return list.some((t) => t && t.k === key);
}

/**
 * Does a round pass, from the point of view of one team (1 or 2)?
 * Side and economy are relative to that team, so the same round can pass for
 * the T side and fail for the CT side.
 *
 * @param {object} row
 * @param {StatsFilter} [filter]
 * @param {number} [team]
 * @param {Map<string, {team: number}>} [players]  keyed demoId:playerId — needed for advantage
 * @param {Map<string, object>} [demos]  keyed demoId — needed for dateFrom / dateTo
 */
export function rowPasses(row, filter = {}, team = 0, players = null, demos = null) {
  if (filter.files?.length && !filter.files.includes(row.f)) return false;
  if (filter.maps?.length && !filter.maps.includes(row.m)) return false;
  if (filter.dateFrom || filter.dateTo) {
    const demo = demos?.get?.(row.d) || null;
    if (!demoPassesDate(demo, filter)) return false;
  }
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

  // Round-library filters are absolute T/CT tags on the row. Subject side must
  // already be known (filter.side) so "our call" vs "their call" is unambiguous.
  const roundOwn = String(filter.roundOwn || '').trim();
  const roundOpp = String(filter.roundOpp || '').trim();
  if (roundOwn || roundOpp) {
    const ownSide = filter.side === 'CT' ? 'CT' : filter.side === 'T' ? 'T' : side;
    if (ownSide !== 'T' && ownSide !== 'CT') return false;
    const oppSide = ownSide === 'T' ? 'CT' : 'T';
    if (roundOwn && !rowHasRoundTag(row, ownSide, roundOwn)) return false;
    if (roundOpp && !rowHasRoundTag(row, oppSide, roundOpp)) return false;
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

/** Signed power: preserves sign so below-average cores stay real. */
function signedPow(x, exp) {
  if (!Number.isFinite(x)) return null;
  if (x === 0) return 0;
  return Math.sign(x) * Math.pow(Math.abs(x), exp);
}

/**
 * Full Aim4 Rating breakdown (inputs, per-term contributions, final value).
 *
 * Missing optional inputs use the formula baselines so they contribute 0.
 * Percent stats and aim are passed on the 0–100 table scale and converted to
 * fractions so terms like (duelWin% − 50.03%) stay O(0.1).
 * PFW is kept on the 0–100 scale (baseline 45.54). PFO is pp (baseline 1.04).
 * Swing in lost rounds uses baseline −4.72 (the written "9.2" is the
 * swingLost placeholder).
 */
export function aim4RatingBreakdown({
  rating,
  swing,
  kd,
  xk,
  duelWin,
  kast,
  opatt,
  or: openingRate,
  ready,
  aim,
  pfo,
  pfw,
  swingWon,
  swingLost,
  rounds
}) {
  if (!Number.isFinite(rating) || !Number.isFinite(kd)) {
    return { value: null, terms: [], core: null, powered: null, roundsBonus: 0 };
  }

  const sw = Number.isFinite(swing) ? swing : 0.11;
  const xK = Number.isFinite(xk) ? xk : 0.63;
  const dwPct = Number.isFinite(duelWin) ? duelWin : 50.03;
  const kastPct = Number.isFinite(kast) ? kast : 72.48;
  const oa = Number.isFinite(opatt) ? opatt : 0.185;
  const orPct = Number.isFinite(openingRate) ? openingRate : 50;
  const readyPct = Number.isFinite(ready) ? ready : 68.8;
  const aimScore = Number.isFinite(aim) ? aim : 63.1;
  const pfoVal = Number.isFinite(pfo) ? pfo : 1.04;
  const pfwPct = Number.isFinite(pfw) ? pfw : 45.54;
  const swWon = Number.isFinite(swingWon) ? swingWon : 10.2;
  const swLost = Number.isFinite(swingLost) ? swingLost : -4.72;
  const nRounds = Number.isFinite(rounds) && rounds > 0 ? rounds : 0;

  const terms = [
    { key: 'rating', label: 'Rating', input: rating, contrib: rating - 0.14 },
    { key: 'swing', label: 'Swing', input: sw, contrib: ((sw - 0.11) / 8) * 1.05 },
    { key: 'kd', label: 'K/D', input: kd, contrib: (kd - 1.02) * 0.9 },
    { key: 'xk', label: 'xK', input: xK, contrib: (xK - 0.63) * 7 * 1.05 },
    {
      key: 'duelWin',
      label: 'Duel Win%',
      input: dwPct,
      contrib: (dwPct / 100 - 0.5003) * 24 * 1.1
    },
    {
      key: 'kast',
      label: 'KAST',
      input: kastPct,
      contrib: (kastPct / 100 - 0.7248) * 13
    },
    { key: 'opatt', label: 'OPATT', input: oa, contrib: (oa - 0.185) * 7.5 * 0.95 },
    {
      key: 'or',
      label: 'OR',
      input: orPct,
      contrib: (orPct / 100 - 0.5) * 9 * 1.05
    },
    {
      key: 'ready',
      label: 'R%',
      input: readyPct,
      contrib: (readyPct / 100 - 0.688) * 8.5
    },
    {
      key: 'aim',
      label: 'Aim',
      input: aimScore,
      contrib: (aimScore / 100 - 0.631) * 5.4
    },
    { key: 'pfo', label: 'PFO', input: pfoVal, contrib: (pfoVal - 1.04) / 5 },
    { key: 'pfw', label: 'PFW', input: pfwPct, contrib: (pfwPct - 45.54) / 6 }
  ];

  const sum = terms.reduce((a, t) => a + t.contrib, 0);
  const avg = sum / 12;
  const swingWonContrib = ((swWon - 10.2) / 6) * 0.2;
  const swingLostContrib = ((swLost - -4.72) / 6) * 0.15;
  const core = avg + swingWonContrib + swingLostContrib;
  const powered = signedPow(core, 1.1);
  const roundsBonus = nRounds / 3000;
  const offset = 0.91;
  const value = powered + roundsBonus + offset;

  return {
    value,
    terms,
    avg,
    swingWon: { input: swWon, contrib: swingWonContrib },
    swingLost: { input: swLost, contrib: swingLostContrib },
    core,
    powered,
    rounds: nRounds,
    roundsBonus,
    offset
  };
}

/** Aim4 Rating: composite ^1.10 + rounds/3000 + 0.91. */
export function aim4Rating(input) {
  return aim4RatingBreakdown(input).value;
}

/**
 * Aim4 Opening Rating.
 * 1.00 + (OPKD/100 + Swing/8 + OPATT)
 */
export function aim4OpeningRating({ opkd, swing, opatt }) {
  const ok = Number.isFinite(opkd) ? opkd : 0;
  const sw = Number.isFinite(swing) ? swing : 0;
  const att = Number.isFinite(opatt) ? opatt : 0;
  return 1 + ok / 100 + sw / 8 + att;
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
        swingWonSum: 0,
        swingWonRounds: 0,
        swingLostSum: 0,
        swingLostRounds: 0,
        psdtSum: 0,
        psdtRounds: 0,
        dtSum: 0,
        dtRounds: 0,
        /** Aim counters (aimMetrics), summed across every round that passes. */
        aim: {},
        /** Utility counters (utilityMetrics), same. */
        util: {},
        /** Rounds counted for the per-round utility average. */
        utilRounds: 0,
        /** Duel model totals (row.du): weight, predSum, wins. */
        duelW: 0,
        duelP: 0,
        duelN: 0,
        /** Rounds where row.du was present (for xK / round). */
        duelDataRounds: 0,
        /** @type {Map<number, { weight: number, predSum: number, wins: number }>} */
        duelBuckets: new Map(),
        /** @type {Map<string, {name: string, rounds: number}>} */
        teamRounds: new Map(),
        /** Rounds with exactly 0–4 kills; index 5 is 5+ kills. */
        mk: [0, 0, 0, 0, 0, 0],
        /** Kills / rounds while holding AWP as primary ≥ AKPR_HOLD_SECONDS. */
        akprKills: 0,
        akprRounds: 0
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
      if (!rowPasses(row, filter, team, players, demos)) continue;
      if (filter.teamName) {
        const demo = demos?.get(row.d);
        if (!demo) continue;
        const displayName = team === 1 ? demo.name1 : demo.name2;
        if (teamNameKey(displayName) !== teamNameKey(filter.teamName)) continue;
      }
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
        const sw = row.sw[id];
        s.swingSum += sw;
        s.swingRounds++;
        if (row.w === team) {
          s.swingWonSum += sw;
          s.swingWonRounds++;
        } else {
          s.swingLostSum += sw;
          s.swingLostRounds++;
        }
      }
      // Aim measurements and utility effectiveness (stats index v11). Plain
      // sums here; the divisions happen once at the end, so a player filtered
      // down to three rounds averages over those three rounds and not the
      // whole match.
      const am = row.am?.[id];
      if (am) addAim(s.aim, am);
      const ut = row.ut?.[id];
      if (ut) addUtility(s.util, ut);
      s.utilRounds++;
      const mv = row.mv?.[id];
      if (mv && Number.isFinite(mv.psdt)) {
        s.psdtSum += mv.psdt;
        s.psdtRounds++;
      }
      if (mv && Number.isFinite(mv.dt)) {
        s.dtSum += mv.dt;
        s.dtRounds++;
      }
      const du = row.du?.[id];
      if (row.du != null && typeof row.du === 'object') {
        // Index has duel data for this round: no fights still count as 0 xK.
        s.duelDataRounds++;
        if (du && Number.isFinite(du.w) && du.w > 0) {
          s.duelW += du.w;
          s.duelP += Number(du.p) || 0;
          s.duelN += Number(du.n) || 0;
          for (const entry of du.b || []) {
            const centre = entry[0];
            const w = entry[1];
            const p = entry[2];
            const n = entry[3];
            if (!Number.isFinite(centre) || !(w > 0)) continue;
            let b = s.duelBuckets.get(centre);
            if (!b) {
              b = { weight: 0, predSum: 0, wins: 0 };
              s.duelBuckets.set(centre, b);
            }
            b.weight += w;
            b.predSum += p || 0;
            b.wins += n || 0;
          }
        }
      }
      const kills = line[P.KILLS] || 0;
      const mkIdx = kills >= 5 ? 5 : Math.max(0, kills | 0);
      s.mk[mkIdx]++;
      const awHold = row.aw?.[id];
      if (Number.isFinite(awHold) && awHold >= AKPR_HOLD_SECONDS) {
        s.akprRounds++;
        s.akprKills += kills;
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
    const swingWon = s.swingWonRounds ? s.swingWonSum / s.swingWonRounds : null;
    const swingLost = s.swingLostRounds ? s.swingLostSum / s.swingLostRounds : null;
    const opkd = s.openKills - s.openDeaths;
    const opatt = all.rounds ? (s.openKills + s.openDeaths) / all.rounds : null;
    const a4or = aim4OpeningRating({ opkd, swing, opatt });
    // Divided once, here, over exactly the rounds that passed the filter.
    const aim = aimRating(s.aim);
    const utilAvg = utilityAverages({ ...s.util, rounds: s.utilRounds });
    const teams = [...s.teamRounds.values()].sort(
      (a, b) => b.rounds - a.rounds || a.name.localeCompare(b.name)
    );
    const teamLabel = !teams.length ? '' : teams.length === 1 ? teams[0].name : 'Multiple';
    const fights = s.all.kills + s.all.deaths;
    const pfw = s.duelW > 0 ? (s.duelP / s.duelW) * 100 : null;
    const pfo = s.duelW > 0 ? ((s.duelN - s.duelP) / s.duelW) * 100 : null;
    const tfw = fights > 0 ? (s.all.kills / fights) * 100 : null;
    // Expected kills per round: sum of predicted win chances across duels,
    // divided by rounds played (rounds with no duel data stay null overall).
    const xk = s.duelDataRounds > 0 ? s.duelP / all.rounds : null;
    const kd = s.all.deaths ? s.all.kills / s.all.deaths : s.all.kills;
    const opkRate =
      s.openKills + s.openDeaths > 0
        ? (s.openKills / (s.openKills + s.openDeaths)) * 100
        : null;
    const readyPct = Number.isFinite(aim.raw?.readyRate) ? aim.raw.readyRate * 100 : null;
    const a4rDetail = aim4RatingBreakdown({
      rating: all.rating,
      swing,
      kd,
      xk,
      duelWin: tfw,
      kast: all.kast,
      opatt,
      or: opkRate,
      ready: readyPct,
      aim: aim.rating,
      pfo,
      pfw,
      swingWon,
      swingLost,
      rounds: all.rounds
    });
    const a4r = a4rDetail.value;
    const pfoBuckets = [...s.duelBuckets]
      .filter(([, b]) => b.weight >= 0.5)
      .sort((x, y) => x[0] - y[0])
      .map(([centre, b]) => ({
        centre,
        duels: b.weight,
        predicted: (b.predSum / b.weight) * 100,
        actual: (b.wins / b.weight) * 100,
        delta: ((b.wins - b.predSum) / b.weight) * 100
      }));
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
      kd,
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
      /** Per-term A4R breakdown for hover tips. */
      a4rDetail,
      a4or,
      openKills: s.openKills,
      openDeaths: s.openDeaths,
      /** Opening kill differential (OK − OD). */
      opkd,
      /** Opening attempts per round: (OK + OD) / rounds. */
      opatt,
      /** Opening duel win rate, percent. */
      opkRate,
      prwSwing: swing,
      prwSwingTotal: s.swingSum,
      prwSwingRounds: s.swingRounds,
      /** Avg PRW swing in rounds the player's team won / lost. */
      prwSwingWon: swingWon,
      prwSwingLost: swingLost,
      /** Avg pulled-string distance travelled / round. */
      psdt: s.psdtRounds ? s.psdtSum / s.psdtRounds : null,
      psdtTotal: s.psdtSum,
      psdtRounds: s.psdtRounds,
      /** Avg raw distance travelled / round. */
      dt: s.dtRounds ? s.dtSum / s.dtRounds : null,
      dtTotal: s.dtSum,
      dtRounds: s.dtRounds,

      // ---- duel model (stats index v13) ------------------------------------
      /** Average predicted fight winrate (%). Null until duels are indexed. */
      pfw,
      /** Predicted fight overperformance (pp). Null until duels are indexed. */
      pfo,
      /** Total fight winrate: kills / (kills + deaths) as %. */
      tfw,
      /** Expected kills per round from the duel model. */
      xk,
      /** Total expected kills (sum of duel win chances). */
      xkTotal: s.duelDataRounds > 0 ? s.duelP : null,
      duels: s.duelW > 0 ? s.duelW : null,
      pfoBuckets,

      // ---- utility effectiveness (stats index v11) ------------------------
      /** Damage per HE actually thrown, not per round. */
      heDmgPerNade: utilAvg.heDamagePerNade,
      heThrown: s.util.heThrown || 0,
      heDamage: s.util.heDamage || 0,
      fireDmgPerNade: utilAvg.fireDamagePerNade,
      fireThrown: s.util.fireThrown || 0,
      fireDamage: s.util.fireDamage || 0,
      /** Enemy blind seconds per flashbang thrown, duds included. */
      blindPerFlash: utilAvg.blindPerFlash,
      flashesThrown: s.util.flashesThrown || 0,
      flashHitRate: utilAvg.flashHitRate,
      enemyBlindSeconds: s.util.enemyBlindSeconds || 0,
      /** All utility damage per round played. */
      utilDmgPerRound: utilAvg.utilDamagePerRound,

      // ---- aim (stats index v11) ------------------------------------------
      /** 0-100. Null until every component has enough sample to be honest. */
      a4aim: aim.rating,
      aimComponents: aim.components,
      aimRaw: aim.raw,
      aimSample: aim.sample,

      // ---- multi-kill round counts + AWP KPR ----------------------------
      mk5: s.mk[5],
      mk4: s.mk[4],
      mk3: s.mk[3],
      mk2: s.mk[2],
      mk1: s.mk[1],
      mk0: s.mk[0],
      /** Kills per round in rounds with AWP held as primary ≥ 10s. */
      akpr: s.akprRounds > 0 ? s.akprKills / s.akprRounds : null,
      akprKills: s.akprKills,
      akprRounds: s.akprRounds
    });
  }
  out.sort((a, b) => (b.a4r ?? b.rating) - (a.a4r ?? a.rating));
  return out;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Normalize a team display name for merging across demos. */
export function teamNameKey(name, shortId = '') {
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
        acAdv: 0,
        acChoke: 0,
        posSum: 0,
        posN: 0,
        utilDmgSum: 0,
        utilDmgRounds: 0,
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
      if (filter.teamName && teamNameKey(displayName) !== teamNameKey(filter.teamName)) continue;
      if (!rowPasses(row, filter, team, players, demos)) continue;
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
      if (row.aca1 !== undefined || row.aca2 !== undefined) {
        s.acAdv += Number(team === 1 ? row.aca1 : row.aca2) || 0;
        s.acChoke += Number(team === 1 ? row.ack1 : row.ack2) || 0;
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
      const utilDmg = row.utt?.[team];
      if (Number.isFinite(utilDmg)) {
        s.utilDmgSum += utilDmg;
        s.utilDmgRounds++;
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
    // Team PFW / PFO: plain average of the side's players (equal say each),
    // matching teamDuelStats — not a pooled duel weight average.
    const duelMembers = members.filter((m) => Number.isFinite(m.pfw));
    const teamPfw = duelMembers.length
      ? duelMembers.reduce((sum, m) => sum + m.pfw, 0) / duelMembers.length
      : null;
    const teamPfo = duelMembers.length
      ? duelMembers.reduce((sum, m) => sum + m.pfo, 0) / duelMembers.length
      : null;
    const xkMembers = members.filter((m) => Number.isFinite(m.xk));
    const teamXk = xkMembers.length
      ? xkMembers.reduce((sum, m) => sum + m.xk, 0) / xkMembers.length
      : null;

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
        prwSwing: m.prwSwing,
        pfw: m.pfw,
        pfo: m.pfo,
        xk: m.xk,
        duels: m.duels
      })),
      pfw: teamPfw,
      pfo: teamPfo,
      xk: teamXk,
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
      /**
       * AC% = chance to convert an advantage (held >51% without falling below 50%).
       * Advantage-choke rate is the inverse (lost / advantages).
       */
      ac: s.acAdv > 0 ? ((s.acAdv - s.acChoke) / s.acAdv) * 100 : null,
      acAdvantages: s.acAdv,
      acChokes: s.acChoke,
      acChokeRate: s.acAdv > 0 ? (s.acChoke / s.acAdv) * 100 : null,
      possession: s.posN ? s.posSum / s.posN : null,
      possessionRounds: s.posN,
      /** Average grenade (HE + fire) damage dealt by the team per round. */
      utilDmgPerRound: s.utilDmgRounds ? s.utilDmgSum / s.utilDmgRounds : null,
      utilDmgRounds: s.utilDmgRounds,
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
