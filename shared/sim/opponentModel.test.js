// Run: node shared/sim/opponentModel.test.js

import { Rng } from './rng.js';
import {
  TendencyTracker,
  Exp3Bandit,
  banditKey,
  econBucket,
  mixPolicyExp3,
  playExploitableMatch,
  TELL_MIN_ROUNDS
} from './opponentModel.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  assert(econBucket(800) === 'eco' && econBucket(5000) === 'full', 'economy buckets');
  assert(banditKey({ side: 'CT', econ: 'full', score: 'even' }) === 'CT|full|even', 'bandit key');
}

{
  const t = new TendencyTracker();
  t.observe({ site: 'b', firstContactSeconds: 18, lurkSeen: true, buy: 'full' });
  t.observe({ site: 'b', firstContactSeconds: 22, lurkSeen: false, buy: 'full' });
  const s = t.summary();
  assert(s.pSite.b > s.pSite.a, 'the tracker saw B');
  assert(s.evidence === 2, 'and says how few rounds that is');
}

{
  const t = new TendencyTracker();
  t.observe({ site: 'a' });
  t.applyScan({
    sides: {
      T: {
        tells: [{ label: 'b-split', rounds: TELL_MIN_ROUNDS, share: 90, name: 'smoke' }]
      }
    }
  });
  assert(t.summary().pSite.b > t.summary().pSite.a, 'a scan tell overwrites the tracker');
  assert(t.scan.evidence >= TELL_MIN_ROUNDS, 'with its evidence count');
}

{
  const rng = new Rng(3);
  const b = new Exp3Bandit();
  const key = 'CT|full|even';
  const ids = ['a-default', 'b-rush'];
  b.reward(key, 'a-default', 0);
  b.reward(key, 'a-default', 0);
  b.reward(key, 'b-rush', 1);
  b.reward(key, 'b-rush', 1);
  assert(b.weight(key, 'b-rush') > b.weight(key, 'a-default'), 'wins raise the arm');
  const p = b.probabilities(key, ids);
  assert(p[1] > p[0], 'so B is sampled more');
  const drawn = b.sample(key, ids, rng);
  assert(ids.includes(drawn.id), 'sample returns a legal id');
}

{
  const rng = new Rng(9);
  const bandit = new Exp3Bandit();
  const cands = [{ id: 'a' }, { id: 'b' }];
  const pick = mixPolicyExp3(cands, {
    policyPick: cands[0],
    bandit,
    key: 'k',
    rng,
    idOf: (c) => c.id
  });
  assert(cands.includes(pick), 'mix returns a candidate');
}

{
  let weightsMoved = 0;
  let wrMoved = 0;
  for (let seed = 1; seed <= 30; seed += 1) {
    const m = playExploitableMatch(new Rng(seed), { rounds: 24 });
    if (m.weightB > m.weightA) weightsMoved += 1;
    if (m.secondHalf > m.firstHalf) wrMoved += 1;
  }
  assert(weightsMoved >= 25, `B weight rose on ${weightsMoved}/30 seeds`);
  assert(wrMoved >= 18, `second half WR beat first on ${wrMoved}/30 seeds`);
  const shown = playExploitableMatch(new Rng(1), { rounds: 24 });
  console.log(
    `EXP3 24-round (seed 1): first ${shown.firstHalf.toFixed(2)} second ${shown.secondHalf.toFixed(2)} wB/wA ${(shown.weightB / shown.weightA).toFixed(2)}`
  );
}

console.log('opponentModel: ok');
