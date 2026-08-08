import assert from 'node:assert/strict';
import { rowHasRoundTag, rowPasses } from './statsMath.js';

const row = {
  f: 'r1',
  d: 'demo1',
  m: 'NUK',
  s1: 'T',
  s2: 'CT',
  e1: 4,
  e2: 4,
  w: 1,
  rl: {
    v: 3,
    t: [{ k: 'a-fake', m: {} }],
    ct: [{ k: 'lobby-crunch', m: {} }]
  }
};

assert.equal(rowHasRoundTag(row, 'T', 'a-fake'), true);
assert.equal(rowHasRoundTag(row, 'T', 'default'), false);
assert.equal(rowHasRoundTag(row, 'CT', 'lobby-crunch'), true);
assert.equal(rowHasRoundTag(row, 'CT', 'a-fake'), false);
assert.equal(rowHasRoundTag(row, 'T', ''), true, 'empty key always passes');

// Subject team 1 on T: own = a-fake, opp = lobby-crunch
assert.equal(
  rowPasses(row, { side: 'T', roundOwn: 'a-fake' }, 1),
  true,
  'T side running a-fake'
);
assert.equal(
  rowPasses(row, { side: 'T', roundOwn: 'default' }, 1),
  false,
  'T side not running default'
);
assert.equal(
  rowPasses(row, { side: 'T', roundOpp: 'lobby-crunch' }, 1),
  true,
  'T side facing lobby-crunch'
);
assert.equal(
  rowPasses(row, { side: 'T', roundOwn: 'a-fake', roundOpp: 'lobby-crunch' }, 1),
  true,
  'both own and vs must match'
);
assert.equal(
  rowPasses(row, { side: 'T', roundOwn: 'a-fake', roundOpp: 'default' }, 1),
  false,
  'vs miss rejects when both set'
);

// Subject team 2 on CT
assert.equal(
  rowPasses(row, { side: 'CT', roundOwn: 'lobby-crunch' }, 2),
  true,
  'CT side running lobby-crunch'
);
assert.equal(
  rowPasses(row, { side: 'CT', roundOpp: 'a-fake' }, 2),
  true,
  'CT side facing a-fake'
);
assert.equal(
  rowPasses(row, { side: 'CT', roundOwn: 'a-fake' }, 2),
  false,
  'CT side did not run a-fake'
);

console.log('statsMath.roundTags.test.js ok');
