// Run: node src/replays/shared/matchSides.test.js
import assert from 'node:assert/strict';
import { formatMatchScore, orientMatchSides } from './matchSides.js';

const alliance = { id: 'alli', name: 'Alliance' };
const fnatic = { id: 'fntc', name: 'fnatic' };
const nexus = { id: 'nxus', name: 'Nexus' };
const focus = { focusIds: ['alli', 'alliance'], focusName: 'Alliance' };

const asHome = orientMatchSides({
  left: alliance,
  right: fnatic,
  scoreLeft: 13,
  scoreRight: 4,
  ...focus
});
assert.equal(asHome.left.name, 'Alliance');
assert.equal(asHome.right.name, 'fnatic');
assert.equal(asHome.scoreLeft, 13);
assert.equal(asHome.scoreRight, 4);

const asAway = orientMatchSides({
  left: nexus,
  right: alliance,
  scoreLeft: 13,
  scoreRight: 9,
  ...focus
});
assert.equal(asAway.left.name, 'Alliance', 'focused team moves to the left');
assert.equal(asAway.right.name, 'Nexus');
assert.equal(asAway.scoreLeft, 9, 'left score belongs to the left team');
assert.equal(asAway.scoreRight, 13);

const noFocus = orientMatchSides({
  left: nexus,
  right: alliance,
  scoreLeft: 13,
  scoreRight: 9
});
assert.equal(noFocus.left.name, 'Nexus', 'no team filter keeps original order');
assert.equal(noFocus.right.name, 'Alliance');
assert.equal(noFocus.scoreLeft, 13);

const twoIdsNoName = orientMatchSides({
  left: fnatic,
  right: alliance,
  scoreLeft: 16,
  scoreRight: 13,
  focusIds: ['alli']
});
assert.equal(twoIdsNoName.left.name, 'Alliance');
assert.equal(twoIdsNoName.scoreLeft, 13);

const byNameOnly = orientMatchSides({
  left: fnatic,
  right: { id: 'other', name: 'Alliance' },
  scoreLeft: 4,
  scoreRight: 13,
  focusName: 'Alliance'
});
assert.equal(byNameOnly.left.name, 'Alliance');
assert.equal(byNameOnly.scoreLeft, 13);

const bothMatch = orientMatchSides({
  left: alliance,
  right: { id: 'alli2', name: 'Alliance' },
  scoreLeft: 1,
  scoreRight: 2,
  ...focus
});
assert.equal(bothMatch.left.id, 'alli', 'left already matching is left alone');
assert.equal(bothMatch.scoreLeft, 1);

const neither = orientMatchSides({
  left: fnatic,
  right: nexus,
  scoreLeft: 10,
  scoreRight: 11,
  ...focus
});
assert.equal(neither.left.name, 'fnatic');
assert.equal(neither.scoreRight, 11);

assert.equal(formatMatchScore(9, 13), '9 - 13');
assert.equal(formatMatchScore(0, 0), '0 - 0');
assert.equal(formatMatchScore(NaN, 13), '…');

console.log('matchSides.test.js: ok');
