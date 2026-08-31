// ---------------------------------------------------------------------------
// replays/statsHotAggregate.js
// Aggregate the resident store, then hand the buckets to statsMath.
//
// Only the *accumulation* is rewritten here. `derivePlayers` still turns the
// buckets into output rows, so ratings, the A4R breakdown, duel overperformance
// and the rest have exactly one implementation and cannot drift between the
// two paths. What this file must get right is narrow and directly testable:
// does it fill the same buckets `accumulatePlayers` would, given the same
// rounds and filter.
// ---------------------------------------------------------------------------

import {
  createTeamAccumulator,
  demoTimestamp,
  derivePlayers,
  deriveTeams,
  teamNameKey,
  teamSeat
} from '../../src/replays/shared/statsMath.js';
import { AIM_FIELDS, AIM_MOTION_WIDTH, emptyMotion } from '../../src/replays/shared/aimMetrics.js';
import { UTILITY_FIELDS } from '../../src/replays/shared/utilityMetrics.js';
import { emptyRating3 } from '../../src/replays/shared/rating3.js';
import { DUEL_BUCKETS, R3_FIELDS, SEAT } from './statsHotStore.js';
import { P } from '../../src/replays/shared/statsMath.js';
import { filterSeatPassesRank, hasRankFilter } from '../../src/replays/shared/vrsRanks.js';
import { loadGlobalRanks } from './teamStandingsDb.js';
import { attachPlayerRoles, playerMatchesRoleFilter } from '../../src/replays/roles/assignRoles.js';

const AKPR_HOLD_SECONDS = 10;

// ---------------------------------------------------------------------------
// Accumulator layout
//
// The first cut used the same nested objects statsMath builds — six buckets a
// seat, each with a sixteen-field Rating 3.0 object. That is ~150 dynamic
// property writes per seat, and at a million seats it cost 1.9 s a query, which
// is most of what this file exists to avoid. Everything a query sums now lives
// in one flat Float64Array indexed by player, and the objects derivePlayers
// wants are built once at the end, for the few thousand players that survived
// the filter.
// ---------------------------------------------------------------------------

/** Counter fields of emptyBucket(), in order, followed by the r3 vector. */
const BUCKET_FIELDS = Object.freeze(['rounds', 'kills', 'deaths', 'assists', 'damage', 'kast']);
const BUCKET_STRIDE = BUCKET_FIELDS.length + R3_FIELDS.length;
/** all, T, CT, won, lost, fullVsFull — the six buckets derivePlayers reads. */
const BUCKET_NAMES = Object.freeze(['all', 'T', 'CT', 'won', 'lost', 'fullVsFull']);
const B_ALL = 0, B_T = 1, B_CT = 2, B_WON = 3, B_LOST = 4, B_FVF = 5;

/** Scalars, in one block after the buckets. */
const SCALARS = Object.freeze([
  'shots', 'hits', 'headshots', 'awpShots', 'awpHits',
  'openKills', 'openDeaths', 'coreOpenKills', 'coreOpenDeaths', 'coreOpenSeen',
  'swingSum', 'swingRounds', 'swingWonSum', 'swingWonRounds', 'swingLostSum', 'swingLostRounds',
  'psdtSum', 'psdtRounds', 'dtSum', 'dtRounds', 'utilRounds',
  'duelW', 'duelP', 'duelN', 'duelDataRounds', 'akprKills', 'akprRounds',
  // Whether any round contributed aim / utility at all. addAim and addUtility
  // write every field including zeros, so a summed-to-zero field must still be
  // present — but a player with no aim data at all keeps an empty object, and
  // aimRating tells those two cases apart.
  'aimSeen', 'utilSeen', 'motSeen'
]);
const S = Object.freeze(Object.fromEntries(SCALARS.map((k, i) => [k, i])));

const OFF_BUCKETS = 0;
const OFF_SCALARS = OFF_BUCKETS + BUCKET_NAMES.length * BUCKET_STRIDE;
const OFF_MK = OFF_SCALARS + SCALARS.length;
const OFF_AIM = OFF_MK + 6;
const OFF_MOT = OFF_AIM + AIM_FIELDS.length;
const OFF_UTIL = OFF_MOT + AIM_MOTION_WIDTH;
const OFF_DUELB = OFF_UTIL + UTILITY_FIELDS.length;
const STRIDE = OFF_DUELB + DUEL_BUCKETS * 3;

/** buyBucket, mirrored: economy codes collapse to five tiers, AWP digit folded. */
function buyBucket(code) {
  const n = Number(code) || 0;
  return n === 5 ? 4 : n;
}

/** econHasAwp, mirrored: the legacy digit 5 is a full buy that had an AWP. */
function econHasAwp(code) {
  return (Number(code) || 0) === 5;
}

/**
 * The round-library half of a filter, resolved against one store.
 *
 * Returns null when the filter asks nothing of the calls, so the hot path pays
 * one null check instead of anything per round. A pick naming calls this store
 * has never interned resolves to an EMPTY id set, which excludes every round —
 * the same answer rowPasses gives, and the opposite of ignoring the filter.
 */
function roundTagQuery(store, filter) {
  const keys = (raw) => {
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return list.map((k) => String(k || '').trim()).filter(Boolean);
  };
  const own = keys(filter.roundOwn);
  const opp = keys(filter.roundOpp);
  const from = Number.isFinite(filter.fromSec) ? filter.fromSec : null;
  const to = Number.isFinite(filter.toSec) ? filter.toSec : null;
  if (!own.length && !opp.length && from === null && to === null) return null;
  const ids = (list) => new Set(list.map((k) => store.tags.find(k)).filter((i) => i >= 0));
  return {
    own: own.length ? ids(own) : null,
    opp: opp.length ? ids(opp) : null,
    windowed: from !== null || to !== null,
    lo: from === null ? -Infinity : from,
    hi: to === null ? Infinity : to,
    // With no call picked, the window asks about any NAMED call the side made,
    // so "default" is the one key it does not count (statsMath.rowTagInWindow).
    defaultId: store.tags.find('default')
  };
}

/**
 * Does this round pass the call / clock filter, for a side?
 *
 * `ownIsT` is the subject side, absolutely. Mirrors the last block of
 * rowPasses: own picks and opponent picks are each an OR over the keys, and the
 * window is asked of the OWN side's picked calls (or of any named call when
 * nothing is picked). A round the library never tagged carries no run at all
 * and so fails any pick, which is what excludes it.
 */
function roundTagsPass(q, store, r, ownIsT) {
  // A store packed before the tag columns existed has no runs at all. Reading
  // it as "no round made any call" excludes everything, which is visibly wrong;
  // reading it as "no filter" would include everything, which is the silent
  // kind. The snapshot layout stamp makes this unreachable in practice.
  if (!store.rTagLen) return false;
  const start = store.rTagOff[r];
  const count = store.rTagLen[r];
  let ownHit = !q.own;
  let oppHit = !q.opp;
  let windowHit = !q.windowed;
  for (let i = 0; i < count; i++) {
    const at = start + i;
    const isOwn = (store.gTagSide[at] === 1) === ownIsT;
    const key = store.gTagKey[at];
    if (isOwn) {
      if (q.own && q.own.has(key)) ownHit = true;
      if (q.windowed && !windowHit && (q.own ? q.own.has(key) : key !== q.defaultId)) {
        const when = store.gTagAt[at];
        // NaN is a call that records no moment; a window is a claim about a
        // clock and an untimed call has not made it.
        if (when >= q.lo && when <= q.hi) windowHit = true;
      }
    } else if (q.opp && q.opp.has(key)) {
      oppHit = true;
    }
    if (ownHit && oppHit && windowHit) return true;
  }
  return ownHit && oppHit && windowHit;
}


/**
 * @param {object} store  from packStore
 * @param {object} filter same shape rowPasses takes
 * @param {Uint8Array|null} [allowDemo] per-demo-index visibility mask. The
 *   store covers the whole library so every caller shares one copy; who may
 *   read which demo is answered here, per query, rather than by building a
 *   separate store per access level.
 * @returns {Array} rows, identical in shape to aggregatePlayers
 */
export function aggregateHot(store, filter = {}, allowDemo = null, benchmarks = null) {
  const {
    nRounds, seatsPerRound, duelStride,
    rDemo, rMap, rSide1, rEcon1, rEcon2, rWinner, rOkSeat, rOdSeat, rHasDuel, rHasCore, rFileIdx,
    sStats, sPlayer, sTeam, sR3, sSwing, sHasSwing, sAim, sHasAim, sMot, sHasMot,
    sUtil, sHasUtil,
    sDuel, sHasDuelSeat, sPsdt, sHasPsdt, sDt, sHasDt, sAwHold, sCoreKill, sCoreDeath, sName
  } = store;

  const nPlayers = store.players.size;
  const acc = new Float64Array(nPlayers * STRIDE);
  const touched = new Uint8Array(nPlayers);
  /** Rounds arrive grouped by demo, so one comparison replaces a per-seat Set. */
  const lastDemo = new Int32Array(nPlayers).fill(-1);
  /** @type {Array<Map<string, number>|null>} */
  const nameCounts = new Array(nPlayers).fill(null);
  /** @type {Array<Map<string, {name: string, rounds: number}>|null>} */
  const teamRounds = new Array(nPlayers).fill(null);
  /** @type {Array<Array<{ at: number, key: string, name: string }>|null>} */
  const clubGames = new Array(nPlayers).fill(null);

  const mapIds = filter.maps?.length
    ? new Set(filter.maps.map((m) => store.maps.find(m)).filter((i) => i >= 0))
    : null;
  if (filter.maps?.length && (!mapIds || !mapIds.size)) return [];
  const fileIds = filter.files?.length
    ? new Set(filter.files.map((f) => store.files.find(f)).filter((i) => i >= 0))
    : null;
  if (filter.files?.length && (!fileIds || !fileIds.size)) return [];

  const wantSide = filter.side || '';
  const wantEcon = filter.econ === null || filter.econ === undefined ? null : buyBucket(filter.econ);
  const wantOppEcon =
    filter.oppEcon === null || filter.oppEcon === undefined ? null : buyBucket(filter.oppEcon);
  const wantAwp = Boolean(filter.hasAwp);
  const wantOppAwp = Boolean(filter.oppHasAwp);
  const wantResult = filter.result || '';
  const wantAdvantage = filter.advantage || '';
  const wantTeamName = filter.teamName ? teamNameKey(filter.teamName) : '';
  const tagQuery = roundTagQuery(store, filter);
  const rankFilter = hasRankFilter(filter)
    ? { ...filter, vrsRanks: filter.vrsRanks || loadGlobalRanks() }
    : filter;
  const fromMs = filter.dateFrom ? Date.parse(`${filter.dateFrom}T00:00:00`) : null;
  const toMs = filter.dateTo ? Date.parse(`${filter.dateTo}T23:59:59.999`) : null;
  const sideTId = store.sides.values.indexOf('T');
  const nR3 = R3_FIELDS.length;
  const nAim = AIM_FIELDS.length;
  const nMot = AIM_MOTION_WIDTH;
  const nUtil = UTILITY_FIELDS.length;

  for (let r = 0; r < nRounds; r++) {
    if (mapIds && !mapIds.has(rMap[r])) continue;
    if (fileIds && !fileIds.has(rFileIdx[r])) continue;
    const demoIdx = rDemo[r];
    if (allowDemo && !allowDemo[demoIdx]) continue;
    const demo = store.demos[demoIdx];
    if (fromMs !== null && !(demo.uploadedAt >= fromMs)) continue;
    if (toMs !== null && !(demo.uploadedAt <= toMs)) continue;

    const s1IsT = rSide1[r] === sideTId;
    const okSeat = rOkSeat[r];
    const odSeat = rOdSeat[r];
    const winner = rWinner[r];
    const hasCore = rHasCore[r];
    const hasDuelRound = rHasDuel[r];
    const rowBase = r * seatsPerRound;
    const okTeam = okSeat >= 0 ? sTeam[rowBase + okSeat] : 0;
    const odTeam = odSeat >= 0 ? sTeam[rowBase + odSeat] : 0;

    for (let k = 0; k < seatsPerRound; k++) {
      const seat = rowBase + k;
      const pid = sPlayer[seat];
      if (pid < 0) continue;
      const team = sTeam[seat];
      if (!team) continue;

      const sideIsT = team === 1 ? s1IsT : !s1IsT;
      if (wantSide) {
        if (wantSide === 'T' ? !sideIsT : sideIsT) continue;
      }

      const own = team === 1 ? rEcon1[r] : rEcon2[r];
      const opp = team === 1 ? rEcon2[r] : rEcon1[r];
      const ownB = buyBucket(own);
      if (wantEcon !== null && ownB !== wantEcon) continue;
      if (wantOppEcon !== null && buyBucket(opp) !== wantOppEcon) continue;
      if (wantAwp && !econHasAwp(own)) continue;
      if (wantOppAwp && !econHasAwp(opp)) continue;
      // Calls and clocks. Last of the cheap tests on purpose: it walks a run.
      if (tagQuery && !roundTagsPass(tagQuery, store, r, sideIsT)) continue;
      const won = winner === team;
      if (wantResult === 'won' && !won) continue;
      if (wantResult === 'lost' && won) continue;

      if (wantAdvantage) {
        const gotOk = okTeam === team;
        const gotOd = odTeam === team;
        if (wantAdvantage === '5v4' && !gotOk) continue;
        if (wantAdvantage === '4v5' && !gotOd) continue;
        if (wantAdvantage === 'even' && (gotOk || gotOd)) continue;
      }

      const displayName = team === 1 ? demo.name1 : demo.name2;
      if (wantTeamName && teamNameKey(displayName) !== wantTeamName) continue;
      if (
        hasRankFilter(rankFilter) &&
        !filterSeatPassesRank(
          displayName,
          team === 1 ? demo.name2 : demo.name1,
          rankFilter
        )
      ) {
        continue;
      }

      touched[pid] = 1;
      const pBase = pid * STRIDE;
      const statBase = seat * SEAT;
      const r3base = seat * nR3;

      const kills = sStats[statBase + P.KILLS];
      const deaths = sStats[statBase + P.DEATHS];
      const assists = sStats[statBase + P.ASSISTS];
      const damage = sStats[statBase + P.DAMAGE];
      const kast = sStats[statBase + P.KAST] ? 1 : 0;

      // Fold into all / side / result / full-vs-full in one pass.
      const targets = [B_ALL, sideIsT ? B_T : B_CT, won ? B_WON : B_LOST];
      const nTargets = ownB === 4 && buyBucket(opp) === 4 ? 4 : 3;
      if (nTargets === 4) targets.push(B_FVF);
      for (let ti = 0; ti < nTargets; ti++) {
        const b = pBase + OFF_BUCKETS + targets[ti] * BUCKET_STRIDE;
        acc[b] += 1;
        acc[b + 1] += kills;
        acc[b + 2] += deaths;
        acc[b + 3] += assists;
        acc[b + 4] += damage;
        acc[b + 5] += kast;
        const rb = b + 6;
        for (let i = 0; i < nR3; i++) acc[rb + i] += sR3[r3base + i];
      }

      const sc = pBase + OFF_SCALARS;
      acc[sc + S.shots] += sStats[statBase + P.SHOTS];
      acc[sc + S.hits] += sStats[statBase + P.HITS];
      acc[sc + S.headshots] += sStats[statBase + P.HEADSHOTS];
      acc[sc + S.awpShots] += sStats[statBase + P.AWP_SHOTS];
      acc[sc + S.awpHits] += sStats[statBase + P.AWP_HITS];
      if (okSeat === k) acc[sc + S.openKills] += 1;
      if (odSeat === k) acc[sc + S.openDeaths] += 1;
      if (hasCore) {
        acc[sc + S.coreOpenSeen] += 1;
        if (sCoreKill[seat]) acc[sc + S.coreOpenKills] += 1;
        if (sCoreDeath[seat]) acc[sc + S.coreOpenDeaths] += 1;
      }
      if (sHasSwing[seat]) {
        const sw = sSwing[seat];
        acc[sc + S.swingSum] += sw;
        acc[sc + S.swingRounds] += 1;
        if (won) {
          acc[sc + S.swingWonSum] += sw;
          acc[sc + S.swingWonRounds] += 1;
        } else {
          acc[sc + S.swingLostSum] += sw;
          acc[sc + S.swingLostRounds] += 1;
        }
      }
      if (sHasAim[seat]) {
        acc[sc + S.aimSeen] += 1;
        const ab = seat * nAim;
        const to = pBase + OFF_AIM;
        for (let i = 0; i < nAim; i++) acc[to + i] += sAim[ab + i];
      }
      if (sHasMot[seat]) {
        acc[sc + S.motSeen] += 1;
        const mb = seat * nMot;
        const to = pBase + OFF_MOT;
        for (let i = 0; i < nMot; i++) acc[to + i] += sMot[mb + i];
      }
      if (sHasUtil[seat]) {
        acc[sc + S.utilSeen] += 1;
        const ub = seat * nUtil;
        const to = pBase + OFF_UTIL;
        for (let i = 0; i < nUtil; i++) acc[to + i] += sUtil[ub + i];
      }
      acc[sc + S.utilRounds] += 1;
      if (sHasPsdt[seat]) {
        acc[sc + S.psdtSum] += sPsdt[seat];
        acc[sc + S.psdtRounds] += 1;
      }
      if (sHasDt[seat]) {
        acc[sc + S.dtSum] += sDt[seat];
        acc[sc + S.dtRounds] += 1;
      }
      if (hasDuelRound) {
        acc[sc + S.duelDataRounds] += 1;
        if (sHasDuelSeat[seat]) {
          const db = seat * duelStride;
          acc[sc + S.duelW] += sDuel[db];
          acc[sc + S.duelP] += sDuel[db + 1];
          acc[sc + S.duelN] += sDuel[db + 2];
          const to = pBase + OFF_DUELB;
          for (let bi = 0; bi < DUEL_BUCKETS * 3; bi++) acc[to + bi] += sDuel[db + 3 + bi];
        }
      }
      acc[pBase + OFF_MK + (kills >= 5 ? 5 : kills < 0 ? 0 : kills | 0)] += 1;
      const hold = sAwHold[seat];
      if (hold >= AKPR_HOLD_SECONDS) {
        acc[sc + S.akprRounds] += 1;
        acc[sc + S.akprKills] += kills;
      }

      // One name vote per player per demo, and team rounds per team key.
      const shortId = team === 1 ? demo.t1 : demo.t2;
      const tkey = teamNameKey(displayName, shortId) || `${demo.id}:${team}`;
      if (lastDemo[pid] !== demoIdx) {
        lastDemo[pid] = demoIdx;
        const label = store.names.lookup(sName[seat]);
        if (label) {
          let counts = nameCounts[pid];
          if (!counts) nameCounts[pid] = counts = new Map();
          counts.set(label, (counts.get(label) || 0) + 1);
        }
        const clubKey = teamNameKey(displayName, shortId);
        if (clubKey) {
          let cg = clubGames[pid];
          if (!cg) clubGames[pid] = cg = [];
          cg.push({
            at: demoTimestamp(demo),
            key: clubKey,
            name:
              String(displayName || '').trim() ||
              String(shortId || '').trim() ||
              `Team ${team}`
          });
        }
      }
      let tr = teamRounds[pid];
      if (!tr) teamRounds[pid] = tr = new Map();
      let hit = tr.get(tkey);
      if (!hit) {
        tr.set(tkey, (hit = {
          name: String(displayName || '').trim() || String(shortId || '').trim() || `Team ${team}`,
          rounds: 0
        }));
      }
      hit.rounds++;
    }
  }

  // ---- materialize ---------------------------------------------------------
  // Only for players that survived the filter, so the object churn statsMath
  // needs is paid a few thousand times rather than a million.
  const out = new Map();
  for (let pid = 0; pid < nPlayers; pid++) {
    if (!touched[pid]) continue;
    const pBase = pid * STRIDE;
    if (acc[pBase + OFF_BUCKETS] === 0) continue;   // all.rounds
    const id = store.players.lookup(pid);
    const state = { id, name: id, nameCounts: nameCounts[pid] || new Map(), nameVoted: new Set() };
    for (let bi = 0; bi < BUCKET_NAMES.length; bi++) {
      const b = pBase + OFF_BUCKETS + bi * BUCKET_STRIDE;
      const r3 = emptyRating3();
      for (let i = 0; i < R3_FIELDS.length; i++) r3[R3_FIELDS[i]] = acc[b + 6 + i];
      state[BUCKET_NAMES[bi]] = {
        rounds: acc[b], kills: acc[b + 1], deaths: acc[b + 2],
        assists: acc[b + 3], damage: acc[b + 4], kast: acc[b + 5], r3
      };
    }
    const sc = pBase + OFF_SCALARS;
    for (const k of SCALARS) {
      if (k === 'aimSeen' || k === 'utilSeen' || k === 'motSeen') continue;
      state[k] = acc[sc + S[k]];
    }
    state.mk = Array.from({ length: 6 }, (_, i) => acc[pBase + OFF_MK + i]);
    // Every field or none: a zero here means "measured, and it was zero",
    // which aimRating scores differently from "never measured".
    state.aim = {};
    if (acc[sc + S.aimSeen] > 0) {
      for (let i = 0; i < AIM_FIELDS.length; i++) state.aim[AIM_FIELDS[i]] = acc[pBase + OFF_AIM + i];
    }
    if (acc[sc + S.motSeen] > 0) {
      state.motion = emptyMotion();
      for (let i = 0; i < AIM_MOTION_WIDTH; i++) state.motion[i] = acc[pBase + OFF_MOT + i];
    }
    state.util = {};
    if (acc[sc + S.utilSeen] > 0) {
      for (let i = 0; i < UTILITY_FIELDS.length; i++) {
        state.util[UTILITY_FIELDS[i]] = acc[pBase + OFF_UTIL + i];
      }
    }
    state.duelBuckets = new Map();
    for (let bi = 0; bi < DUEL_BUCKETS; bi++) {
      const at = pBase + OFF_DUELB + bi * 3;
      if (!(acc[at] > 0)) continue;
      state.duelBuckets.set(bi / 10, { weight: acc[at], predSum: acc[at + 1], wins: acc[at + 2] });
    }
    state.teamRounds = teamRounds[pid] || new Map();
    state.clubGames = clubGames[pid] || [];
    out.set(id, state);
  }

  // Passed in rather than looked up here: measuring the benchmarks calls this
  // function, so a lookup would recurse. The calibration pass reads raw
  // statistics and never the ratings, so running it against the defaults is
  // harmless.
  return derivePlayers(out, benchmarks);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * Team table for a filter, over the resident store.
 *
 * Unlike the player table this one keeps object accumulators: there are tens of
 * teams rather than thousands of players, and each seat touches a handful of
 * fields, so the flat-array treatment would buy nothing and cost clarity.
 * Derivation is `deriveTeams`, shared with the row-based path.
 *
 * @param {object} store
 * @param {object} filter
 * @param {Array} [playerRows] the player table under the same filter; computed
 *   if absent. Passing it in avoids aggregating the library twice when a caller
 *   wants both tables.
 * @param {Uint8Array|null} [allowDemo] per-demo visibility mask, as above.
 */
export function aggregateTeamsHot(store, filter = {}, playerRows = null, allowDemo = null) {
  const acc = createTeamAccumulator();
  const {
    nRounds, seatsPerRound,
    rDemo, rMap, rSide1, rEcon1, rEcon2, rWinner, rOkSeat, rOdSeat, rFileIdx,
    rPrw1, rPrw2, rHasPrw1, rHasPrw2, rPos1, rPos2, rHasPos1, rHasPos2,
    rAca1, rAck1, rAca2, rAck2, rHasAc, rUtt1, rUtt2, rHasUtt1, rHasUtt2,
    sPlayer, sTeam
  } = store;

  const mapIds = filter.maps?.length
    ? new Set(filter.maps.map((m) => store.maps.find(m)).filter((i) => i >= 0))
    : null;
  if (filter.maps?.length && (!mapIds || !mapIds.size)) return [];
  const fileIds = filter.files?.length
    ? new Set(filter.files.map((f) => store.files.find(f)).filter((i) => i >= 0))
    : null;
  if (filter.files?.length && (!fileIds || !fileIds.size)) return [];

  const wantSide = filter.side || '';
  const wantEcon = filter.econ === null || filter.econ === undefined ? null : buyBucket(filter.econ);
  const wantOppEcon =
    filter.oppEcon === null || filter.oppEcon === undefined ? null : buyBucket(filter.oppEcon);
  const wantAwp = Boolean(filter.hasAwp);
  const wantOppAwp = Boolean(filter.oppHasAwp);
  const wantResult = filter.result || '';
  const wantAdvantage = filter.advantage || '';
  const wantTeamName = filter.teamName ? teamNameKey(filter.teamName) : '';
  const tagQuery = roundTagQuery(store, filter);
  const rankFilter = hasRankFilter(filter)
    ? { ...filter, vrsRanks: filter.vrsRanks || loadGlobalRanks() }
    : filter;
  const fromMs = filter.dateFrom ? Date.parse(`${filter.dateFrom}T00:00:00`) : null;
  const toMs = filter.dateTo ? Date.parse(`${filter.dateTo}T23:59:59.999`) : null;
  const sideTId = store.sides.values.indexOf('T');

  for (let r = 0; r < nRounds; r++) {
    if (mapIds && !mapIds.has(rMap[r])) continue;
    if (fileIds && !fileIds.has(rFileIdx[r])) continue;
    if (allowDemo && !allowDemo[rDemo[r]]) continue;
    const demo = store.demos[rDemo[r]];
    if (!demo) continue;
    if (fromMs !== null && !(demo.uploadedAt >= fromMs)) continue;
    if (toMs !== null && !(demo.uploadedAt <= toMs)) continue;

    const s1IsT = rSide1[r] === sideTId;
    const rowBase = r * seatsPerRound;
    const okSeat = rOkSeat[r];
    const odSeat = rOdSeat[r];
    const okTeam = okSeat >= 0 ? sTeam[rowBase + okSeat] : 0;
    const odTeam = odSeat >= 0 ? sTeam[rowBase + odSeat] : 0;
    const winner = rWinner[r];
    const map = store.maps.lookup(rMap[r]) || '';

    for (const team of [1, 2]) {
      const shortId = team === 1 ? demo.t1 : demo.t2;
      const displayName = team === 1 ? demo.name1 : demo.name2;
      const key = teamNameKey(displayName, shortId);
      if (!key) continue;
      if (wantTeamName && teamNameKey(displayName) !== wantTeamName) continue;
      if (
        hasRankFilter(rankFilter) &&
        !filterSeatPassesRank(
          displayName,
          team === 1 ? demo.name2 : demo.name1,
          rankFilter
        )
      ) {
        continue;
      }

      const sideIsT = team === 1 ? s1IsT : !s1IsT;
      if (wantSide) {
        if (wantSide === 'T' ? !sideIsT : sideIsT) continue;
      }
      const own = team === 1 ? rEcon1[r] : rEcon2[r];
      const opp = team === 1 ? rEcon2[r] : rEcon1[r];
      if (wantEcon !== null && buyBucket(own) !== wantEcon) continue;
      if (wantOppEcon !== null && buyBucket(opp) !== wantOppEcon) continue;
      if (wantAwp && !econHasAwp(own)) continue;
      if (wantOppAwp && !econHasAwp(opp)) continue;
      // Calls and clocks. Last of the cheap tests on purpose: it walks a run.
      if (tagQuery && !roundTagsPass(tagQuery, store, r, sideIsT)) continue;
      const won = winner === team;
      if (wantResult === 'won' && !won) continue;
      if (wantResult === 'lost' && won) continue;
      if (wantAdvantage) {
        const gotOk = okTeam === team;
        const gotOd = odTeam === team;
        if (wantAdvantage === '5v4' && !gotOk) continue;
        if (wantAdvantage === '4v5' && !gotOd) continue;
        if (wantAdvantage === 'even' && (gotOk || gotOd)) continue;
      }

      const s = teamSeat(acc, key, displayName || shortId);
      if (shortId) s.shortIds.add(shortId);
      s.rounds++;
      s.demoIds.add(demo.id);
      if (won) s.won++;
      if (okTeam === team) {
        s.openKills++;
        if (won) s.openKillWon++;
      }
      if (odTeam === team) {
        s.openDeaths++;
        if (won) s.openDeathWon++;
      }
      for (let k = 0; k < seatsPerRound; k++) {
        const seat = rowBase + k;
        if (sPlayer[seat] >= 0 && sTeam[seat] === team) {
          s.playerIds.add(store.players.lookup(sPlayer[seat]));
        }
      }
      if (team === 1 ? rHasPrw1[r] : rHasPrw2[r]) {
        s.prwSum += team === 1 ? rPrw1[r] : rPrw2[r];
        s.prwN++;
      }
      if (rHasAc[r]) {
        s.acAdv += team === 1 ? rAca1[r] : rAca2[r];
        s.acChoke += team === 1 ? rAck1[r] : rAck2[r];
      }
      if (team === 1 ? rHasPos1[r] : rHasPos2[r]) {
        const pos = team === 1 ? rPos1[r] : rPos2[r];
        s.posSum += pos;
        s.posN++;
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
      if (team === 1 ? rHasUtt1[r] : rHasUtt2[r]) {
        s.utilDmgSum += team === 1 ? rUtt1[r] : rUtt2[r];
        s.utilDmgRounds++;
      }
    }
  }

  // Live copies only: after a heal an id can appear twice, and team identity
  // must come from the version whose rounds counted.
  const demoMap = new Map();
  for (const d of store.demos) if (!d.dead) demoMap.set(d.id, d);
  return deriveTeams(acc, playerRows || aggregateHot(store, filter, allowDemo), demoMap);
}

// ---------------------------------------------------------------------------
// Per-match rows
// ---------------------------------------------------------------------------

/**
 * One aggregated row per demo, for a single player or team.
 *
 * This is what the Database's player/team detail view shows, and it used to be
 * the reason opening a name downloaded the whole library: the browser needed
 * every raw round to aggregate each match separately. The store can do it
 * without shipping anything.
 *
 * Deliberately a loop over `aggregateHot` / `aggregateTeamsHot` rather than a
 * second accumulator. Those two functions are where every metric is defined,
 * and a per-match variant that re-implemented the per-seat folding would be one
 * refactor away from disagreeing with the table above it — the failure nobody
 * notices, because both numbers look plausible. One demo at a time costs an
 * extra scan per match; correctness by construction is worth more than the
 * scans, and `demoIds` is a single entity's history, not the library.
 *
 * @param {object} store
 * @param {string[]} demoIds demos to produce a row for
 * @param {object} filter
 * @param {Uint8Array|null} allowDemo visibility mask
 * @param {{ kind: 'player'|'team', id: string }} want
 * @returns {Array<object>} rows, each stamped with the demo it came from
 */
export function aggregateHotMatches(store, demoIds, filter, allowDemo, want) {
  // Live copies only, for the same reason as deriveTeams' demoMap above.
  const byId = new Map();
  store.demos.forEach((d, i) => {
    if (!d.dead) byId.set(d.id, i);
  });
  const wantKey = want?.kind === 'team' ? teamNameKey(String(want.id || '')) : '';
  const wantPlayer = String(want?.id || '');
  const out = [];

  for (const demoId of demoIds || []) {
    const idx = byId.get(demoId);
    if (idx === undefined) continue;
    if (allowDemo && !allowDemo[idx]) continue;
    // A mask of exactly this demo. Cheaper than re-slicing the store, and it
    // rides the same filter path every other query uses.
    const only = new Uint8Array(store.demos.length);
    only[idx] = 1;

    const demo = store.demos[idx];
    const players = aggregateHot(store, filter, only);
    // Team rows come along for the score. They are the only place the filtered
    // round record lives — "13:9" has to mean the rounds this filter kept, not
    // the scoreline on the scoreboard, or a side filter would leave every match
    // claiming a result it did not have under that filter.
    const teams = aggregateTeamsHot(store, filter, players, only);

    let row = null;
    let side = 0;
    if (want?.kind === 'team') {
      row = teams.find((t) => t.key === wantKey) || null;
      side = teamNameKey(demo.name1, demo.t1) === wantKey
        ? 1
        : teamNameKey(demo.name2, demo.t2) === wantKey
          ? 2
          : 0;
    } else {
      row = players.find((pl) => String(pl.id) === wantPlayer) || null;
      const seat = (demo.players || []).find((pl) => String(pl.id) === wantPlayer);
      side = seat?.team === 2 ? 2 : seat ? 1 : 0;
    }
    if (!row || !(row.rounds > 0)) continue;

    const ownKey = side === 2
      ? teamNameKey(demo.name2, demo.t2)
      : teamNameKey(demo.name1, demo.t1);
    const own = teams.find((t) => t.key === ownKey) || null;
    const mine = own?.roundsWon ?? 0;
    const theirs = own ? own.rounds - own.roundsWon : 0;

    out.push({
      ...row,
      demoId: demo.id,
      side,
      scoreLabel: own ? `${mine}:${theirs}` : '',
      scoreSort: mine - theirs
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Attach roleT / roleCT / posT / posCT to server-computed player rows.
 *
 * Roles are not derived here. They are written once during indexing, stored per
 * (map, side, player) on the demo, and `attachPlayerRoles` in the browser only
 * ever read that table — so this hands the very same function the very same
 * table and gets the very same answer. The only thing computed here is which
 * (demo, map) pairs survived the filter, and the two conditions that decides on
 * — map and file — are exactly the two `attachPlayerRoles` applies itself.
 *
 * @param {object} store
 * @param {object} filter
 * @param {Uint8Array|null} allowDemo
 * @param {object[]} playerRows rows from aggregateHot
 * @returns {object[]} the same rows, with role fields
 */
export function attachRolesHot(store, filter = {}, allowDemo = null, playerRows = []) {
  const { nRounds, rDemo, rMap, rFileIdx } = store;
  const mapIds = filter.maps?.length
    ? new Set(filter.maps.map((m) => store.maps.find(m)).filter((i) => i >= 0))
    : null;
  const fileIds = filter.files?.length
    ? new Set(filter.files.map((f) => store.files.find(f)).filter((i) => i >= 0))
    : null;

  /** demo index → the map codes it still has rounds on. */
  const mapsByDemo = new Map();
  for (let r = 0; r < nRounds; r++) {
    if (mapIds && !mapIds.has(rMap[r])) continue;
    if (fileIds && !fileIds.has(rFileIdx[r])) continue;
    const d = rDemo[r];
    if (allowDemo && !allowDemo[d]) continue;
    let set = mapsByDemo.get(d);
    if (!set) mapsByDemo.set(d, (set = new Set()));
    set.add(rMap[r]);
  }

  // A payload shaped just enough for attachPlayerRoles: it reads `demo.roles`
  // and groups rounds by `r.m`, so one stub round per surviving map is the
  // whole of what it needs.
  const demos = [];
  for (const [d, mapSet] of mapsByDemo) {
    const demo = store.demos[d];
    if (!demo?.roles?.maps) continue;
    const rounds = [];
    for (const mi of mapSet) rounds.push({ m: store.maps.lookup(mi) });
    demos.push({ id: demo.id, map: demo.map, roles: demo.roles, rounds });
  }
  if (!demos.length) return playerRows;
  // Filters are already applied above; passing `maps` through keeps the
  // single-map "position" mode, which changes which labels come back.
  return attachPlayerRoles(playerRows, { demos }, { maps: filter.maps || [] });
}

/** Drop rows the role chip excludes. Same predicate the browser used. */
export function filterRolesHot(playerRows, role) {
  if (!role?.side || !role?.value) return playerRows;
  return playerRows.filter((p) => playerMatchesRoleFilter(p, role));
}
