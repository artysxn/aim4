// Run: node shared/sim/review.test.js

import { prwDrops, attributeDrop, reviewRound } from './review.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const drops = prwDrops(
    [
      { tick: 0, prw: 0.6 },
      { tick: 10, prw: 0.55 },
      { tick: 20, prw: 0.2 },
      { tick: 30, prw: 0.19 }
    ],
    1
  );
  assert(drops[0].tick === 20, 'the largest PRW drop is the round');
}

{
  const exec = attributeDrop({
    drop: { tick: 20, drop: 0.3 },
    played: 'hold',
    optionsAtTick: () => [
      { id: 'hold', value: 0.2 },
      { id: 'hunt', value: 0.5 }
    ]
  });
  assert(exec.kind === 'exec', 'a better option for the same bot is execution');

  const call = attributeDrop({
    drop: { tick: 20, drop: 0.3 },
    played: 'a-default',
    optionsAtTick: () => [
      { id: 'a-default', value: 0.2 },
      { id: 'b-rush', value: 0.21 }
    ]
  });
  assert(call.kind === 'call', 'when every option was already bad, the call owns it');
}

{
  const r = reviewRound({
    timeline: [
      { tick: 0, prw: 0.5 },
      { tick: 8, prw: 0.2 }
    ],
    played: 'hold',
    optionsAtTick: () => [
      { id: 'hold', value: 0.1 },
      { id: 'rotate', value: 0.4 }
    ],
    searchLog: [{ policy: 'hold', search: 'rotate' }]
  });
  assert(r.execLosses === 1, 'the review attributes');
  assert(r.regret.length === 1, 'and keeps the search disagreement for expert iteration');
}

console.log('review: ok');
