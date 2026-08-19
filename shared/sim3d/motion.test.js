// Run: node shared/sim3d/motion.test.js
//
// The movement tick against its own closed forms. The demo corpus (via
// scripts/cs3d-oracle.mjs) is the authority on whether the MODEL matches
// CS2; this file is the authority on whether the CODE matches the model:
// the leapfrog identity, the accelerate cap, the air-speed cap, the exact
// friction sequence, and bit-for-bit determinism of the f32 discipline.
// Everything is derived from constants.js at runtime, so retuning a
// constant to a measured value does not break the suite.

import {
  TICK_DT,
  GRAVITY,
  JUMP_IMPULSE,
  ACCEL,
  FRICTION,
  STOP_SPEED,
  AIR_SPEED_CAP,
  STAMINA,
  DUCK,
  WALK_SPEED_SCALE,
  DUCK_SPEED_SCALE,
  BUNNYJUMP_MAX_SPEED_FACTOR,
  ACCEL_SPEED_REF
} from './constants.js';
import {
  createPlayerState,
  createInput,
  stepPlayer,
  flatWorld,
  emptyWorld,
  CLIMB_SPEED,
  LADDER_SPEED_SCALE
} from './motion.js';
import { createGrenade, stepGrenade, GRENADE_GRAVITY_SCALE } from './grenade.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- jump: CheckJumpButton add + FinishGravity, then FullWalk FinishGravity --
{
  close(JUMP_IMPULSE, 301.993377, 1e-4, 'sv_jump_impulse leak default');

  const world = flatWorld(0);
  const st = createPlayerState(0, 0, 0);
  const input = createInput();
  stepPlayer(st, input, world);
  assert(st.onGround, 'starts grounded on the flat world');

  input.jump = true;
  stepPlayer(st, input, world);
  input.jump = false;

  // Standing: StartGravity, ADD impulse, CheckJump FinishGravity, AirMove, FullWalk FinishGravity.
  // AirMove sees vz = J − g·dt, so first-tick rise is (J − g·dt)·dt.
  const gHalf = (GRAVITY * TICK_DT) / 2;
  close(st.pos.z, (JUMP_IMPULSE - GRAVITY * TICK_DT) * TICK_DT, 1e-2, 'standing first-tick rise');
  close(st.vel.z, JUMP_IMPULSE - 3 * gHalf, 0.05, 'vz after jump tick is J − 1.5 g dt');
  assert(!st.onGround, 'left the ground');

  let apex = 0;
  let ticks = 1;
  while (!st.onGround && ticks < 200) {
    stepPlayer(st, input, world);
    apex = Math.max(apex, st.pos.z);
    ticks++;
  }
  assert(st.onGround, 'lands');
  assert(apex > 50 && apex < 58, `apex in leak jump band (got ${apex})`);
  close(st.pos.z, 0, 1e-3, 'back on the floor');
}

// ---- ground accelerate: first-tick kick, cap, and steady state ------------
{
  const world = flatWorld(0);
  const st = createPlayerState(0, 0, 0);
  const input = createInput();
  input.maxSpeed = 215;
  stepPlayer(st, input, world);
  input.forward = 1;

  stepPlayer(st, input, world);
  // From rest friction no-ops, so tick one adds exactly accel·dt·wishspeed.
  close(Math.hypot(st.vel.x, st.vel.y), ACCEL * TICK_DT * 215, 1e-2, 'first-tick accelerate');

  for (let i = 0; i < 96; i++) stepPlayer(st, input, world);
  const speed = Math.hypot(st.vel.x, st.vel.y);
  close(speed, 215, 1e-2, 'steady-state run speed');
  assert(speed <= 215 + 1e-3, 'never exceeds wishspeed');
  assert(st.onGround && Math.abs(st.pos.z) < 1e-3, 'stays glued to the floor');
}

// ---- friction: the exact Source decay sequence ----------------------------
{
  const world = flatWorld(0);
  const st = createPlayerState(0, 0, 0);
  const input = createInput();
  stepPlayer(st, input, world);
  st.vel.x = 200;

  // Reference: control = max(v, stopspeed); v' = v − control·f·dt, and
  // WalkMove snaps speeds under 1 u/s to a dead stop.
  let ref = 200;
  for (let i = 0; i < 40; i++) {
    stepPlayer(st, input, world);
    const control = ref < STOP_SPEED ? STOP_SPEED : ref;
    ref = Math.max(0, ref - control * FRICTION * TICK_DT);
    if (ref < 1) ref = 0;
    close(st.vel.x, ref, 0.05, `friction tick ${i}`);
    if (ref === 0) break;
  }
  assert(st.vel.x === 0, 'comes to a dead stop');
}

// ---- air control: the 30 u/s projection cap -------------------------------
{
  const world = emptyWorld();
  const st = createPlayerState(0, 0, 10000);
  st.onGround = false;
  const input = createInput();
  input.maxSpeed = 215;
  input.side = 1;
  for (let i = 0; i < 128; i++) stepPlayer(st, input, world);
  const h = Math.hypot(st.vel.x, st.vel.y);
  close(h, AIR_SPEED_CAP, 0.5, 'air speed saturates at the cap');
  assert(h <= AIR_SPEED_CAP + 1e-3, 'cap never exceeded');
}

// ---- determinism: the f32 discipline is bit-stable ------------------------
{
  const run = () => {
    const world = flatWorld(0);
    const st = createPlayerState(3.25, -7.5, 0);
    const input = createInput();
    input.maxSpeed = 215;
    for (let i = 0; i < 300; i++) {
      input.forward = i % 3 === 0 ? 1 : 0;
      input.side = i % 5 === 0 ? -1 : 1;
      input.yaw = (i * 7) % 360;
      input.jump = i % 50 === 10;
      stepPlayer(st, input, world);
    }
    return st;
  };
  const a = run();
  const b = run();
  assert(Object.is(a.pos.x, b.pos.x) && Object.is(a.pos.y, b.pos.y) && Object.is(a.pos.z, b.pos.z), 'positions bit-identical');
  assert(Object.is(a.vel.x, b.vel.x) && Object.is(a.vel.y, b.vel.y) && Object.is(a.vel.z, b.vel.z), 'velocities bit-identical');
  assert(a.pos.x === Math.fround(a.pos.x) && a.vel.x === Math.fround(a.vel.x), 'state stays f32');
}

// ---- grenade: leapfrog arc and coming to rest -----------------------------
{
  const g = createGrenade({ x: 0, y: 0, z: 100 }, { x: 250, y: 0, z: 100 });
  const world = emptyWorld();
  const grav = GRAVITY * GRENADE_GRAVITY_SCALE;
  for (let k = 1; k <= 64; k++) {
    stepGrenade(g, world);
    const t = k * TICK_DT;
    close(g.pos.z, 100 + 100 * t - (grav / 2) * t * t, 0.02, `grenade parabola tick ${k}`);
    close(g.pos.x, 250 * t, 0.02, `grenade linear x tick ${k}`);
  }

  const g2 = createGrenade({ x: 0, y: 0, z: 60 }, { x: 40, y: 0, z: 0 });
  const floor = flatWorld(0);
  for (let k = 0; k < 640 && !g2.resting; k++) stepGrenade(g2, floor);
  assert(g2.resting, 'grenade comes to rest on the floor');
  assert(g2.bounces > 0, 'rest came via at least one bounce');
}

// ---- ladders ---------------------------------------------------------------
// A climb volume is the one thing in the pipeline steered by view PITCH, and
// the one thing with no gravity. Both are checked here against a wall at
// x = 0 whose face points back along +x, which is the shape of every ladder on
// a Source map.
{
  const LADDER = { normal: { x: 1, y: 0, z: 0 } };
  /** A world that is a ladder everywhere below z = 400 and open air above. */
  const climbWorld = (top = 400) => ({
    ...emptyWorld(),
    ladderAt: (pos) => (pos.z < top ? LADDER : null)
  });

  // Facing the ladder (yaw 180, so forward is −x) and looking up: W climbs.
  const up = createPlayerState(0, 0, 0);
  const inp = createInput();
  inp.yaw = 180;
  inp.pitch = -80; // Source pitch is positive DOWN, so this is looking up
  inp.forward = 1;
  const world = climbWorld();
  for (let k = 0; k < 64; k++) stepPlayer(up, inp, world);
  assert(up.onLadder, 'still on the ladder');
  assert(up.pos.z > 100, `W while looking up climbs (reached ${up.pos.z.toFixed(1)})`);
  close(up.vel.z, CLIMB_SPEED * LADDER_SPEED_SCALE * Math.sin((80 * Math.PI) / 180), 1, 'at the climb speed, scaled');

  // ...and looking down descends, at the same speed.
  const down = createPlayerState(0, 0, 300);
  const dinp = createInput();
  dinp.yaw = 180;
  dinp.pitch = 80;
  dinp.forward = 1;
  for (let k = 0; k < 32; k++) stepPlayer(down, dinp, world);
  assert(down.pos.z < 300, 'W while looking down descends');
  assert(down.onLadder, 'and stays on');

  // Gravity is off entirely: no input, no movement, no fall.
  const hang = createPlayerState(0, 0, 200);
  const still = createInput();
  still.yaw = 180;
  for (let k = 0; k < 64; k++) stepPlayer(hang, still, world);
  close(hang.pos.z, 200, 1e-6, 'a body on a ladder with no input hangs there');
  close(hang.vel.z, 0, 1e-6, 'with no velocity at all');

  // Pressing back descends while still looking up — direction is the INPUT
  // through the view, not the view alone.
  const back = createPlayerState(0, 0, 300);
  const binp = createInput();
  binp.yaw = 180;
  binp.pitch = -80;
  binp.forward = -1;
  for (let k = 0; k < 32; k++) stepPlayer(back, binp, world);
  assert(back.pos.z < 300, 'S while looking up goes down');

  // Jump lets go, pushing away along the ladder face, and the grab is locked
  // out for a few ticks so the same volume does not catch it again.
  const off = createPlayerState(0, 0, 200);
  const jinp = createInput();
  jinp.yaw = 180;
  jinp.jump = true;
  stepPlayer(off, jinp, world);
  assert(!off.onLadder, 'jumping lets go');
  assert(off.pos.x > 0, 'and pushes away from the face');
  jinp.jump = false;
  const xBefore = off.pos.x;
  for (let k = 0; k < 4; k++) stepPlayer(off, jinp, world);
  assert(!off.onLadder, 'and it does not re-grab immediately');
  assert(off.pos.x > xBefore, 'it keeps travelling away');
  assert(off.vel.z < 0, 'with gravity back on');

  // Climbing off the top: past the volume, it is an ordinary airborne body.
  const exit = createPlayerState(0, 0, 380);
  const einp = createInput();
  einp.yaw = 180;
  einp.pitch = -80;
  einp.forward = 1;
  for (let k = 0; k < 40; k++) stepPlayer(exit, einp, climbWorld(400));
  assert(!exit.onLadder, 'above the volume it is off the ladder');

  // A world with no ladder probe at all behaves exactly as it did before —
  // which is the whole reason this can be added without re-running the oracle.
  const plain = createPlayerState(0, 0, 100);
  const pinp = createInput();
  pinp.pitch = -80;
  for (let k = 0; k < 8; k++) stepPlayer(plain, pinp, emptyWorld());
  assert(!plain.onLadder && plain.vel.z < 0, 'no ladderAt means no ladder, and gravity as usual');
}

// ---- leak formulas: stamina, duck-in-air, bunnyhop crop, walk cap, accel ----
{
  const world = flatWorld(0);
  const gHalf = (GRAVITY * TICK_DT) / 2;

  // Ducking SETS vz; standing ADDS. Air duck is instant (FinishDuck if !onGround).
  {
    const stand = createPlayerState(0, 0, 0);
    const duck = createPlayerState(0, 0, 0);
    const a = createInput();
    const b = createInput();
    stepPlayer(stand, a, world);
    stepPlayer(duck, b, world);
    a.jump = b.jump = true;
    stepPlayer(stand, a, world);
    stepPlayer(duck, b, world);
    a.jump = b.jump = false;
    b.duck = true;
    stepPlayer(stand, a, world);
    stepPlayer(duck, b, world);
    assert(duck.duckAmount === 1 && duck.ducked, 'air duck finishes immediately');
    close(duck.pos.z - stand.pos.z, 0.5 * (72 - 54), 0.15, 'air duck origin +0.5*(stand-duck hull)');
  }

  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    stepPlayer(st, input, world);
    input.duck = true;
    for (let i = 0; i < 32; i++) stepPlayer(st, input, world);
    assert(st.ducking && st.ducked && st.duckAmount === 1, 'ground duck completes');
    input.jump = true;
    stepPlayer(st, input, world);
    close(st.pos.z, (JUMP_IMPULSE - gHalf) * TICK_DT, 0.05, 'duck jump SET first-tick rise');
  }

  // Stamina on jump: 0.080 * fImpulse, clamped to 80. Jump vz scaled by (1 - stam/100).
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    stepPlayer(st, input, world);
    input.jump = true;
    stepPlayer(st, input, world);
    const startz = -gHalf;
    const afterCheckJump = JUMP_IMPULSE + startz - gHalf; // add then CheckJump FinishGravity
    const impulse = afterCheckJump - startz;
    close(st.stamina, Math.min(STAMINA.MAX, STAMINA.JUMP_COST * impulse), 0.05, 'OnJump stamina');
    assert(st.stamina > 20 && st.stamina < STAMINA.MAX, 'jump costs a chunk of stamina');
  }

  // Stamina on land: 0.050 * fallVelocity, plus recovery each tick.
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    stepPlayer(st, input, world);
    input.jump = true;
    stepPlayer(st, input, world);
    input.jump = false;
    const stamTakeoff = st.stamina;
    let preLand = stamTakeoff;
    while (!st.onGround) {
      preLand = st.stamina;
      stepPlayer(st, input, world);
    }
    assert(st.stamina > preLand, 'OnLand adds stamina from fall velocity');
    assert(st.stamina <= STAMINA.MAX, 'stamina clamped to sv_staminamax');
  }

  // sv_autobunnyhopping 0: must release jump.
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    stepPlayer(st, input, world);
    input.jump = true;
    let jumps = 0;
    for (let i = 0; i < 200; i++) {
      const g = st.onGround;
      stepPlayer(st, input, world);
      if (g && !st.onGround) jumps++;
    }
    assert(jumps === 1, `holding jump does not bhop (jumps=${jumps})`);
  }

  // sv_enablebunnyhopping 0: crop speed to 1.1 * maxspeed before jump.
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    input.maxSpeed = 250;
    stepPlayer(st, input, world);
    st.vel.x = 400;
    input.jump = true;
    stepPlayer(st, input, world);
    const h = Math.hypot(st.vel.x, st.vel.y);
    const cap = BUNNYJUMP_MAX_SPEED_FACTOR * 250;
    assert(h <= cap + 1, `bhop crop horizontal ${h} vs ${cap}`);
    close(h, cap, 2, 'horizontal speed cropped to 1.1 maxspeed');
  }

  // Walk: only cap maxSpeed * 0.52 when current speed < walkCap+25.
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    input.maxSpeed = 250;
    stepPlayer(st, input, world);
    input.forward = 1;
    for (let i = 0; i < 96; i++) stepPlayer(st, input, world);
    close(Math.hypot(st.vel.x, st.vel.y), 250, 1, 'run speed before walk');
    input.walk = true;
    stepPlayer(st, input, world);
    const afterTap = Math.hypot(st.vel.x, st.vel.y);
    assert(afterTap > 200, `walk does not instantly cap from run (got ${afterTap})`);
    for (let i = 0; i < 160; i++) stepPlayer(st, input, world);
    close(Math.hypot(st.vel.x, st.vel.y), 250 * WALK_SPEED_SCALE, 1, 'walk cap once slowed');
  }

  // Accel weapon scale: running a 215 gun first-tick uses 215, not 250.
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    input.maxSpeed = 215;
    stepPlayer(st, input, world);
    input.forward = 1;
    stepPlayer(st, input, world);
    close(Math.hypot(st.vel.x, st.vel.y), ACCEL * TICK_DT * 215, 1e-2, 'weapon-scaled first-tick accel');
  }

  // Walking from rest: Accelerate uses MAX(250, wish)*walk modifier = 130.
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    input.maxSpeed = 250;
    input.walk = true;
    stepPlayer(st, input, world);
    input.forward = 1;
    stepPlayer(st, input, world);
    const first = Math.hypot(st.vel.x, st.vel.y);
    close(first, ACCEL * TICK_DT * ACCEL_SPEED_REF * WALK_SPEED_SCALE, 0.05, 'walk accel scale 250*0.52');
  }

  // Crouch spam: press/release drops duckSpeed by 2; DuckingEnabled false below 1.5.
  {
    const st = createPlayerState(0, 0, 0);
    const input = createInput();
    stepPlayer(st, input, world);
    const speeds = [];
    for (let k = 0; k < 6; k++) {
      input.duck = true;
      stepPlayer(st, input, world);
      speeds.push(st.duckSpeed);
      input.duck = false;
      stepPlayer(st, input, world);
    }
    assert(speeds[0] < DUCK.SPEED_IDEAL, 'first press applies spam penalty');
    assert(st.duckSpeed < DUCK.ENABLED_MIN_SPEED + 3, 'repeated crouch drains duckSpeed');
  }

  assert(DUCK_SPEED_SCALE === Math.fround(0.34), 'CS_PLAYER_SPEED_DUCK_MODIFIER');
}

console.log('motion.test: ok');
