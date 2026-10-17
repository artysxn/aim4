// Run: node src/replays/training/opinions.test.js
//
// The opinion rules against a hand-made report: facts as the antistrat
// summary attaches them to its lines, nested the way the sheet nests them.

import assert from 'node:assert/strict';
import { factsOf, opinionsFrom } from './opinions.js';

const spots = {
  kind: 'spots',
  id: 'dy',
  name: 'dytor',
  role: 'A Anchor',
  n: 30,
  spots: [
    {
      pos: 'Close sandbags',
      share: 60,
      n: 18,
      files: ['s1', 's2'],
      tells: [{ kind: 'utility', words: 'Niko smoke', share: 85, hits: 17, of: 18, files: ['s1'] }]
    }
  ],
  files: ['s1', 's2', 's3']
};
const anchor = {
  kind: 'anchor',
  id: 'dy',
  name: 'dytor',
  role: 'A Anchor',
  n: 40,
  share: 90,
  smoke: 5,
  molo: 88,
  both: 3,
  spots: [{ name: 'Banana molo', share: 85 }],
  files: ['a1']
};
const lurk = {
  kind: 'lurk',
  id: 'lk',
  name: 'volt',
  n: 10,
  basis: 60,
  area: 'B',
  push: { n: 6, where: 'Banana', clock: '1:20', before: 5, won: 4 },
  rotate: null,
  stay: 2,
  died: 2,
  files: ['l1']
};
const core = {
  kind: 'core',
  area: 'A',
  n: 20,
  basis: 60,
  clock: '1:30',
  size: 4,
  others: [{ area: 'B', nobody: 85, spots: [], does: { hold: 2, push: 1 }, joins: 0, files: ['c1'] }],
  files: ['c0']
};
const reactive = {
  kind: 'reactive',
  group: 'spot',
  words: 'Library molo',
  label: 'Library',
  type: 'molotov',
  thrower: '',
  n: 8,
  reactive: 8,
  hits: 2,
  deaths: 4,
  util: 6,
  after: { does: 'still', n: 3, of: 4 },
  single: { flashbang: 3 },
  files: ['r1']
};

// Facts sit on lines, inside parts and sub lines, anywhere under sides.
const report = {
  sides: {
    T: { lurks: { lurks: [{ text: 'volt lurks', fact: lurk }], core: [{ text: 'Core', fact: core, sub: [] }] } },
    CT: {
      positions: [{ name: 'dytor', sub: [{ text: 'At 1:30', fact: spots }] }],
      defaults: { rows: [], anchors: [{ text: 'dytor uses', fact: anchor }] },
      reactive: { lines: [{ text: 'Library molo', fact: reactive }] }
    }
  }
};

assert.deepEqual(
  factsOf(report).map((f) => f.kind).sort(),
  ['anchor', 'core', 'lurk', 'reactive', 'spots']
);

const byRule = Object.fromEntries(opinionsFrom(report).map((o) => [o.rule, o]));

// The user's own example: always on one spot, never a smoke -> molotov it.
assert.ok(byRule['anchor-pinned'], 'an anchor pinned to one spot without a smoke');
assert.match(byRule['anchor-pinned'].text, /dytor .* Close sandbags .* 60% .* only 5%, .* molotov on Close sandbags/);
assert.equal(byRule['anchor-pinned'].because.length, 2, 'built from two facts');
assert.deepEqual(byRule['anchor-pinned'].files, ['s1', 's2', 'a1'], 'the rounds of both facts');

assert.match(byRule['anchor-spent'].text, /Banana molo out by 1:35 in 85% .* a hit on A after 1:20/);
assert.match(byRule['spot-tell'].text, /When dytor is Close sandbags at 1:30, Niko smoke comes with it in 85%/);
assert.match(byRule['lurk-aggressive'].text, /lurker on the B side, volt, goes at Banana himself before the hit \(5 of 10/);
assert.equal(byRule['lurk-leaves'], undefined, 'he never rotates, so nothing about leaving');
assert.match(byRule['core-empty'].text, /core shows itself on the A side, the B side is empty in 85%/);
assert.equal(byRule['core-pushers'], undefined, 'one push out of three is not a pattern');
assert.match(byRule['reactive-bait'].text, /Library molo only comes as an answer \(8 of 8\), and a flash on its own sets it off 3 times/);
assert.match(byRule['reactive-still'].text, /team holds still \(3 of 4\)/);

// Thin facts give no opinions.
const thin = {
  sides: {
    CT: {
      positions: [{ sub: [{ fact: { ...spots, spots: [{ ...spots.spots[0], share: 20, tells: [{ ...spots.spots[0].tells[0], of: 3 }] }] } }] }],
      defaults: { anchors: [{ fact: { ...anchor, share: 70, smoke: 40 } }] }
    }
  }
};
assert.deepEqual(opinionsFrom(thin), []);

console.log('opinions.test.js ok');
