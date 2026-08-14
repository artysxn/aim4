// ---------------------------------------------------------------------------
// shared/sim/bootcamp.js
// The drill ladder: a training mode where one team is a metronome.
//
// TWO STAGES, AND BOTH ARE TRAINING. That is the operator's spec and it is
// the thing to keep straight about this file:
//
//   STAGE 1 — LEARN TO BEAT EVERY ROUND. The bootcamp IGL calls the SAME
//   round every time until the trainee wins 8 of the last 10 against it (and
//   has faced it at least 10 times). Then the next drill. 5A until it is
//   beaten, 5B until it is beaten, and so on down the list.
//
//   STAGE 2 — LEARN TO RECOGNIZE THEM. Every drill beaten, the IGL mixes
//   them at random for a chosen number of rounds. This is not a graded
//   finale: it is the second half of the curriculum, where a trainee that
//   holds five separate answers learns to tell which question it is being
//   asked. The trainee keeps learning here exactly as it did in stage 1.
//
// Stage 1 alone produces five scripts. Stage 2 is what turns them into a
// read, which is why its length is the operator's to choose and why its
// winrate is reported apart from the per-drill numbers: 90% on every drill
// and 45% mixed means stage 2 has not happened yet, not that the trainee
// failed a test.
//
// This file is only the ladder — pure state, no engine, no rng of its own
// (mixing draws through the rng it is handed, so a bootcamp run replays under
// its seed like everything else). The runner (scripts/sim-bootcamp.mjs) wires
// it to real matches: the bootcamp side's caller gets `forceCallOf` pointed
// at `drillFor`, every round's outcome comes back through `record`, and
// infinite money keeps the economy from ever deciding a drill.
//
// What makes this training rather than theatre is the OTHER side: the trainee
// runs with its bandit and memory on, so the pattern in front of it — the
// same round, every round — is exactly what EXP3 and the experience index
// exist to punish. The ladder never tells the trainee anything; it only holds
// the pattern still long enough to be learned.
// ---------------------------------------------------------------------------

/** The rolling window a drill is judged over. */
export const BOOTCAMP_WINDOW = 10;
/** Trainee wins inside the window that retire the drill. */
export const BOOTCAMP_PASS = 8;
/** Default length of the recognition stage, when the operator names no other. */
export const BOOTCAMP_MIX_ROUNDS = 50;

export const BOOTCAMP_PHASE = Object.freeze({
  DRILLING: 'drilling',
  MIXED: 'mixed',
  DONE: 'done', // the mixed block is spent; this side has nothing left to ask
  IDLE: 'idle' // a side with no drills listed
});

/**
 * @param {object} args
 * @param {{T?: string[], CT?: string[]}} args.drills  call ids per bootcamp side
 * @param {number} [args.window]
 * @param {number} [args.need]
 * @param {number} [args.mixRounds]  length of the recognition stage, per side
 */
export function createBootcamp({
  drills = {},
  window = BOOTCAMP_WINDOW,
  need = BOOTCAMP_PASS,
  mixRounds = BOOTCAMP_MIX_ROUNDS
} = {}) {
  const sides = {};
  for (const side of ['T', 'CT']) {
    sides[side] = {
      list: [...(drills[side] || [])],
      at: 0,
      rounds: 0,
      mixed: 0,
      mixedWins: 0,
      stats: new Map() // call -> { rounds, wins, recent: [], passedAt: null }
    };
  }

  function statOf(side, call) {
    const s = sides[side];
    let st = s.stats.get(call);
    if (!st) {
      st = { rounds: 0, wins: 0, recent: [], passedAt: null };
      s.stats.set(call, st);
    }
    return st;
  }

  function phase(side) {
    const s = sides[side];
    if (!s.list.length) return BOOTCAMP_PHASE.IDLE;
    if (s.at < s.list.length) return BOOTCAMP_PHASE.DRILLING;
    return s.mixed >= mixRounds ? BOOTCAMP_PHASE.DONE : BOOTCAMP_PHASE.MIXED;
  }

  return {
    /**
     * The call the bootcamp side runs THIS round. In the drilling phase it is
     * the current drill, every time — that is the whole point. In the mixed
     * phase it is a uniform draw over everything the trainee has already
     * beaten one at a time.
     */
    drillFor(side, rng = null) {
      const s = sides[side];
      if (!s.list.length) return null;
      if (s.at < s.list.length) return s.list[s.at];
      const roll = rng?.next ? rng.next() : 0.5;
      return s.list[Math.min(s.list.length - 1, Math.floor(roll * s.list.length))];
    },

    /**
     * One finished round. `side` is the BOOTCAMP side that round; `call` is
     * what it actually ran (so a mixed-phase round credits the drill it drew).
     */
    record({ side, call = null, traineeWon }) {
      const s = sides[side];
      if (!s.list.length) return { phase: BOOTCAMP_PHASE.IDLE, passed: false };
      // A finished side tallies nothing. Matches are played in halves, so a
      // run whose only remaining debt is on one side still has to walk
      // through the other side's rounds to reach it — those are overhead,
      // and booking them onto retired drills would quietly rewrite stats
      // that were final when the side finished.
      if (phase(side) === BOOTCAMP_PHASE.DONE) {
        return { phase: BOOTCAMP_PHASE.DONE, passed: false, overtime: true };
      }
      const drilling = s.at < s.list.length;
      // While drilling, the DRILL is the unit of evidence — never whatever
      // call happened to run. A round where the metronome could not play the
      // drill (a T call handed to a CT ladder, an empty econ bucket) says
      // nothing about whether the drill has been countered, and silently
      // crediting it retires drills that were never faced.
      if (drilling && call && call !== s.list[s.at]) {
        return { phase: phase(side), passed: false, mismatch: true, drill: s.list[s.at], ran: call };
      }
      const active = drilling ? s.list[s.at] : call;
      if (!active) return { phase: phase(side), passed: false };
      s.rounds += 1;
      const st = statOf(side, active);
      st.rounds += 1;
      if (traineeWon) st.wins += 1;
      st.recent.push(traineeWon ? 1 : 0);
      if (st.recent.length > window) st.recent.shift();
      // Stage 2 is tallied apart from the drill it drew: "can it read which
      // round this is" is a different skill from "can it beat this round",
      // and averaging them hides which half of the curriculum has landed.
      // Capped at the stage's length so `mixed.rounds` is exactly the block
      // that was asked for: a runner that stops at a match boundary can
      // overrun by a round or two, and those are not part of the stage.
      if (!drilling && s.mixed < mixRounds) {
        s.mixed += 1;
        if (traineeWon) s.mixedWins += 1;
      }

      // The gate, exactly as specified: at least `window` meetings with this
      // drill, and `need` of the last `window` lost by the metronome.
      let passed = false;
      if (drilling && st.rounds >= window) {
        const winsInWindow = st.recent.reduce((a, b) => a + b, 0);
        if (winsInWindow >= need) {
          st.passedAt = st.rounds;
          s.at += 1;
          passed = true;
        }
      }
      return { phase: phase(side), passed, drill: active };
    },

    /**
     * Every side with drills has spent its mixed block. The runner stops on
     * this rather than on a round budget: a bootcamp is finished when the
     * curriculum is finished, not when the clock runs out.
     */
    isComplete() {
      const active = ['T', 'CT'].filter((side) => sides[side].list.length);
      return active.length > 0 && active.every((side) => phase(side) === BOOTCAMP_PHASE.DONE);
    },

    /**
     * What this side's ladder still needs, in rounds: Infinity while
     * drilling (a drill has no schedule), the stage-2 balance while mixing,
     * zero when done or idle. Per side because match halves are per side —
     * team A meets the T ladder in rounds 1-12 and the CT ladder only from
     * round 13, so a runner sizing matches off a single pooled number
     * starved whichever ladder lived in the half it never reached.
     */
    remainingFor(side) {
      const s = sides[side];
      if (!s.list.length) return 0;
      if (s.at < s.list.length) return Infinity;
      return Math.max(0, mixRounds - s.mixed);
    },

    phase,

    /** Ladder position for a side: which drill, how far into it. */
    progress(side) {
      const s = sides[side];
      const current = s.at < s.list.length ? s.list[s.at] : null;
      const st = current ? statOf(side, current) : null;
      return {
        phase: phase(side),
        drill: current,
        drillIndex: Math.min(s.at, s.list.length),
        drills: s.list.length,
        rounds: st ? st.rounds : 0,
        recentWins: st ? st.recent.reduce((a, b) => a + b, 0) : 0,
        mixed: s.mixed,
        mixRounds,
        mixedWins: s.mixedWins
      };
    },

    summary() {
      const out = {};
      for (const side of ['T', 'CT']) {
        const s = sides[side];
        out[side] = {
          phase: phase(side),
          rounds: s.rounds,
          // Stage 2's own number: how the trainee did once the questions
          // stopped coming in order.
          mixed: {
            rounds: s.mixed,
            of: mixRounds,
            traineeWins: s.mixedWins,
            traineeWinrate: s.mixed ? Math.round((s.mixedWins / s.mixed) * 1000) / 10 : 0
          },
          drills: s.list.map((call) => {
            const st = s.stats.get(call) || { rounds: 0, wins: 0, passedAt: null };
            return {
              call,
              rounds: st.rounds,
              traineeWins: st.wins,
              traineeWinrate: st.rounds ? Math.round((st.wins / st.rounds) * 1000) / 10 : 0,
              passedAt: st.passedAt
            };
          })
        };
      }
      return out;
    }
  };
}
