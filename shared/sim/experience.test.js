// Run: node shared/sim/experience.test.js

import { ExperienceIndex, wilsonLower } from './experience.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const lucky = wilsonLower(2, 2);
  const solid = wilsonLower(25, 40);
  assert(solid > lucky, `2-and-0 (${lucky.toFixed(3)}) does not outrank 40-and-25 (${solid.toFixed(3)})`);
}

{
  const idx = new ExperienceIndex();
  idx.seedPrior('k', { n: 20, w: 10 });
  idx.write({ key: 'k', call: 'b-split', won: true, attrib: 'call' });
  idx.write({ key: 'k', call: 'b-split', won: true, attrib: 'call' });
  const r = idx.read('k', 'b-split');
  assert(r.n > 2, 'the library prior is in the mix');
  assert(r.lower > 0, 'lower bound is a number');
}

{
  const idx = new ExperienceIndex({ maxRows: 2 });
  idx.write({ key: 'a', won: true, scopes: ['career'] });
  idx.write({ key: 'b', won: true, scopes: ['career'] });
  idx.write({ key: 'c', won: true, scopes: ['career'] });
  assert(idx.career.size <= 2, 'LRU caps the career shard');
}

{
  const idx = new ExperienceIndex();
  const before = idx.seq;
  idx.write({ key: 'k', won: false, attrib: 'exec' });
  assert(idx.seq === before + 1, 'recency is a seq, not a wall clock');
}

console.log('experience: ok');
