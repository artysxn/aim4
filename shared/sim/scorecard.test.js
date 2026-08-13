// Run: node shared/sim/scorecard.test.js

import {
  percentile,
  median,
  softMin,
  bandScore,
  scorecard,
  correctionTerm,
  fourVerdicts,
  FROZEN_REFS
} from './scorecard.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  assert(percentile(5, [1, 2, 3, 4, 5]) === 1, 'top of the pop is 100th');
  assert(percentile(1, [1, 2, 3, 4, 5]) === 0.2, 'bottom is 20th of five');
  assert(median([1, 2, 9]) === 2, 'median');
  assert(softMin([0.9, 0.8, 0.1, 0.7, 0.6], 0.2) === 0.1, 'soft min is the 20th, not the mean');
  assert(bandScore(0.5, 0.4, 0.6) === 1, 'inside the band is 1');
  assert(bandScore(0, 0.4, 0.6) < 1, 'outside falls off');
}

{
  const card = scorecard(
    { mechanics: 0.5, duel: 0.5, utility: 0.5, teamwork: 0.5, macro: 0.5, information: 0.5, objective: 0.5, discipline: 0.5, doctrine: 0.9 },
    {}
  );
  assert(card.library === 'not available', 'missing library is stated, not invented');
  assert(card.doctrine === 0.9, 'doctrine stays on its own axis');
}

{
  const cand = { overall: 0.55 };
  const bc0 = { overall: 0.5 };
  const c = correctionTerm(cand, bc0);
  assert(/correction/.test(c.stated), 'the shift is a stated correction term');
}

{
  const v = fourVerdicts({
    eloDelta: 40,
    card: { overall: 0.55, axes: { mechanics: 0.5 } },
    honesty: { belief: true, aim: true, ks: true, determinism: true },
    exploitability: 0.4,
    examRegret: 0.02,
    contractPass: true
  });
  assert(v.strength.name === 'Strength' && v.quality.name === 'Quality', 'four named verdicts');
  assert(v.honesty.name === 'Honesty' && v.robustness.name === 'Robustness', 'never merged');
  assert(v.strength.pass && v.honesty.pass, 'this candidate is green');
}

{
  const broke = fourVerdicts({
    eloDelta: 80,
    card: { overall: 0.7, axes: {} },
    honesty: {},
    contractPass: false
  });
  assert(broke.strength.pass, 'the role-breaker can win on Elo');
  assert(!broke.quality.pass, 'and still fail Quality because of the contract gate');
}

{
  assert(FROZEN_REFS.includes('bc0') && FROZEN_REFS.includes('desire') && FROZEN_REFS.includes('scripted'), 'frozen refs');
}

console.log('scorecard: ok');
