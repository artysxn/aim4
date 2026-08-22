// Run: node src/agents/agentBlend.test.js
//
// The locomotion blend's arithmetic, on its own.
//
// Two properties are worth pinning here rather than eyeballing on a running
// bot, because both fail in ways that still look like animation:
//
//   · The directional ring blends the two loops that BRACKET the heading. Pick
//     the wrong neighbour and a bot strafing left is blended with the loop for
//     walking backwards — legs still move, cadence is still right, and the
//     only tell is that the feet go the wrong way.
//   · The gait split is continuous through the walk→run handover. A
//     discontinuity there is a pop on one frame at one speed, which is
//     invisible unless you are looking for it and obvious once you are.

import {
  DIRS,
  AIR_DIRS,
  IDLE_SPEED,
  dirWeights,
  gaitWeights,
  wrap180
} from './agentBlend.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${msg}`);
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- wrap180 ---------------------------------------------------------------
close(wrap180(0), 0, 1e-9, 'wrap180(0)');
close(wrap180(190), -170, 1e-9, 'wrap180(190)');
close(wrap180(-190), 170, 1e-9, 'wrap180(-190)');
// The range is [−180, 180): a half turn lands on −180, not +180.
close(wrap180(540), -180, 1e-9, 'wrap180(540)');
close(wrap180(180), -180, 1e-9, 'wrap180(180)');
close(wrap180(-45), -45, 1e-9, 'wrap180(-45)');

// ---- dirWeights: exact hits --------------------------------------------------
for (const d of DIRS) {
  const w = dirWeights(DIRS, d.angle);
  assert(w.length === 1 && w[0][0] === d.key && w[0][1] === 1, `exact ${d.key} -> ${JSON.stringify(w)}`);
}

// ---- dirWeights: every heading sums to 1 and uses adjacent loops -------------
const ANGLE_OF = new Map(DIRS.map((d) => [d.key, d.angle]));
for (let a = -180; a < 180; a += 1) {
  const w = dirWeights(DIRS, a);
  const sum = w.reduce((t, [, x]) => t + x, 0);
  close(sum, 1, 1e-9, `weights sum at ${a}`);
  assert(w.every(([, x]) => x >= 0), `no negative weight at ${a}`);
  if (w.length === 2) {
    const gap = Math.abs(wrap180(ANGLE_OF.get(w[0][0]) - ANGLE_OF.get(w[1][0])));
    close(gap, 45, 1e-6, `blended loops are neighbours at ${a}`);
  }
}

// ---- dirWeights: the SIDE, which is the bug that hides ----------------------
// Halfway between n (0) and w (+90) is +45, which is nw — and never ne.
{
  const w = new Map(dirWeights(DIRS, 22.5));
  assert(w.has('n') && w.has('nw'), `+22.5 blends n/nw, got ${[...w.keys()]}`);
  close(w.get('n'), 0.5, 1e-9, '+22.5 n weight');
  close(w.get('nw'), 0.5, 1e-9, '+22.5 nw weight');
}
{
  const w = new Map(dirWeights(DIRS, -22.5));
  assert(w.has('n') && w.has('ne'), `-22.5 blends n/ne, got ${[...w.keys()]}`);
}
// Straight left is 'w' and straight right is 'e', not the other way round.
assert(dirWeights(DIRS, 90)[0][0] === 'w', 'yaw +90 is w');
assert(dirWeights(DIRS, -90)[0][0] === 'e', 'yaw -90 is e');

// ---- the air ring is 90°-spaced and behaves the same ------------------------
for (let a = -180; a < 180; a += 3) {
  const w = dirWeights(AIR_DIRS, a);
  close(w.reduce((t, [, x]) => t + x, 0), 1, 1e-9, `air weights sum at ${a}`);
  assert(w.every(([k]) => AIR_DIRS.some((d) => d.key === k)), `air keys at ${a}`);
}

// ---- gaitWeights ------------------------------------------------------------
const RUN = 215;
const WALK_SCALE = 0.52;
const WALK = RUN * WALK_SCALE;
{
  const g = gaitWeights(0, RUN, WALK_SCALE);
  assert(g.idle === 1 && g.walk === 0 && g.run === 0, 'still is idle');
  assert(g.crouchMove === 0, 'still does not crouch-walk');

  const still = gaitWeights(IDLE_SPEED, RUN, WALK_SCALE);
  assert(still.idle === 1, 'at IDLE_SPEED exactly, still idle');

  const fast = gaitWeights(RUN + 50, RUN, WALK_SCALE);
  assert(fast.run === 1 && fast.walk === 0 && fast.idle === 0, 'over top speed is all run');
  assert(fast.crouchMove === 1, 'over top speed crouch-walks fully');
}
// Continuous everywhere, and the three stand weights always sum to 1.
{
  let prev = null;
  for (let s = 0; s <= RUN + 20; s += 0.5) {
    const g = gaitWeights(s, RUN, WALK_SCALE);
    close(g.idle + g.walk + g.run, 1, 1e-9, `stand weights sum at ${s}`);
    assert(g.idle >= 0 && g.walk >= 0 && g.run >= 0, `no negative gait weight at ${s}`);
    if (prev) {
      const jump = Math.max(Math.abs(g.idle - prev.idle), Math.abs(g.walk - prev.walk), Math.abs(g.run - prev.run));
      assert(jump < 0.05, `gait is continuous at ${s} (jumped ${jump.toFixed(3)})`);
    }
    prev = g;
  }
}
// The handover points are where the names say they are.
{
  const atWalk = gaitWeights(WALK, RUN, WALK_SCALE);
  close(atWalk.walk, 1, 1e-6, 'walk reference is pure walk');
  const atRun = gaitWeights(RUN, RUN, WALK_SCALE);
  close(atRun.run, 1, 1e-6, 'run reference is pure run');
}
// A slower weapon reaches its run sooner: the same 150 u/s is a run with an
// AWP (200) and still a walk with a knife (250).
{
  const awp = gaitWeights(150, 200, WALK_SCALE);
  const knife = gaitWeights(150, 250, WALK_SCALE);
  assert(awp.run > knife.run, `slower weapon runs sooner (${awp.run} vs ${knife.run})`);
}

if (failures) {
  console.error(`agentBlend.test.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('agentBlend.test.js: ok');
