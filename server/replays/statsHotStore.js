// ---------------------------------------------------------------------------
// replays/statsHotStore.js
// The library, resident, as typed arrays.
//
// Measured on a 4100-demo library: holding the parsed indexes as JS objects
// costs ~1.7 GB of heap and 6.9 s to build, which is why every page re-read
// them from disk instead — 6.6 s of JSON.parse per load, on every load, for
// every user. The same data as flat typed arrays is a few hundred MB and can be
// scanned in milliseconds.
//
// Two things make that possible without reimplementing the statistics:
//
//   1. Every accumulator in statsMath is a *fold over numeric fields* —
//      emptyBucket, emptyRating3, AIM_FIELDS, UTILITY_FIELDS. So a seat's
//      contribution is a fixed-width vector, and aggregation is column sums.
//   2. Rating 3.0's per-round duel context is the expensive part and does not
//      depend on the query, so it is resolved once here, at pack time, into
//      those same per-seat vectors. Queries never see a kill list.
//
// Derivation stays in statsMath: `derivePlayers` turns summed buckets into the
// sixty-odd output fields, so the non-linear maths has exactly one home.
//
// Floats are Float64, not Float32. Float32 halves the footprint and was the
// first cut, but it moved `prwSwingTotal` and `pfo` by ~3e-6 relative against
// the existing aggregator. Nobody would see that on screen; everybody would see
// "the Database shows different numbers than it used to", and chasing that back
// to a storage width later would cost far more than the memory does now.
// ---------------------------------------------------------------------------

import { AIM_FIELDS } from '../../src/replays/shared/aimMetrics.js';
import { UTILITY_FIELDS } from '../../src/replays/shared/utilityMetrics.js';
import {
  addRating3Round,
  emptyRating3,
  rating3RoundContext,
  rating3RoundFacts
} from '../../src/replays/shared/rating3.js';
import { P, PLAYER_SLOTS } from '../../src/replays/shared/statsMath.js';

/** Field order for the packed Rating 3.0 vector. Fixed by emptyRating3. */
export const R3_FIELDS = Object.freeze(Object.keys(emptyRating3()));

/**
 * Duel-model bucket centres, quantized. `du.b` entries are [centre, w, p, n]
 * with centres on a 0.1 grid, so eleven slots cover the range exactly and a
 * variable-length list becomes a fixed-width one.
 */
export const DUEL_BUCKETS = 11;
const duelSlot = (centre) => {
  const i = Math.round(Number(centre) * 10);
  return i >= 0 && i < DUEL_BUCKETS ? i : -1;
};

const SEAT = PLAYER_SLOTS;          // 10 stat slots per seat
const SEATS_PER_ROUND = 10;

/** Sides and maps are interned so a round's metadata is one byte each. */
function interner() {
  const to = new Map();
  const from = [];
  return {
    id(v) {
      const k = String(v ?? '');
      let i = to.get(k);
      if (i === undefined) {
        i = from.length;
        to.set(k, i);
        from.push(k);
      }
      return i;
    },
    lookup: (i) => from[i],
    /**
     * The id for a value that is already interned, or −1.
     *
     * Distinct from `id()`, which INTERNS what it is given: a filter asking for
     * a value the store has never seen must not grow the table. And distinct
     * from `values.indexOf()`, which is what the filters used to do — a linear
     * scan of the whole table per requested value. On the Pattern Finder's
     * round-file filter that is (rounds asked for × rounds in the library),
     * which on a big library is billions of string compares to answer a
     * question the map already knows.
     */
    find(v) {
      const i = to.get(String(v ?? ''));
      return i === undefined ? -1 : i;
    },
    get size() {
      return from.length;
    },
    values: from
  };
}

/**
 * A packer that takes entries one at a time.
 *
 * The first version took an array of every parsed index. At four thousand
 * demos that array is ~1.8 GB of heap on its own — the exact thing the paging
 * in statsIndex exists to avoid — and it sat alongside the 600 MB of typed
 * arrays being built from it. Streaming means one entry is live at a time and
 * the peak is the store itself.
 *
 * Capacity comes from the demo records' `roundCount`, which the caller already
 * has in memory. It is a hint, not a contract: the arrays grow if it is short.
 *
 * @param {number} capacityRounds expected round count
 */
export function createPacker(capacityRounds = 1024) {
  let nRounds = Math.max(1, Math.floor(capacityRounds) || 1);
  let nSeats = nRounds * SEATS_PER_ROUND;

  const maps = interner();
  const sides = interner();
  const players = interner();

  // ---- per round -----------------------------------------------------------
  const rDemo = new Int32Array(nRounds);
  const rMap = new Uint8Array(nRounds);
  const rSide1 = new Uint8Array(nRounds);
  const rEcon1 = new Uint8Array(nRounds);
  const rEcon2 = new Uint8Array(nRounds);
  const rWinner = new Uint8Array(nRounds);
  const rOkSeat = new Int8Array(nRounds);   // seat index within the round, -1 = none
  const rOdSeat = new Int8Array(nRounds);
  const rHasDuel = new Uint8Array(nRounds); // row.du present at all
  const rHasCore = new Uint8Array(nRounds); // row.cok / row.cod present
  const rFileIdx = new Int32Array(nRounds); // into `files`, for filter.files
  const files = interner();
  // Team-level round columns, for the Teams table. Held per round rather than
  // per seat: possession, PRW and advantage conversion are properties of a
  // side, not of a player.
  const rPrw1 = new Float64Array(nRounds);
  const rPrw2 = new Float64Array(nRounds);
  const rHasPrw1 = new Uint8Array(nRounds);
  const rHasPrw2 = new Uint8Array(nRounds);
  const rPos1 = new Float64Array(nRounds);
  const rPos2 = new Float64Array(nRounds);
  const rHasPos1 = new Uint8Array(nRounds);
  const rHasPos2 = new Uint8Array(nRounds);
  const rAca1 = new Float64Array(nRounds);
  const rAck1 = new Float64Array(nRounds);
  const rAca2 = new Float64Array(nRounds);
  const rAck2 = new Float64Array(nRounds);
  const rHasAc = new Uint8Array(nRounds);
  const rUtt1 = new Float64Array(nRounds);
  const rUtt2 = new Float64Array(nRounds);
  const rHasUtt1 = new Uint8Array(nRounds);
  const rHasUtt2 = new Uint8Array(nRounds);

  // ---- per seat ------------------------------------------------------------
  const sPlayer = new Int32Array(nSeats);
  const sTeam = new Uint8Array(nSeats);
  const sStats = new Int32Array(nSeats * SEAT);
  const sSwing = new Float64Array(nSeats);
  const sHasSwing = new Uint8Array(nSeats);
  const sR3 = new Float64Array(nSeats * R3_FIELDS.length);
  const sAim = new Float64Array(nSeats * AIM_FIELDS.length);
  const sHasAim = new Uint8Array(nSeats);
  const sUtil = new Float64Array(nSeats * UTILITY_FIELDS.length);
  const sHasUtil = new Uint8Array(nSeats);
  const sDuel = new Float64Array(nSeats * (3 + DUEL_BUCKETS * 3));
  const sHasDuelSeat = new Uint8Array(nSeats);
  const sPsdt = new Float64Array(nSeats);
  const sHasPsdt = new Uint8Array(nSeats);
  const sDt = new Float64Array(nSeats);
  const sHasDt = new Uint8Array(nSeats);
  const sAwHold = new Float64Array(nSeats);
  const sCoreKill = new Uint8Array(nSeats);
  const sCoreDeath = new Uint8Array(nSeats);
  const sName = new Int32Array(nSeats);     // display-name vote, interned
  const names = interner();

  const demos = [];
  const DUEL_STRIDE = 3 + DUEL_BUCKETS * 3;

  /** Live counts, as opposed to allocated capacity. */
  let r = 0;

  /** Column table, so growth does not mean naming every array twice. */
  const roundCols = {
    rDemo, rMap, rSide1, rEcon1, rEcon2, rWinner, rOkSeat, rOdSeat, rHasDuel, rHasCore, rFileIdx,
    rPrw1, rPrw2, rHasPrw1, rHasPrw2, rPos1, rPos2, rHasPos1, rHasPos2,
    rAca1, rAck1, rAca2, rAck2, rHasAc, rUtt1, rUtt2, rHasUtt1, rHasUtt2
  };
  const seatCols = {
    sPlayer, sTeam, sStats, sSwing, sHasSwing, sR3, sAim, sHasAim, sUtil, sHasUtil,
    sDuel, sHasDuelSeat, sPsdt, sHasPsdt, sDt, sHasDt, sAwHold, sCoreKill, sCoreDeath, sName
  };
  /** Elements per round / per seat, for reallocation. */
  const seatWidth = {
    sPlayer: 1, sTeam: 1, sStats: SEAT, sSwing: 1, sHasSwing: 1, sR3: R3_FIELDS.length,
    sAim: AIM_FIELDS.length, sHasAim: 1, sUtil: UTILITY_FIELDS.length, sHasUtil: 1,
    sDuel: DUEL_STRIDE, sHasDuelSeat: 1, sPsdt: 1, sHasPsdt: 1, sDt: 1, sHasDt: 1,
    sAwHold: 1, sCoreKill: 1, sCoreDeath: 1, sName: 1
  };

  function grow(needRounds) {
    if (needRounds <= nRounds) return;
    const next = Math.max(needRounds, Math.ceil(nRounds * 1.5));
    for (const k of Object.keys(roundCols)) {
      const old = roundCols[k];
      const bigger = new old.constructor(next);
      bigger.set(old);
      roundCols[k] = bigger;
    }
    for (const k of Object.keys(seatCols)) {
      const old = seatCols[k];
      const bigger = new old.constructor(next * SEATS_PER_ROUND * seatWidth[k]);
      bigger.set(old);
      seatCols[k] = bigger;
    }
    // sPlayer marks empty seats with -1; new capacity must say "empty" too.
    seatCols.sPlayer.fill(-1, nRounds * SEATS_PER_ROUND);
    nRounds = next;
    nSeats = nRounds * SEATS_PER_ROUND;
  }
  seatCols.sPlayer.fill(-1);

  function addEntry(e) {
    if (!e || !Array.isArray(e.rounds) || !e.rounds.length) return;
    grow(r + e.rounds.length);
    const {
      rDemo, rMap, rSide1, rEcon1, rEcon2, rWinner, rOkSeat, rOdSeat, rHasDuel, rHasCore, rFileIdx,
      rPrw1, rPrw2, rHasPrw1, rHasPrw2, rPos1, rPos2, rHasPos1, rHasPos2,
      rAca1, rAck1, rAca2, rAck2, rHasAc, rUtt1, rUtt2, rHasUtt1, rHasUtt2
    } = roundCols;
    const {
      sPlayer, sTeam, sStats, sSwing, sHasSwing, sR3, sAim, sHasAim, sUtil, sHasUtil,
      sDuel, sHasDuelSeat, sPsdt, sHasPsdt, sDt, sHasDt, sAwHold, sCoreKill, sCoreDeath, sName
    } = seatCols;
    const d = demos.length;
    demos.push({
      id: e.id,
      map: e.map || '',
      t1: e.t1 || '',
      t2: e.t2 || '',
      name1: e.name1 || '',
      name2: e.name2 || '',
      winner: e.winner || 0,
      uploadedAt: e.uploadedAt || 0,
      players: e.players || [],
      // Role assignments are computed once during indexing and stored per
      // (map, side, player). Carrying the table here — a few hundred bytes a
      // demo — is what lets the Role filter be answered from the store instead
      // of shipping every round so the browser can read the same table.
      roles: e.roles || null
    });
    const roster = e.players || [];
    const teamById = new Map(roster.map((p) => [p.id, p.team]));

    for (const row of e.rounds) {
      rDemo[r] = d;
      rMap[r] = maps.id(row.m || e.map || '');
      rSide1[r] = sides.id(row.s1 || 'T');
      rEcon1[r] = Math.max(0, Math.min(255, Number(row.e1) || 0));
      rEcon2[r] = Math.max(0, Math.min(255, Number(row.e2) || 0));
      rWinner[r] = row.w === 2 ? 2 : 1;
      rFileIdx[r] = files.id(row.f || '');
      rHasDuel[r] = row.du != null && typeof row.du === 'object' ? 1 : 0;
      rHasCore[r] = Array.isArray(row.cok) || Array.isArray(row.cod) ? 1 : 0;
      rOkSeat[r] = -1;
      rOdSeat[r] = -1;
      if (Number.isFinite(row.prw1)) { rPrw1[r] = row.prw1; rHasPrw1[r] = 1; }
      if (Number.isFinite(row.prw2)) { rPrw2[r] = row.prw2; rHasPrw2[r] = 1; }
      if (Number.isFinite(row.pos1)) { rPos1[r] = row.pos1; rHasPos1[r] = 1; }
      if (Number.isFinite(row.pos2)) { rPos2[r] = row.pos2; rHasPos2[r] = 1; }
      // Mirrors statsMath: the pair is read when *either* side carries it.
      if (row.aca1 !== undefined || row.aca2 !== undefined) {
        rHasAc[r] = 1;
        rAca1[r] = Number(row.aca1) || 0;
        rAck1[r] = Number(row.ack1) || 0;
        rAca2[r] = Number(row.aca2) || 0;
        rAck2[r] = Number(row.ack2) || 0;
      }
      if (Number.isFinite(row.utt?.[1])) { rUtt1[r] = row.utt[1]; rHasUtt1[r] = 1; }
      if (Number.isFinite(row.utt?.[2])) { rUtt2[r] = row.utt[2]; rHasUtt2[r] = 1; }

      // Rating 3.0 context: resolved once, here. This is the quadratic trade
      // scan that made a filtered query expensive; a query now reads its result.
      let ctx = null;
      try {
        ctx = rating3RoundContext(row, teamById);
      } catch {
        ctx = null;
      }

      const cok = Array.isArray(row.cok) ? new Set(row.cok) : null;
      const cod = Array.isArray(row.cod) ? new Set(row.cod) : null;

      for (let k = 0; k < SEATS_PER_ROUND; k++) {
        const seat = r * SEATS_PER_ROUND + k;
        const who = roster[k];
        if (!who) {
          sPlayer[seat] = -1;
          continue;
        }
        const id = who.id;
        sPlayer[seat] = players.id(id);
        sName[seat] = names.id(String(who.name || '').trim());
        const team = who.team === 2 ? 2 : 1;
        sTeam[seat] = team;
        if (row.ok === id) rOkSeat[r] = k;
        if (row.od === id) rOdSeat[r] = k;

        const line = row.p?.[id];
        if (line) {
          const base = seat * SEAT;
          for (let s = 0; s < SEAT; s++) sStats[base + s] = Number(line[s]) || 0;
        }

        const sw = row.sw?.[id];
        if (Number.isFinite(sw)) {
          sSwing[seat] = sw;
          sHasSwing[seat] = 1;
        }

        // Fold this seat's Rating 3.0 round into a fixed vector.
        if (ctx) {
          const facts = rating3RoundFacts(ctx, id, team);
          if (facts) {
            const acc = emptyRating3();
            addRating3Round(acc, facts);
            const base = seat * R3_FIELDS.length;
            for (let i = 0; i < R3_FIELDS.length; i++) sR3[base + i] = acc[R3_FIELDS[i]] || 0;
          }
        }

        const am = row.am?.[id];
        if (am) {
          sHasAim[seat] = 1;
          const base = seat * AIM_FIELDS.length;
          for (let i = 0; i < AIM_FIELDS.length; i++) sAim[base + i] = Number(am[AIM_FIELDS[i]]) || 0;
        }

        const ut = row.ut?.[id];
        if (ut) {
          sHasUtil[seat] = 1;
          const base = seat * UTILITY_FIELDS.length;
          for (let i = 0; i < UTILITY_FIELDS.length; i++) {
            sUtil[base + i] = Number(ut[UTILITY_FIELDS[i]]) || 0;
          }
        }

        const du = row.du?.[id];
        if (du && Number.isFinite(du.w) && du.w > 0) {
          sHasDuelSeat[seat] = 1;
          const base = seat * DUEL_STRIDE;
          sDuel[base] = du.w;
          sDuel[base + 1] = Number(du.p) || 0;
          sDuel[base + 2] = Number(du.n) || 0;
          for (const entry of du.b || []) {
            const slot = duelSlot(entry?.[0]);
            if (slot < 0 || !(entry[1] > 0)) continue;
            const at = base + 3 + slot * 3;
            sDuel[at] += Number(entry[1]) || 0;
            sDuel[at + 1] += Number(entry[2]) || 0;
            sDuel[at + 2] += Number(entry[3]) || 0;
          }
        }

        const mv = row.mv?.[id];
        if (mv && Number.isFinite(mv.psdt)) {
          sPsdt[seat] = mv.psdt;
          sHasPsdt[seat] = 1;
        }
        if (mv && Number.isFinite(mv.dt)) {
          sDt[seat] = mv.dt;
          sHasDt[seat] = 1;
        }

        const aw = row.aw?.[id];
        if (Number.isFinite(aw)) sAwHold[seat] = aw;

        if (cok?.has(id)) sCoreKill[seat] = 1;
        if (cod?.has(id)) sCoreDeath[seat] = 1;
      }
      r++;
    }
  }

  function finish() {
    const {
      rDemo, rMap, rSide1, rEcon1, rEcon2, rWinner, rOkSeat, rOdSeat, rHasDuel, rHasCore, rFileIdx,
      rPrw1, rPrw2, rHasPrw1, rHasPrw2, rPos1, rPos2, rHasPos1, rHasPos2,
      rAca1, rAck1, rAca2, rAck2, rHasAc, rUtt1, rUtt2, rHasUtt1, rHasUtt2
    } = roundCols;
    const {
      sPlayer, sTeam, sStats, sSwing, sHasSwing, sR3, sAim, sHasAim, sUtil, sHasUtil,
      sDuel, sHasDuelSeat, sPsdt, sHasPsdt, sDt, sHasDt, sAwHold, sCoreKill, sCoreDeath, sName
    } = seatCols;
    const usedRounds = r;
    const usedSeats = r * SEATS_PER_ROUND;
    // Trim to what was actually filled. subarray shares the buffer, so an
    // over-generous capacity hint costs address space, not a copy.
    const cutR = (a) => a.subarray(0, usedRounds);
    const cutS = (a, w) => a.subarray(0, usedSeats * w);

    const out = {
      nRounds: usedRounds,
      nSeats: usedSeats,
      seatsPerRound: SEATS_PER_ROUND,
      duelStride: DUEL_STRIDE,
      demos,
      maps,
      sides,
      players,
      names,
      files,
      rDemo: cutR(rDemo), rMap: cutR(rMap), rSide1: cutR(rSide1),
      rEcon1: cutR(rEcon1), rEcon2: cutR(rEcon2), rWinner: cutR(rWinner),
      rOkSeat: cutR(rOkSeat), rOdSeat: cutR(rOdSeat),
      rHasDuel: cutR(rHasDuel), rHasCore: cutR(rHasCore), rFileIdx: cutR(rFileIdx),
      rPrw1: cutR(rPrw1), rPrw2: cutR(rPrw2),
      rHasPrw1: cutR(rHasPrw1), rHasPrw2: cutR(rHasPrw2),
      rPos1: cutR(rPos1), rPos2: cutR(rPos2),
      rHasPos1: cutR(rHasPos1), rHasPos2: cutR(rHasPos2),
      rAca1: cutR(rAca1), rAck1: cutR(rAck1), rAca2: cutR(rAca2), rAck2: cutR(rAck2),
      rHasAc: cutR(rHasAc),
      rUtt1: cutR(rUtt1), rUtt2: cutR(rUtt2),
      rHasUtt1: cutR(rHasUtt1), rHasUtt2: cutR(rHasUtt2),
      sPlayer: cutS(sPlayer, 1), sTeam: cutS(sTeam, 1), sStats: cutS(sStats, SEAT),
      sSwing: cutS(sSwing, 1), sHasSwing: cutS(sHasSwing, 1),
      sR3: cutS(sR3, R3_FIELDS.length),
      sAim: cutS(sAim, AIM_FIELDS.length), sHasAim: cutS(sHasAim, 1),
      sUtil: cutS(sUtil, UTILITY_FIELDS.length), sHasUtil: cutS(sHasUtil, 1),
      sDuel: cutS(sDuel, DUEL_STRIDE), sHasDuelSeat: cutS(sHasDuelSeat, 1),
      sPsdt: cutS(sPsdt, 1), sHasPsdt: cutS(sHasPsdt, 1),
      sDt: cutS(sDt, 1), sHasDt: cutS(sHasDt, 1),
      sAwHold: cutS(sAwHold, 1),
      sCoreKill: cutS(sCoreKill, 1), sCoreDeath: cutS(sCoreDeath, 1),
      sName: cutS(sName, 1)
    };
    let bytes = 0;
    for (const v of Object.values(out)) if (ArrayBuffer.isView(v)) bytes += v.byteLength;
    out.bytes = bytes;
    return out;
  }

  return { add: addEntry, finish, get rounds() { return r; } };
}

/**
 * Pack a set of entries in one go. Convenience for tests and small sets; the
 * server streams through `createPacker` instead so it never holds the library.
 *
 * @param {Iterable<object>} entries full (unprojected) stats indexes
 */
export function packStore(entries) {
  const list = [...entries].filter((e) => e && Array.isArray(e.rounds));
  let capacity = 0;
  for (const e of list) capacity += e.rounds.length;
  const packer = createPacker(capacity || 1);
  for (const e of list) packer.add(e);
  return packer.finish();
}

export { P, SEAT, AIM_FIELDS, UTILITY_FIELDS };
