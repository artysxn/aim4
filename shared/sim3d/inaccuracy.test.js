// ---------------------------------------------------------------------------
// shared/sim3d/inaccuracy.test.js
// The cone: its shape, its state machine, and the numbers a player would feel.
//
// Run: node --test shared/sim3d/inaccuracy.test.js
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAccuracyState,
  updateAccuracy,
  addFireInaccuracy,
  getInaccuracy,
  getSpread,
  sampleCone,
  bulletDirection,
  recoveryTime
} from './inaccuracy.js';

/** The AK-47's accuracy block, straight out of `scripts/weapons.vdata`. */
const AK47 = {
  name: 'ak47',
  maxSpeed: 215,
  accuracy: {
    spread: [0.0006, 0.0006],
    stand: [0.00641, 0.00641],
    crouch: [0.00481, 0.00481],
    move: [0.17506, 0.17506],
    jump: [0.14076, 0.14076],
    land: [0.000242, 0.000242],
    ladder: [0.14, 0.14],
    fire: [0.0078, 0.0078],
    jumpInitial: 0.10094,
    jumpApex: 0,
    reload: 0,
    pitchShift: 0,
    spreadSeed: 0
  },
  recoil: {
    seed: 223,
    recoveryTimeStand: 0.368,
    recoveryTimeCrouch: 0.305257,
    recoveryTimeStandFinal: 0.506,
    recoveryTimeCrouchFinal: 0.419728,
    recoveryTransitionStartBullet: 2,
    recoveryTransitionEndBullet: 5
  }
};

const STANDING = { speed: 0, onGround: true, ducking: false, walking: false, recoilIndex: 0 };

test('standing still, the first bullet leaves in the weapon own cone', () => {
  const s = createAccuracyState();
  updateAccuracy(s, AK47, STANDING, 1 / 64);
  const inacc = getInaccuracy(s, AK47, STANDING);
  assert.ok(Math.abs(inacc - 0.00641) < 1e-9, `standing inaccuracy ${inacc}`);
  assert.equal(getSpread(AK47), 0.0006);
});

test('crouching is a quarter better, running is twenty-seven times worse', () => {
  const s = createAccuracyState();
  const crouch = { ...STANDING, ducking: true };
  for (let i = 0; i < 64; i++) updateAccuracy(s, AK47, crouch, 1 / 64);
  assert.ok(Math.abs(getInaccuracy(s, AK47, crouch) - 0.00481) < 1e-6);

  const run = { ...STANDING, speed: 215 };
  const s2 = createAccuracyState();
  updateAccuracy(s2, AK47, run, 1 / 64);
  const moving = getInaccuracy(s2, AK47, run);
  assert.ok(moving > 0.17, `running inaccuracy ${moving}`);
  assert.ok(moving / 0.00641 > 25, 'running should be a different weapon entirely');
});

test('walking takes the ramp linearly, which is what walking buys', () => {
  const at = (speed, walking) => {
    const s = createAccuracyState();
    const p = { ...STANDING, speed, walking };
    updateAccuracy(s, AK47, p, 1 / 64);
    return getInaccuracy(s, AK47, p);
  };
  // Halfway up the ramp: 0.34 to 0.95 of 215 is 73 to 204, so 138 u/s.
  const run = at(138, false);
  const walk = at(138, true);
  assert.ok(walk < run, 'walking must be more accurate than running at the same speed');
  assert.ok(run / walk > 1.5, `running only ${(run / walk).toFixed(2)}x worse`);
});

test('under a third of max speed costs nothing at all', () => {
  const s = createAccuracyState();
  const creep = { ...STANDING, speed: 215 * 0.33 };
  updateAccuracy(s, AK47, creep, 1 / 64);
  assert.ok(Math.abs(getInaccuracy(s, AK47, creep) - 0.00641) < 1e-9);
});

test('the penalty snaps up on the shot and eases back over the recovery time', () => {
  const s = createAccuracyState();
  updateAccuracy(s, AK47, STANDING, 1 / 64);
  const before = getInaccuracy(s, AK47, STANDING);
  addFireInaccuracy(s, AK47);
  const after = getInaccuracy(s, AK47, STANDING);
  assert.ok(Math.abs(after - before - 0.0078) < 1e-9, 'one shot adds exactly its fire inaccuracy');

  // A decade per recovery time: 0.368 s should take the ADDED penalty to a
  // tenth, not the whole cone (the stance floor stays).
  let t = 0;
  while (t < 0.368) {
    updateAccuracy(s, AK47, STANDING, 1 / 256);
    t += 1 / 256;
  }
  const left = getInaccuracy(s, AK47, STANDING) - before;
  assert.ok(left < 0.0078 * 0.12 && left > 0.0078 * 0.08, `after one recovery time, ${(left / 0.0078).toFixed(3)} left`);
});

test('a long spray recovers slower than a tap', () => {
  const tap = recoveryTime(AK47.accuracy, AK47.recoil, { ...STANDING, recoilIndex: 0 });
  const spray = recoveryTime(AK47.accuracy, AK47.recoil, { ...STANDING, recoilIndex: 8 });
  assert.ok(Math.abs(tap - 0.368) < 1e-9);
  assert.ok(Math.abs(spray - 0.506) < 1e-9);
  // ...and crouching recovers faster than standing.
  assert.ok(recoveryTime(AK47.accuracy, AK47.recoil, { ...STANDING, ducking: true }) < tap);
  // In the air it is four times the crouch value, the worst case in the game.
  const air = recoveryTime(AK47.accuracy, AK47.recoil, { ...STANDING, onGround: false });
  assert.ok(Math.abs(air - 0.305257 * 4) < 1e-9);
});

test('the cone is uniform in RADIUS, not in area', () => {
  // Density falls as 1/r, so half the bullets land inside HALF the radius —
  // where an area-uniform disc would put only a quarter of them.
  let inner = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const [p] = sampleCone({ seed: i, inaccuracy: 1, spread: 0, bullets: 1 });
    if (Math.hypot(p.x, p.y) < 0.5) inner++;
  }
  const frac = inner / N;
  assert.ok(frac > 0.44 && frac < 0.56, `${(frac * 100).toFixed(1)}% inside half the radius`);
});

test('a shotgun moves its whole pattern, then scatters it', () => {
  const pellets = sampleCone({ seed: 7, inaccuracy: 0.05, spread: 0.01, bullets: 9 });
  assert.equal(pellets.length, 9);
  const cx = pellets.reduce((a, p) => a + p.x, 0) / 9;
  const cy = pellets.reduce((a, p) => a + p.y, 0) / 9;
  const spreadOut = Math.max(...pellets.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  // Every pellet is within the SPREAD of the shared centre, not within the
  // inaccuracy: the inaccuracy offset is common to all nine.
  assert.ok(spreadOut <= 0.02, `pellets scattered ${spreadOut.toFixed(4)} from their own centre`);
});

test('the same seed fires the same bullet, a different one does not', () => {
  const a = sampleCone({ seed: 42, inaccuracy: 0.01, spread: 0.001 })[0];
  const b = sampleCone({ seed: 42, inaccuracy: 0.01, spread: 0.001 })[0];
  const c = sampleCone({ seed: 43, inaccuracy: 0.01, spread: 0.001 })[0];
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  // Only the low byte is used, so the pattern repeats every 256 shots.
  assert.deepEqual(a, sampleCone({ seed: 42 + 256, inaccuracy: 0.01, spread: 0.001 })[0]);
});

test('a zero cone shoots exactly where you look', () => {
  const d = bulletDirection(0, 0, 0, 0);
  assert.ok(Math.abs(d.x - 1) < 1e-12 && Math.abs(d.y) < 1e-12 && Math.abs(d.z) < 1e-12);
  // Pitch is positive DOWN in Source.
  const down = bulletDirection(90, 0, 0, 0);
  assert.ok(down.z < -0.999);
});

test('the cone offsets go right and up, in that order', () => {
  // At yaw 0 the player faces +x and their right is -y.
  const right = bulletDirection(0, 0, 0.1, 0);
  assert.ok(right.y < 0, 'a positive x offset must go to the shooter right');
  const up = bulletDirection(0, 0, 0, 0.1);
  assert.ok(up.z > 0, 'a positive y offset must go up');
  // And they are tangents: 0.1 of tangent is atan(0.1) = 5.71 degrees.
  const deg = (Math.atan2(-right.y, right.x) * 180) / Math.PI;
  assert.ok(Math.abs(deg - 5.7106) < 1e-3, `0.1 tangent came out ${deg} deg`);
});
