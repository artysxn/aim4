// Run: node src/cs3d/bootScreen.test.js

import { packProgress } from './bootScreen.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const mid = packProgress({
  phase: 'geo',
  bytesLoaded: 5e6,
  bytesTotal: 10e6,
  texBytesLoaded: 0,
  texBytesTotal: 0,
  groupsLoaded: 2,
  groupsTotal: 4,
  texLoaded: 0,
  texTotal: 0
});
assert(mid.pct === 50, `mid pct ${mid.pct}`);
assert(mid.label === '5 / 10 MB', mid.label);
assert(!mid.done, 'not done mid-stream');

const done = packProgress({
  phase: 'geo',
  bytesLoaded: 10e6,
  bytesTotal: 10e6,
  texBytesLoaded: 0,
  texBytesTotal: 0,
  groupsLoaded: 4,
  groupsTotal: 4,
  texLoaded: 0,
  texTotal: 0
});
assert(done.done, 'geo-only pack is done');

const phys = packProgress({
  phase: 'phys',
  bytesLoaded: 0,
  bytesTotal: 0,
  texBytesLoaded: 0,
  texBytesTotal: 0,
  groupsLoaded: 0,
  groupsTotal: 0,
  texLoaded: 0,
  texTotal: 0
});
assert(phys.label === 'collision', phys.label);
assert(!phys.done, 'phys is not done');

console.log('bootScreen.test.js: ok');
