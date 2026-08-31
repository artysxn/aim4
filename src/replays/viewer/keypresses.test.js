// ---------------------------------------------------------------------------
// replays/viewer/keypresses.test.js
//   node --test src/replays/viewer/keypresses.test.js
//
// The overlay's whole worth is not lying. A key it shows must be one the
// player could actually have been holding given the motion, and the exact
// half (duck, scope, jump, shots) must follow the stored engine state to the
// tick. The fixtures below are synthetic tracks with known inputs.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  keysAt,
  walkCap,
  MOVE_MIN,
  SPACE_HOLD,
  M1_HOLD
} from './keypresses.js';
import { FLAG_ALIVE, FLAG_AIRBORNE, FLAG_DUCKING, FLAG_SCOPED } from '../shared/tickFormat.js';

const RATE = 64;
const DT = 1 / RATE;

/**
 * A sampler over a generated track. `gen(t)` returns partial state; the rest
 * defaults to a live, standing player at the origin.
 */
function track(gen) {
  return (tick, out = {}) => {
    const st = gen(tick);
    if (!st) return null;
    out.x = st.x ?? 0;
    out.y = st.y ?? 0;
    out.z = st.z ?? 0;
    out.yaw = st.yaw ?? 0;
    out.duckAmount = st.duckAmount ?? 0;
    out.flags = FLAG_ALIVE | (st.flags ?? 0);
    out.alive = true;
    return out;
  };
}

const keys = (over = {}) =>
  keysAt({ at: 100, rate: RATE, sample: track(() => ({})), ...over });

// ---- movement ---------------------------------------------------------------

test('standing still holds nothing', () => {
  const k = keys();
  assert.deepEqual(
    [k.w, k.a, k.s, k.d, k.ctrl, k.shift, k.space, k.m1, k.m2],
    [false, false, false, false, false, false, false, false, false]
  );
});

test('running straight at the view direction is W and only W', () => {
  // 250 u/s along +X, facing +X.
  const k = keys({ sample: track((t) => ({ x: t * 250 * DT, yaw: 0 })) });
  assert.deepEqual([k.w, k.a, k.s, k.d], [true, false, false, false]);
});

test('the view basis, not the world, decides which key it is', () => {
  // Same +X motion, but the player faces +Y: the world-east run is a D strafe.
  const k = keys({ sample: track((t) => ({ x: t * 250 * DT, yaw: 90 })) });
  assert.deepEqual([k.w, k.a, k.s, k.d], [false, false, false, true]);
  // Facing -X, that motion is backpedal.
  const b = keys({ sample: track((t) => ({ x: t * 250 * DT, yaw: 180 })) });
  assert.deepEqual([b.w, b.a, b.s, b.d], [false, false, true, false]);
});

test('a diagonal lights both of its keys', () => {
  const k = keys({
    sample: track((t) => ({ x: t * 180 * DT, y: t * 180 * DT, yaw: 0 }))
  });
  assert.deepEqual([k.w, k.a, k.s, k.d], [true, true, false, false]);
});

test('drifting slower than MOVE_MIN reads as no keys', () => {
  const k = keys({ sample: track((t) => ({ x: t * (MOVE_MIN / 2) * DT })) });
  assert.equal(k.w || k.a || k.s || k.d, false);
});

test('a counter-strafe brake shows the opposing key', () => {
  // Sprint +X at 250, then a hard brake: speed collapses to 0 in ~4 ticks.
  // While braking the velocity still points at +X (W), but the held key is S.
  const BRAKE = 96; // tick the brake starts
  const speedAt = (t) => (t < BRAKE ? 250 : Math.max(0, 250 - (t - BRAKE) * 62));
  let pos = 0;
  const xs = new Map();
  for (let t = 0; t <= 200; t++) {
    xs.set(t, pos);
    pos += speedAt(t) * DT;
  }
  const k = keysAt({ at: BRAKE + 2, rate: RATE, sample: track((t) => ({ x: xs.get(t) ?? 0, yaw: 0 })) });
  assert.equal(k.s, true, 'the brake key');
  assert.equal(k.w, false, 'not the direction of travel');
});

// ---- shift ------------------------------------------------------------------

test('a sustained walk-capped speed is Shift', () => {
  const cap = walkCap('ak47'); // 111.8
  const k = keys({
    sample: track((t) => ({ x: t * (cap - 5) * DT, yaw: 0 })),
    weaponName: 'ak47'
  });
  assert.equal(k.shift, true);
  assert.equal(k.w, true, 'still moving forward');
});

test('sprinting through the walk band is not Shift', () => {
  // 0 to 250 at CS-like accel (~21 u/s per tick): the band is crossed in a
  // few ticks and the window either side of any moment inside it is faster.
  let v = 0;
  let pos = 0;
  const xs = new Map();
  for (let t = 0; t <= 300; t++) {
    xs.set(t, pos);
    v = Math.min(250, t >= 100 ? v + 21.5 : 0);
    pos += v * DT;
  }
  const sample = track((t) => ({ x: xs.get(t) ?? 0, yaw: 0 }));
  // No tick of the run-up may read as Shift.
  for (let at = 100; at <= 120; at++) {
    const k = keysAt({ at, rate: RATE, sample, weaponName: 'ak47' });
    assert.equal(k.shift, false, `tick ${at} of the run-up`);
  }
});

test('full sprint with a rifle is never Shift', () => {
  const k = keys({ sample: track((t) => ({ x: t * 215 * DT })), weaponName: 'ak47' });
  assert.equal(k.shift, false);
});

// ---- state-mirror keys ------------------------------------------------------

test('rising duck is Ctrl, releasing is not', () => {
  // Down over 16 ticks, held, then up.
  const duck = (t) => (t < 100 ? 0 : t < 116 ? (t - 100) / 16 : t < 150 ? 1 : Math.max(0, 1 - (t - 150) / 16));
  const sample = track((t) => ({ duckAmount: duck(t), flags: duck(t) >= 1 ? FLAG_DUCKING : 0 }));
  assert.equal(keysAt({ at: 108, rate: RATE, sample }).ctrl, true, 'going down');
  assert.equal(keysAt({ at: 130, rate: RATE, sample }).ctrl, true, 'held');
  assert.equal(keysAt({ at: 156, rate: RATE, sample }).ctrl, false, 'released');
});

test('a jump lights Space, walking off a ledge does not', () => {
  const jump = track((t) => ({
    z: t < 100 ? 0 : Math.max(0, 55 * Math.sin(((t - 100) / 40) * Math.PI)),
    flags: t >= 100 && t < 140 ? FLAG_AIRBORNE : 0
  }));
  assert.equal(keysAt({ at: 104, rate: RATE, sample: jump }).space, true, 'just after takeoff');
  assert.equal(
    keysAt({ at: 100 + Math.floor(SPACE_HOLD * RATE) + 4, rate: RATE, sample: jump }).space,
    false,
    'the flash ends'
  );

  const fall = track((t) => ({
    z: t < 100 ? 0 : -(t - 100) * 2,
    flags: t >= 100 && t < 140 ? FLAG_AIRBORNE : 0
  }));
  assert.equal(keysAt({ at: 104, rate: RATE, sample: fall }).space, false, 'falling is not jumping');
});

test('scoped is Mouse2, exactly as stored', () => {
  const sample = track((t) => ({ flags: t >= 100 ? FLAG_SCOPED : 0 }));
  assert.equal(keysAt({ at: 99, rate: RATE, sample }).m2, false);
  assert.equal(keysAt({ at: 101, rate: RATE, sample }).m2, true);
});

// ---- mouse1 -----------------------------------------------------------------

test('a shot lights Mouse1 for its window, for the right player', () => {
  const shots = [{ tick: 100, player: 'p1' }];
  const base = { rate: RATE, sample: track(() => ({})), shots, playerId: 'p1' };
  assert.equal(keysAt({ ...base, at: 100 }).m1, true, 'on the shot tick');
  assert.equal(keysAt({ ...base, at: 100 + Math.floor(M1_HOLD * RATE) - 1 }).m1, true, 'still lit');
  assert.equal(keysAt({ ...base, at: 120 }).m1, false, 'released');
  assert.equal(keysAt({ ...base, at: 98 }).m1, false, 'never before the shot');
  assert.equal(keysAt({ ...base, at: 100, playerId: 'p2' }).m1, false, 'someone else fired');
});

test('a spray reads as one continuous press', () => {
  // 600 RPM = a shot every ~6.4 ticks; the hold window is longer than the gap.
  const shots = [];
  for (let i = 0; i < 10; i++) shots.push({ tick: 100 + Math.round(i * 6.4), player: 'p1' });
  const base = { rate: RATE, sample: track(() => ({})), shots, playerId: 'p1' };
  for (let at = 100; at <= 100 + Math.round(9 * 6.4); at++) {
    assert.equal(keysAt({ ...base, at }).m1, true, `tick ${at} mid-spray`);
  }
});

// ---- lifecycle --------------------------------------------------------------

test('a dead player holds nothing', () => {
  const sample = (tick, out = {}) => {
    out.x = tick * 250 * DT;
    out.flags = 0;
    out.alive = false;
    return out;
  };
  const k = keysAt({ at: 100, rate: RATE, sample, shots: [{ tick: 100 }] });
  assert.equal(k.w || k.m1 || k.ctrl, false);
});

test('a strided track still reads its own rows', () => {
  // Rows every 4 ticks: `at` snaps to a row and neighbours are real rows.
  const sample = track((t) => {
    if (t % 4 !== 0) throw new Error(`asked for an off-row tick: ${t}`);
    return { x: t * 250 * DT, yaw: 0 };
  });
  const k = keysAt({ at: 102, rate: RATE, stride: 4, sample });
  assert.equal(k.w, true);
});

console.log('keypresses.test.js: movement, counter-strafe, shift, state keys and shots all pass');
