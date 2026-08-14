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

// ---- 18.6b: the third bucket ----------------------------------------------

{
  // Ranked its options right, priced the round at 80 when it was 51.
  const perc = attributeDrop({
    drop: { tick: 20, drop: 0.3 },
    played: 'hold',
    residual: -0.29,
    optionsAtTick: () => [
      { id: 'hold', value: 0.4 },
      { id: 'rotate', value: 0.1 }
    ],
    trueOptionsAtTick: () => [
      { id: 'hold', value: 0.2 },
      { id: 'rotate', value: 0.05 }
    ]
  });
  assert(perc.kind === 'perc', 'a right ranking on a wrong picture is perception');

  // Believed 80, truth 78. Nobody is punished for that.
  const noise = attributeDrop({
    drop: { tick: 20, drop: 0.3 },
    played: 'hold',
    residual: -0.02,
    optionsAtTick: () => [
      { id: 'hold', value: 0.2 },
      { id: 'hunt', value: 0.5 }
    ]
  });
  assert(noise.kind === 'exec', 'a residual inside the margin leaves 18.6 alone');

  // Wrong picture AND the wrong option on top of it: that is not perception.
  const flipped = attributeDrop({
    drop: { tick: 20, drop: 0.3 },
    played: 'hold',
    residual: -0.29,
    optionsAtTick: () => [
      { id: 'hold', value: 0.4 },
      { id: 'rotate', value: 0.1 }
    ],
    trueOptionsAtTick: () => [
      { id: 'hold', value: 0.05 },
      { id: 'rotate', value: 0.6 }
    ]
  });
  assert(flipped.kind !== 'perc', 'a flipped ranking is not perception');
  assert(flipped.kind === 'call', 'it played its believed best, so the call owns it');
}

{
  // The walk runs on the TRUE timeline: the believed one never dips.
  const rows = [
    { tick: 0, situation: 'k', pWin_belief: 0.72, pWin_true: 0.7, residual: -0.02 },
    { tick: 64, situation: 'k', pWin_belief: 0.74, pWin_true: 0.68, residual: -0.06 },
    { tick: 128, situation: 'k', pWin_belief: 0.75, pWin_true: 0.31, residual: -0.44 },
    { tick: 192, situation: 'k', pWin_belief: 0.7, pWin_true: 0.28, residual: -0.42 }
  ];
  const r = reviewRound({
    rows,
    k: 1,
    played: 'a-execute',
    optionsAtTick: () => [
      { id: 'a-execute', value: 0.5 },
      { id: 'b-split', value: 0.45 }
    ]
  });
  assert(r.drops[0].tick === 128, 'the true timeline says where the round went');
  assert(r.percLosses === 1 && r.callLosses === 0, 'and the loss is perception, not the call');
  assert(r.calibrations.get('k').n === 4, 'every graded row feeds the bias');
  assert(r.calibrations.get('k').mean < 0, 'this picture runs overconfident');
  assert(r.residuals.mae > 0.2, 'and it is not close');
  assert(r.believed.length === 4 && r.truth.length === 4, 'both curves come back for the inspector');
}

console.log('review: ok');
