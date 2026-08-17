// Run: node shared/sim3d/hullTrace.test.js
//
// The swept hull against triangles, and motion.js on top of it: a floor made
// of triangles must behave like flatWorld() (same landing, same glide), a wall
// must stop and slide, a knee-high step must be climbed and a hip-high one
// refused, a ceiling must block a jump, and nothing may tunnel at full run
// speed. This is the code-correctness half of CS3D-PLAN §4's parity harness;
// the demo corpus (scripts/cs3d-oracle.mjs) is the other half.

import { TICK_DT, JUMP_IMPULSE, GRAVITY, STEP_HEIGHT, HULL_HALF_WIDE, HULL_STAND } from './constants.js';
import { createPlayerState, createInput, stepPlayer, flatWorld } from './motion.js';
import { createHullTracer, triangleSoupTracer, boxTriangles, DIST_EPSILON } from './hullTrace.js';
import { sweepBoxTriangle, createSweepHit } from './sweptBox.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- sweptBox: the primitive ------------------------------------------------
{
  const hit = createSweepHit();
  // A unit box at the origin moving +x by 10 toward a wall triangle at x = 5 (in the yz plane).
  let ok = sweepBoxTriangle(0, 0, 0, 1, 1, 1, 10, 0, 0, 5, -10, -10, 5, 10, -10, 5, 0, 10, hit);
  assert(ok, 'wall ahead is hit');
  close(hit.t, 0.4, 1e-9, 'box face reaches x=5 at t=0.4');
  close(hit.nx, -1, 1e-9, 'normal faces back along the motion');
  close(hit.ny, 0, 1e-9, 'normal y');
  close(hit.nz, 0, 1e-9, 'normal z');
  // Moving away from the same wall: no hit.
  ok = sweepBoxTriangle(0, 0, 0, 1, 1, 1, -10, 0, 0, 5, -10, -10, 5, 10, -10, 5, 0, 10, hit);
  assert(!ok, 'moving away is not a hit');
  // Sliding parallel next to the wall (touching at x=4..5? no: box max x=1, wall at 5): separated, no hit.
  ok = sweepBoxTriangle(0, 0, 0, 1, 1, 1, 0, 10, 0, 5, -10, -10, 5, 10, -10, 5, 0, 10, hit);
  assert(!ok, 'sliding parallel is not a hit');
  // Touching (box max x = 5) and moving into it: hit at t = 0.
  ok = sweepBoxTriangle(4, 0, 0, 1, 1, 1, 10, 0, 0, 5, -10, -10, 5, 10, -10, 5, 0, 10, hit);
  assert(ok && hit.t <= 1e-9 && hit.depth < 1e-6, 'touching + moving in is a t=0 hit, not startsolid');
  // Touching and moving away: no hit.
  ok = sweepBoxTriangle(4, 0, 0, 1, 1, 1, -10, 0, 0, 5, -10, -10, 5, 10, -10, 5, 0, 10, hit);
  assert(!ok, 'touching + moving away is not a hit');
  // Overlapping deeply at start.
  ok = sweepBoxTriangle(5, 0, 0, 1, 1, 1, 1, 0, 0, 5, -10, -10, 5, 10, -10, 5, 0, 10, hit);
  assert(ok && hit.t === 0 && hit.depth > 0.9, `overlap reports depth (${hit.depth})`);
  // A floor triangle below, falling onto it: hit on -y motion with +y normal.
  ok = sweepBoxTriangle(0, 5, 0, 1, 1, 1, 0, -10, 0, -10, 0, -10, 10, 0, -10, 0, 0, 10, hit);
  assert(ok, 'floor is hit');
  close(hit.t, 0.4, 1e-9, 'box bottom (y=4) reaches y=0 at t=0.4');
  close(hit.ny, 1, 1e-9, 'floor normal up');
  // Missing the triangle sideways: box passes beside it.
  ok = sweepBoxTriangle(30, 5, 0, 1, 1, 1, 0, -10, 0, -10, 0, -10, 10, 0, -10, 0, 0, 10, hit);
  assert(!ok, 'a box beside the triangle never hits it');
  // Corner case: an edge-first contact (box moving diagonally into a triangle edge).
  ok = sweepBoxTriangle(-5, -5, 0, 1, 1, 1, 10, 10, 0, 0, 0, -10, 10, 0, -10, 0, 0, 10, hit);
  assert(ok, 'edge contact registers');
}

// ---- a triangle floor behaves like flatWorld -------------------------------
{
  const soup = boxTriangles([-2000, -2000, -64], [2000, 2000, 0]);
  const tracer = triangleSoupTracer(soup);
  const flat = flatWorld(0);
  const a = createPlayerState(0, 0, 10);
  const b = createPlayerState(0, 0, 10);
  const input = createInput();
  input.forward = 1;
  input.yaw = 30;
  input.maxSpeed = 250;
  // Fall to the floor, run, jump, land, stop: the two worlds must agree.
  for (let i = 0; i < 400; i++) {
    if (i === 60) input.jump = true;
    if (i === 61) input.jump = false;
    if (i === 200) input.forward = 0;
    stepPlayer(a, input, tracer);
    stepPlayer(b, input, flat);
    close(a.pos.x, b.pos.x, 0.05, `x agrees at tick ${i}`);
    close(a.pos.y, b.pos.y, 0.05, `y agrees at tick ${i}`);
    // The tracer stops DIST_EPSILON above the floor; flatWorld exactly on it.
    close(a.pos.z, b.pos.z, DIST_EPSILON + 0.02, `z agrees at tick ${i}`);
    assert(a.onGround === b.onGround, `ground state agrees at tick ${i} (${a.onGround} vs ${b.onGround})`);
  }
  assert(a.onGround, 'ends on the ground');
  const speed = Math.hypot(a.vel.x, a.vel.y);
  assert(speed < 1, `stopped (${speed})`);
}

// ---- walls stop and slide; nothing tunnels at 250 u/s -----------------------
{
  const soup = [];
  boxTriangles([-2000, -2000, -64], [2000, 2000, 0], soup); // floor
  boxTriangles([200, -2000, 0], [232, 2000, 128], soup); // wall at x = 200, 32 thick
  const tracer = triangleSoupTracer(soup);
  const st = createPlayerState(0, 0, 0);
  const input = createInput();
  input.forward = 1;
  input.yaw = 20; // running at the wall at an angle: must slide along it
  input.maxSpeed = 250;
  let maxX = -Infinity;
  for (let i = 0; i < 300; i++) {
    stepPlayer(st, input, tracer);
    maxX = Math.max(maxX, st.pos.x);
    assert(st.pos.x < 200 - HULL_HALF_WIDE + 0.01, `hull never enters the wall (x=${st.pos.x} at tick ${i})`);
  }
  close(maxX, 200 - HULL_HALF_WIDE - DIST_EPSILON, 0.05, 'rests against the wall face');
  assert(st.pos.y > 300, `slid along the wall (y=${st.pos.y})`);
  assert(st.onGround, 'still grounded while sliding');
}

// ---- steps: knee-high climbed, hip-high refused -----------------------------
{
  const soup = [];
  boxTriangles([-2000, -2000, -64], [2000, 2000, 0], soup);
  boxTriangles([100, -2000, 0], [400, 2000, STEP_HEIGHT - 2], soup); // 16u step: climbable
  boxTriangles([400, -2000, 0], [800, 2000, STEP_HEIGHT + 20], soup); // 38u ledge: not
  const tracer = triangleSoupTracer(soup);
  const st = createPlayerState(0, 0, 0);
  const input = createInput();
  input.forward = 1;
  input.yaw = 0;
  input.maxSpeed = 250;
  for (let i = 0; i < 400; i++) stepPlayer(st, input, tracer);
  assert(st.pos.x > 100 + HULL_HALF_WIDE, `climbed the 16u step (x=${st.pos.x})`);
  close(st.pos.z, STEP_HEIGHT - 2, DIST_EPSILON + 0.05, 'standing on the step');
  assert(st.pos.x < 400 - HULL_HALF_WIDE + 0.01, `blocked by the 38u ledge (x=${st.pos.x})`);
  assert(st.onGround, 'grounded against the ledge');
}

// ---- ceiling caps a jump; crouch fits under a low gap -------------------------
{
  const soup = [];
  boxTriangles([-2000, -2000, -64], [2000, 2000, 0], soup);
  boxTriangles([-2000, -2000, 100], [2000, 2000, 132], soup); // ceiling at 100
  const tracer = triangleSoupTracer(soup);
  const st = createPlayerState(0, 0, 0);
  const input = createInput();
  stepPlayer(st, input, tracer);
  input.jump = true;
  stepPlayer(st, input, tracer);
  input.jump = false;
  let apex = 0;
  for (let i = 0; i < 100 && !(i > 5 && st.onGround); i++) {
    stepPlayer(st, input, tracer);
    apex = Math.max(apex, st.pos.z);
  }
  assert(apex <= 100 - HULL_STAND + 0.01, `head stops at the ceiling (apex ${apex})`);
  assert(apex > 100 - HULL_STAND - 1, `and reaches it (apex ${apex}, free apex would be ${((JUMP_IMPULSE * JUMP_IMPULSE) / (2 * GRAVITY)).toFixed(1)})`);
  assert(st.onGround, 'lands again');
}

// ---- no standing up into a ceiling --------------------------------------------
{
  const soup = [];
  boxTriangles([-2000, -2000, -64], [2000, 2000, 0], soup);
  boxTriangles([-2000, -2000, 60], [200, 2000, 92], soup); // a 60u gap over x < 200
  const tracer = triangleSoupTracer(soup);
  const st = createPlayerState(0, 0, 0);
  const input = createInput();
  input.duck = true;
  for (let i = 0; i < 5; i++) stepPlayer(st, input, tracer);
  assert(st.ducking && st.onGround, 'ducked under the gap');
  input.duck = false;
  input.forward = 1;
  input.yaw = 0;
  input.maxSpeed = 250;
  let stoodAt = null;
  for (let i = 0; i < 400 && stoodAt === null; i++) {
    stepPlayer(st, input, tracer);
    if (!st.ducking) stoodAt = st.pos.x;
    else assert(st.pos.x < 200 + HULL_HALF_WIDE + 1, `still ducked only while under the gap (x=${st.pos.x})`);
  }
  assert(stoodAt !== null, 'stands once clear');
  assert(stoodAt > 200 - HULL_HALF_WIDE - 1, `stood up right after the gap (x=${stoodAt})`);
  assert(st.onGround, 'grounded throughout');
}

// ---- determinism: same tape, same trajectory, byte for byte -------------------
{
  const soup = [];
  boxTriangles([-2000, -2000, -64], [2000, 2000, 0], soup);
  boxTriangles([300, -50, 0], [340, 50, 60], soup);
  const run = () => {
    const tracer = triangleSoupTracer(soup);
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    input.maxSpeed = 250;
    const out = [];
    for (let i = 0; i < 300; i++) {
      input.forward = i < 200 ? 1 : 0;
      input.side = i > 50 && i < 120 ? 1 : 0;
      input.yaw = (i * 0.7) % 360;
      input.jump = i % 90 === 40;
      stepPlayer(st, input, tracer);
      out.push(st.pos.x, st.pos.y, st.pos.z);
    }
    return out;
  };
  const a = run();
  const b = run();
  for (let i = 0; i < a.length; i++) assert(Object.is(a[i], b[i]), `deterministic at sample ${i}`);
}

// ---- BVH-shaped query contract: bounds are respected -----------------------
{
  // A tracer whose query counts calls and rejects any triangle outside the
  // bounds it was handed must give the same answer as the soup.
  const soup = boxTriangles([-100, -100, -10], [100, 100, 0]);
  let calls = 0;
  const strict = createHullTracer((minX, minY, minZ, maxX, maxY, maxZ, visit) => {
    calls++;
    for (let i = 0; i < soup.length; i += 9) visit(...soup.slice(i, i + 9));
  });
  const t = strict.traceHull({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -10 }, HULL_HALF_WIDE, HULL_STAND);
  assert(calls === 1, 'one query per trace');
  close(t.fraction, 0.5 - DIST_EPSILON / 20, 1e-6, 'lands on the floor at half the sweep, pulled back');
  close(t.endpos.z, DIST_EPSILON, 1e-6, 'endpos sits DIST_EPSILON above z=0');
  close(t.normal.z, 1, 1e-9, 'floor normal is +z in Source');
  const miss = strict.traceHull({ x: 0, y: 0, z: 10 }, { x: 50, y: 0, z: 10 }, HULL_HALF_WIDE, HULL_STAND);
  assert(miss.fraction === 1 && miss.normal === null, 'a clear sweep is fraction 1');
}

console.log('hullTrace.test: ok');
