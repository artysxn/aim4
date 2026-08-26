import assert from 'node:assert/strict';
import {
  filterNeedsRounds,
  rowHasAnyRoundTag,
  rowHasRoundTag,
  rowPasses
} from './statsMath.js';

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

// Multi-select: any selected own/opp key matches.
assert.equal(
  rowHasAnyRoundTag(row, 'T', ['default', 'a-fake']),
  true,
  'any-of own tags'
);
assert.equal(
  rowPasses(row, { side: 'T', roundOwn: ['default', 'a-fake'] }, 1),
  true,
  'OR across selected own rounds'
);
assert.equal(
  rowPasses(row, { side: 'T', roundOwn: ['default', 'ramp-rush'] }, 1),
  false,
  'OR still fails when none match'
);
assert.equal(
  rowPasses(row, { side: 'T', roundOpp: ['default', 'lobby-crunch'] }, 1),
  true,
  'OR across selected vs rounds'
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

// ---- which filters can only be answered from a round ----------------------
//
// Everything above reads `row.rl`. The server's aggregate does not carry it, so
// a caller has to know to stay off that endpoint: this predicate is that answer,
// and a filter that slips out of it comes back UNFILTERED rather than refused.
assert.equal(filterNeedsRounds({}), false, 'the default filter is answerable');
assert.equal(filterNeedsRounds(), false);
assert.equal(
  filterNeedsRounds({ maps: ['NUK'], side: 'T', econ: 4, result: 'won', hasAwp: true }),
  false,
  'map, side, buy, result and AWP are all one line per round'
);
assert.equal(filterNeedsRounds({ roundOwn: ['a-fake'] }), true);
assert.equal(filterNeedsRounds({ roundOwn: 'a-fake' }), true, 'a bare string counts');
assert.equal(filterNeedsRounds({ roundOpp: ['lobby-crunch'] }), true);
assert.equal(filterNeedsRounds({ fromSec: 0 }), true, 'zero is a window, not absent');
assert.equal(filterNeedsRounds({ toSec: 35 }), true);
assert.equal(
  filterNeedsRounds({ roundOwn: [], roundOpp: [], fromSec: null, toSec: null }),
  false,
  'cleared is not set'
);

console.log('statsMath.roundTags.test.js ok');
