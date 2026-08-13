// Run: node shared/sim/spaceField.test.js
//
// Space, not the ball. The properties that make the field worth reading:
//
//   control is a race: winning the arrival wins the cell
//   opportunity is value earned times control held, minus who can punish it
//   the best free ground is real free ground, not the contested frontier
//   the three route kinds are one search with three costs

import { bestSpace, computeSpaceField, routeCost, CONTROL_HORIZON_SECONDS } from './spaceField.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// A four-anchor world: my spawn, their spawn, a contested mid, a free flank.
const REACH_MINE = { mine: 1, theirs: 20, mid: 6, flank: 5 };
const REACH_THEIRS = { mine: 20, theirs: 1, mid: 6, flank: 14 };
const VALUE = { mine: 0.2, theirs: 0.9, mid: 0.7, flank: 0.6 };

const field = () =>
  computeSpaceField({
    anchors: Object.keys(VALUE),
    myReachSeconds: (a) => REACH_MINE[a],
    enemyReachSeconds: (a) => REACH_THEIRS[a],
    value: (a) => VALUE[a],
    dangerMass: (a) => (a === 'theirs' ? 0.8 : 0)
  });

// ---- control is a race ------------------------------------------------------

{
  const f = field();
  assert(f.get('mine').control > 0.99, 'my own ground is mine');
  assert(f.get('theirs').control < 0.01, 'theirs is theirs');
  assert(Math.abs(f.get('mid').control - 0.5) < 0.01, 'a dead heat is a coin');
  assert(f.get('flank').control > 0.9, 'winning the race by nine seconds wins the cell');

  const walled = computeSpaceField({
    anchors: ['gone'],
    myReachSeconds: () => Infinity,
    enemyReachSeconds: () => 3,
    value: () => 1
  });
  assert(walled.get('gone').control === 0, 'unreachable ground is not controlled');

  const empty = computeSpaceField({
    anchors: ['open'],
    myReachSeconds: () => 3,
    enemyReachSeconds: () => Infinity,
    value: () => 1
  });
  assert(empty.get('open').control === 1, 'ground the belief cannot reach is free');
}

// ---- opportunity, and where the run goes ------------------------------------

{
  const f = field();
  assert(
    f.get('theirs').opportunity < 0,
    'valuable ground under their guns is not an opportunity'
  );

  const runs = bestSpace(f);
  assert(runs[0].anchor === 'flank', `the run goes to the free flank (${runs[0].anchor})`);

  const excluding = bestSpace(f, (a) => a !== 'flank', 1);
  assert(excluding[0].anchor === 'mid', 'eligibility filters the vocabulary');

  assert(CONTROL_HORIZON_SECONDS > 0, 'the horizon exists and is stated');
}

// ---- the three routes are three costs ---------------------------------------

{
  assert(routeCost('fastest') === null, 'fastest leaves the search alone');

  const danger = (cx) => (cx === 5 ? 1 : 0);
  const safest = routeCost('safest', { dangerAt: danger });
  assert(safest(0, 0) === 1, 'quiet ground costs its length');
  assert(safest(5, 0) > 5, 'watched ground costs a detour');

  const retreat = routeCost('retreat', { dangerAt: danger, towardThreat: (cx) => (cx > 8 ? 1 : 0) });
  assert(retreat(9, 0) > safest(9, 0), 'retreat refuses ground toward the threat');
  assert(retreat(0, 0) === 1, 'and pays nothing to walk away');

  let threw = false;
  try {
    routeCost('scenic');
  } catch {
    threw = true;
  }
  assert(threw, 'an unknown route kind is a loud error');
}

console.log('spaceField: ok');
