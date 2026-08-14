// Run: node shared/sim/bootcamp.test.js

import {
  BOOTCAMP_MIX_ROUNDS,
  BOOTCAMP_PASS,
  BOOTCAMP_PHASE,
  BOOTCAMP_WINDOW,
  createBootcamp
} from './bootcamp.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const rngOf = (values) => {
  let i = 0;
  return { next: () => values[i++ % values.length] };
};

// ---- the metronome -------------------------------------------------------

{
  const camp = createBootcamp({ drills: { T: ['5a', '5b'] } });
  assert(camp.phase('T') === BOOTCAMP_PHASE.DRILLING, 'drills start as drills');
  for (let i = 0; i < 25; i += 1) {
    assert(camp.drillFor('T') === '5a', 'the SAME round every time, no matter how it goes');
    camp.record({ side: 'T', traineeWon: i % 3 === 0 }); // ~33%: not learning fast enough
  }
  assert(camp.drillFor('T') === '5a', 'a drill that is not being beaten does not move on');
  assert(camp.phase('CT') === BOOTCAMP_PHASE.IDLE, 'a side with no drills stays quiet');
}

// ---- the gate: 8 of the last 10, and at least 10 meetings ----------------

{
  const camp = createBootcamp({ drills: { T: ['5a', '5b'] } });
  // Nine straight trainee wins: dominant, but the drill has not been faced
  // ten times yet — a pattern is not learned off a lucky streak.
  for (let i = 0; i < 9; i += 1) camp.record({ side: 'T', traineeWon: true });
  assert(camp.drillFor('T') === '5a', 'nine of nine is still not ten rounds');
  const r = camp.record({ side: 'T', traineeWon: true });
  assert(r.passed === true, 'the tenth makes it official');
  assert(camp.drillFor('T') === '5b', 'and the next drill begins');
}

{
  // Early losses age out of the window: what counts is the LAST ten, because
  // the trainee is supposed to be different by the end than at the start.
  const camp = createBootcamp({ drills: { T: ['5a'] } });
  for (let i = 0; i < 6; i += 1) camp.record({ side: 'T', traineeWon: false });
  for (let i = 0; i < 9; i += 1) camp.record({ side: 'T', traineeWon: true });
  // window now holds 1 loss + 9 wins = 9 of 10.
  assert(camp.phase('T') === BOOTCAMP_PHASE.MIXED, 'learned late still counts as learned');
}

{
  // 7 of 10 is not 8 of 10.
  const camp = createBootcamp({ drills: { T: ['5a'] } });
  const seq = [1, 1, 1, 1, 1, 1, 1, 0, 0, 0];
  for (const w of seq) camp.record({ side: 'T', traineeWon: Boolean(w) });
  assert(camp.phase('T') === BOOTCAMP_PHASE.DRILLING, 'seven of ten does not graduate');
  assert(BOOTCAMP_PASS === 8 && BOOTCAMP_WINDOW === 10, 'the numbers are the spec');
}

// ---- the mix -------------------------------------------------------------

{
  const camp = createBootcamp({ drills: { T: ['5a', '5b', 'mid'] } });
  for (const _ of ['5a', '5b', 'mid']) {
    for (let i = 0; i < 10; i += 1) camp.record({ side: 'T', traineeWon: true });
  }
  assert(camp.phase('T') === BOOTCAMP_PHASE.MIXED, 'every drill beaten: the coin comes out');
  // Mixing draws through the rng it is handed, so a run replays under its seed.
  assert(camp.drillFor('T', rngOf([0.0])) === '5a', 'low roll, first drill');
  assert(camp.drillFor('T', rngOf([0.99])) === 'mid', 'high roll, last drill');
  // Mixed rounds still book onto the drill they drew.
  camp.record({ side: 'T', call: 'mid', traineeWon: false });
  const mid = camp.summary().T.drills.find((d) => d.call === 'mid');
  assert(mid.rounds === 11, 'a mixed-phase meeting still counts as a meeting');
}

// ---- a drill that did not run is not a drill that was faced --------------

{
  // The metronome could not play the drill — a T call on a CT ladder, an
  // econ bucket with no tapes. Crediting that round would retire a drill the
  // trainee never saw, which is exactly what happened on the first live run.
  const camp = createBootcamp({ drills: { CT: ['3-2'] } });
  for (let i = 0; i < 15; i += 1) {
    const r = camp.record({ side: 'CT', call: 'default', traineeWon: true });
    assert(r.mismatch === true, 'the ladder says the drill did not run');
    assert(r.passed === false, 'and refuses to retire it');
  }
  assert(camp.phase('CT') === BOOTCAMP_PHASE.DRILLING, 'fifteen wrong rounds move nothing');
  assert(camp.summary().CT.drills[0].rounds === 0, 'and none of them are on the books');
  assert(camp.progress('CT').drill === '3-2', 'the drill is still the one in front');
  // The real drill still counts normally.
  for (let i = 0; i < 10; i += 1) camp.record({ side: 'CT', call: '3-2', traineeWon: true });
  assert(camp.phase('CT') === BOOTCAMP_PHASE.MIXED, 'ten real meetings retire it');
}

// ---- stage 2: recognition, for a chosen number of rounds ----------------

{
  const camp = createBootcamp({ drills: { T: ['5a', '5b'] }, mixRounds: 6 });
  for (const _ of ['5a', '5b']) {
    for (let i = 0; i < 10; i += 1) camp.record({ side: 'T', traineeWon: true });
  }
  assert(camp.phase('T') === BOOTCAMP_PHASE.MIXED, 'drills beaten, recognition begins');
  assert(camp.isComplete() === false, 'and stage 2 unstarted is not a finished curriculum');
  for (let i = 0; i < 5; i += 1) {
    camp.record({ side: 'T', call: '5a', traineeWon: true });
    assert(camp.phase('T') === BOOTCAMP_PHASE.MIXED, `still in stage 2 at ${i + 1}`);
  }
  camp.record({ side: 'T', call: '5b', traineeWon: false });
  assert(camp.phase('T') === BOOTCAMP_PHASE.DONE, 'six of six: stage 2 is served');
  assert(camp.isComplete() === true, 'and with no other side drilling, so is the bootcamp');
  // 5 of 6 in stage 2, tallied on its own — the drills it drew are credited
  // too, but recognition is the skill this half of the curriculum teaches.
  const mixed = camp.summary().T.mixed;
  assert(mixed.rounds === 6 && mixed.traineeWins === 5, `mixed tally: ${JSON.stringify(mixed)}`);
  assert(mixed.traineeWinrate === 83.3, `mixed winrate: ${mixed.traineeWinrate}`);
  assert(camp.summary().T.drills.find((d) => d.call === '5a').rounds === 15, 'drills still tally');
}

{
  // Both sides drill, so the curriculum is only over when BOTH have run it.
  const camp = createBootcamp({ drills: { T: ['5a'], CT: ['3-2'] }, mixRounds: 2 });
  for (let i = 0; i < 10; i += 1) camp.record({ side: 'T', traineeWon: true });
  for (let i = 0; i < 2; i += 1) camp.record({ side: 'T', call: '5a', traineeWon: true });
  assert(camp.phase('T') === BOOTCAMP_PHASE.DONE, 'T is finished');
  assert(camp.isComplete() === false, 'but CT has not started its ladder');
  for (let i = 0; i < 10; i += 1) camp.record({ side: 'CT', traineeWon: true });
  for (let i = 0; i < 2; i += 1) camp.record({ side: 'CT', call: '3-2', traineeWon: true });
  assert(camp.isComplete() === true, 'both sides through stage 2, the bootcamp is over');
  assert(BOOTCAMP_MIX_ROUNDS === 50, 'and stage 2 has a stated default length');
}

// ---- a finished side tallies nothing --------------------------------------

{
  // Matches run in halves, so a run whose only debt is CT-side still walks
  // through T rounds to reach it. Those are overhead, and they must not
  // rewrite stats that were final when the side finished.
  const camp = createBootcamp({ drills: { T: ['5a'], CT: ['3-2'] }, mixRounds: 1 });
  for (let i = 0; i < 10; i += 1) camp.record({ side: 'T', traineeWon: true });
  camp.record({ side: 'T', call: '5a', traineeWon: true });
  assert(camp.phase('T') === BOOTCAMP_PHASE.DONE, 'T is finished');
  const finalRounds = camp.summary().T.drills[0].rounds;
  const finalMixed = camp.summary().T.mixed;
  const r = camp.record({ side: 'T', call: '5a', traineeWon: false });
  assert(r.overtime === true, 'a post-done round announces itself as overhead');
  assert(camp.summary().T.drills[0].rounds === finalRounds, 'and moves no drill stat');
  assert(camp.summary().T.mixed.traineeWins === finalMixed.traineeWins, 'nor the stage-2 tally');
}

// ---- remaining need is per side, because match halves are ----------------

{
  const camp = createBootcamp({ drills: { T: ['5a'], CT: ['3-2'] }, mixRounds: 4 });
  assert(camp.remainingFor('T') === Infinity, 'a drill has no schedule');
  assert(camp.remainingFor('CT') === Infinity, 'on either side');
  for (let i = 0; i < 10; i += 1) camp.record({ side: 'T', traineeWon: true });
  camp.record({ side: 'T', call: '5a', traineeWon: true });
  assert(camp.remainingFor('T') === 3, 'mixing owes what is left of the block');
  for (let i = 0; i < 3; i += 1) camp.record({ side: 'T', call: '5a', traineeWon: true });
  assert(camp.remainingFor('T') === 0, 'done owes nothing');
  assert(camp.remainingFor('CT') === Infinity, 'while the other ladder still stands whole');
  const empty = createBootcamp({ drills: { T: ['5a'] } });
  assert(empty.remainingFor('CT') === 0, 'and a side with no drills never owed any');
}

// ---- the summary reads like a report -------------------------------------

{
  const camp = createBootcamp({ drills: { T: ['5a'], CT: ['3-2'] } });
  for (let i = 0; i < 10; i += 1) camp.record({ side: 'T', traineeWon: i >= 2 });
  const s = camp.summary();
  assert(s.T.drills[0].rounds === 10 && s.T.drills[0].traineeWins === 8, 'the tally is honest');
  assert(s.T.drills[0].passedAt === 10, 'and says when the drill fell');
  assert(s.CT.phase === BOOTCAMP_PHASE.DRILLING, 'the other side has its own ladder');
  const p = camp.progress('CT');
  assert(p.drill === '3-2' && p.rounds === 0, 'progress names the drill in front');
}

console.log('bootcamp: ok');
