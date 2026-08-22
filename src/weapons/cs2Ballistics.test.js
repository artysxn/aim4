// Run: node src/weapons/cs2Ballistics.test.js
//
// The trainer firing CS2's numbers.
//
// The ballistics themselves are already covered by shared/sim3d/recoil.test.js,
// which holds the punch series measured off six GOTV demos. What is NOT covered
// there, and is entirely this file's, is the wiring: the order the two models
// are driven in, the unit conversions, and the frame the direction comes out in.
// Each of the three fails in a way that still produces a plausible spray:
//
//   · **The order.** The bullet leaves with the CURRENT punch and the CURRENT
//     penalty; only then do this shot's kick and this shot's penalty land, on
//     the NEXT one. Kick first and the first bullet of every spray is off the
//     crosshair — the one thing every CS player knows is not true, and a
//     pattern that is otherwise identical.
//   · **The units.** The trainer counts metres and the accuracy model counts
//     Source units per second. Feed it metres and 5.4 m/s reads as 5 u/s,
//     which is under the threshold where movement costs anything at all: a
//     sprinting player would shoot like a standing one.
//   · **The frame.** Source pitch is positive DOWN and yaw positive LEFT; the
//     trainer's camera is the other way on both. Get a sign wrong and the
//     spray goes down, or mirrors.

import { CS2Ballistics } from './cs2Ballistics.js';
import { sprayPattern, RECOIL_SCALE } from '../../shared/sim3d/recoil.js';
import { UNIT_M } from '../../shared/sim3d/units.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${msg}`);
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- a stand-in for the weapons pack ----------------------------------------
// The AK's real row, as `scripts/cs3d-weapons.mjs` writes it.
const AK = {
  name: 'ak47',
  auto: true,
  bullets: 1,
  maxSpeed: 215,
  cycleTime: [0.1, 0.1],
  clip: 30,
  tracerFrequency: 3,
  recoil: {
    seed: 223,
    angle: [0, 0],
    angleVariance: [70, 70],
    magnitude: [30, 30],
    magnitudeVariance: [0, 0],
    recoveryTimeStand: 0.368,
    recoveryTimeCrouch: 0.305257,
    recoveryTimeStandFinal: 0.506,
    recoveryTimeCrouchFinal: 0.419728,
    recoveryTransitionStartBullet: 2,
    recoveryTransitionEndBullet: 5
  },
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
  }
};
const AWP = { ...AK, name: 'awp', auto: false, maxSpeed: 200, cycleTime: [1.455, 1.455], clip: 5 };
const pack = { stats: (n) => (n === 'ak47' ? AK : n === 'awp' ? AWP : null) };
const make = (name = 'ak47') => {
  const b = new CS2Ballistics({ assets: pack });
  b.setWeapon(name);
  return b;
};
const STILL = { onGround: true, speedHoriz: 0, velY: 0, crouchAmt: 0, walking: false };

// ---- the table it reads -----------------------------------------------------
{
  const b = make();
  assert(b.ready, 'a weapon with a recoil block is ready');
  close(b.cycleTime(), 0.1, 1e-9, 'the cycle time is the table\'s');
  assert(b.clipSize() === 30, 'and so is the magazine');

  const awp = make('awp');
  close(awp.cycleTime(), 1.455, 1e-9, 'AWP cycle time');

  const none = new CS2Ballistics({ assets: pack });
  none.setWeapon('nothing_like_this');
  assert(!none.ready, 'an unknown weapon is not ready — the trainer falls back');

  // The pack lands AFTER a scenario has already asked for a weapon: the row
  // must be picked up then, not stay null for the session.
  let live = null;
  const late = new CS2Ballistics({ assets: { stats: () => live } });
  late.setWeapon('ak47');
  assert(!late.ready, 'not ready while the pack is still loading');
  live = AK;
  assert(late.ready, 'and ready as soon as it lands, with no second setWeapon');
}

// ---- the spray is the game's, shot for shot ---------------------------------
{
  const b = make();
  const ref = sprayPattern(AK, 30);
  let worst = 0;
  for (let i = 0; i < 30; i++) {
    const p = b.aimPunchDeg([0, 0, 0]);
    // Source QAngle → screen: pitch+ is down and yaw+ is left, so both flip.
    const mine = { x: -p[1], y: -p[0] };
    worst = Math.max(worst, Math.hypot(mine.x - ref[i].x, mine.y - ref[i].y));
    b.fire({ yaw: 0, pitch: 0, player: STILL, now: i * 0.1 });
    b.update(0.1, STILL, i * 0.1);
  }
  close(worst, 0, 1e-9, 'the whole 30-shot spray matches sprayPattern exactly');
}

// ---- the first bullet is on the crosshair -----------------------------------
{
  const b = make();
  const p = b.aimPunchDeg([0, 0, 0]);
  close(p[0], 0, 1e-12, 'no punch before the first shot (pitch)');
  close(p[1], 0, 1e-12, 'no punch before the first shot (yaw)');
  b.fire({ yaw: 0, pitch: 0, player: STILL, now: 0 });
  // ...and the kick it just took is velocity, so the punch is STILL zero until
  // time passes. Firing before updating must not move the second bullet much.
  const after = b.aimPunchDeg([0, 0, 0]);
  close(after[0], 0, 1e-12, 'a shot kicks the velocity, never the punch itself');
}

// ---- the direction, in the trainer's frame ----------------------------------
{
  const b = make();
  const DEGREES = 180 / Math.PI;  // eslint-disable-line no-unused-vars
  // Camera at yaw 0 / pitch 0 looks down −z in three.
  const s0 = b.fire({ yaw: 0, pitch: 0, player: STILL, now: 0 });
  const ang = (d) => ({
    right: Math.atan2(d.x, -d.z) * DEGREES,
    up: Math.atan2(d.y, Math.hypot(d.x, d.z)) * DEGREES
  });
  const a0 = ang(s0.dir);
  // The first bullet is inside the weapon's irreducible spread (0.0006 rad),
  // which is 0.034° — not zero, and not more than that either.
  assert(Math.hypot(a0.right, a0.up) < 0.06, `first bullet is on the crosshair (${a0.right}, ${a0.up})`);
  close(Math.hypot(s0.dir.x, s0.dir.y, s0.dir.z), 1, 1e-9, 'the direction is a unit vector');

  // Walk the punch up, then check the bullet follows it.
  //
  // The tolerance is the cone, computed rather than guessed: a standing AK
  // draws inside `stand + spread` = 0.00701 rad, which is 0.40°. Anything
  // tighter than that fails at random on the draw, and anything much looser
  // would not catch a sign error.
  const CONE_DEG = (AK.accuracy.stand[0] + AK.accuracy.spread[0]) * DEGREES;
  for (let i = 0; i < 6; i++) {
    b.fire({ yaw: 0, pitch: 0, player: STILL, now: i * 0.1 });
    b.update(0.1, STILL, i * 0.1);
  }
  const p = b.aimPunchDeg([0, 0, 0]);
  const s = b.fire({ yaw: 0, pitch: 0, player: STILL, now: 0.6 });
  const a = ang(s.dir);
  // Source pitch is positive DOWN, so a gun that kicks UP carries a NEGATIVE
  // punch pitch. Getting that backwards is a spray that goes into the floor.
  assert(p[0] < -1, `the punch has built up, and upward (${p[0].toFixed(3)}°)`);
  close(a.up, -p[0], CONE_DEG, 'the bullet goes up by the punch');
  close(a.right, -p[1], CONE_DEG, 'and sideways by it, mirrored (Source yaw is positive LEFT)');
}

// ---- turning the camera carries the whole thing with it ---------------------
{
  const b = make();
  const s = b.fire({ yaw: Math.PI / 2, pitch: 0, player: STILL, now: 0 });
  // three yaw +90° faces −x.
  close(s.dir.x, -1, 0.01, 'yaw +90° shoots down −x');
  close(s.dir.z, 0, 0.01, 'and nothing down z');
  const up = make().fire({ yaw: 0, pitch: Math.PI / 4, player: STILL, now: 0 });
  close(up.dir.y, Math.SQRT1_2, 0.01, 'the trainer\'s pitch is positive UP');
}

// ---- the units the accuracy model counts in ---------------------------------
{
  const b = make();
  // 250 u/s is 6.35 m/s. Handing the model metres would read as 6 u/s, which
  // is below the threshold where moving costs anything at all.
  const running = { onGround: true, speedHoriz: 250 * UNIT_M, velY: 0, crouchAmt: 0, walking: false };
  const state = b.playerState(running);
  close(state.speed, 250, 1e-9, 'metres per second become Source units per second');

  const inacc = (player) => {
    const t = make();
    t.update(1, player, 0);
    return t.fire({ yaw: 0, pitch: 0, player, now: 0 }).inaccuracy;
  };
  const still = inacc(STILL);
  const run = inacc(running);
  const crouch = inacc({ ...STILL, crouchAmt: 1 });
  const air = inacc({ onGround: false, speedHoriz: 0, velY: 3, crouchAmt: 0, walking: false });
  close(still, AK.accuracy.stand[0], 1e-6, 'standing is the table\'s stand value');
  close(crouch, AK.accuracy.crouch[0], 1e-6, 'crouched is the table\'s crouch value');
  close(run, AK.accuracy.stand[0] + AK.accuracy.move[0], 1e-5, 'running is stand + the full move penalty');
  assert(run > still * 20, `running is far worse than standing (${run} vs ${still})`);
  assert(air > run, `and the air is worse still (${air})`);

  // The crouch follows the BODY, not the key: half-way down is still standing.
  const half = make().playerState({ ...STILL, crouchAmt: 0.4 });
  assert(half.ducking === false, 'a partial crouch does not count yet');
  assert(make().playerState({ ...STILL, crouchAmt: 0.9 }).ducking === true, 'a full one does');
}

// ---- the camera sees 45% of what the bullets do -----------------------------
{
  const b = make();
  for (let i = 0; i < 8; i++) {
    b.fire({ yaw: 0, pitch: 0, player: STILL, now: i * 0.1 });
    b.update(0.1, STILL, i * 0.1);
  }
  const aim = b.aimPunchDeg([0, 0, 0]);
  const cam = b.cameraPunchDeg([0, 0, 0]);
  // Both are negative — the gun kicks up and Source pitch is positive down —
  // so this compares magnitudes.
  assert(aim[0] < -1, `the spray has climbed (${aim[0].toFixed(3)}°)`);
  assert(Math.abs(cam[0]) < Math.abs(aim[0]), `the camera lags the bullets (${cam[0]} vs ${aim[0]})`);
  // The gap is the whole point: 0.45 of the aim punch plus the cosmetic shake,
  // so the ratio sits near 0.45 and never reaches 1.
  const ratio = cam[0] / aim[0];
  assert(ratio > 0.4 && ratio < 0.75, `the camera takes about 45% of it (got ${ratio.toFixed(3)})`);
}

// ---- a scoped weapon reads the second column --------------------------------
{
  const b = make('awp');
  b.setMode(1);
  close(b.cycleTime(), AWP.cycleTime[1], 1e-9, 'scoped cycle time');
  assert(b.mode === 1, 'the mode is remembered');
  b.setMode(0);
  assert(b.mode === 0, 'and cleared');
}

// ---- reset ------------------------------------------------------------------
{
  const b = make();
  for (let i = 0; i < 5; i++) {
    b.fire({ yaw: 0, pitch: 0, player: STILL, now: i * 0.1 });
    b.update(0.1, STILL, i * 0.1);
  }
  assert(b.recoil.index > 0 && b.accuracy.penalty > 0, 'state built up');
  b.reset();
  assert(b.recoil.index === 0, 'reset clears the spray index');
  assert(b.accuracy.penalty === 0, 'and the accuracy penalty');
  close(b.aimPunchDeg([0, 0, 0])[0], 0, 1e-12, 'and the punch');
}

// ---- switching weapons resets, holding the same one does not ----------------
{
  const b = make();
  b.fire({ yaw: 0, pitch: 0, player: STILL, now: 0 });
  b.update(0.1, STILL, 0);
  const idx = b.recoil.index;
  b.setWeapon('ak47');
  close(b.recoil.index, idx, 1e-12, 're-asking for the same weapon does not reset mid-spray');
  b.setWeapon('awp');
  assert(b.recoil.index === 0, 'switching weapons does');
}

assert(RECOIL_SCALE === 2, 'weapon_recoil_scale is still 2 (the punch series assumes it)');

if (failures) {
  console.error(`cs2Ballistics.test.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('cs2Ballistics.test.js: ok');
