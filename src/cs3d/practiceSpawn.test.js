// Run: node src/cs3d/practiceSpawn.test.js

import { cycleSpawnIndex, formatSpawnChat } from './practiceSpawn.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

assert(cycleSpawnIndex(-1, 5) === 0, 'first N lands on spawn 1');
assert(cycleSpawnIndex(0, 5) === 1, 'next');
assert(cycleSpawnIndex(4, 5) === 0, 'wraps');
assert(cycleSpawnIndex(0, 0) === 0, 'empty list');
assert(formatSpawnChat('T', 2, 5) === 'T spawn 3/5', '1-based chat');
assert(formatSpawnChat('CT', 0, 4) === 'CT spawn 1/4', 'CT');

console.log('practiceSpawn.test.js ok');
