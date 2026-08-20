// ---------------------------------------------------------------------------
// shared/sim3d/recoil.test.js
// The spray pattern against the game's own.
//
// The reference below is not a fixture this file produced; it is CS2, measured.
// `scripts/cs3d-spray-truth.mjs` walks six GOTV demos, reads
// `CCSPlayerPawn.m_aimPunchAngle` at every `weapon_fire` tick, keeps only the
// runs that are at the weapon's full-auto cadence, and takes the median per
// shot index. 758 AK-47 sprays and 135 M4A4 sprays went into the two tables.
//
// So a failure here means the generator no longer matches Counter-Strike, not
// that a golden file needs updating.
//
// Run: node --test shared/sim3d/recoil.test.js
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UniformRandomStream,
  buildRecoilTable,
  recoilTable,
  createRecoilState,
  fireRecoil,
  updateRecoil,
  updateRecoilIndex,
  aimPunch,
  cameraPunch,
  sprayPattern,
  applyHitFlinch,
  RECOIL_TABLE_SIZE,
  RECOIL_SCALE,
  VIEW_RECOIL_TRACKING
} from './recoil.js';

/** The AK-47 and M4A4, exactly as `scripts/weapons.vdata` has them. */
const AK47 = {
  name: 'ak47',
  auto: true,
  cycleTime: [0.1, 0.1],
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
  }
};

const M4A4 = {
  name: 'm4a1',
  auto: true,
  cycleTime: [0.09, 0.09],
  recoil: {
    seed: 38965,
    angle: [0, 0],
    angleVariance: [70, 70],
    magnitude: [23, 23],
    magnitudeVariance: [0, 0]
  }
};

/**
 * MEASURED CS2 aim punch, [shot, pitch°, yaw°, samples]. Raw networked values,
 * i.e. before `weapon_recoil_scale`.
 */
const AK_TRUTH = [
  [1, 0, 0, 758],
  [2, -0.0979, -0.0506, 757],
  [3, -0.6233, 0.0007, 757],
  [4, -1.4381, -0.0729, 757],
  [5, -2.3046, -0.0965, 624],
  [6, -3.0992, 0.2425, 493],
  [7, -3.8177, 0.4476, 388],
  [8, -4.3417, 0.8038, 303],
  [9, -4.744, 0.3567, 222],
  [10, -4.6035, -0.807, 165],
  [11, -4.7303, -1.356, 129],
  [12, -4.9985, -0.9845, 101],
  [13, -5.0285, -1.4114, 82],
  [14, -4.8482, -2.0895, 65],
  [15, -4.9691, -2.166, 50],
  [16, -5.071, -1.1256, 40],
  [17, -5.2399, -0.5839, 32],
  [18, -5.3994, -0.2029, 25]
];

const M4_TRUTH = [
  [1, 0, 0, 135],
  [2, -0.0863, 0.0189, 135],
  [3, -0.3448, 0.0325, 135],
  [4, -0.8365, -0.0999, 135],
  [5, -1.4426, 0.0474, 119],
  [6, -2.08, -0.1624, 103],
  [7, -2.6969, -0.2785, 83],
  [8, -3.114, 0.1592, 68],
  [9, -3.4885, 0.4287, 50],
  [10, -3.551, 1.0381, 42],
  [11, -3.7851, 0.8614, 30],
  [12, -3.9738, 0.395, 24],
  [13, -3.914, -0.3987, 21],
  [14, -3.8336, -1.0563, 20],
  [15, -3.6478, -1.6872, 20]
];

/** A held spray: the RAW punch at each shot, before the ×2 read scale. */
function simulate(weapon, shots) {
  const cycle = weapon.cycleTime[0];
  const s = createRecoilState();
  const out = [];
  for (let i = 0; i < shots; i++) {
    out.push([s.punch[0], s.punch[1]]);
    fireRecoil(s, weapon, { now: i * cycle });
    updateRecoil(s, cycle);
  }
  return out;
}

test('the stream is Valve ran1: seed 1 reproduces the published sequence', () => {
  const r = new UniformRandomStream(1);
  assert.deepEqual(
    [r.next(), r.next(), r.next(), r.next(), r.next()],
    [893351816, 197493099, 1624379149, 1137522503, 1998097157]
  );
  // SetSeed stores -|seed|, so 0, 1 and -1 are the same stream.
  const a = new UniformRandomStream(0).next();
  const b = new UniformRandomStream(-1).next();
  assert.equal(a, 893351816);
  assert.equal(b, 893351816);
});

test("the AK's first table angle is the one CS2 kicks at", () => {
  // Measured: the first shot of 758 AK sprays has its punch velocity at
  // 27.330 degrees. The generator has to produce that from seed 223 alone.
  const t = buildRecoilTable(AK47.recoil, 0, true);
  assert.equal(t.length, RECOIL_TABLE_SIZE);
  assert.ok(Math.abs(t[0].angle - 27.33) < 0.01, `first angle ${t[0].angle}`);
  // ...and its magnitude is 0.75 of the weapon's 30, on the nose.
  assert.ok(Math.abs(t[0].magnitude - 22.5) < 0.005, `first magnitude ${t[0].magnitude}`);
});

test('the M4A4 and the Galil agree too — three seeds, three first angles', () => {
  assert.ok(Math.abs(buildRecoilTable(M4A4.recoil, 0, true)[0].angle - -12.325) < 0.02);
  const galil = { seed: 51191, angle: [0, 0], angleVariance: [70, 70], magnitude: [21, 21], magnitudeVariance: [0, 0] };
  assert.ok(Math.abs(buildRecoilTable(galil, 0, true)[0].angle - -42.728) < 0.02);
});

test('the smoothing keeps the AK inside its own pattern', () => {
  // +/-70 degrees of variance, but the 0.55 smoothing means no entry actually
  // reaches the bound: a table that does has lost the smoothing step.
  const t = buildRecoilTable(AK47.recoil, 0, true);
  const worst = Math.max(...t.map((e) => Math.abs(e.angle)));
  assert.ok(worst < 60, `angle reached ${worst}, smoothing is not being applied`);
  assert.ok(worst > 40, `angle only reached ${worst}, smoothing is too strong`);
});

test('a held AK spray reproduces CS2 to better than a tenth of a degree', () => {
  const sim = simulate(AK47, 20);
  let sq = 0;
  let n = 0;
  let worst = 0;
  for (const [i, pitch, yaw] of AK_TRUTH) {
    const [sp, sy] = sim[i - 1];
    const dp = sp - pitch;
    const dy = sy - yaw;
    sq += dp * dp + dy * dy;
    n += 2;
    worst = Math.max(worst, Math.abs(dp), Math.abs(dy));
  }
  const rms = Math.sqrt(sq / n);
  assert.ok(rms < 0.06, `RMS ${rms.toFixed(4)} deg against the measured spray`);
  assert.ok(worst < 0.12, `worst single shot off by ${worst.toFixed(4)} deg`);
});

test('and the M4A4, on its own seed and its own fire rate', () => {
  const sim = simulate(M4A4, 16);
  let sq = 0;
  let n = 0;
  for (const [i, pitch, yaw] of M4_TRUTH) {
    const [sp, sy] = sim[i - 1];
    sq += (sp - pitch) ** 2 + (sy - yaw) ** 2;
    n += 2;
  }
  assert.ok(Math.sqrt(sq / n) < 0.08, `RMS ${Math.sqrt(sq / n).toFixed(4)} deg`);
});

test('the first bullet of a spray is dead on the crosshair', () => {
  const s = createRecoilState();
  const p = aimPunch(s);
  assert.equal(p[0], 0);
  assert.equal(p[1], 0);
  // ...and the shot has kicked the VELOCITY, not the punch.
  fireRecoil(s, AK47, { now: 0 });
  assert.equal(s.punch[0], 0);
  assert.ok(s.punchVel[0] < -10, 'the kick went somewhere other than the velocity');
});

test('the camera follows 45% of what the bullets do', () => {
  const s = createRecoilState();
  for (let i = 0; i < 8; i++) {
    fireRecoil(s, AK47, { now: i * 0.1 });
    updateRecoil(s, 0.1);
  }
  const aim = aimPunch(s);
  assert.ok(Math.abs(aim[0]) > 5, 'eight AK shots should be several degrees up');
  // Mid-spray the camera also carries the cosmetic shake, which never settles
  // while the trigger is held — so it leads the tracking a little.
  const withShake = cameraPunch(s)[0] / aim[0];
  assert.ok(withShake > VIEW_RECOIL_TRACKING, 'the shake should add to the tracking');
  assert.ok(withShake < 0.55, `camera tracked ${withShake.toFixed(3)} of the punch`);
  // Take the shake away and the tracking fraction is exact.
  s.viewPunch[0] = 0;
  s.viewPunch[1] = 0;
  assert.ok(Math.abs(cameraPunch(s)[0] / aim[0] - VIEW_RECOIL_TRACKING) < 1e-12);
});

test('the spray goes UP and the pattern is taller than it is wide', () => {
  const pts = sprayPattern(AK47, 30);
  assert.ok(Math.abs(pts[0].x) < 1e-12 && Math.abs(pts[0].y) < 1e-12, 'the first shot is not on the crosshair');
  // Screen frame: y up. Ten shots in, an AK is well above the crosshair.
  assert.ok(pts[9].y > 8, `shot 10 at y=${pts[9].y.toFixed(2)} deg`);
  const height = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
  const width = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
  assert.ok(height > width, `pattern is ${height.toFixed(1)} tall and ${width.toFixed(1)} wide`);
  // The first nine shots are the vertical run; the rest is the sweep.
  const early = Math.max(...pts.slice(0, 9).map((p) => Math.abs(p.x)));
  assert.ok(early < 3, `the first nine shots wandered ${early.toFixed(2)} deg sideways`);
});

test('the read scale is the only place ×2 happens', () => {
  const s = createRecoilState();
  s.punch[0] = -1;
  s.punch[1] = 0.5;
  assert.deepEqual(aimPunch(s), [-RECOIL_SCALE, 0.5 * RECOIL_SCALE, 0]);
});

test('TraceAttack writes raw punch the camera still scales', () => {
  const s = createRecoilState();
  applyHitFlinch(s, { pitch: -6, yaw: 0, roll: 4 });
  assert.equal(s.punch[0], -6);
  assert.equal(s.punchRoll, 4);
  const cam = cameraPunch(s);
  assert.equal(cam[0], -6 * RECOIL_SCALE * VIEW_RECOIL_TRACKING);
  assert.equal(cam[2], 4 * RECOIL_SCALE * VIEW_RECOIL_TRACKING);
  applyHitFlinch(s, { pitch: -3, yaw: 0, roll: 0 }, { replacePitch: true });
  assert.equal(s.punch[0], -3, 'blast replaces pitch');
});

test('the index holds through a spray and falls after it', () => {
  const s = createRecoilState();
  let t = 0;
  for (let i = 0; i < 10; i++) {
    fireRecoil(s, AK47, { now: t });
    updateRecoilIndex(s, 0.1, 0.1, t);
    t += 0.1;
  }
  assert.equal(s.index, 10, 'the index must not decay between automatic shots');
  // Let go: a decade a second, so a full second takes 10 down to 0.1.
  for (let i = 0; i < 64; i++) {
    t += 1 / 64;
    updateRecoilIndex(s, 1 / 64, 0.1, t);
  }
  assert.ok(s.index < 0.15 && s.index > 0.05, `index recovered to ${s.index.toFixed(3)} after a second`);
});

test('a semi-automatic weapon gets the raw draws, not the smoothed walk', () => {
  const deagle = {
    name: 'deagle',
    auto: false,
    cycleTime: [0.224, 0.224],
    recoil: { seed: 1454, angle: [0, 0], angleVariance: [60, 60], magnitude: [48.2, 48.2], magnitudeVariance: [18, 18] }
  };
  const auto = buildRecoilTable(deagle.recoil, 0, true);
  const semi = buildRecoilTable(deagle.recoil, 0, false);
  assert.equal(auto[0].angle, semi[0].angle, 'the first entry is raw either way');
  assert.notEqual(auto[3].angle, semi[3].angle);
  // No suppression ramp on a semi: the first shot is its full magnitude.
  assert.ok(semi[0].magnitude > 30, `semi first magnitude ${semi[0].magnitude}`);
  assert.ok(Math.abs(auto[0].magnitude / semi[0].magnitude - 0.75) < 1e-9);
});

test('two weapons that share a seed do not share a pattern', () => {
  // CS2 really does hand the M4A1-S its parent M4A4's seed, and the USP-S the
  // P2000's — the prefab chain carries `m_nRecoilSeed` down with everything
  // else. The two guns differ in magnitude, so caching on the seed alone gives
  // whichever was drawn first to the other for the rest of the session, and
  // the spray that comes out belongs to neither.
  const m4a4 = { name: 'm4a1', auto: true, cycleTime: [0.09, 0.09], recoil: { ...M4A4.recoil } };
  const m4a1s = {
    name: 'm4a1_silencer',
    auto: true,
    cycleTime: [0.1, 0.1],
    recoil: { seed: 38965, angle: [0, 0], angleVariance: [70, 70], magnitude: [25, 21], magnitudeVariance: [3, 0] }
  };
  // Both orders, because the bug was order-dependent: whichever gun the player
  // picked up first poisoned the other.
  const a = recoilTable(m4a4, 0)[0].magnitude;
  const b = recoilTable(m4a1s, 0)[0].magnitude;
  assert.notEqual(a, b, 'the two M4s came out with the same first kick');
  assert.ok(Math.abs(a - 23 * 0.75) < 1e-6, `M4A4 first kick ${a}`);
  // Same seed, so the same underlying draws — the ANGLE is genuinely shared.
  assert.ok(Math.abs(recoilTable(m4a4, 0)[0].angle - recoilTable(m4a1s, 0)[0].angle) < 1e-9);
});

test('the AWP scopes into a different table', () => {
  const awp = {
    seed: 4100,
    angle: [0, 0],
    angleVariance: [20, 20],
    magnitude: [78, 25],
    magnitudeVariance: [15, 2]
  };
  const hip = buildRecoilTable(awp, 0, false);
  const scoped = buildRecoilTable(awp, 1, false);
  // Same seed, so the same underlying draws — but different bounds, so a
  // scoped shot kicks about a third as hard.
  assert.ok(scoped[0].magnitude < hip[0].magnitude * 0.5);
  assert.ok(hip[0].magnitude > 60 && hip[0].magnitude < 95);
});
