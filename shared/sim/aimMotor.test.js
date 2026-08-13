// Run: node shared/sim/aimMotor.test.js
//
// This file guards the one promise the whole project rests on: the bots are not
// aimbots, and they cannot become aimbots by being trained. So the assertions
// that matter are the ones no amount of learning may violate:
//
//   the crosshair cannot turn faster than the envelope allows
//   a profile cannot be constructed outside the envelope, whatever is asked for
//   a target is never shot at before a human reaction time has elapsed
//   accuracy degrades with distance, with movement, and through a spray
//
// And, on the other side, that "worse" is a shape rather than a level: a mix
// bot is slower and looser, not blind.

import { TICK_DT, ticksFor } from './constants.js';
import {
  acquire,
  angleDelta,
  createMotor,
  release,
  resolveShot,
  stepMotor,
  targetAngularRadius
} from './aimMotor.js';
import { MAX_BLOOM, recoilBloom } from './aimMotor.js';
import { simWeapon } from './weapons.js';
import { PRO_ENVELOPE, clampToEnvelope, skillProfile, teamProfiles, withinEnvelope } from './skill.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- angles -----------------------------------------------------------------

assert(angleDelta(0, 90) === 90, 'a quarter turn right');
assert(angleDelta(0, -90) === -90, 'and left');
assert(angleDelta(170, -170) === 20, 'the short way across the wrap');
assert(angleDelta(-170, 170) === -20, 'in both directions');

assert(targetAngularRadius(100) > targetAngularRadius(2000), 'a body is a smaller target further away');
assert(targetAngularRadius(1000, 'head') < targetAngularRadius(1000), 'and a head is smaller than a body');

// ---- the envelope cannot be escaped -----------------------------------------

{
  for (const stop of ['mix', 't3', 'average', 't2', 't1', 'pro']) {
    assert(withinEnvelope(skillProfile(stop)), `${stop} sits inside the envelope`);
  }

  // Someone types in a superhuman profile. They get the envelope.
  const cheat = skillProfile('pro', {
    reactionMedian: 0.001,
    flickSigmaScale: 0,
    trackSigmaScale: 0,
    maxTurnRate: 100000,
    triggerConfidence: 5,
    hsBias: 1
  });
  assert(withinEnvelope(cheat), 'an attempt to build an aimbot is clamped');
  assert(cheat.reactionMedian === PRO_ENVELOPE.reactionMedian, 'reaction cannot be faster than the cap');
  assert(cheat.maxTurnRate === PRO_ENVELOPE.maxTurnRate, 'the hand cannot turn faster');
  assert(cheat.flickSigmaScale === PRO_ENVELOPE.flickSigmaScale, 'and cannot be more accurate');

  // A profile from anywhere else, e.g. fitted from a mimicked player, gets the
  // same treatment: clampToEnvelope is not optional and has no bypass.
  assert(withinEnvelope(clampToEnvelope({ maxTurnRate: 99999, reactionMedian: 0 })), 'any profile is clampable');

  // Worse than the floor is allowed. The wall is one-sided on purpose.
  const awful = skillProfile('mix', { maxTurnRate: 50 });
  assert(awful.maxTurnRate === 50, 'a deliberately terrible bot is legal');
  assert(withinEnvelope(awful), 'and still inside the envelope, which is a ceiling');
}

{
  const five = teamProfiles('t2', { 0: 'pro' });
  assert(five.length === 5, 'a side has five profiles');
  assert(five[0].maxTurnRate > five[1].maxTurnRate, 'the star AWPer is sharper than the team');
  assert(five.every(withinEnvelope), 'and everyone is still inside the envelope');
}

// ---- the turn rate is a hard wall -------------------------------------------

{
  const p = skillProfile('pro');
  const rng = new Rng(1);
  const motor = createMotor(p);
  motor.yaw = 0;

  // Ask for a 180 degree snap, every tick, forever.
  let maxObserved = 0;
  for (let t = 0; t < 200; t += 1) {
    const before = motor.yaw;
    stepMotor(motor, { tick: t, targetYaw: 180, distance: 800, moveSpeed: 0, weapon: 'ak47', rng });
    const rate = Math.abs(angleDelta(before, motor.yaw)) / TICK_DT;
    maxObserved = Math.max(maxObserved, rate);
  }
  assert(
    maxObserved <= p.maxTurnRate + 1e-6,
    `the crosshair never exceeds ${p.maxTurnRate} deg/s (saw ${maxObserved.toFixed(0)})`
  );

  // And it does get there, eventually, so the cap is a limit rather than a lock.
  assert(Math.abs(angleDelta(motor.yaw, 180)) < 1, 'a flick does complete');
}

// ---- reaction time ----------------------------------------------------------

{
  const rng = new Rng(7);
  const p = skillProfile('pro');
  const samples = [];
  for (let i = 0; i < 400; i += 1) {
    const m = createMotor(p);
    m.yaw = 0;
    acquire(m, { targetId: 'e1', targetYaw: 90, tick: 0, rng });
    samples.push(m.reactionReadyTick * TICK_DT);
  }
  samples.sort((a, b) => a - b);
  const median = samples[200];
  assert(median > 0.1, `even a pro takes over 100 ms to react (median ${median.toFixed(3)}s)`);
  assert(median < 0.35, 'but not half a second');
  assert(samples[0] > 0.05, 'and nobody ever reacts instantly');

  // A bot cannot fire before it has reacted, no matter how perfect the aim.
  const m = createMotor(p);
  m.yaw = 90;
  acquire(m, { targetId: 'e1', targetYaw: 90, tick: 0, rng });
  let firedEarly = false;
  for (let t = 0; t < m.reactionReadyTick; t += 1) {
    const r = stepMotor(m, { tick: t, targetYaw: 90, distance: 500, moveSpeed: 0, weapon: 'ak47', rng });
    if (r.fire) firedEarly = true;
  }
  assert(!firedEarly, 'no shot lands before the reaction gate opens');
}

{
  // Pre-aiming buys time. This is the mechanism that makes the DECISION to
  // pre-aim worth more than raw reflexes, which is the plan's claim in 8.1.
  const rng = new Rng(3);
  const p = skillProfile('pro');
  const mean = (preAimed) => {
    let sum = 0;
    for (let i = 0; i < 300; i += 1) {
      const m = createMotor(p);
      acquire(m, { targetId: `e${i}`, targetYaw: 0, tick: 0, rng, preAimed });
      sum += m.reactionReadyTick * TICK_DT;
    }
    return sum / 300;
  };
  const onAngle = mean(3);
  const surprised = mean(120);
  assert(surprised > onAngle, 'being surprised is slower than being pre-aimed');
  assert(surprised - onAngle > 0.1, `and by a lot (${((surprised - onAngle) * 1000).toFixed(0)} ms)`);
}

// ---- accuracy degrades the ways it should -----------------------------------

/** Fraction of fired shots that hit, over a long engagement. */
function hitRate({ level = 'pro', distance = 800, moveSpeed = 0, seed = 11, ticks = 4000 }) {
  const rng = new Rng(seed);
  const p = skillProfile(level);
  const m = createMotor(p);
  m.yaw = 0;
  acquire(m, { targetId: 'e1', targetYaw: 0, tick: 0, rng, preAimed: 0 });
  let fired = 0;
  let hit = 0;
  for (let t = 0; t < ticks; t += 1) {
    const r = stepMotor(m, { tick: t, targetYaw: 0, distance, moveSpeed, weapon: 'ak47', rng });
    if (!r.fire) continue;
    fired += 1;
    if (resolveShot(m, { distance, rng, weapon: 'ak47', moveSpeed }).hit) hit += 1;
  }
  return { fired, hit, rate: fired ? hit / fired : 0 };
}

{
  const near = hitRate({ distance: 400 });
  const far = hitRate({ distance: 2500 });
  assert(near.fired > 50 && far.fired > 10, 'both engagements produced shots');
  assert(
    near.rate > far.rate + 0.1,
    `accuracy falls with range (${near.rate.toFixed(2)} vs ${far.rate.toFixed(2)})`
  );

  const still = hitRate({ distance: 900, moveSpeed: 0 });
  const running = hitRate({ distance: 900, moveSpeed: 215 });
  assert(
    running.fired < still.fired || running.rate < still.rate,
    'firing on the move is worse: fewer shots taken, or more of them missing'
  );
}

{
  const pro = hitRate({ level: 'pro', distance: 1000 });
  const mix = hitRate({ level: 'mix', distance: 1000 });
  assert(pro.rate > mix.rate, `a pro out-shoots a mix bot (${pro.rate.toFixed(2)} vs ${mix.rate.toFixed(2)})`);
  // But a mix bot is not blind. "Worse" has to stay playable, or the ladder's
  // low end is not a team anybody would scrim against.
  assert(mix.rate > 0.1, `and a mix bot still hits things (${mix.rate.toFixed(2)})`);
  assert(pro.rate < 1, 'while a pro still misses some');
}

{
  // Recoil bloom: later bullets in a burst have a wider cone than early ones,
  // and the widening stops rather than running away. Measured on the SPREAD the
  // shot resolves against, not on the crosshair error, because the crosshair is
  // steady during a spray and the cone is what opens.
  const info = simWeapon('ak47');
  const m = createMotor(skillProfile('pro'));

  m.burst = 1;
  const first = recoilBloom(m, info);
  m.burst = 10;
  const tenth = recoilBloom(m, info);
  m.burst = 30;
  const thirtieth = recoilBloom(m, info);
  m.burst = 500;
  const absurd = recoilBloom(m, info);

  assert(first === 1, 'the first bullets are at the standing cone');
  assert(tenth > first, 'the tenth is wider');
  assert(thirtieth > tenth, 'and the thirtieth wider still');
  assert(absurd <= MAX_BLOOM + 1e-9, `but it stops at ${MAX_BLOOM}x (got ${absurd})`);
  assert(
    absurd === recoilBloom({ ...m, burst: info.magSize }, info),
    'and a burst past the magazine is the same as a full magazine, because the gun is empty'
  );

  const loose = createMotor(skillProfile('mix'));
  loose.burst = 12;
  m.burst = 12;
  assert(
    recoilBloom(loose, info) > recoilBloom(m, info),
    'a bot with worse spray discipline blooms harder'
  );
}

// ---- headshots are a tendency, never a guarantee -----------------------------

{
  const rng = new Rng(2);
  const m = createMotor(skillProfile('pro'));
  let heads = 0;
  let hits = 0;
  for (let i = 0; i < 2000; i += 1) {
    m.wobble = rng.range(-0.4, 0.4);
    const r = resolveShot(m, { distance: 600, rng, weapon: 'ak47' });
    if (!r.hit) continue;
    hits += 1;
    if (r.group === 'head') heads += 1;
  }
  const hs = heads / hits;
  assert(hs > 0.05, `a pro gets headshots (${(hs * 100).toFixed(0)}%)`);
  assert(hs < 0.75, 'but nowhere near all of them');
}

// ---- determinism -------------------------------------------------------------

{
  const run = () => {
    const rng = new Rng(99);
    const m = createMotor(skillProfile('t2'));
    acquire(m, { targetId: 'e1', targetYaw: 140, tick: 0, rng });
    const out = [];
    for (let t = 0; t < 400; t += 1) {
      const r = stepMotor(m, { tick: t, targetYaw: 140, distance: 700, moveSpeed: 30, weapon: 'ak47', rng });
      if (r.fire) out.push(`${t}:${resolveShot(m, { distance: 700, rng, weapon: 'ak47' }).group}`);
    }
    return out.join(',');
  };
  assert(run() === run(), 'the same seed reproduces the same gunfight, shot for shot');
}

{
  // Releasing a target stops the motor firing at it.
  const rng = new Rng(4);
  const m = createMotor(skillProfile('pro'));
  acquire(m, { targetId: 'e1', targetYaw: 0, tick: 0, rng, preAimed: 0 });
  for (let t = 0; t < 60; t += 1) {
    stepMotor(m, { tick: t, targetYaw: 0, distance: 500, moveSpeed: 0, weapon: 'ak47', rng });
  }
  release(m);
  const after = stepMotor(m, { tick: 100, targetYaw: 0, distance: 500, moveSpeed: 0, weapon: 'ak47', rng });
  assert(!after.fire, 'a released target is not shot at');
  assert(m.burst === 0, 'and the burst resets');
}

console.log('aimMotor: ok');
