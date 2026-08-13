// Run: node shared/sim/avoidSet.test.js

import { ExperienceIndex } from './experience.js';
import { reweightAvoid, applyAvoidPriors } from './avoidSet.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const idx = new ExperienceIndex();
  idx.seedPrior('sit', { n: 20, w: 12 });
  for (let i = 0; i < 12; i += 1) {
    idx.write({ key: 'sit', call: 'a-default', won: false, attrib: 'call', scopes: ['career'] });
  }
  const cands = [
    { id: 'a-default', score: 0.5 },
    { id: 'b-rush', score: 0.5 }
  ];
  const out = reweightAvoid(cands, { index: idx, key: 'sit' });
  assert(out.length === 2, 'avoidance never drops a candidate');
  assert(out.find((c) => c.id === 'a-default').penalty > 0, 'the losing call is penalized');
}

{
  const idx = new ExperienceIndex();
  idx.seedPrior('sit', { n: 20, w: 12 });
  for (let i = 0; i < 12; i += 1) {
    idx.write({ key: 'sit', call: 'a-default', won: false, attrib: 'exec', scopes: ['career'] });
  }
  const out = reweightAvoid(
    [
      { id: 'a-default', score: 0.5 },
      { id: 'b-rush', score: 0.5 }
    ],
    { index: idx, key: 'sit' }
  );
  assert(out.find((c) => c.id === 'a-default').penalty === 0, 'execution losses do not move the call');
}

{
  const cands = [{ id: 'a-default', prior: 1 }, { id: 'b-rush', prior: 1 }];
  applyAvoidPriors(cands, [
    { id: 'a-default', penalty: 1 },
    { id: 'b-rush', penalty: 0 }
  ]);
  assert(cands.length === 2, 'still two');
  assert(cands[0].prior < cands[1].prior, 'reweight, never mask');
}

console.log('avoidSet: ok');
