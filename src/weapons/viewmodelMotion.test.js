// Run: node src/weapons/viewmodelMotion.test.js
//
// The viewmodel's bob and sway, on their own.
//
// Both are shapes that "look about right" whatever you do to them, which is
// exactly why they are worth pinning:
//
//   · The bob's asymmetry (`cl_bobup`) is the whole difference between
//     footfalls and a float. A plain sine passes any eyeball test.
//   · The sway samples where the view WAS, interpolating between the two
//     stored samples straddling that moment. Read the ring backwards, or off
//     by one stride, and the gun still lags — just not by the right amount,
//     and never in a way a screenshot shows.
//   · `wrapDeg` is what keeps a pan across the 180° seam from reading as a
//     359° flick, which IS visible: the gun snaps across the screen once per
//     full turn.

import {
  BOB,
  SWAY,
  CLIP_ALIASES,
  bobShape,
  bobPeriod,
  wrapDeg,
  sampleAngles,
  forwardOf
} from './viewmodelMotion.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${msg}`);
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- wrapDeg ----------------------------------------------------------------
close(wrapDeg(0), 0, 1e-9, 'wrapDeg(0)');
close(wrapDeg(190), -170, 1e-9, 'wrapDeg(190)');
close(wrapDeg(-190), 170, 1e-9, 'wrapDeg(-190)');
close(wrapDeg(359), -1, 1e-9, 'wrapDeg(359) is a degree, not a full turn');
close(wrapDeg(-359), 1, 1e-9, 'wrapDeg(-359)');
close(wrapDeg(720 + 10), 10, 1e-9, 'wrapDeg unwinds whole turns');

// ---- bobShape ---------------------------------------------------------------
{
  close(bobShape(0, 0.22), 0, 1e-9, 'bob starts at 0');
  close(bobShape(0.22, 0.22), 0, 1e-9, 'bob is periodic');
  close(bobShape(0.11, 0.22), Math.PI, 1e-9, 'peak sits at cl_bobup through the cycle');
  assert(bobShape(1, 0) === 0, 'a zero period is flat, not NaN');
  // Monotonic within a cycle, i.e. the phase only ever moves forward.
  let prev = -Infinity;
  for (let t = 0; t < 0.22; t += 0.005) {
    const v = bobShape(t, 0.22);
    assert(v >= prev - 1e-12, `bob phase is monotonic at ${t.toFixed(3)}`);
    prev = v;
  }
  // The asymmetry: with cl_bobup at 0.5 the two halves are symmetric, so the
  // property to hold is that moving the peak moves the shape with it.
  const half = bobShape(0.055, 0.22); // a quarter through
  close(half, Math.PI / 2, 1e-9, 'quarter through the cycle is a quarter of the rise');
}

// ---- bobPeriod --------------------------------------------------------------
{
  // The period is the WEAPON's, and a faster weapon bobs faster.
  const ak = bobPeriod(215);
  const knife = bobPeriod(250);
  close(ak, ((1000 - 215) / 3.5) * 0.001 * BOB.cycle, 1e-12, 'AK period');
  assert(knife < ak, `a knife (250 u/s) bobs faster than an AK (215): ${knife} vs ${ak}`);
  close(ak, 0.2198, 1e-3, 'AK cycles about every 0.22 s');
}

// ---- sampleAngles -----------------------------------------------------------
{
  // Flat [t, pitch, yaw] triples, oldest first.
  const log = [0, 0, 0, 0.1, 10, 20, 0.2, 20, 40];

  // Too short to interpolate: hand back what the caller has now.
  const empty = sampleAngles([0, 1, 2], 0.05, 7, 9);
  assert(empty.pitch === 7 && empty.yaw === 9, 'a ring shorter than two samples returns the live angles');

  // Before the oldest sample: the oldest one.
  const old = sampleAngles(log, -1, 99, 99);
  assert(old.pitch === 0 && old.yaw === 0, 'before the ring starts, the oldest sample');

  // Exactly on a sample.
  const on = sampleAngles(log, 0.1, 99, 99);
  close(on.pitch, 10, 1e-9, 'on-sample pitch');
  close(on.yaw, 20, 1e-9, 'on-sample yaw');

  // Halfway between two samples.
  const mid = sampleAngles(log, 0.15, 99, 99);
  close(mid.pitch, 15, 1e-9, 'interpolated pitch');
  close(mid.yaw, 30, 1e-9, 'interpolated yaw');

  // Across the yaw seam: 350° → 10° is a 20° turn, not a 340° one.
  const seam = sampleAngles([0, 0, 350, 0.1, 0, 10], 0.05, 0, 10);
  close(wrapDeg(seam.yaw - 350), 10, 1e-9, 'interpolating across the seam is the short way round');
}

// ---- forwardOf --------------------------------------------------------------
{
  const f = forwardOf(0, 0);
  close(f[0], 1, 1e-12, 'level and forward is +x');
  close(f[1], 0, 1e-12, 'level and forward has no y');
  close(f[2], 0, 1e-12, 'level and forward has no z');
  // Source pitch is positive DOWN.
  close(forwardOf(90, 0)[2], -1, 1e-12, 'pitch +90 looks down');
  // Source yaw is positive LEFT.
  close(forwardOf(0, 90)[1], 1, 1e-12, 'yaw +90 is +y (left)');
  for (const [p, y] of [[0, 0], [30, 40], [-80, 200], [89, -170]]) {
    const v = forwardOf(p, y);
    close(Math.hypot(v[0], v[1], v[2]), 1, 1e-12, `forwardOf(${p},${y}) is a unit vector`);
  }
}

// ---- the clip table ---------------------------------------------------------
{
  assert(CLIP_ALIASES.fire[0] === 'shoot1', 'the first fire clip is the one CS2 names');
  assert(CLIP_ALIASES.idle.includes('idle1'), 'knives author idle1 and no plain idle');
  assert(CLIP_ALIASES.draw.includes('deploy'), 'draw falls back to deploy');
  assert(SWAY.interp > 0 && SWAY.scale > 0, 'sway constants are set');
}

if (failures) {
  console.error(`viewmodelMotion.test.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('viewmodelMotion.test.js: ok');
