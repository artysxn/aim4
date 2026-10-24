// ---------------------------------------------------------------------------
// src/cs3d/demoRecoil.test.js
// The replayed spray must be the spray the explorer's frame loop produces, at
// any tick, and must not care what order the ticks are asked in (a rewind
// asks them backwards).
//
// Run: node src/cs3d/demoRecoil.test.js
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { demoSprayPunch, shotsByPlayer, SPRAY_GAP_SECONDS } from './demoRecoil.js';
import { createRecoilState, fireRecoil, updateRecoil, updateRecoilIndex, aimPunch, cameraPunch } from '../../shared/sim3d/recoil.js';

const AK47 = {
  name: 'ak47',
  auto: true,
  cycleTime: [0.1, 0.1],
  recoil: { seed: 223, angle: [0, 0], angleVariance: [70, 70], magnitude: [30, 30], magnitudeVariance: [0, 0] }
};
const M4A4 = {
  name: 'm4a1',
  auto: true,
  cycleTime: [0.09, 0.09],
  recoil: { seed: 38965, angle: [0, 0], angleVariance: [70, 70], magnitude: [23, 23], magnitudeVariance: [0, 0] }
};
const STATS = { ak47: AK47, m4a1: M4A4, knife: { name: 'knife' } };
const statsOf = (w) => STATS[w] || null;
const RATE = 64;

// A 12-shot AK spray (one shot every 6.4 ticks, rounded the way ticks are), a
// pause, then a 3-shot tap, all from player 'a'; player 'b' fires in between.
const shots = [];
for (let i = 0; i < 12; i++) shots.push({ tick: 1000 + Math.round(i * 6.4), player: 'a', weapon: 'ak47' });
shots.push({ tick: 1030, player: 'b', weapon: 'm4a1' });
for (let i = 0; i < 3; i++) shots.push({ tick: 1300 + i * 20, player: 'a', weapon: 'ak47' });
const byPlayer = shotsByPlayer(shots.slice().reverse());
const listA = byPlayer.get('a');

/** The explorer's way: a frame loop at `fps`, firing as each shot's time passes. */
function liveAt(endTick, fps = 512) {
  const state = createRecoilState();
  const dt = 1 / fps;
  let t = listA[0].tick / RATE;
  let i = 0;
  while (i < listA.length && listA[i].tick / RATE <= t + 1e-9) {
    fireRecoil(state, AK47, { now: listA[i].tick / RATE });
    i++;
  }
  while (t + dt <= endTick / RATE + 1e-9) {
    t += dt;
    updateRecoil(state, dt);
    updateRecoilIndex(state, dt, 0.1, t);
    while (i < listA.length && listA[i].tick / RATE <= t + 1e-9) {
      fireRecoil(state, AK47, { now: t });
      i++;
    }
  }
  return { aim: aimPunch(state), camera: cameraPunch(state) };
}

const close = (a, b, eps, msg) => {
  for (let k = 0; k < 2; k++) assert.ok(Math.abs(a[k] - b[k]) < eps, `${msg}: ${a[k]} vs ${b[k]}`);
};

// ---- before the first shot, nothing --------------------------------------
{
  const p = demoSprayPunch(listA, 999, RATE, statsOf);
  assert.deepEqual(p.aim, [0, 0, 0]);
  assert.deepEqual(p.camera, [0, 0, 0]);
}

// ---- the first bullet is on the crosshair; the punch builds after it -----
{
  const p = demoSprayPunch(listA, 1000, RATE, statsOf);
  assert.deepEqual(p.aim.slice(0, 2), [0, 0], 'a shot kicks the velocity, not the punch');
  // CS2's second bullet is only ~0.1 deg off (recoil.js hybridDecay); by the
  // fourth the climb is well under way.
  const second = demoSprayPunch(listA, 1006, RATE, statsOf);
  assert.ok(second.aim[0] < 0 && second.aim[0] > -0.3, `second shot barely off: ${second.aim[0]}`);
  const fourth = demoSprayPunch(listA, 1019, RATE, statsOf);
  assert.ok(fourth.aim[0] < -1, `the AK climbs (pitch negative is up): ${fourth.aim[0]}`);
}

// ---- matches the frame-loop simulation through the spray -----------------
for (const at of [1006, 1032, 1070, 1072.5, 1100]) {
  const ours = demoSprayPunch(listA, at, RATE, statsOf);
  const live = liveAt(at);
  close(ours.aim, live.aim, 0.05, `aim at tick ${at}`);
  close(ours.camera, live.camera, 0.05, `camera at tick ${at}`);
}

// ---- the camera takes the shake plus 45% of the punch --------------------
{
  const p = demoSprayPunch(listA, 1050, RATE, statsOf);
  assert.ok(Math.abs(p.camera[0]) < Math.abs(p.aim[0]), 'the view shows less than the bullets take');
}

// ---- order of asking does not matter (a rewind asks backwards) ----------
{
  const ticks = [];
  for (let t = 1000; t <= 1120; t += 0.75) ticks.push(t);
  const fwd = ticks.map((t) => demoSprayPunch(listA, t, RATE, statsOf).aim.slice());
  const back = ticks
    .slice()
    .reverse()
    .map((t) => demoSprayPunch(listA, t, RATE, statsOf).aim.slice())
    .reverse();
  assert.deepEqual(back, fwd);
}

// ---- a long enough pause starts a new spray from the top -----------------
{
  const gapTicks = SPRAY_GAP_SECONDS * RATE;
  const idle = demoSprayPunch(listA, 1070 + gapTicks + 1, RATE, statsOf);
  assert.deepEqual(idle.aim, [0, 0, 0], 'long after the spray, no punch');
  // The tap at 1300 is a fresh spray: its second shot kicks like a second shot.
  const tap = demoSprayPunch(listA, 1325, RATE, statsOf);
  const fresh = demoSprayPunch(
    [
      { tick: 0, player: 'a', weapon: 'ak47' },
      { tick: 20, player: 'a', weapon: 'ak47' }
    ],
    25,
    RATE,
    statsOf
  );
  close(tap.aim, fresh.aim, 1e-9, 'tap after a pause');
}

// ---- other players' shots and knives do not kick --------------------------
{
  assert.equal(byPlayer.get('b').length, 1);
  const knife = demoSprayPunch([{ tick: 10, player: 'a', weapon: 'knife' }], 20, RATE, statsOf);
  assert.deepEqual(knife.aim, [0, 0, 0]);
  assert.deepEqual(demoSprayPunch(null, 10, RATE, statsOf).aim, [0, 0, 0]);
}

console.log('demoRecoil: ok');
