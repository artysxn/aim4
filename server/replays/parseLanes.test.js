// ---------------------------------------------------------------------------
// server/replays/parseLanes.test.js
//   node --test server/replays/parseLanes.test.js
//
// The parse queue's fairness, plus the concurrency derivation it feeds. The
// scheduler is pure on purpose (see parseLanes.js) so the ORDER can be proved
// here without forking a single parser.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLanes } from './parseLanes.js';
import { deriveParseConcurrency } from './hostMemory.js';

/** Drain a lane set into a flat list of items, in served order. */
function drain(lanes) {
  const out = [];
  for (let item = lanes.next(); item !== null; item = lanes.next()) out.push(item);
  return out;
}

test('a bulk drop cannot park another uploader behind all of it', () => {
  const lanes = createLanes();
  for (let i = 1; i <= 20; i++) lanes.push('alice', `a${i}`);
  lanes.push('bob', 'b1');

  const served = drain(lanes);
  assert.equal(served.length, 21, 'every queued demo is still served');
  assert.equal(served[0], 'a1', 'whoever queued first still goes first');
  // The single upload waits one parse, not twenty.
  assert.equal(served[1], 'b1');
  assert.deepEqual(served.slice(2, 5), ['a2', 'a3', 'a4']);
});

test('three uploaders take turns', () => {
  const lanes = createLanes();
  for (const who of ['a', 'b', 'c']) {
    lanes.push(who, `${who}1`);
    lanes.push(who, `${who}2`);
  }
  assert.deepEqual(drain(lanes), ['a1', 'b1', 'c1', 'a2', 'b2', 'c2']);
});

test('within one lane, order is the order queued', () => {
  const lanes = createLanes();
  lanes.push('solo', 'first');
  lanes.push('solo', 'second');
  lanes.push('solo', 'third');
  assert.deepEqual(drain(lanes), ['first', 'second', 'third']);
});

test('a lane that drained and refills goes to the back, not where it was', () => {
  const lanes = createLanes();
  lanes.push('a', 'a1');
  lanes.push('b', 'b1');
  assert.equal(lanes.next(), 'a1');
  // a is empty now; queueing to it again must not let it cut ahead of b,
  // whose turn it is.
  lanes.push('a', 'a2');
  assert.equal(lanes.next(), 'b1');
  assert.equal(lanes.next(), 'a2');
});

test('a requeued retry goes next, not to the back of the whole queue', () => {
  const lanes = createLanes();
  lanes.push('a', 'a1');
  lanes.push('b', 'b1');
  lanes.push('b', 'b2');
  const retried = lanes.next(); // a1 starts, then its worker is killed
  assert.equal(retried, 'a1');
  lanes.requeue('a', retried);
  // It already waited its turn once; the failure was the host's, not the
  // demo's, so it is not charged the queue again.
  assert.deepEqual(drain(lanes), ['a1', 'b1', 'b2']);
});

test('size counts across lanes and next() on empty returns null', () => {
  const lanes = createLanes();
  assert.equal(lanes.size(), 0);
  assert.equal(lanes.next(), null);
  lanes.push('a', 'a1');
  lanes.push('b', 'b1');
  assert.equal(lanes.size(), 2);
  lanes.next();
  assert.equal(lanes.size(), 1);
});

test('parse concurrency scales with the box and never below one', () => {
  const derive = (availableMb, cpus) => deriveParseConcurrency({ availableMb, cpus, env: '' });
  // The host this shipped on first: one parse, exactly as before.
  assert.equal(derive(4096, 2), 1);
  assert.equal(derive(2048, 1), 1);
  // Memory there but only one core: the API keeps its core.
  assert.equal(derive(16384, 1), 1);
  // Cores there but no memory: each worker needs its footprint.
  assert.equal(derive(2048, 8), 1);
  // A box that can actually hold more, does more.
  assert.equal(derive(8192, 4), 3);
  // The disk cap: past four, the volume is the queue.
  assert.equal(derive(65536, 16), 4);
  // A fractional cgroup CPU quota must not derive zero.
  assert.equal(derive(8192, 0.5), 1);
});

test('AIM4_PARSE_CONCURRENCY overrides the derivation, clamped', () => {
  assert.equal(deriveParseConcurrency({ availableMb: 2048, cpus: 1, env: '3' }), 3);
  assert.equal(deriveParseConcurrency({ availableMb: 65536, cpus: 16, env: '1' }), 1);
  assert.equal(deriveParseConcurrency({ availableMb: 2048, cpus: 1, env: '99' }), 8);
  // Nonsense in the env falls back to deriving.
  assert.equal(deriveParseConcurrency({ availableMb: 8192, cpus: 4, env: 'lots' }), 3);
  assert.equal(deriveParseConcurrency({ availableMb: 8192, cpus: 4, env: '0' }), 3);
});
