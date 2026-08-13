// Run: node shared/sim/search.test.js

import { Rng } from './rng.js';
import { decisionSearch, ExpertIterLog } from './search.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const cands = [{ id: 'hold' }, { id: 'hunt' }];

{
  const off = decisionSearch({ candidates: cands, policyPick: cands[0], enabled: false });
  assert(off.pick === cands[0], 'off during bulk RL, policy stands');
  assert(off.evaluations === 0, 'and it does not evaluate');
}

{
  const rng = new Rng(2);
  const out = decisionSearch({
    candidates: cands,
    policyPick: cands[0],
    evaluate: (c) => (c.id === 'hunt' ? 1 : 0),
    sampleLayouts: () => [{}, {}],
    K: 8,
    rng,
    obs: [0, 1],
    mask: new Set(['hold', 'hunt']),
    now: () => 0
  });
  assert(out.pick.id === 'hunt', 'search prefers the better leaf');
  assert(out.disagreement, 'and logs the policy disagreement');
  assert(out.disagreement.policy === 'hold' && out.disagreement.search === 'hunt', 'named');
  const log = new ExpertIterLog();
  log.push(out.disagreement);
  const lines = log.toJSONL();
  assert(lines.length === 1, 'distillable as JSONL');
  const row = JSON.parse(lines[0]);
  assert(row.obs && row.dist.length === 2, 'obs, mask, dist');
}

{
  let t = 0;
  const out = decisionSearch({
    candidates: cands,
    evaluate: () => 0,
    K: 32,
    maxMs: 1,
    now: () => {
      t += 2;
      return t;
    }
  });
  assert(out.timedOut, 'the millisecond cap fires');
  assert(out.evaluations < 32, `and stops early (${out.evaluations})`);
}

console.log('search: ok');
