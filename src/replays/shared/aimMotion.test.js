// The trainer's seven measurements, taken off synthetic rounds whose answer is
// arithmetic rather than opinion.
//
// The value of a fixture here is that a flick is a thing the test can DRAW: a
// player standing still, an enemy at a known angle, and a yaw ramp between two
// ticks. Everything the pass reports about that flick — how far it travelled,
// how long it took, how much of the gap it closed, whether it stopped short —
// is then a number the test can compute by hand, which is the only way to tell
// a working measurement from a plausible one.

import { writeHeader, writeRecord, HEADER_BYTES, TICK_BYTES, FLAG_ALIVE } from './tickFormat.js';
import {
  AIM_MOTION_BENCH,
  AIM_MOTION_FIELDS,
  AIM_V2_MIN_SAMPLE,
  addMotion,
  aimRating,
  aimRatingV2,
  aimTelemetry,
  emptyMotion,
  engineToHundred,
  motionEngineScores,
  motionHasSample,
  motionObject
} from './aimMetrics.js';
import { aimMotionFromRound } from './aimMotion.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

const TICK_RATE = 64;

function buildTicks(tickCount, at) {
  const buffer = new ArrayBuffer(HEADER_BYTES + tickCount * TICK_BYTES);
  const view = new DataView(buffer);
  writeHeader(view, { tickCount, firstTick: 0, stride: 1, tickRate: TICK_RATE, playerCount: 10 });
  for (let t = 0; t < tickCount; t++) {
    for (let slot = 0; slot < 10; slot++) writeRecord(view, t, slot, at(t, slot));
  }
  return buffer;
}

const alive = (over = {}) => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  health: 100,
  armor: 100,
  weapon: 0,
  flags: FLAG_ALIVE,
  flash: 0,
  side: 2,
  ...over
});

/** A on slot 0 (team 1), B on slot 5 (team 2). */
function twoPlayerMeta(events) {
  return {
    tickRate: TICK_RATE,
    map: 'de_test',
    players: [
      { id: 'aaa', name: 'A', team: 1, slot: 0 },
      { id: 'bbb', name: 'B', team: 2, slot: 5 }
    ],
    events: { kills: [], shots: [], grenades: [], bomb: [], damage: [], items: [], ...events }
  };
}

/**
 * A stands at the origin. B stands 1000 units away at 90°, i.e. straight up
 * the y axis, so "aiming at B" is yaw 90 and the angular gap from yaw 0 is a
 * flat 90 degrees.
 *
 * A rests at `restYaw` until `flickStart`, sweeps linearly to `endYaw` by
 * `shotTick`, and holds after. That is one flick, drawn.
 */
function flickFixture({
  restYaw = 0,
  endYaw = 90,
  flickStart = 60,
  shotTick = 70,
  ticks = 160,
  hit = false,
  killed = false
} = {}) {
  const yawAt = (t) => {
    if (t <= flickStart) return restYaw;
    if (t >= shotTick) return endYaw;
    return restYaw + ((endYaw - restYaw) * (t - flickStart)) / (shotTick - flickStart);
  };
  const buffer = buildTicks(ticks, (t, slot) => {
    if (slot === 0) return alive({ x: 0, y: 0, yaw: yawAt(t), side: 2 });
    if (slot === 5) return alive({ x: 0, y: 1000, yaw: -90, side: 3 });
    // Everyone else is dead and out of the way.
    return alive({ x: 9000, y: 9000, health: 0, flags: 0 });
  });
  const meta = twoPlayerMeta({
    shots: [{ tick: shotTick, player: 'aaa', weapon: 'ak47', x: 0, y: 0, yaw: yawAt(shotTick) }],
    damage: hit
      ? [{ tick: shotTick + 2, attacker: 'aaa', victim: 'bbb', weapon: 'ak47', hp: 30 }]
      : [],
    kills: killed ? [{ tick: shotTick + 2, attacker: 'aaa', victim: 'bbb', weapon: 'ak47' }] : []
  });
  return { meta, buffer };
}

// ---------------------------------------------------------------------------
{
  // The packed vector round-trips through its names, and the fold is a fold.
  const a = emptyMotion();
  const b = emptyMotion();
  a[0] = 3;
  b[0] = 4;
  b[5] = 12.5;
  const sum = addMotion(addMotion(emptyMotion(), a), b);
  assert(sum[0] === 7, 'packed fold adds slot 0');
  assert(sum[5] === 12.5, 'packed fold adds slot 5');
  assert(!motionHasSample(emptyMotion()), 'an empty vector has no sample');
  assert(motionHasSample(sum), 'a filled vector has a sample');
  const named = motionObject(sum);
  assert(named[AIM_MOTION_FIELDS[0]] === 7, 'names line up with slots');
  assert(Object.keys(named).length === AIM_MOTION_FIELDS.length, 'every field is named');
  // A vector of the wrong shape must not silently half-fold.
  assert(addMotion(null, a)[0] === 3, 'a missing accumulator is created');
}

// ---------------------------------------------------------------------------
{
  // One clean flick that lands: 90 degrees of travel over 10 ticks.
  const { meta, buffer } = flickFixture({ hit: true, killed: true });
  const out = aimMotionFromRound(meta, buffer);
  const m = motionObject(out.aaa);

  assert(m.flickHit === 1, `flick counted as landed, got hit=${m.flickHit}`);
  assert(m.flickOver === 0 && m.flickUnder === 0, 'a landed flick is neither over nor under');
  assert(close(m.pathDeg, 90, 1), `90 degrees of travel, got ${m.pathDeg}`);
  // 10 ticks at 64 Hz.
  assert(close(m.flickMs, (10 / TICK_RATE) * 1000, 1), `flick took 156 ms, got ${m.flickMs}`);
  assert(close(m.directDeg, 90, 1.5), `direct distance is the same 90, got ${m.directDeg}`);
  assert(m.speedN === 1, 'one flick fed the speed totals');
  assert(m.targets === 1, 'one target killed');
  assert(m.segments >= 1, 'at least one motion segment');

  const { raw } = aimTelemetry(out.aaa);
  assert(close(raw.speed, 576, 12), `90 deg / 0.156 s = 576 deg/s, got ${raw.speed}`);
  assert(close(raw.tension, 0, 3), `a straight flick has no tension, got ${raw.tension}`);
  assert(close(raw.flicks, 100), 'the one flick landed');
  assert(close(raw.adjustments, m.segments), 'segments per target, one target');
}

// ---------------------------------------------------------------------------
{
  // Stopping short is an underflick; going past is an overflick. Same drawing,
  // different end angle.
  const shortFix = flickFixture({ endYaw: 60 });
  const under = motionObject(aimMotionFromRound(shortFix.meta, shortFix.buffer).aaa);
  assert(under.flickUnder === 1, `stopping at 60 of 90 is under, got ${JSON.stringify(under)}`);
  assert(under.flickHit === 0, 'and it did not land');

  const longFix = flickFixture({ endYaw: 130 });
  const over = motionObject(aimMotionFromRound(longFix.meta, longFix.buffer).aaa);
  assert(over.flickOver === 1, 'sweeping to 130 of 90 is over');
  assert(over.flickUnder === 0, 'and it is not both');
}

// ---------------------------------------------------------------------------
{
  // Precision is how much of the gap the motion closed. Ending 9 degrees short
  // of a 90 degree gap closed 90% of it.
  const fix = flickFixture({ endYaw: 81 });
  const m = motionObject(aimMotionFromRound(fix.meta, fix.buffer).aaa);
  assert(m.closeN === 1, 'one closeness sample');
  assert(close(m.closeSum, 90, 2), `closed 90% of the gap, got ${m.closeSum}`);

  const { raw } = aimTelemetry(m);
  assert(close(raw.precision, m.closeSum, 0.01), 'precision is the mean closeness');
}

// ---------------------------------------------------------------------------
{
  // A curved path travels further than the direct route, and that excess IS
  // tension. Sweep out to 140 and back to 90: 190 degrees of travel for a 90
  // degree gap, so 111% excess.
  const yawAt = (t) => {
    if (t <= 60) return 0;
    if (t <= 70) return ((t - 60) / 10) * 140;
    if (t <= 80) return 140 - ((t - 70) / 10) * 50;
    return 90;
  };
  const buffer = buildTicks(160, (t, slot) => {
    if (slot === 0) return alive({ x: 0, y: 0, yaw: yawAt(t), side: 2 });
    if (slot === 5) return alive({ x: 0, y: 1000, yaw: -90, side: 3 });
    return alive({ x: 9000, y: 9000, health: 0, flags: 0 });
  });
  const meta = twoPlayerMeta({
    shots: [{ tick: 80, player: 'aaa', weapon: 'ak47', x: 0, y: 0, yaw: 90 }],
    damage: [{ tick: 82, attacker: 'aaa', victim: 'bbb', weapon: 'ak47', hp: 30 }]
  });
  const m = motionObject(aimMotionFromRound(meta, buffer).aaa);
  assert(close(m.pathDeg, 190, 3), `190 degrees travelled, got ${m.pathDeg}`);
  assert(close(m.directDeg, 90, 2), `90 degrees of it was necessary, got ${m.directDeg}`);
  const { raw } = aimTelemetry(m);
  assert(close(raw.tension, 111, 5), `111% excess path, got ${raw.tension}`);
  // Two direction changes inside one engagement is more than one adjustment.
  assert(m.segments >= 1, 'the sweep is at least one segment');
}

// ---------------------------------------------------------------------------
{
  // A strided buffer has thrown the hand movement away. Measuring speed off it
  // would invent a number, so the pass must decline rather than guess.
  const fix = flickFixture({ hit: true });
  const view = new DataView(fix.buffer);
  writeHeader(view, {
    tickCount: 160,
    firstTick: 0,
    stride: 4,
    tickRate: TICK_RATE,
    playerCount: 10
  });
  const out = aimMotionFromRound(fix.meta, fix.buffer);
  assert(Object.keys(out).length === 0, 'a strided buffer measures nothing');
}

// ---------------------------------------------------------------------------
{
  // Shooting at nobody is not a flick. Same fixture, enemy dead throughout.
  const buffer = buildTicks(160, (t, slot) => {
    if (slot === 0) return alive({ x: 0, y: 0, yaw: t <= 60 ? 0 : 90, side: 2 });
    return alive({ x: 9000, y: 9000, health: 0, flags: 0 });
  });
  const meta = twoPlayerMeta({
    shots: [{ tick: 70, player: 'aaa', weapon: 'ak47', x: 0, y: 0, yaw: 90 }]
  });
  const m = motionObject(aimMotionFromRound(meta, buffer).aaa);
  const flicks = m.flickHit + m.flickOver + m.flickUnder;
  assert(flicks === 0, 'no target, no flick');
  assert(m.speedN === 0, 'and nothing fed the speed totals');
}

// ---------------------------------------------------------------------------
{
  // Utility is not aim: a grenade throw must not register as a flick.
  const fix = flickFixture({ hit: true });
  fix.meta.events.shots[0].weapon = 'hegrenade';
  fix.meta.events.damage = [];
  const out = aimMotionFromRound(fix.meta, fix.buffer);
  const m = motionObject(out.aaa);
  assert(m.flickHit + m.flickOver + m.flickUnder === 0, 'a nade is not a flick');
}

// ---------------------------------------------------------------------------
{
  // The scales: an average value scores 1.00, which is 50 on the aim scale —
  // the same place the outcome half now puts a typical player. That is the
  // property the whole v2 blend rests on, so it is pinned here. It used to be
  // 63, which was the centre of the old hand-picked anchors; both halves moved
  // together to the measured middle (see aimCalibration.js).
  assert(close(engineToHundred(1), 50, 0.001), `average maps to 50, got ${engineToHundred(1)}`);
  assert(close(engineToHundred(2), 100, 0.001), 'the top anchor is 100');
  assert(close(engineToHundred(0.1), 0, 0.001), 'the bottom anchor is 0');
  assert(engineToHundred(null) === null, 'no score, no number');

  // Read from the benchmarks, not copied from them: recalibrating against the
  // library is an expected change, and a test that pinned the old numbers
  // would fail for the wrong reason when it happens.
  const mids = {};
  for (const [key, b] of Object.entries(AIM_MOTION_BENCH)) mids[key] = b.mid;
  const scores = motionEngineScores(mids);
  for (const [key, v] of Object.entries(scores)) {
    assert(close(v, 1, 0.001), `${key} at its average should score 1.00, got ${v}`);
  }

  // And the tails land where the specification says they do.
  const good = {};
  const bad = {};
  for (const [key, b] of Object.entries(AIM_MOTION_BENCH)) {
    good[key] = b.good;
    bad[key] = b.bad;
  }
  for (const [key, v] of Object.entries(motionEngineScores(good))) {
    assert(close(v, 2, 0.001), `${key} at the 97th percentile should be 2.00, got ${v}`);
  }
  for (const [key, v] of Object.entries(motionEngineScores(bad))) {
    assert(close(v, 0.1, 0.001), `${key} at the 3rd percentile should be 0.10, got ${v}`);
  }
}

// ---------------------------------------------------------------------------
{
  // v2 without motion IS v1. This is what lets the rescan run for hours over a
  // live library without any page showing a half-migrated rating.
  const totals = {
    engagements: 200,
    crosshairErrorSum: 200 * 30,
    fightsReady: 130,
    fightsUnaware: 70,
    shots: 400,
    hits: 100,
    firstBullets: 60,
    firstBulletHits: 20,
    overflicks: 8,
    underflicks: 8
  };
  const v1 = aimRating(totals);
  const v2 = aimRatingV2(totals, null);
  assert(v2.rating === v1.rating, `no motion means v2 === v1 (${v2.rating} vs ${v1.rating})`);
  assert(v2.hasMotion === false, 'and it says so');
  assert(v2.v1 === v1.rating, 'v1 is carried alongside');

  // Below the sample floor a component is dropped, not scored as zero.
  const thin = emptyMotion();
  const named = motionObject(thin);
  named.closeN = 3;
  named.closeSum = 3;
  const packed = AIM_MOTION_FIELDS.map((k) => named[k]);
  assert(aimRatingV2(totals, packed).hasMotion === false, 'three flicks is not a sample');

  // With a full sample the motion half moves the number.
  const full = motionObject(emptyMotion());
  full.closeN = 100;
  full.closeSum = 100 * 96; // well above the 88 pivot
  full.flickHit = 90;
  full.flickOver = 5;
  full.flickUnder = 5;
  full.speedN = 100;
  full.pathDeg = 100 * 60;
  full.flickMs = 100 * 200;
  full.directDeg = 100 * 58;
  full.segments = 60;
  full.targets = 50;
  full.reactDirMs = 20 * 150;
  full.reactDirN = 20;
  full.reactHoldMs = 20 * 90;
  full.reactHoldN = 20;
  full.trackOn = 700;
  full.trackN = 1000;
  const strong = aimRatingV2(totals, AIM_MOTION_FIELDS.map((k) => full[k]));
  assert(strong.hasMotion, 'a full sample scores every motion axis');
  for (const key of ['precision', 'speed', 'flicks', 'adjustments', 'reaction', 'tension', 'tracking']) {
    assert(Number.isFinite(strong.components[key]), `${key} scored`);
  }
  assert(strong.rating > v1.rating, `strong motion lifts the rating (${strong.rating} vs ${v1.rating})`);
  assert(strong.v1 === v1.rating, 'and the outcome half is unchanged underneath');
}

console.log('aimMotion tests passed');

// ---------------------------------------------------------------------------
{
  // Speed and tension share a denominator that is a strict subset of the one
  // precision uses, so gating them at precision's threshold left them unscored
  // on demos where every other axis was fine. A player with 18 measured flicks
  // reported "18 of 25 samples" on those two rows and nothing else.
  assert(
    AIM_V2_MIN_SAMPLE.speed === AIM_V2_MIN_SAMPLE.tension,
    'the two axes off one denominator gate together'
  );
  assert(
    AIM_V2_MIN_SAMPLE.speed < AIM_V2_MIN_SAMPLE.precision,
    'and lower than precision, whose denominator is strictly larger'
  );

  // The counters behind that screenshot: 18 flicks with travel, 26 with a gap
  // worth closing. Everything scores.
  const motion = emptyMotion();
  const set = (key, v) => {
    motion[AIM_MOTION_FIELDS.indexOf(key)] = v;
  };
  set('speedN', 18);
  set('pathDeg', 18 * 40);
  set('flickMs', 18 * 340);
  set('directDeg', 18 * 31);
  set('closeN', 26);
  set('closeSum', 26 * 33.4);
  set('flickHit', 18);
  set('flickOver', 4);
  set('flickUnder', 4);

  const tele = aimTelemetry(motion);
  assert(tele.sample.speed === 18, `speed sample is speedN, got ${tele.sample.speed}`);
  assert(tele.sample.tension === 18, 'tension shares it');
  assert(
    tele.sample.speed >= AIM_V2_MIN_SAMPLE.speed,
    '18 measured flicks is enough to score speed'
  );
  assert(
    tele.sample.tension >= AIM_V2_MIN_SAMPLE.tension,
    '18 measured flicks is enough to score tension'
  );
  assert(Number.isFinite(tele.raw.speed), 'and there is a speed to score');
  assert(Number.isFinite(tele.raw.tension), 'and a tension');
}
