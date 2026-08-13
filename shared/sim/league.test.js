// Run: node shared/sim/league.test.js

import { Rng } from './rng.js';
import {
  EXPLOITER_RESET,
  ROLE,
  exploiterShouldReset,
  exploitabilityGate,
  pfspWeight,
  pickOpponent,
  poolEntry,
  samplePfsp
} from './league.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  assert(pfspWeight(0) > pfspWeight(0.5), 'an unbeaten opponent is sampled more');
  assert(pfspWeight(0.5) > pfspWeight(0.9), 'a punching bag is sampled less');
  assert(pfspWeight(1) === 0, 'a guaranteed win is never sampled');
}

{
  const rng = new Rng(7);
  const counts = { hard: 0, easy: 0 };
  for (let i = 0; i < 400; i += 1) {
    const id = samplePfsp(rng, ['hard', 'easy'], { hard: 0.45, easy: 0.9 });
    counts[id] += 1;
  }
  assert(counts.hard > counts.easy, `PFSP prefers hard-but-beatable (${counts.hard} vs ${counts.easy})`);
}

{
  const rng = new Rng(3);
  const vsMain = pickOpponent({
    role: ROLE.MAIN_EXPLOITER,
    selfId: 'ex1',
    mainId: 'gen4',
    pool: ['gen4', 'gen3', 'ex1'],
    rng
  });
  assert(vsMain.opponent === 'gen4' && vsMain.kind === 'main', 'main exploiters only fight the main');

  let self = 0;
  for (let i = 0; i < 200; i += 1) {
    const p = pickOpponent({
      role: ROLE.MAIN,
      selfId: 'gen4',
      mainId: 'gen4',
      pool: ['gen4', 'gen3', 'bc0'],
      winRates: { gen3: 0.55, bc0: 0.7 },
      rng
    });
    if (p.kind === 'self') self += 1;
  }
  assert(self > 40 && self < 120, `main self-play is about 35% (${self}/200)`);
}

{
  const win = exploiterShouldReset({ winRateVsMain: EXPLOITER_RESET, steps: 10, budget: 100 });
  assert(win.reset, 'a successful exploiter resets to BC');
  const spent = exploiterShouldReset({ winRateVsMain: 0.4, steps: 100, budget: 100 });
  assert(spent.reset && /budget/.test(spent.reason), 'a spent budget also resets');
  const hunt = exploiterShouldReset({ winRateVsMain: 0.4, steps: 10, budget: 100 });
  assert(!hunt.reset, 'otherwise it keeps hunting');
}

{
  const ok = exploitabilityGate(0.54);
  assert(ok.pass, ok.reason);
  const frag = exploitabilityGate(0.85);
  assert(!frag.pass, frag.reason);
}

{
  const e = poolEntry({ id: 'ex1', role: ROLE.MAIN_EXPLOITER, shipped: true });
  assert(e.shipped === false, 'exploiters are never shipped even if flagged');
  const m = poolEntry({ id: 'gen1', role: ROLE.MAIN, shipped: true });
  assert(m.shipped === true, 'mains may ship');
}

console.log('league: ok');
