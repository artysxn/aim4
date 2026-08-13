// ---------------------------------------------------------------------------
// shared/sim/match.js
// MR12: twelve rounds a side, halftime, overtime, and the money in between.
//
// The round is the engine's job (engine.js). This is the layer above it, and
// it exists because almost every economic decision is a multi-round decision:
// whether to force now depends on what the next two rounds look like, and a
// side that has just lost four in a row is a different opponent from one that
// has lost one, whatever the scoreboard says.
//
// Deliberately not a simulation of anything. It counts rounds, swaps sides,
// settles money, and answers "is this over". Everything interesting happens
// below it or above it.
// ---------------------------------------------------------------------------

import {
  OT_ROUNDS_PER_HALF,
  ROUNDS_PER_HALF,
  ROUNDS_TO_WIN
} from './constants.js';
import { OT_START_MONEY, START_MONEY, settleRound } from './economy.js';

export const MATCH_PHASE = Object.freeze({
  FIRST_HALF: 'first',
  SECOND_HALF: 'second',
  OVERTIME: 'overtime',
  DONE: 'done'
});

/**
 * @param {object} cfg
 * @param {string} cfg.map
 * @param {Array<{id: string, slot: number}>} cfg.teamA  starts T
 * @param {Array<{id: string, slot: number}>} cfg.teamB  starts CT
 */
export function createMatch(cfg) {
  const state = {
    map: cfg.map,
    phase: MATCH_PHASE.FIRST_HALF,
    round: 1,
    /** Score by TEAM, never by side, because sides swap and scores do not. */
    score: { A: 0, B: 0 },
    /** Which side each team is currently playing. */
    side: { A: 'T', B: 'CT' },
    lossStreak: { A: 0, B: 0 },
    money: {},
    /**
     * Overtime is played in BLOCKS of six rounds, three a side. `otBlock` is
     * which block we are in and decides the target score; `otHalf` is which
     * half of that block and decides when sides swap. Conflating them makes the
     * match winnable one round early, which is exactly the kind of bug that
     * only shows up in a 12-12.
     */
    otBlock: 0,
    otHalf: 0,
    otRound: 0,
    history: []
  };

  for (const p of [...cfg.teamA, ...cfg.teamB]) state.money[p.slot] = START_MONEY;

  const teamOf = (slot) => (cfg.teamA.some((p) => p.slot === slot) ? 'A' : 'B');
  const sideOf = (slot) => state.side[teamOf(slot)];

  /** Rounds needed to win, accounting for overtime. */
  function target() {
    if (state.phase !== MATCH_PHASE.OVERTIME) return ROUNDS_TO_WIN;
    // 12-12 goes to a first-to-16 block, then first-to-19, and so on.
    return ROUNDS_PER_HALF + (state.otBlock + 1) * OT_ROUNDS_PER_HALF + 1;
  }

  function swapSides() {
    state.side = { A: state.side.A === 'T' ? 'CT' : 'T', B: state.side.B === 'T' ? 'CT' : 'T' };
    // Money and streaks reset at the swap, which is what makes the first round
    // of a half a pistol round rather than a continuation.
    state.lossStreak = { A: 0, B: 0 };
    const start = state.phase === MATCH_PHASE.OVERTIME ? OT_START_MONEY : START_MONEY;
    for (const slot of Object.keys(state.money)) state.money[slot] = start;
  }

  return {
    state,
    teamOf,
    sideOf,

    /**
     * Deduct what a side spent at the buy. The engine never touches money; the
     * match holds the wallets, the runner (later: the buy head) decides the
     * purchases, and this applies them. Clamped at zero because a scripted
     * buyer that overspends is a bug worth surviving, not obeying.
     */
    applySpending(spend) {
      for (const [slot, amount] of Object.entries(spend || {})) {
        if (state.money[slot] === undefined) continue;
        state.money[slot] = Math.max(0, state.money[slot] - Math.max(0, amount));
      }
      return state;
    },

    /** Money and side for every slot, which is what a round needs to start. */
    roundSetup() {
      return {
        round: state.round,
        phase: state.phase,
        score: { ...state.score },
        side: { ...state.side },
        money: { ...state.money },
        pistol: isPistolRound(state)
      };
    },

    /**
     * Record a finished round and advance.
     *
     * @param {object} outcome  from the engine: winner SIDE, reason, planted...
     * @param {Record<number, number>} killCash
     */
    recordRound(outcome, killCash = {}) {
      if (state.phase === MATCH_PHASE.DONE) return state;

      const winningTeam = state.side.A === outcome.winner ? 'A' : 'B';
      const losingTeam = winningTeam === 'A' ? 'B' : 'A';

      const players = Object.keys(state.money).map((slot) => ({
        slot: Number(slot),
        side: sideOf(Number(slot)),
        alive: true,
        money: state.money[slot]
      }));

      // The economy settles in SIDES because the payout rules are written in
      // sides (a T that planted and lost, a CT that ran the clock), while the
      // scoreboard advances in TEAMS. Conflating the two is how a halftime swap
      // silently starts paying the wrong side.
      const settled = settleRound({
        outcome,
        players,
        killCash,
        lossStreak: {
          T: state.side.A === 'T' ? state.lossStreak.A : state.lossStreak.B,
          CT: state.side.A === 'CT' ? state.lossStreak.A : state.lossStreak.B
        }
      });

      state.money = settled.money;
      state.lossStreak = {
        A: state.side.A === 'T' ? settled.lossStreak.T : settled.lossStreak.CT,
        B: state.side.B === 'T' ? settled.lossStreak.T : settled.lossStreak.CT
      };

      state.score[winningTeam] += 1;
      state.history.push({
        round: state.round,
        winner: winningTeam,
        side: outcome.winner,
        reason: outcome.reason,
        score: { ...state.score }
      });

      // ---- advance ----
      const t = target();
      if (state.score[winningTeam] >= t) {
        state.phase = MATCH_PHASE.DONE;
        state.winner = winningTeam;
        return state;
      }

      state.round += 1;

      if (state.phase === MATCH_PHASE.FIRST_HALF && state.round > ROUNDS_PER_HALF) {
        state.phase = MATCH_PHASE.SECOND_HALF;
        swapSides();
        return state;
      }

      if (state.phase === MATCH_PHASE.SECOND_HALF && state.round > ROUNDS_PER_HALF * 2) {
        // 12-12: into overtime rather than a draw.
        state.phase = MATCH_PHASE.OVERTIME;
        state.otBlock = 0;
        state.otHalf = 0;
        state.otRound = 1;
        swapSides();
        return state;
      }

      if (state.phase === MATCH_PHASE.OVERTIME) {
        state.otRound += 1;
        if (state.otRound > OT_ROUNDS_PER_HALF) {
          state.otRound = 1;
          state.otHalf += 1;
          if (state.otHalf > 1) {
            // Six rounds played and still level: a new block, a higher target.
            state.otHalf = 0;
            state.otBlock += 1;
          }
          swapSides();
        }
      }

      void losingTeam;
      return state;
    },

    isOver: () => state.phase === MATCH_PHASE.DONE
  };
}

/**
 * A pistol round is the first of each half, including each overtime half.
 * It matters because it is the one round where the economy is not a decision.
 */
export function isPistolRound(state) {
  if (state.phase === MATCH_PHASE.FIRST_HALF) return state.round === 1;
  if (state.phase === MATCH_PHASE.SECOND_HALF) return state.round === ROUNDS_PER_HALF + 1;
  if (state.phase === MATCH_PHASE.OVERTIME) return state.otRound === 1;
  return false;
}
