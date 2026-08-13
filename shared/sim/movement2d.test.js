// Run: node shared/sim/movement2d.test.js
//
// The load-bearing claim in this file is the first one: the sim's movement and
// the trainer's movement are the same model. Everything else in SIM-PLAN that
// says "bots move like the demos" is downstream of it, and the two
// implementations exist separately only because one works in metres on {x,z}
// and the other in units on {x,y}. If they ever drift, requirement D is a lie
// and nothing downstream would notice.
//
// After that: the ramp, the stop, the crouch-walk case that the activeWishSpeed
// flag exists for, sliding rather than sticking, and a counter-strafe that
// arrives without overshooting.

import { srcAccelerate, srcFriction, UNIT } from '../../src/utils/SourceMovement.js';
import {
  BODY_RADIUS,
  CROUCH_FACTOR,
  TICK_DT,
  WALK_FACTOR,
  runSpeedFor,
  speedCap,
  ticksFor
} from './constants.js';
import {
  accelerate,
  friction,
  seekDirection,
  slideMove,
  stepBody,
  stepVelocity,
  stopDistance,
  unit
} from './movement2d.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
function close(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg || 'not close'}: ${a} vs ${b}`);
}

// ---- 1. parity with SourceMovement.js ---------------------------------------
// Same physical run, expressed twice. The Source equations are scale invariant
// (accel and friction are rates; stopspeed carries the unit), so the unit-space
// trajectory times UNIT must equal the metre-space one.

{
  const CAP_U = 215;
  const CAP_M = CAP_U * UNIT;

  const velU = { x: 0, y: 0 };
  const velM = { x: 0, z: 0 };
  let posU = 0;
  let posM = 0;

  // 1.5 s accelerating forward, then 1.5 s of no input.
  for (let i = 0; i < ticksFor(3); i += 1) {
    const pressing = i < ticksFor(1.5);

    stepVelocity(velU, pressing ? { x: 1, y: 0 } : null, CAP_U, TICK_DT);
    posU += velU.x * TICK_DT;

    srcFriction(velM, TICK_DT, pressing ? CAP_M : 0);
    if (pressing) srcAccelerate(velM, 1, 0, CAP_M, TICK_DT);
    posM += velM.x * TICK_DT;
  }

  close(velU.x * UNIT, velM.x, 1e-9, 'parity: velocity');
  close(posU * UNIT, posM, 1e-9, 'parity: position');
  assert(posU > 0, 'parity: the body actually moved');
}

// Same again for a crouch cap, which is below sv_stopspeed and is where a naive
// friction implementation refuses to let the body move at all.
{
  const CAP_U = 215 * CROUCH_FACTOR;
  const CAP_M = CAP_U * UNIT;
  const velU = { x: 0, y: 0 };
  const velM = { x: 0, z: 0 };

  for (let i = 0; i < ticksFor(2); i += 1) {
    stepVelocity(velU, { x: 0, y: 1 }, CAP_U, TICK_DT);
    srcFriction(velM, TICK_DT, CAP_M);
    srcAccelerate(velM, 0, 1, CAP_M, TICK_DT);
  }
  close(velU.y * UNIT, velM.z, 1e-9, 'parity: crouch velocity');
  assert(velU.y > CAP_U * 0.9, 'crouch walk reaches its cap despite stopspeed friction');
}

// ---- 2. the ramp and the cap ------------------------------------------------

{
  const cap = 215;
  const vel = { x: 0, y: 0 };
  let ticks = 0;
  while (Math.hypot(vel.x, vel.y) < cap * 0.99 && ticks < 640) {
    stepVelocity(vel, { x: 1, y: 0 }, cap, TICK_DT);
    ticks += 1;
  }
  assert(ticks < 64, `ramp to full speed takes under a second (took ${ticks} ticks)`);
  // Never above the cap, no matter how long the key is held.
  for (let i = 0; i < 200; i += 1) stepVelocity(vel, { x: 1, y: 0 }, cap, TICK_DT);
  assert(Math.hypot(vel.x, vel.y) <= cap + 1e-6, 'speed never exceeds the cap');
}

// A diagonal is normalized before it reaches accelerate(), so it is not faster
// than a straight line. (Source's own bug is a different thing entirely and is
// not something the sim should reproduce.)
{
  const cap = 215;
  const straight = { x: 0, y: 0 };
  const diagonal = { x: 0, y: 0 };
  const d = unit(1, 1);
  for (let i = 0; i < 128; i += 1) {
    stepVelocity(straight, { x: 1, y: 0 }, cap, TICK_DT);
    stepVelocity(diagonal, d, cap, TICK_DT);
  }
  close(Math.hypot(straight.x, straight.y), Math.hypot(diagonal.x, diagonal.y), 1e-9, 'diagonal speed');
}

// ---- 3. friction stops the body --------------------------------------------

{
  const vel = { x: 215, y: 0 };
  let ticks = 0;
  while (Math.hypot(vel.x, vel.y) > 1 && ticks < 640) {
    friction(vel, TICK_DT);
    ticks += 1;
  }
  assert(ticks < 64, `a body coasts to a stop inside a second (took ${ticks} ticks)`);
  friction(vel, TICK_DT);
  assert(vel.x === 0 && vel.y === 0, 'friction snaps residual velocity to exactly zero');
}

// ---- 4. accelerate does nothing when already at speed ------------------------

{
  const vel = { x: 215, y: 0 };
  accelerate(vel, 1, 0, 215, TICK_DT);
  close(vel.x, 215, 1e-9, 'no acceleration past the cap along the wish direction');

  // But it does redirect: pressing sideways at full speed still adds sideways.
  accelerate(vel, 0, 1, 215, TICK_DT);
  assert(vel.y > 0, 'a perpendicular press still accelerates');
}

// ---- 5. collision: slide, do not stick --------------------------------------

// A wall along y = 500: everything above it is solid.
const wallAt500 = (x, y) => y >= 500;

{
  // Walking into the wall at 45 degrees should keep the x component.
  const pos = { x: 0, y: 400 };
  const vel = { x: 100, y: 100 };
  const moved = slideMove(pos, vel, 10, 90, wallAt500);
  assert(moved, 'a body brushing a wall still moves');
  close(pos.x, 10, 1e-9, 'the free axis survives');
  close(pos.y, 400, 1e-9, 'the blocked axis does not');
  assert(vel.y === 0, 'the blocked axis loses its velocity');
  assert(vel.x === 100, 'the free axis keeps its velocity');
}

{
  // Head on into the wall: no movement, no velocity, and no tunnelling.
  const pos = { x: 0, y: 480 - BODY_RADIUS };
  const vel = { x: 0, y: 200 };
  const moved = slideMove(pos, vel, 0, 100, wallAt500);
  assert(!moved, 'a body cannot walk into a wall');
  assert(vel.x === 0 && vel.y === 0, 'a head-on stop kills velocity');
}

{
  // The disc, not the point, is what collides: a centre 10 units short of the
  // wall is already touching it at radius 16.
  const pos = { x: 0, y: 500 - 10 };
  const vel = { x: 0, y: 10 };
  slideMove(pos, vel, 0, 1, wallAt500);
  close(pos.y, 490, 1e-9, 'the body radius keeps the centre out of the wall');
}

{
  // Sliding along a wall for a while must not creep into it. The body starts
  // one unit clear of contact: at y = 484 the disc's leading edge is at 500.
  const body = { pos: { x: 0, y: 500 - BODY_RADIUS - 1 }, vel: { x: 0, y: 0 } };
  for (let i = 0; i < 128; i += 1) {
    stepBody(body, unit(1, 1), 215, TICK_DT, wallAt500);
  }
  assert(body.pos.y + BODY_RADIUS <= 500, 'a long slide never enters the wall');
  assert(body.pos.x > 100, `and it makes real progress along it (x=${body.pos.x})`);
}

{
  // A body that somehow starts overlapping geometry is stuck, by construction:
  // every candidate position is blocked, so slideMove refuses all of them. The
  // engine must therefore never place one there. Asserted rather than fixed
  // with an unstick nudge, because a silent nudge would hide a bad spawn or a
  // bad nav node, and those are the things worth finding.
  const body = { pos: { x: 0, y: 495 }, vel: { x: 0, y: 0 } };
  const moved = slideMove(body.pos, body.vel, 20, 0, wallAt500);
  assert(!moved, 'an overlapping body does not move');
  assert(body.pos.x === 0, 'and stays exactly where it was, visibly stuck');
}

// ---- 6. counter-strafe arrives without overshooting -------------------------

{
  const body = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
  const target = { x: 600, y: 0 };
  let maxX = 0;
  let settledAt = -1;
  let reversals = 0;
  let lastWish = 0;

  for (let i = 0; i < ticksFor(8); i += 1) {
    const wish = seekDirection(body.pos, body.vel, target, 215);
    stepBody(body, wish, 215, TICK_DT);
    maxX = Math.max(maxX, body.pos.x);
    const w = wish ? Math.sign(wish.x) : 0;
    if (w !== 0 && lastWish !== 0 && w !== lastWish) reversals += 1;
    if (w !== 0) lastWish = w;
    if (settledAt < 0 && wish === null && Math.hypot(body.vel.x, body.vel.y) < 1) settledAt = i;
  }

  assert(settledAt > 0, 'the seek settles');
  assert(Math.abs(body.pos.x - target.x) < 4, `settles on the target (at ${body.pos.x})`);
  assert(maxX < target.x + 4, `does not overshoot (peak ${maxX})`);
  assert(Math.hypot(body.vel.x, body.vel.y) < 1, 'and is stationary when it gets there');
  // The whole point of an accurate stopping distance: one commitment to the
  // brake, not a tap-dance. A player counter-strafes once.
  assert(reversals <= 1, `brakes once rather than chattering (${reversals} reversals)`);
}

{
  // The stopping distance is the thing the seek is built on, so check it
  // against the engine rather than against arithmetic: brake from full speed
  // and see how far the body actually travels.
  const cap = 215;
  const body = { pos: { x: 0, y: 0 }, vel: { x: cap, y: 0 } };
  const predicted = stopDistance(cap, cap);
  let ticks = 0;
  while (body.vel.x > 1 && ticks < 640) {
    stepBody(body, { x: -1, y: 0 }, cap, TICK_DT);
    ticks += 1;
  }
  assert(
    Math.abs(body.pos.x - predicted) < predicted * 0.25,
    `predicted stop distance ${predicted.toFixed(2)} vs actual ${body.pos.x.toFixed(2)}`
  );
  assert(predicted < 20, `a rifle stops inside 20 units (${predicted.toFixed(2)})`);
}

// ---- 7. speed caps ----------------------------------------------------------

close(speedCap('ak47', 'run'), 215, 1e-9, 'ak run speed');
close(speedCap('ak47', 'walk'), 215 * WALK_FACTOR, 1e-9, 'ak walk speed');
close(speedCap('ak47', 'crouchwalk'), 215 * CROUCH_FACTOR, 1e-9, 'ak crouch speed');
close(speedCap('ak47', 'walk'), 112, 1e-9, 'walk matches the trainer constant exactly');
close(speedCap('ak47', 'crouchwalk'), 73, 1e-9, 'crouch matches the trainer constant exactly');
close(runSpeedFor('awp'), 200, 1e-9, 'awp is slower');
close(runSpeedFor('awp', true), 100, 1e-9, 'a scoped awp is much slower');
close(runSpeedFor('not_a_gun'), 215, 1e-9, 'unknown weapons fall back to the rifle speed');

// ---- 8. determinism ---------------------------------------------------------

{
  // Same inputs, same floats. The engine's determinism gate (9.8.5) is only
  // meaningful if the layer underneath it is bit-exact.
  const run = () => {
    const body = { pos: { x: 12.5, y: -33.25 }, vel: { x: 0, y: 0 } };
    for (let i = 0; i < 512; i += 1) {
      const wish = i % 7 < 4 ? unit(Math.cos(i / 9), Math.sin(i / 11)) : null;
      stepBody(body, wish, speedCap('ak47', i % 3 === 0 ? 'walk' : 'run'), TICK_DT, wallAt500);
    }
    return `${body.pos.x},${body.pos.y},${body.vel.x},${body.vel.y}`;
  };
  assert(run() === run(), 'two identical runs produce identical state');
}

console.log('movement2d: ok');
