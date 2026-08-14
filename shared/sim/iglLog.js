// ---------------------------------------------------------------------------
// shared/sim/iglLog.js
// The caller's dataset (SIM-PLAN 9.25 stage 3).
//
// One row per freeze or recall — not per tick, not per option, not per flick.
// A match contributes 24 to 80 rows against the individual trainer's ~40,000,
// and that ratio is the whole reason this file exists separately from the
// bot loggers:
//
//   { picture, decision, tapeId, call, pWin_belief, pWin_true, fightEv,
//     recalled, won, attrib }
//
// `pWin_true` is backfilled after the round from the sealed PRW truth (18.6b).
// `won` is backfilled at the same moment. Nothing here is decided live: the
// log is an observation of a decision that has already been made, which is
// what keeps it out of the determinism hash.
//
// Three rules this file enforces rather than documents:
//
//   NO POSITIONS. The picture goes through prw.js's allowlist, the same one
//   the review path uses (5.4). A dataset is a thing you eventually publish,
//   and a caller trained on god-view coordinates is a caller that cannot be
//   run honestly.
//
//   ONLY `call` ROWS TRAIN THE SITUATION VALUE. `exec` rows lost the round on
//   execution and `perc` rows priced a correct ranking wrong (18.6b.2). Both
//   are kept — they are the mistake ledger and the calibration table — and
//   neither is evidence that the call was bad.
//
//   HOLDOUT BY MATCH, STRATIFIED BY (map, side, call, econ). Splitting by
//   round leaks: rounds 4 and 5 of one match share econ, score, opponent and
//   half the belief. Grade it like BC or do not grade it.
// ---------------------------------------------------------------------------

import { scrubPicture } from './prw.js';

export const IGL_LOG_VERSION = 1;

/** What made the caller speak. Freeze is round start; the rest are recalls. */
export const IGL_EVENT = Object.freeze({
  FREEZE: 'freeze',
  RECALL: 'recall'
});

/** The default share of matches held out. Same 20% the BC trainers use. */
export const HOLDOUT_FRACTION = 0.2;

/**
 * Candidate plans, trimmed to what a trainer needs. The full entry is a tape
 * with five roles and their waypoints; storing that per row would make the
 * dataset larger than the replays it came from, and the head never sees it.
 */
function slimCandidates(candidates = []) {
  return candidates.slice(0, 8).map((c) => ({
    id: c.entry?.id || null,
    call: c.entry?.call || null,
    decision: c.decision || null,
    distance: Number.isFinite(c.distance) ? c.distance : null,
    value: Number.isFinite(c.value) ? c.value : null
  }));
}

/**
 * One side's caller log for one round.
 *
 * @param {object} args
 * @param {'T'|'CT'} args.side
 * @param {string} [args.map]
 * @param {number} [args.econ]     this side's buy, for the holdout stratum
 * @param {number} [args.gen]      which lineage wrote it
 * @param {string} [args.matchId]  the holdout unit
 */
export function createIglLog({ side, map = null, econ = null, gen = 0, matchId = null } = {}) {
  const rows = [];
  let sealed = false;

  return {
    side,
    map,
    econ,
    gen,
    matchId,

    /**
     * Write one decision. Everything the caller knew at the moment it spoke,
     * and nothing it learned afterwards.
     *
     * @returns {object} the row, so the bot can hold a reference to it
     */
    log({
      tick,
      round = null,
      event = IGL_EVENT.RECALL,
      situation = null,
      picture = null,
      decision = null,
      entry = null,
      call = null,
      candidates = null,
      pWinBelief = null,
      fightEv = null,
      margin = null,
      recalled = false,
      posture = null,
      motive = null
    } = {}) {
      const row = {
        v: IGL_LOG_VERSION,
        map,
        side,
        round,
        tick: Number.isFinite(tick) ? tick : null,
        event,
        econ,
        gen,
        situation: typeof situation === 'string' ? situation : situation?.hash || null,
        picture: scrubPicture(picture),
        decision: decision || null,
        tapeId: entry?.id || null,
        call: call || entry?.call || null,
        candidates: candidates ? slimCandidates(candidates) : null,
        pWin_belief: Number.isFinite(pWinBelief) ? pWinBelief : null,
        // Backfilled at roundEnd. Null here is honest: at the moment of the
        // decision the true price does not exist for this side to know.
        pWin_true: null,
        residual: null,
        fightEv: Number.isFinite(fightEv) ? fightEv : null,
        margin: Number.isFinite(margin) ? margin : null,
        recalled: Boolean(recalled),
        posture: posture || null,
        motive: motive || null,
        won: null,
        attrib: null
      };
      rows.push(row);
      sealed = false;
      return row;
    },

    rows() {
      return rows.map((r) => ({ ...r }));
    },

    size() {
      return rows.length;
    },

    isSealed() {
      return sealed;
    },

    /**
     * Post-round. `prwRows` are the graded PRW rows (18.6b) for this side; a
     * caller row takes the true price from the nearest graded row at or
     * before its tick, which is the same join the value collector uses.
     *
     * `attrib` is the round's 18.6 verdict, one per round rather than one per
     * decision: the review names which drop lost it, and every decision in
     * the round carries that label so a trainer can drop `exec` and `perc`
     * without having to re-run the review.
     */
    seal({ won = null, attrib = null, prwRows = null } = {}) {
      const graded = (prwRows || [])
        .filter((r) => Number.isFinite(r?.tick) && Number.isFinite(r?.pWin_true))
        .sort((a, b) => a.tick - b.tick);
      for (const row of rows) {
        row.won = won == null ? null : Boolean(won);
        row.attrib = attrib || null;
        if (!graded.length || !Number.isFinite(row.tick)) continue;
        let truth = null;
        for (const g of graded) {
          if (g.tick > row.tick) break;
          truth = g;
        }
        if (!truth) continue;
        row.pWin_true = truth.pWin_true;
        if (Number.isFinite(row.pWin_belief)) row.residual = truth.pWin_true - row.pWin_belief;
      }
      sealed = true;
      return this.rows();
    },

    /** Drain for storage; the log is empty after. */
    drain() {
      const out = this.rows();
      rows.length = 0;
      sealed = false;
      return out;
    },

    toJSON() {
      return { v: IGL_LOG_VERSION, side, map, econ, gen, matchId, rows: this.rows() };
    }
  };
}

/**
 * The stratum a row belongs to: `(map, side, call, econ)`. Econ is bucketed
 * rather than exact, because "$4,150 vs $4,300" is one stratum in every sense
 * that matters and treating them as two produces strata of size one.
 */
export function stratumOf(row = {}) {
  const econ = Number.isFinite(row.econ) ? Math.round(row.econ / 1000) : 'na';
  return `${row.map || 'na'}|${row.side || 'na'}|${row.call || 'na'}|${econ}`;
}

/**
 * FNV-1a plus an avalanche finalizer. A stable hash so a split is reproducible
 * without storing it.
 *
 * The finalizer is not decoration. Plain FNV-1a barely diffuses the last byte
 * it consumed, and every key here differs only in its tail (`...|m8`,
 * `...|m9`), so the raw hash ordered the matches almost by their trailing
 * digit — three different salts picked the identical holdout. A split that
 * cannot be re-drawn is not a random split, it is a fixed one with a salt
 * parameter that does nothing.
 *
 * This is murmur3's fmix32, used only for spreading; nothing here is
 * cryptographic and nothing depends on it being.
 */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Match-level holdout, stratified by `(map, side, call, econ)`.
 *
 * The unit is the MATCH and never the round, for the reason 9.25 gives and
 * 9.3's BC grading learned the hard way: two rounds of one match share econ,
 * score, opponent and most of the belief, so a round-level split reports a
 * number that no unseen match will reproduce.
 *
 * Deterministic: the same rows and salt always produce the same split, so a
 * re-run of the trainer is comparable to the run before it.
 *
 * @returns {{train: object[], val: object[], holdout: Set<string>, strata: number}}
 */
export function splitMatches(rows = [], { fraction = HOLDOUT_FRACTION, salt = '' } = {}) {
  // Which stratum each match mostly belongs to. A match plays one map and one
  // pair of sides, so this is nearly always unanimous; the mode settles the
  // rest rather than letting a match land in two strata.
  const byMatch = new Map();
  for (const r of rows) {
    const id = r?.matchId || r?.match || 'na';
    let counts = byMatch.get(id);
    if (!counts) {
      counts = new Map();
      byMatch.set(id, counts);
    }
    const s = stratumOf(r);
    counts.set(s, (counts.get(s) || 0) + 1);
  }

  const strata = new Map();
  for (const [id, counts] of byMatch) {
    let best = null;
    let bestN = -1;
    for (const [s, n] of counts) {
      if (n > bestN || (n === bestN && s < best)) {
        best = s;
        bestN = n;
      }
    }
    if (!strata.has(best)) strata.set(best, []);
    strata.get(best).push(id);
  }

  const holdout = new Set();
  for (const [stratum, ids] of strata) {
    // Sorted by hash, not shuffled: a stratum of three matches must still
    // yield a val set, and the ordering must not depend on read order.
    const ranked = ids
      .map((id) => ({ id, h: hashString(`${salt}|${stratum}|${id}`) }))
      .sort((a, b) => a.h - b.h || (a.id < b.id ? -1 : 1));
    const take = ids.length <= 1 ? 0 : Math.max(1, Math.round(ids.length * fraction));
    for (const m of ranked.slice(0, take)) holdout.add(m.id);
  }

  const train = [];
  const val = [];
  for (const r of rows) {
    (holdout.has(r?.matchId || r?.match || 'na') ? val : train).push(r);
  }
  return { train, val, holdout, strata: strata.size };
}

/**
 * The rows that may move a situation's value: 9.25 stage 3, verbatim — "only
 * `call` rows update situation value. `exec` and `perc` go to the mistake
 * ledger and the calibration table, not to 'never do this call again'."
 *
 * Rows with no attribution at all are kept: an ungraded round is unlabelled,
 * not exonerated, and dropping it silently would bias the set toward rounds
 * that had a clean verdict.
 */
export function trainableRows(rows = []) {
  return rows.filter((r) => !r?.attrib || r.attrib === 'call');
}

/** The other two buckets, for the ledger and the calibration table. */
export function ledgerRows(rows = []) {
  return rows.filter((r) => r?.attrib === 'exec' || r?.attrib === 'perc');
}

/** JSONL, one row per line. The format every trainer in scripts/ reads. */
export function toJsonl(rows = []) {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}
