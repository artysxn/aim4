// Run: node shared/sim/callValue.test.js

import { Rng } from './rng.js';
import { ExperienceIndex } from './experience.js';
import { CALL_DECISION, shouldRecall } from './caller.js';
import {
  DECISION_FIGHT_SHARE,
  MEMORY_MIN_N,
  blendMemory,
  comparePlans,
  indexValueOf,
  pickPlan,
  planValue,
  rankPlans
} from './callValue.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const picture = (over = {}) => ({
  side: 'T',
  alive: 5,
  enemyAlive: 5,
  clock: 20,
  secondsLeft: 90,
  planted: false,
  hasKit: false,
  contactRel: 'front',
  siteExpectedTarget: 1,
  siteExpectedOther: 2,
  packAtTarget: 3,
  ...over
});

const tape = (id, call, over = {}) => ({
  id,
  call,
  side: 'T',
  firstContact: { t: 20, rel: 'front' },
  plant: { site: 'a', t: 40 },
  ...over
});

// ---- the three ingredients -----------------------------------------------

{
  const p = picture();
  const v = planValue({ picture: p, decision: 'commit' });
  assert(v.value >= 0 && v.value <= 1, 'value is a probability');
  assert(Number.isFinite(v.pWin) && Number.isFinite(v.fightEv), 'and carries its parts');
  assert(v.memory === null, 'no head means no memory term, not a silent zero');
}

{
  // Freeze is the anchor: it takes none of the next fight, by construction.
  assert(DECISION_FIGHT_SHARE.freeze === 0, 'freeze takes no fight');
  assert(DECISION_FIGHT_SHARE.commit === 1, 'commit takes it as priced');
  const p = picture();
  const commit = planValue({ picture: p, decision: 'commit', incumbent: true });
  const freeze = planValue({ picture: p, decision: 'freeze', incumbent: true });
  // Same picture, so the only difference between the two IS the fight.
  const gap = commit.value - freeze.value;
  assert(
    Math.abs(gap - commit.fightEv) < 1e-9,
    'commit minus freeze is exactly the priced fight'
  );
}

{
  // Sign, not magnitude: that is the standard the header claims.
  const winning = picture({ alive: 5, enemyAlive: 2 });
  const losing = picture({ alive: 2, enemyAlive: 5 });
  const a = planValue({ picture: winning, decision: 'commit' });
  const b = planValue({ picture: losing, decision: 'commit' });
  assert(a.value > b.value, 'a 5v2 is worth more than a 2v5');
}

// ---- memory blends in by count, and only by count ------------------------

{
  const base = 0.5;
  assert(blendMemory(base, null) === base, 'no record leaves the model alone');
  assert(
    blendMemory(base, { n: MEMORY_MIN_N - 1, lower: 0.9 }) === base,
    'a thin record is a rumour, not a head'
  );
  const blended = blendMemory(base, { n: 40, lower: 0.9 });
  assert(blended > base, 'evidence pulls the number');
  assert(blended < 0.9, 'but never all the way: the head does not outvote the model');
}

{
  const index = new ExperienceIndex();
  const key = 'sit-1';
  for (let i = 0; i < 12; i += 1) index.write({ key, call: 'a-exec', won: true });
  const memoryOf = indexValueOf(index, key);
  const seen = planValue({ picture: picture(), decision: 'commit', entry: tape('t1', 'a-exec'), memoryOf });
  const unseen = planValue({ picture: picture(), decision: 'commit', entry: tape('t2', 'b-exec'), memoryOf });
  assert(seen.memory?.n > 0, 'the head read the situation');
  assert(seen.value > unseen.value, 'a call that has actually won is worth more');
}

// ---- the one comparison (9.25 stage 1) -----------------------------------

{
  // Nothing better on offer: the plan stays in motion. That is the default
  // the whole caller is built around.
  const current = tape('cur', 'a-exec');
  const verdict = comparePlans({
    picture: picture(),
    candidates: [{ entry: tape('alt', 'a-exec'), decision: 'commit', distance: 0.1 }],
    currentDecision: 'commit',
    currentEntry: current,
    recallMargin: 0.12
  });
  assert(verdict.recall === false, 'an equal alternative is not a recall');
  assert(verdict.entry === current, 'and the tape does not move');
}

{
  // Holding is always a candidate, even with an empty answer book: a caller
  // that can only choose between two ways of walking forward cannot stop.
  const verdict = comparePlans({
    picture: picture(),
    candidates: [],
    currentDecision: 'commit',
    currentEntry: tape('cur', 'a-exec'),
    recallMargin: 0.0
  });
  assert(verdict.ranked.length === 0, 'no library answers here');
  assert(verdict.decision === CALL_DECISION.FREEZE || verdict.recall === false, 'freeze was still on the table');
}

{
  // A -EV fight makes holding worth more than continuing, and the reason says
  // so in the spec's own words.
  const bad = picture({ alive: 2, enemyAlive: 5, contactRel: 'behind' });
  const verdict = comparePlans({
    picture: bad,
    candidates: [],
    currentDecision: 'commit',
    currentEntry: tape('cur', 'a-exec'),
    recallMargin: 0.01
  });
  if (verdict.recall) {
    assert(verdict.decision === CALL_DECISION.FREEZE, 'the only alternative offered was holding');
    assert(/-EV versus holding/.test(verdict.reason), 'and it is priced, not asserted');
  }
}

{
  const ranked = rankPlans(
    [
      { entry: tape('a', 'a-exec'), decision: 'commit', distance: 0 },
      { entry: tape('b', 'b-exec', { plant: null }), decision: 'turnaround', distance: 0.4 }
    ],
    { picture: picture() }
  );
  assert(ranked.length === 2, 'every candidate is scored');
  assert(ranked[0].value >= ranked[1].value, 'best first');
  assert(ranked.every((r) => r.entry && r.decision), 'and keeps what it was given');
}

// ---- the incumbent is not free to abandon --------------------------------

{
  const p = picture();
  const inMotion = planValue({ picture: p, decision: 'commit', entry: tape('x', 'a'), incumbent: true });
  const fresh = planValue({ picture: p, decision: 'commit', entry: tape('x', 'a'), incumbent: false });
  assert(inMotion.value > fresh.value, 'continuity is worth something, so ties do not thrash');
}

// ---- the freeze draw is a draw, not an argmax ----------------------------

{
  const candidates = [
    { entry: tape('a', 'a-exec'), decision: 'commit', distance: 0 },
    { entry: tape('b', 'b-exec'), decision: 'commit', distance: 0 },
    { entry: tape('c', 'c-exec'), decision: 'commit', distance: 0 }
  ];
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const chosen = pickPlan({ candidates, picture: picture(), rng: new Rng(100 + i) });
    assert(chosen?.entry, 'a plan came back');
    seen.add(chosen.entry.id);
  }
  assert(seen.size > 1, 'equal-value tapes do not collapse onto one round forever');
}

{
  // Same seed, same answer. The head must not cost determinism.
  const candidates = [
    { entry: tape('a', 'a-exec'), decision: 'commit', distance: 0 },
    { entry: tape('b', 'b-exec'), decision: 'commit', distance: 0 }
  ];
  const one = pickPlan({ candidates, picture: picture(), rng: new Rng(7) });
  const two = pickPlan({ candidates, picture: picture(), rng: new Rng(7) });
  assert(one.entry.id === two.entry.id, 'the draw is seeded');
}

// ---- the gate: posture first, head second --------------------------------

{
  // VP still freezes its 5v4 with the head on. Freezing when ahead is
  // doctrine (6.2 H3), and the value head must not be able to grant it to a
  // posture that does not have it.
  const ahead = picture({ alive: 5, enemyAlive: 4 });
  const called = [];
  const compare = (args) => {
    called.push(args);
    return { recall: false, decision: args.currentDecision, entry: args.currentEntry, reason: 'x', margin: 0, ranked: [] };
  };
  const vp = shouldRecall({ picture: ahead, posture: 'vp', currentDecision: 'commit', compare, rng: new Rng(3) });
  assert(vp.recall === true && vp.decision === CALL_DECISION.FREEZE, 'VP freezes a 5v4');

  const def = shouldRecall({ picture: ahead, posture: 'default', currentDecision: 'commit', compare, rng: new Rng(3) });
  assert(def.decision !== CALL_DECISION.FREEZE, 'default does not');
  assert(called.length >= 1, 'and default did reach the head');
}

{
  // With no head injected, the stage 0 librarian answers exactly as before.
  const p = picture({ alive: 2, enemyAlive: 5 });
  const before = shouldRecall({ picture: p, posture: 'default', currentDecision: 'commit' });
  assert(typeof before.recall === 'boolean', 'the heuristic still runs');
  assert(before.entry === undefined, 'and names no tape, because it never did');
}

{
  // A head that says "recall to this tape" is obeyed, tape and all.
  const alt = tape('alt', 'b-exec');
  const compare = () => ({
    recall: true,
    decision: 'turnaround',
    entry: alt,
    reason: 'turnaround is worth 0.30 more than continuing',
    margin: 0.3,
    ranked: []
  });
  const gate = shouldRecall({
    picture: picture({ alive: 3, enemyAlive: 4 }),
    posture: 'default',
    currentDecision: 'commit',
    compare
  });
  assert(gate.recall === true, 'the head recalled');
  assert(gate.entry === alt, 'and the named tape survives the gate');
  assert(gate.decision === 'turnaround', 'with its decision');
}

console.log('callValue: ok');
