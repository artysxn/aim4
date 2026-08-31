// ---------------------------------------------------------------------------
// utils/sourceMouse.test.js
//   node --test src/utils/sourceMouse.test.js
//
// Checked against the engine, not against itself. The numbers below are the
// ones a player can verify in CS2 with a mouse and a wall, which is the only
// standard that matters here: if a sensitivity typed into the trainer does not
// turn the same amount as the same number in the game, the trainer is teaching
// muscle memory that does not transfer.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEL_OFF,
  ACCEL_POW_ONLY,
  ACCEL_POW_SCALE,
  ACCEL_POW_SCALE_AXIS,
  CL_PITCHDOWN,
  CL_PITCHUP,
  M_PITCH_DEFAULT,
  M_YAW_DEFAULT,
  SENSITIVITY_DEFAULT,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  applyMouse,
  cm360,
  countsPer360,
  degreesPerCount,
  scaleMouse,
  sensitivityForCm360
} from './sourceMouse.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- the constants -----------------------------------------------------------

test('the engine defaults are the engine defaults', () => {
  assert.equal(M_YAW_DEFAULT, 0.022);
  assert.equal(M_PITCH_DEFAULT, 0.022);
  assert.equal(SENSITIVITY_DEFAULT, 2.5);
  assert.equal(SENSITIVITY_MIN, 0.0001, 'the sensitivity ConVar lower bound');
  assert.equal(SENSITIVITY_MAX, 1000, 'and its upper bound');
  assert.equal(CL_PITCHDOWN, 89);
  assert.equal(CL_PITCHUP, 89);
});

// ---- the whole relationship --------------------------------------------------

test('one count at sensitivity 1 turns exactly m_yaw degrees', () => {
  assert.ok(near(degreesPerCount(1), 0.022));
  assert.ok(near(degreesPerCount(2.5), 0.055), 'and the default is 0.055');
});

test('a full turn takes the counts the game says it does', () => {
  // 360 / (0.022 * 2.5) = 6545.4545…
  assert.ok(near(countsPer360(2.5), 360 / 0.055, 1e-9));
  // Doubling the sensitivity halves the distance. Source has no curve here.
  assert.ok(near(countsPer360(5), countsPer360(2.5) / 2, 1e-9));
});

test('cm/360 matches the figures players actually quote', () => {
  // The canonical reference every sensitivity converter agrees on: 800 CPI at
  // sensitivity 1 is 51.9 cm for a full turn.
  assert.ok(Math.abs(cm360(1, 800) - 51.95) < 0.05, `800 at 1: ${cm360(1, 800)}`);
  // And it halves with the sensitivity, because the scale is linear.
  assert.ok(Math.abs(cm360(2, 800) - 25.98) < 0.05, `800 at 2: ${cm360(2, 800)}`);
  // The stock 800 CPI, sensitivity 2.5 setup.
  assert.ok(Math.abs(cm360(2.5, 800) - 20.78) < 0.05, `800 at 2.5: ${cm360(2.5, 800)}`);
  // Halving the CPI doubles the distance.
  assert.ok(Math.abs(cm360(2.5, 400) - 41.56) < 0.05, `400 at 2.5: ${cm360(2.5, 400)}`);
});

test('cm/360 and the sensitivity that produces it are inverses', () => {
  for (const [s, dpi] of [[2.5, 800], [1.1, 1600], [0.7, 3200], [4, 400]]) {
    const back = sensitivityForCm360(cm360(s, dpi), dpi);
    assert.ok(near(back, s, 1e-9), `${s} at ${dpi} round-tripped to ${back}`);
  }
});

// ---- ScaleMouse --------------------------------------------------------------

test('with acceleration off, scaling is one multiplication', () => {
  const out = scaleMouse(10, -4, { sensitivity: 2.5, customAccel: ACCEL_OFF });
  assert.ok(near(out.x, 25));
  assert.ok(near(out.y, -10));
});

test('the sensitivity ConVar bounds are enforced, as the engine enforces them', () => {
  assert.ok(near(scaleMouse(1, 0, { sensitivity: 0 }).x, SENSITIVITY_MIN));
  assert.ok(near(scaleMouse(1, 0, { sensitivity: 99999 }).x, SENSITIVITY_MAX));
});

test('custom acceleration mode 1 follows pow(distance, exp) * scale + sens', () => {
  const cfg = {
    sensitivity: 2.5,
    customAccel: ACCEL_POW_SCALE,
    accelScale: 0.04,
    accelExponent: 1.05,
    accelMax: 0
  };
  const mx = 6;
  const my = 8; // distance exactly 10
  const expected = Math.pow(10, 1.05) * 0.04 + 2.5;
  const out = scaleMouse(mx, my, cfg);
  assert.ok(near(out.x, mx * expected));
  assert.ok(near(out.y, my * expected));
});

test('m_customaccel_max of zero means no limit, not a limit of zero', () => {
  // The engine tests `> 0.0001` for exactly this reason. Reading 0 as a cap
  // would freeze the view at any sensitivity.
  const cfg = { sensitivity: 2.5, customAccel: ACCEL_POW_SCALE, accelMax: 0 };
  assert.ok(scaleMouse(50, 0, cfg).x > 0);
  const capped = { ...cfg, accelMax: 3 };
  assert.ok(near(scaleMouse(50, 0, capped).x, 150), 'and a real cap does cap');
});

test('mode 2 is mode 1 with the axis factors applied a second time', () => {
  const base = { sensitivity: 2.5, accelScale: 0.04, accelExponent: 1.05, accelMax: 0 };
  const one = scaleMouse(6, 8, { ...base, customAccel: ACCEL_POW_SCALE });
  const two = scaleMouse(6, 8, { ...base, customAccel: ACCEL_POW_SCALE_AXIS });
  assert.ok(near(two.x, one.x * M_YAW_DEFAULT));
  assert.ok(near(two.y, one.y * M_PITCH_DEFAULT));
});

test('mode 3 raises the squared distance to half the reduced exponent', () => {
  const cfg = { sensitivity: 2.5, customAccel: ACCEL_POW_ONLY, accelExponent: 1.4 };
  const mx = 3;
  const my = 4;
  const expected = Math.pow(25, (1.4 - 1) / 2) * 2.5;
  const out = scaleMouse(mx, my, cfg);
  assert.ok(near(out.x, mx * expected));
  assert.ok(near(out.y, my * expected));
});

test('mode 3 with exponent 1 is plain sensitivity', () => {
  // pow(anything, 0) is 1, so the curve collapses back to no acceleration.
  const cfg = { sensitivity: 2.5, customAccel: ACCEL_POW_ONLY, accelExponent: 1 };
  assert.ok(near(scaleMouse(9, 0, cfg).x, 9 * 2.5));
});

// ---- ApplyMouse --------------------------------------------------------------

test('right turns the view right, and down looks down', () => {
  // Source yaw decreases as the mouse goes right; pitch is positive-downward.
  const scaled = scaleMouse(100, 100, { sensitivity: 2.5 });
  const out = applyMouse(0, 0, scaled.x, scaled.y);
  assert.ok(near(out.yaw, -(0.022 * 250)), 'yaw decreases');
  assert.ok(near(out.pitch, 0.022 * 250), 'pitch increases downward');
});

test('a hundred counts at the default turns 5.5 degrees', () => {
  const scaled = scaleMouse(100, 0, { sensitivity: 2.5 });
  const out = applyMouse(0, 0, scaled.x, scaled.y);
  assert.ok(near(Math.abs(out.yaw), 5.5), `got ${Math.abs(out.yaw)}`);
});

test('pitch stops at the engine limits and yaw never does', () => {
  const far = scaleMouse(0, 100000, { sensitivity: 2.5 });
  assert.equal(applyMouse(0, 0, far.x, far.y).pitch, CL_PITCHDOWN);
  const up = scaleMouse(0, -100000, { sensitivity: 2.5 });
  assert.equal(applyMouse(0, 0, up.x, up.y).pitch, -CL_PITCHUP);
  // Yaw has no clamp in the engine; it wraps elsewhere.
  const spin = scaleMouse(100000, 0, { sensitivity: 2.5 });
  assert.ok(Math.abs(applyMouse(0, 0, spin.x, spin.y).yaw) > 360);
});

test('the pitch limits are configurable, like the ConVars they came from', () => {
  const far = scaleMouse(0, 100000, { sensitivity: 2.5 });
  assert.equal(applyMouse(0, 0, far.x, far.y, { pitchDown: 45 }).pitch, 45);
});

test('accumulating counts one at a time equals moving them all at once', () => {
  // No hidden per-event state: the relationship is linear, so a 240 Hz mouse
  // and a 1000 Hz mouse land on the same angle for the same total travel.
  const cfg = { sensitivity: 2.5 };
  let angles = { yaw: 0, pitch: 0 };
  for (let i = 0; i < 100; i++) {
    const s = scaleMouse(1, 0, cfg);
    angles = applyMouse(angles.yaw, angles.pitch, s.x, s.y);
  }
  const once = scaleMouse(100, 0, cfg);
  const bulk = applyMouse(0, 0, once.x, once.y);
  assert.ok(near(angles.yaw, bulk.yaw, 1e-9));
});

test('acceleration is the one mode where that stops being true', () => {
  // Stated rather than hidden: with m_customaccel on, the split of a movement
  // across events changes the result. That is the engine's behaviour too.
  const cfg = { sensitivity: 2.5, customAccel: ACCEL_POW_SCALE, accelScale: 0.04 };
  const split = scaleMouse(50, 0, cfg).x + scaleMouse(50, 0, cfg).x;
  const whole = scaleMouse(100, 0, cfg).x;
  assert.ok(Math.abs(split - whole) > 1, 'acceleration is not additive');
});
