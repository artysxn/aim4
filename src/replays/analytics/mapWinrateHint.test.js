import { strict as assert } from 'node:assert';
import {
  mapWinrateCompareKind,
  mapWinrateGapSpan,
  mapWinrateHint
} from './mapWinrateHint.js';

assert.equal(mapWinrateCompareKind(50, 54), 'under');
assert.equal(mapWinrateCompareKind(54, 50), 'over');
assert.equal(mapWinrateCompareKind(50, 50), '');
assert.equal(mapWinrateCompareKind(null, 54), '');

assert.equal(
  mapWinrateHint(50, 54),
  "You're not winning as much as you should. Your predicted round winrate is 54.0%, that being 4.0% higher than your actual winrate at 50.0%."
);
assert.equal(
  mapWinrateHint(54, 50),
  "You're overperforming! Your real winrate is 54.0%, 4.0% higher than your predicted winrate at 50.0%."
);

assert.deepEqual(mapWinrateGapSpan(50, 54), { left: 50, width: 4 });
assert.deepEqual(mapWinrateGapSpan(56, 54), { left: 54, width: 2 });
assert.equal(mapWinrateGapSpan(50, 50), null);

console.log('mapWinrateHint.test.js: ok');
