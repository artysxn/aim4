// Run: node shared/sim/match.test.js
//
// The match layer is small and gets two things wrong if nobody watches it:
// scores counted in sides instead of teams (so a halftime swap hands the lead
// to the wrong side), and money that survives a swap it should not. Both are
// silent, and both would show up only as bots that buy strangely after round 12.

import { MATCH_PHASE, createMatch, isPistolRound } from './match.js';
import { OT_START_MONEY, START_MONEY } from './economy.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const teamA = [0, 1, 2, 3, 4].map((slot) => ({ id: `a${slot}`, slot }));
const teamB = [5, 6, 7, 8, 9].map((slot) => ({ id: `b${slot}`, slot }));
const fresh = () => createMatch({ map: 'INF', teamA, teamB });

const win = (side, reason = 'elimination') => ({
  winner: side,
  reason,
  planted: false,
  planterSlot: null,
  defuserSlot: null
});

// ---- setup ------------------------------------------------------------------

{
  const m = fresh();
  assert(m.state.side.A === 'T' && m.state.side.B === 'CT', 'team A starts T');
  assert(m.state.money[0] === START_MONEY, 'everyone starts at 800');
  assert(m.roundSetup().pistol, 'round 1 is a pistol round');
  assert(m.sideOf(0) === 'T' && m.sideOf(5) === 'CT', 'slots resolve to sides');
  assert(m.teamOf(0) === 'A' && m.teamOf(9) === 'B', 'and to teams');
}

// ---- the score follows the team, not the side -------------------------------

{
  const m = fresh();
  // A (playing T) wins the first three.
  for (let i = 0; i < 3; i += 1) m.recordRound(win('T'));
  assert(m.state.score.A === 3, 'A has three');
  assert(m.state.score.B === 0, 'B has none');

  // Play out the half. A wins all twelve.
  for (let i = 3; i < 12; i += 1) m.recordRound(win('T'));
  assert(m.state.score.A === 12, 'A took the half 12-0');
  assert(m.state.phase === MATCH_PHASE.SECOND_HALF, 'and it is now the second half');
  assert(m.state.side.A === 'CT', 'A has swapped to CT');
  assert(m.state.side.B === 'T', 'and B to T');

  // Now a T win is a win for B, not for A. This is the assertion that catches
  // a score kept in sides.
  m.recordRound(win('T'));
  assert(m.state.score.B === 1, 'after the swap, a T win belongs to B');
  assert(m.state.score.A === 12, 'and A is unchanged');
}

// ---- halftime resets the economy --------------------------------------------

{
  const m = fresh();
  for (let i = 0; i < 12; i += 1) m.recordRound(win('T'));
  assert(m.state.money[0] === START_MONEY, 'money resets at the swap');
  assert(m.state.lossStreak.A === 0 && m.state.lossStreak.B === 0, 'so do loss streaks');
  assert(isPistolRound(m.state), 'and round 13 is a pistol round');
}

// ---- winning ----------------------------------------------------------------

{
  const m = fresh();
  for (let i = 0; i < 12; i += 1) m.recordRound(win('T')); // A: 12
  for (let i = 0; i < 12; i += 1) {
    if (m.isOver()) break;
    m.recordRound(win('CT')); // A is CT now, so A keeps winning
  }
  assert(m.isOver(), 'the match ends');
  assert(m.state.winner === 'A', 'A won it');
  assert(m.state.score.A === 13, 'at 13 rounds');
  const before = m.state.round;
  m.recordRound(win('T'));
  assert(m.state.round === before, 'and a finished match does not advance');
}

// ---- overtime ---------------------------------------------------------------

{
  const m = fresh();
  // 12-12: A wins the first six of its half, B wins the other six, and so on.
  for (let i = 0; i < 12; i += 1) m.recordRound(i < 6 ? win('T') : win('CT'));
  assert(m.state.score.A === 6 && m.state.score.B === 6, 'the first half splits');
  for (let i = 0; i < 12; i += 1) {
    if (m.isOver()) break;
    // A is CT now. Six each again.
    m.recordRound(i < 6 ? win('CT') : win('T'));
  }
  assert(m.state.score.A === 12 && m.state.score.B === 12, 'and so does the second');
  assert(m.state.phase === MATCH_PHASE.OVERTIME, '12-12 goes to overtime, not a draw');
  assert(m.state.money[0] === OT_START_MONEY, 'overtime starts at 10000');
  assert(isPistolRound(m.state), 'the first OT round counts as a pistol round');

  // Three rounds, then the OT sides swap.
  const sideBefore = m.state.side.A;
  for (let i = 0; i < 3; i += 1) m.recordRound(win(m.state.side.A));
  assert(m.state.side.A !== sideBefore, 'sides swap after three overtime rounds');
  assert(m.state.money[0] === OT_START_MONEY, 'and the money resets again');

  // A has 15 now and needs 16 to take this overtime.
  assert(!m.isOver(), 'three overtime rounds is not enough to win it');
  assert(m.state.score.A === 15, 'A is on 15');
  m.recordRound(win(m.state.side.A));
  assert(m.isOver() && m.state.winner === 'A', 'the sixteenth wins it');
}

// ---- history ----------------------------------------------------------------

{
  const m = fresh();
  m.recordRound(win('T', 'bomb'));
  m.recordRound(win('CT', 'defuse'));
  assert(m.state.history.length === 2, 'the match keeps a history');
  assert(m.state.history[0].reason === 'bomb', 'with how each round ended');
  assert(m.state.history[0].winner === 'A', 'and who won it, by team');
  assert(m.state.history[1].score.B === 1, 'and the running score');
}

console.log('match: ok');
