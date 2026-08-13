// Run: node shared/sim/situationKey.test.js

import { situationKey, clockBucket, shapeFromCore } from './situationKey.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  assert(clockBucket(75) === '60-80', '20 s buckets');
  const a = situationKey({ map: 'INF', side: 'CT', phase: 'pre-plant', secondsLeft: 75, ours: 4, theirs: 5 });
  const b = situationKey({ map: 'INF', side: 'CT', phase: 'pre-plant', secondsLeft: 71, ours: 4, theirs: 5 });
  assert(a.hash === b.hash, 'the same sentence hashes the same');
  const c = situationKey({ map: 'INF', side: 'CT', phase: 'pre-plant', secondsLeft: 75, ours: 3, theirs: 5 });
  assert(a.hash !== c.hash, 'a man-count change is a new key');
}

{
  assert(shapeFromCore({ size: 4, lurkers: ['x'] }) === 'core4,lurk1', 'core+lurk');
  assert(shapeFromCore({ size: 0, lurkers: [] }) === 'spread', 'no core is a spread');
}

console.log('situationKey: ok');
