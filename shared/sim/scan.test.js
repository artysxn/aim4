// Run: node shared/sim/scan.test.js
//
// The behaviour under test is "holding an angle means checking several", and
// the two properties that make it usable in this engine: the rotation spends
// most of its time where the danger is, and it is a pure function of the tick
// so a held angle does not break the determinism gate.

import { DWELL_GLANCE, DWELL_PRIMARY, WATCH_MAX, scanOffset, scanPick, watchAngles } from './scan.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// A tiny map: the spot, two arrivals that see it, one that does not, and one
// far outside the radius.
const spot = { x: 0, y: 0, level: 'default' };
const graph = {
  anchors: new Map([
    ['ramp', { level: 'default', world: { x: 800, y: 0 } }],
    ['door', { level: 'default', world: { x: -600, y: 300 } }],
    ['behind_wall', { level: 'default', world: { x: 0, y: 700 } }],
    ['far_away', { level: 'default', world: { x: 9000, y: 0 } }],
    ['upstairs', { level: 'upper', world: { x: 300, y: 300 } }],
    ['my_feet', { level: 'default', world: { x: 40, y: 0 } }]
  ])
};
const angles = {
  canSee: (ax, ay, bx, by) => !(bx === 0 && by === 700)
};

// ---- which angles are worth holding ---------------------------------------

{
  const w = watchAngles({ graph, angles, spot });
  assert(w.includes('ramp') && w.includes('door'), `the two real arrivals are watched: ${w}`);
  assert(!w.includes('behind_wall'), 'an anchor that cannot see the spot is not an angle');
  assert(!w.includes('far_away'), 'nor is one on the other side of the map');
  assert(!w.includes('upstairs'), 'nor one on another level');
  assert(!w.includes('my_feet'), 'nor the ground the bot is standing on');
  assert(w.length <= WATCH_MAX, 'a human holds a few angles, not every angle');

  // Threat decides the order, which is the whole point: most of the rotation
  // should be spent on the door the enemy is believed to be behind.
  const threatened = watchAngles({
    graph,
    angles,
    spot,
    threatOf: (id) => (id === 'door' ? 0.9 : 0.05)
  });
  assert(threatened[0] === 'door', `the believed threat is held primary: ${threatened}`);

  const own = watchAngles({ graph, angles, spot, exclude: ['ramp'] });
  assert(!own.includes('ramp'), 'an excluded anchor stays excluded');
}

// ---- the rotation ----------------------------------------------------------

{
  const watch = ['ramp', 'door', 'window'];
  const cycle = DWELL_PRIMARY + DWELL_GLANCE * 2;

  // Every angle gets looked at, and the dangerous one gets most of it.
  const seen = new Map();
  for (let t = 0; t < cycle * 3; t += 1) {
    const a = scanPick(watch, t);
    seen.set(a, (seen.get(a) || 0) + 1);
  }
  assert(seen.size === 3, 'all three are checked across a cycle');
  const share = seen.get('ramp') / (cycle * 3);
  assert(share > 0.5 && share < 0.75, `the primary holds most of the time, not all: ${share.toFixed(2)}`);
  assert(seen.get('door') > 0 && seen.get('window') > 0, 'and the others are genuinely glanced at');

  // One angle is a stare, correctly: there is nothing to rotate between.
  assert(scanPick(['ramp'], 999) === 'ramp', 'a single arrival is simply held');
  assert(scanPick([], 5) === null, 'and no arrivals is no pre-aim, not a crash');
}

{
  // Determinism: the same tick is the same angle, always. A hold that drifted
  // with wall-clock or rng would make "same seed re-runs bit-identical" false
  // and nothing would say so.
  const watch = ['a', 'b', 'c'];
  for (const t of [0, 37, 512, 6001]) {
    assert(scanPick(watch, t) === scanPick(watch, t), 'pure in tick');
  }
  const cycle = DWELL_PRIMARY + DWELL_GLANCE * 2;
  assert(scanPick(watch, 11) === scanPick(watch, 11 + cycle), 'and periodic in the cycle');
  // Negative ticks cannot happen in a round, but a modulo that returns -1 index
  // would throw rather than misbehave visibly, so it is pinned.
  assert(scanPick(watch, -5) !== undefined, 'a negative tick still resolves');
}

{
  // Five holders on one site must not sweep in lockstep: that leaves every
  // angle unwatched at the same instant, which is worse than one bot staring.
  const watch = ['a', 'b', 'c'];
  const at = (slot) => scanPick(watch, 100, { offset: scanOffset(slot) });
  const distinct = new Set([0, 1, 2, 3, 4].map(at));
  assert(distinct.size > 1, 'slots are phase-shifted rather than synchronised');
  assert(scanOffset(0) === 0, 'and slot 0 is the unshifted reference');
}

console.log('scan: ok (arrivals that see the spot, threat first, pure in tick)');
