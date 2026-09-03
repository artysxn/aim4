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

import { keysAt, walkCap, SPACE_HOLD, M1_HOLD } from './keypresses.js';
import { ACCEL, FRICTION, STOP_SPEED } from '../../../shared/sim3d/constants.js';
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

/**
 * Positions from a per-tick speed function, so every fixture below obeys the
 * movement code the reader inverts. A track that could not happen in CS2
 * proves nothing about a reader built on CS2's own equations.
 */
function fromSpeeds(speedAt, { dirX = 1, dirY = 0, from = 0, to = 300 } = {}) {
  const pos = new Map();
  let x = 0;
  let y = 0;
  for (let t = from; t <= to; t++) {
    pos.set(t, { x, y });
    const v = speedAt(t);
    x += dirX * v * DT;
    y += dirY * v * DT;
  }
  return pos;
}

/** Speed after one tick of Source friction with no key held. */
const coastStep = (v) => Math.max(0, v - Math.max(v, STOP_SPEED) * FRICTION * DT);

/** Speed after one tick of Accelerate() toward `wish` from a standstill run-up. */
const accelStep = (v, wish) => Math.min(wish, v + Math.min(ACCEL * wish * DT, wish - v));

// ---- movement ---------------------------------------------------------------

test('standing still holds nothing', () => {
  const k = keys();
  assert.deepEqual(
    [k.w, k.a, k.s, k.d, k.ctrl, k.shift, k.space, k.m1, k.m2],
    [false, false, false, false, false, false, false, false, false]
  );
});

test('running straight at the view direction is W and only W', () => {
  // 250 u/s along +X, facing +X. Steady speed is not zero input: the engine
  // is spending exactly the accel that cancels friction, and that is what the
  // reader recovers.
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

test('coasting on friction with nothing held shows nothing', () => {
  // The case a velocity-direction reading cannot get right: the player let go
  // at tick 100 and is still sliding forward at speed. Friction is doing all
  // of it, so the input left over is zero and no key may light.
  let v = 250;
  const pos = fromSpeeds((t) => {
    if (t < 100) return 250;
    v = coastStep(v);
    return v;
  });
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
  for (const at of [104, 108, 112, 116]) {
    const k = keysAt({ at, rate: RATE, sample });
    assert.equal(
      k.w || k.a || k.s || k.d,
      false,
      `tick ${at} of the slide still shows a key`
    );
  }
  // And before the release, W is lit: holding a sprint IS spending accel.
  assert.equal(keysAt({ at: 90, rate: RATE, sample }).w, true, 'the sprint before it');
});

test('a key press lights within a couple of ticks of the press', () => {
  // Standing still, then W at tick 100. The stencil is centred, so the edge
  // is not late; it is blurred by the half-width either way.
  let v = 0;
  const pos = fromSpeeds((t) => {
    if (t < 100) return 0;
    v = accelStep(v, 250);
    return v;
  });
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
  assert.equal(keysAt({ at: 96, rate: RATE, sample }).w, false, 'before the press');
  assert.equal(keysAt({ at: 102, rate: RATE, sample }).w, true, 'just after it');
});

test('a counter-strafe shows the brake key, not the direction of travel', () => {
  // Sprint +X, then S at tick 100: friction AND accelerate both pull back, so
  // the speed collapses far faster than a coast while the player is still
  // moving forward. Velocity says W the whole way down; the input says S.
  let v = 250;
  const pos = fromSpeeds((t) => {
    if (t < 100) return 250;
    v = Math.max(0, coastStep(v) - ACCEL * 250 * DT);
    return v;
  });
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
  for (const at of [102, 104]) {
    const k = keysAt({ at, rate: RATE, sample });
    assert.equal(k.s, true, `tick ${at}: the brake key`);
    assert.equal(k.w, false, `tick ${at}: not the direction of travel`);
  }
});

test('a counter-strafe and a release do not look alike', () => {
  // Both slow the player from a sprint while still sliding forward. Only one
  // of them has a key down, and the difference is the whole reason the reader
  // works off input rather than off velocity.
  const brake = (() => {
    let v = 250;
    return fromSpeeds((t) => (t < 100 ? 250 : (v = Math.max(0, coastStep(v) - ACCEL * 250 * DT))));
  })();
  const release = (() => {
    let v = 250;
    return fromSpeeds((t) => (t < 100 ? 250 : (v = coastStep(v))));
  })();
  const kb = keysAt({ at: 103, rate: RATE, sample: track((t) => brake.get(t) || { x: 0, y: 0 }) });
  const kr = keysAt({ at: 103, rate: RATE, sample: track((t) => release.get(t) || { x: 0, y: 0 }) });
  assert.equal(kb.s, true, 'the brake is a key');
  assert.equal(kr.s || kr.w || kr.a || kr.d, false, 'the release is not');
});

test('quantization jitter at a standstill lights nothing', () => {
  // Real positions arrive in quarter units, so a stationary player's stored
  // track wobbles by a quantum and the second difference of that is hundreds
  // of u/s². The standstill floor is what it has to clear, and cannot.
  const Q = 0.25;
  const sample = track((t) => ({
    x: Math.round(Math.sin(t * 1.7) * 0.6) * Q,
    y: Math.round(Math.cos(t * 2.3) * 0.6) * Q
  }));
  for (let at = 100; at < 130; at++) {
    const k = keysAt({ at, rate: RATE, sample });
    assert.equal(k.w || k.a || k.s || k.d, false, `tick ${at} invented a key`);
  }
});

test('a real press from a standstill still clears that floor', () => {
  // The floor is doubled at rest, so check the thing it must not break:
  // starting to move spends ACCEL × wishspeed, which is well past it.
  let v = 0;
  const pos = fromSpeeds((t) => (t < 100 ? 0 : (v = accelStep(v, 250))));
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
  assert.equal(keysAt({ at: 102, rate: RATE, sample }).w, true);
});

test('a held key survives a dip below the on threshold', () => {
  // Hysteresis. A steady sprint sits near the line once quantization is in
  // play, and a key that strobes every other tick is worse than no overlay.
  const pos = fromSpeeds((t) => (t < 100 ? 0 : 250));
  const raw = track((t) => pos.get(t) || { x: 0, y: 0 });
  // Same track, but one row nudged back a quantum: a single-tick dip.
  const dipped = (t, out = {}) => {
    const r = raw(t, out);
    if (t === 120) r.x -= 0.25;
    return r;
  };
  assert.equal(keysAt({ at: 120, rate: RATE, sample: raw }).w, true, 'the clean track');
  assert.equal(keysAt({ at: 120, rate: RATE, sample: dipped }).w, true, 'and through the dip');
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
  // 0 to 250 on the real Accelerate() curve: the walk band is crossed in a
  // few ticks and the speed a tenth of a second later is well past any cap.
  let v = 0;
  const pos = fromSpeeds((t) => (t < 100 ? 0 : (v = accelStep(v, 250))));
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
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

test('stopping from a sprint is not Shift', () => {
  // Release W at 250 u/s and coast on the real friction curve. The speed
  // passes down through the walk band on its way to zero, and the speed a
  // tenth of a second ahead is lower still, so a forward-only window reads
  // every stop as a tapped Shift. No tick of the run-down may.
  let v = 250;
  const pos = fromSpeeds((t) => (t < 100 ? 250 : (v = coastStep(v))));
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
  for (let at = 100; at <= 150; at++) {
    const k = keysAt({ at, rate: RATE, sample, weaponName: 'ak47' });
    assert.equal(k.shift, false, `tick ${at} of the run-down`);
  }
});

test('coasting under the walk cap with nothing held is not Shift', () => {
  // Under the cap on both sides of now, and nobody is walking: the key came
  // up and friction is doing the rest. Walking is a held key and spends
  // accel like one; this spends none.
  let v = 100;
  const pos = fromSpeeds((t) => (t < 100 ? 100 : (v = coastStep(v))));
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
  for (let at = 104; at <= 130; at++) {
    const k = keysAt({ at, rate: RATE, sample, weaponName: 'ak47' });
    assert.equal(k.shift, false, `tick ${at} of the coast`);
  }
});

test('walking from standstill is Shift once it is moving', () => {
  // Accelerate() toward the walk cap rather than the sprint cap. Behind is a
  // standstill (under the cap), ahead is a walk (under the cap), so the
  // two-sided window lights it as soon as the speed is readable at all.
  const cap = walkCap('ak47');
  let v = 0;
  const pos = fromSpeeds((t) => (t < 100 ? 0 : (v = accelStep(v, cap - 5))));
  const sample = track((t) => pos.get(t) || { x: 0, y: 0 });
  assert.equal(keysAt({ at: 112, rate: RATE, sample, weaponName: 'ak47' }).shift, true, 'early');
  assert.equal(keysAt({ at: 140, rate: RATE, sample, weaponName: 'ak47' }).shift, true, 'steady');
  assert.equal(keysAt({ at: 140, rate: RATE, sample, weaponName: 'ak47' }).w, true, 'and it is W');
});

// ---- state-mirror keys ------------------------------------------------------

test('rising duck is Ctrl, releasing is not', () => {
  // Down over 16 ticks, held, then up. The flag is set the way the parser
  // sets it (laihoe.js: m_bDucked OR amount > 0.5), which means it is STILL
  // SET for the first half of the release. The old fixture only raised it at
  // a full duck, so the old read passed here while lighting Ctrl on every
  // real release.
  const duck = (t) => (t < 100 ? 0 : t < 116 ? (t - 100) / 16 : t < 150 ? 1 : Math.max(0, 1 - (t - 150) / 16));
  const sample = track((t) => ({ duckAmount: duck(t), flags: duck(t) > 0.5 ? FLAG_DUCKING : 0 }));
  assert.equal(keysAt({ at: 108, rate: RATE, sample }).ctrl, true, 'going down');
  assert.equal(keysAt({ at: 130, rate: RATE, sample }).ctrl, true, 'held');
  assert.equal(keysAt({ at: 156, rate: RATE, sample }).ctrl, false, 'released, flag still set');
  for (let at = 152; at <= 166; at++) {
    assert.equal(keysAt({ at, rate: RATE, sample }).ctrl, false, `tick ${at} of the release`);
  }
});

test('a release stored as a duck nibble is not Ctrl on its plateaus', () => {
  // Stored duck is 0..15, so a slow release repeats a value on adjacent rows.
  // "next is not below now" is true on every one of those plateaus; the read
  // has to look further apart than the plateau is wide.
  const nib = (v) => Math.round(v * 15) / 15;
  const duck = (t) => (t < 100 ? 1 : Math.max(0, 1 - (t - 100) / 24));
  const sample = track((t) => ({ duckAmount: nib(duck(t)), flags: duck(t) > 0.5 ? FLAG_DUCKING : 0 }));
  assert.equal(keysAt({ at: 90, rate: RATE, sample }).ctrl, true, 'held before the release');
  for (let at = 102; at <= 122; at++) {
    assert.equal(keysAt({ at, rate: RATE, sample }).ctrl, false, `tick ${at} of the release`);
  }
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
