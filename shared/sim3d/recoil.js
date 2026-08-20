// ---------------------------------------------------------------------------
// shared/sim3d/recoil.js
// The spray pattern, and where the bullets actually go.
//
// CS2 does not ship spray patterns. It ships a per-weapon RANDOM SEED and the
// bounds of a random walk (`scripts/weapons.vdata`, in the pack's `recoil`
// block) and generates the pattern at load. Same seed, same table, every
// machine, every match — which is the only reason a spray is learnable. So
// this file is not a set of hand-traced patterns; it is the generator, and
// the AK's pattern falls out of `seed 223` the way it does in the game.
//
// Four pieces, in the order a shot goes through them:
//
//   1. THE STREAM      Valve's `CUniformRandomStream` — Numerical Recipes
//      `ran1`, a Park-Miller multiplier with a 32-entry shuffle table. Every
//      constant matters; Schrage's trick is what keeps each intermediate under
//      2^31 so this is exact in doubles with no `Math.imul` anywhere.
//
//   2. THE TABLE       64 entries per fire mode. Per entry: an ANGLE (0 is
//      straight up, positive is to the player's right) and a MAGNITUDE, each
//      drawn from the weapon's `± variance`, ANGLE FIRST — a magnitude draw
//      still happens when the variance is zero and skipping it desynchronises
//      every angle after it. Both are then smoothed against the previous entry
//      by `weapon_recoil_variance` (0.55), which is why the AK's ±70° bounds
//      produce a pattern that stays inside about ±52°.
//
//   3. THE PUNCH       A shot KICKS the punch VELOCITY (never the punch
//      itself — the first bullet of any spray is dead on the crosshair, which
//      is a fact you can read straight off a demo). The punch integrates that
//      velocity and both decay: the velocity exponentially at 4.5/s, the punch
//      by a hybrid law with an exponential term (8/s) and a LINEAR one
//      (18°/s). The linear term is why a spray settles to exactly zero instead
//      of asymptoting, and it is what makes the second bullet of a spray land
//      almost on the crosshair while the third is already 0.6° high.
//
//   4. THE SPLIT       Bullets take 100% of the punch. The CAMERA takes only
//      45% of it. That difference is the whole feel of a CS spray: the
//      crosshair lies to you by `0.55 × punch × 2`, and a trainer that moves
//      the camera by the full punch teaches the wrong compensation.
//
// MEASURED, NOT ASSUMED. Every number below was checked against 758 AK-47 and
// 135 M4A4 sprays pulled out of six CS2 GOTV demos, which network
// `m_aimPunchAngle` and `m_aimPunchAngleVel` for every player
// (scripts/cs3d-spray-truth.mjs). What that measurement settled:
//
//   * the first table angle for seed 223 is 27.33°, and the first shot's
//     measured punch velocity is at 27.330° — the generator is confirmed, not
//     inferred, and the same check passes on the M4A4 (38965) and Galil (51191)
//   * the velocity decay is `exp(-4.5 · dt)`: solving for it per interval gives
//     0.63763 at every shot index of an AK spray, and `exp(-4.5 × 0.1)` is
//     0.637628
//   * the first shot's kick is exactly 0.75 × the weapon's magnitude, on both
//     the AK (22.5 of 30) and the M4A4 (17.25 of 23)
//
// Over the AK's first 20 shots this file reproduces CS2's own punch to an RMS
// of 0.031° on a pattern 5° tall. shared/sim3d/recoil.test.js holds the
// measured series and fails if that drifts.
//
// Headless: no three.js, no DOM. The renderer's half is src/cs3d/main.js.
// ---------------------------------------------------------------------------

/** Entries per fire mode. A spray longer than this repeats the last entry. */
export const RECOIL_TABLE_SIZE = 64;

const DEG = Math.PI / 180;

// ---- the stream -------------------------------------------------------------

const NTAB = 32;
const IA = 16807;
const IM = 2147483647;
const IQ = 127773;
const IR = 2836;
const NDIV = 1 + Math.floor((IM - 1) / NTAB);
const AM = 1.0 / IM;
const RNMX = 1.0 - 1.2e-7;

/**
 * Valve's `CUniformRandomStream` (vstdlib/random.cpp), which is Numerical
 * Recipes' `ran1`.
 *
 * Two things about porting it that are easy to get wrong and impossible to
 * notice without a reference: the division by IQ is C's TRUNCATING integer
 * division, and `SetSeed` stores the NEGATIVE of the seed, so seeds 0, 1 and
 * −1 all produce the same stream. Nothing here needs `Math.imul` — Schrage's
 * factorisation keeps `IA * (idum - k*IQ)` under 2^31 by construction, and a
 * double holds that exactly.
 */
export class UniformRandomStream {
  constructor(seed = 0) {
    this.iv = new Int32Array(NTAB);
    this.idum = 0;
    this.iy = 0;
    this.setSeed(seed);
  }

  setSeed(seed) {
    const s = seed | 0;
    this.idum = (s < 0 ? s : -s) | 0;
    this.iy = 0;
  }

  /** The next raw integer, in [1, IM). */
  next() {
    let j;
    let k;
    if (this.idum <= 0 || this.iy === 0) {
      // Warm-up: 40 iterations descending, the last 32 of which fill the
      // shuffle table. The first 8 are thrown away on purpose.
      this.idum = -this.idum < 1 ? 1 : -this.idum;
      for (j = NTAB + 7; j >= 0; j--) {
        k = Math.trunc(this.idum / IQ);
        this.idum = IA * (this.idum - k * IQ) - IR * k;
        if (this.idum < 0) this.idum += IM;
        if (j < NTAB) this.iv[j] = this.idum;
      }
      this.iy = this.iv[0];
    }
    k = Math.trunc(this.idum / IQ);
    this.idum = IA * (this.idum - k * IQ) - IR * k;
    if (this.idum < 0) this.idum += IM;
    j = Math.trunc(this.iy / NDIV);
    this.iy = this.iv[j];
    this.iv[j] = this.idum;
    return this.iy;
  }

  /** Uniform in [low, high). */
  float(low = 0, high = 1) {
    let f = AM * this.next();
    if (f > RNMX) f = RNMX;
    return f * (high - low) + low;
  }
}

// ---- the table --------------------------------------------------------------

/**
 * [docs] `weapon_recoil_variance`. How much of each new draw is taken, the
 * rest being carried over from the previous entry.
 *
 * This is what turns a pattern from noise into a shape. Without it, ±70° of
 * angle variance means consecutive shots can jump from hard left to hard
 * right; with it, the AK sweeps.
 */
export const RECOIL_VARIANCE = 0.55;

/**
 * [measured] What fraction of its magnitude a shot's kick actually gets, by
 * index into a spray.
 *
 * The first bullet lands at 0.75 — exactly, on every weapon checked — and the
 * ramp back to full takes about eight shots. This is CS2's own
 * `weapon_recoil_suppression`, and the numbers below are its OUTPUT, read off
 * the demos rather than derived: solving `vel[k] = e^{-4.5·T}·vel[k-1] + M·û`
 * for M at every shot index gives this sequence on the AK (magnitude 30) and
 * the same sequence on the M4A4 (magnitude 23), to four significant figures.
 *
 * The closed form behind it is not recovered. `weapon_recoil_suppression_shots
 * = 4` and `_factor = 0.75` are the documented cvars and they produce the
 * right first entry and the right shape, but not these values — the ramp is
 * itself smoothed by RECOIL_VARIANCE and the initial state of that smoother is
 * not something the demos can show. The table is exact where it matters and
 * the tail is 1 to four decimals by entry 12, so this costs nothing.
 */
export const RECOIL_SUPPRESSION = Object.freeze([
  0.75, 0.7211, 0.76517, 0.83843, 0.9273, 0.96727, 0.98527, 0.99337, 0.997, 0.99867, 0.9994, 0.99973, 0.99987, 0.99994
]);

/**
 * One fire mode's recoil table.
 *
 * @param {object} recoil  the pack's `weapon.recoil` block
 * @param {number} [mode]  0 primary, 1 secondary (scoped, or burst)
 * @param {boolean} [fullAuto]  a semi-automatic weapon gets neither the
 *   smoothing nor the suppression ramp: every shot is its raw draw.
 * @returns {{angle: number, magnitude: number}[]} 64 entries. `angle` is
 *   degrees, 0 straight up and positive to the player's right.
 */
export function buildRecoilTable(recoil, mode = 0, fullAuto = true) {
  const pick = (v, d = 0) => (Array.isArray(v) ? (v[mode] ?? v[0] ?? d) : (v ?? d));
  const base = pick(recoil?.angle, 0);
  const baseVar = pick(recoil?.angleVariance, 0);
  const mag = pick(recoil?.magnitude, 0);
  const magVar = pick(recoil?.magnitudeVariance, 0);
  // The stream is re-seeded per mode: mode 1 is not a continuation of mode 0,
  // it is the same sequence over different bounds. Two weapons in the game
  // depend on that (the AWP's scoped kick is a quarter of its hip kick).
  const rng = new UniformRandomStream(recoil?.seed || 0);

  const out = new Array(RECOIL_TABLE_SIZE);
  let angle = 0;
  let magnitude = 0;
  for (let i = 0; i < RECOIL_TABLE_SIZE; i++) {
    // ANGLE FIRST, then magnitude, ALWAYS — a zero-variance magnitude still
    // consumes a draw, and dropping it shifts every later angle by one.
    const drawAngle = rng.float(base - baseVar, base + baseVar);
    const drawMag = rng.float(mag - magVar, mag + magVar);
    if (fullAuto && i > 0) {
      angle += (drawAngle - angle) * RECOIL_VARIANCE;
      magnitude += (drawMag - magnitude) * RECOIL_VARIANCE;
    } else {
      angle = drawAngle;
      magnitude = drawMag;
    }
    const supp = fullAuto ? RECOIL_SUPPRESSION[i] ?? 1 : 1;
    out[i] = { angle, magnitude: magnitude * supp };
  }
  return out;
}

/** Cache: one table per set of inputs, so a spray costs no allocation. */
const _tables = new Map();

/**
 * The table for a weapons-pack row, built once and kept.
 *
 * The key is every input `buildRecoilTable` reads, not just the seed — because
 * CS2 SHARES seeds between weapons that are otherwise different guns. The
 * M4A1-S inherits the M4A4's prefab and its 38965 while carrying its own
 * magnitude (25/21 against 23/23, with variance 3) and the USP-S does the same
 * to the P2000's 5426. Keying on the seed alone hands whichever of the pair
 * was drawn first to the other, for the rest of the session, and the spray
 * that comes out is neither weapon's.
 * @param {object} weapon  a row out of the weapons pack manifest
 */
export function recoilTable(weapon, mode = 0) {
  const recoil = weapon?.recoil;
  if (!recoil) return null;
  const auto = weapon.auto !== false;
  const key =
    `${recoil.seed}|${mode}|${auto ? 1 : 0}|` +
    `${recoil.angle}|${recoil.angleVariance}|${recoil.magnitude}|${recoil.magnitudeVariance}`;
  let t = _tables.get(key);
  if (!t) {
    t = buildRecoilTable(recoil, mode, auto);
    _tables.set(key, t);
  }
  return t;
}

// ---- the punch --------------------------------------------------------------

/** [docs] `weapon_recoil_scale`. Applied when the punch is READ, not stored. */
export const RECOIL_SCALE = 2.0;
/** [docs] How much of the aim punch the CAMERA follows. The rest is the lie. */
export const VIEW_RECOIL_TRACKING = 0.45;
/** [docs] `weapon_recoil_view_punch_extra`: the cosmetic screen shake per shot. */
export const VIEW_PUNCH_EXTRA = 0.055;
/** [docs] `weapon_recoil_decay2_exp` — exponential decay of the punch. */
export const PUNCH_DECAY_EXP = 8.0;
/** [docs] `weapon_recoil_decay2_lin` — the linear pull that lands it on zero. */
export const PUNCH_DECAY_LIN = 18.0;
/** [docs] `weapon_recoil_vel_decay`. Confirmed against demos to four figures. */
export const PUNCH_VEL_DECAY = 4.5;
/** [docs] The view punch decays exponentially only, no linear term. */
export const VIEW_PUNCH_DECAY = 18.0;

/**
 * The integration sub-step, seconds.
 *
 * The decay is not linear in dt — the hybrid law subtracts a fixed amount of
 * magnitude per second and clamps at zero — so the answer depends on how
 * finely it is stepped, and a browser frame is far too coarse. Measured
 * against the demos, an AK's 20-shot punch comes out 0.164° RMS wrong at 64 Hz,
 * 0.038° at 256 and 0.031° at 1024; this is where it stops paying for itself.
 * A held spray is 51 sub-steps of arithmetic on two floats.
 */
const SUB_STEP = 1 / 512;

/** The punch, the velocity behind it, and where the spray has got to. */
export function createRecoilState() {
  return {
    /** Aim punch, degrees, [pitch, yaw]. Source QAngle: pitch+ is DOWN. */
    punch: [0, 0],
    /** Its velocity, degrees per second. A shot kicks THIS. */
    punchVel: [0, 0],
    /** The cosmetic shake. Never touches a bullet. */
    viewPunch: [0, 0],
    /** TraceAttack roll (Source z). Spray recoil never writes this. */
    punchRoll: 0,
    /** Where in the table the next shot reads. Fractional between sprays. */
    index: 0,
    /** Shots since the trigger was last released, for the HUD and the ramp. */
    shotsFired: 0,
    /** Seconds (same clock as `fire`) of the last shot. */
    lastShotTime: -1e9,
    _sub: 0
  };
}

export function resetRecoil(state) {
  state.punch[0] = state.punch[1] = 0;
  state.punchVel[0] = state.punchVel[1] = 0;
  state.viewPunch[0] = state.viewPunch[1] = 0;
  state.punchRoll = 0;
  state.index = 0;
  state.shotsFired = 0;
  state.lastShotTime = -1e9;
  state._sub = 0;
}

/**
 * `KickBack`. A shot moves the punch VELOCITY, and the punch itself not at all.
 *
 * That is why the first bullet of every spray is exactly on the crosshair, and
 * it is not a detail — it is the single most-relied-on fact in the game.
 */
function kickBack(state, angleDeg, magnitude) {
  const r = angleDeg * DEG;
  state.punchVel[0] += -Math.cos(r) * magnitude;
  state.punchVel[1] += -Math.sin(r) * magnitude;
  const vp = magnitude * VIEW_PUNCH_EXTRA;
  state.viewPunch[0] -= Math.cos(r) * vp;
  state.viewPunch[1] -= Math.sin(r) * vp;
}

/**
 * Pull the trigger.
 *
 * Order matters and is the game's: the bullet has already been fired with the
 * CURRENT punch by the time this runs, so the kick belongs to the NEXT one.
 * Call `aimPunch()` for the shot, then this.
 *
 * @param {object} state
 * @param {object} weapon  a weapons-pack row
 * @param {object} [o]
 * @param {number} [o.mode]  0 primary, 1 scoped/burst
 * @param {number} [o.now]   seconds
 * @returns {{angle: number, magnitude: number, index: number}|null}
 */
export function fireRecoil(state, weapon, { mode = 0, now = 0 } = {}) {
  const table = recoilTable(weapon, mode);
  if (!table) return null;
  const i = Math.min(RECOIL_TABLE_SIZE - 1, Math.max(0, Math.trunc(state.index)));
  const e = table[i];
  kickBack(state, e.angle, e.magnitude);
  state.index += 1;
  state.shotsFired += 1;
  state.lastShotTime = now;
  return { angle: e.angle, magnitude: e.magnitude, index: i };
}

/**
 * The hybrid decay CS2 applies to both punches: an exponential term, then a
 * fixed amount of magnitude taken off the top.
 *
 * The linear term is the interesting one. It means the punch reaches EXACTLY
 * zero rather than trailing off forever, and near zero it dominates — which is
 * why the second bullet of a spray is only 0.1° off the crosshair while the
 * third is already 0.6°: the first bullet's velocity had barely enough to
 * outrun it.
 */
function hybridDecay(v, expRate, linRate, dt) {
  const e = Math.exp(-expRate * dt);
  v[0] *= e;
  v[1] *= e;
  const lin = linRate * dt;
  const mag = Math.hypot(v[0], v[1]);
  if (mag > lin) {
    const k = 1 - lin / mag;
    v[0] *= k;
    v[1] *= k;
  } else {
    v[0] = 0;
    v[1] = 0;
  }
}

/**
 * Let the punch settle. Call once a frame with the frame time.
 *
 * Sub-stepped at a fixed rate, because the answer depends on it (see
 * SUB_STEP), and the remainder is carried so the result does not depend on how
 * the frames happened to land.
 */
export function updateRecoil(state, dt) {
  if (!(dt > 0)) return;
  state._sub += Math.min(dt, 0.25);
  while (state._sub >= SUB_STEP) {
    const h = SUB_STEP;
    hybridDecay(state.punch, PUNCH_DECAY_EXP, PUNCH_DECAY_LIN, h);
    // Split half-step around the velocity's own decay. Plain Euler here is
    // visibly wrong over a spray — the punch overshoots on the way up.
    state.punch[0] += state.punchVel[0] * h * 0.5;
    state.punch[1] += state.punchVel[1] * h * 0.5;
    const e = Math.exp(-PUNCH_VEL_DECAY * h);
    state.punchVel[0] *= e;
    state.punchVel[1] *= e;
    state.punch[0] += state.punchVel[0] * h * 0.5;
    state.punch[1] += state.punchVel[1] * h * 0.5;
    hybridDecay(state.viewPunch, VIEW_PUNCH_DECAY, 0, h);
    state.punchRoll *= Math.exp(-PUNCH_DECAY_EXP * h);
    {
      const lin = PUNCH_DECAY_LIN * h;
      const mag = Math.abs(state.punchRoll || 0);
      if (mag > lin) state.punchRoll *= 1 - lin / mag;
      else state.punchRoll = 0;
    }
    state._sub -= h;
  }
}

/**
 * The punch a BULLET takes, degrees [pitch, yaw]. All of it.
 *
 * `weapon_recoil_scale` is applied here rather than at the kick, which is why
 * the values a demo carries are half what the bullets use.
 */
export function aimPunch(state, out = [0, 0, 0]) {
  out[0] = state.punch[0] * RECOIL_SCALE;
  out[1] = state.punch[1] * RECOIL_SCALE;
  out[2] = (state.punchRoll || 0) * RECOIL_SCALE;
  return out;
}

/**
 * The punch the CAMERA takes: the cosmetic shake in full, plus 45% of the aim
 * punch.
 *
 * The missing 55% is the gap between where the crosshair is and where the
 * bullets are going, and reproducing it is the difference between a spray that
 * can be learned the way CS players learn it and one that cannot.
 */
export function cameraPunch(state, out = [0, 0, 0]) {
  out[0] = state.viewPunch[0] + state.punch[0] * RECOIL_SCALE * VIEW_RECOIL_TRACKING;
  out[1] = state.viewPunch[1] + state.punch[1] * RECOIL_SCALE * VIEW_RECOIL_TRACKING;
  out[2] = (state.punchRoll || 0) * RECOIL_SCALE * VIEW_RECOIL_TRACKING;
  return out;
}

/**
 * CCSPlayer::TraceAttack writing m_aimPunchAngle. `delta` is degrees of raw
 * punch from shared/sim3d/flinch.js. Blast replaces pitch; bullets add.
 */
export function applyHitFlinch(state, delta, { replacePitch = false } = {}) {
  if (!state || !delta) return state;
  if (replacePitch) state.punch[0] = delta.pitch || 0;
  else state.punch[0] += delta.pitch || 0;
  state.punch[1] += delta.yaw || 0;
  state.punchRoll = (state.punchRoll || 0) + (delta.roll || 0);
  const capHead = 3 * -12;
  if (state.punch[0] < capHead) state.punch[0] = capHead;
  const capRoll = 3 * 9;
  if (state.punchRoll < -capRoll) state.punchRoll = -capRoll;
  if (state.punchRoll > capRoll) state.punchRoll = capRoll;
  return state;
}

// ---- the recoil index -------------------------------------------------------

/** [docs] `weapon_recoil_decay_coefficient`: decades per second, so ×0.01 in 1s. */
export const RECOIL_INDEX_DECAY = 2.0;
/** [docs] Cycle times to wait after a shot before the index starts falling. */
export const RECOIL_DECAY_THRESHOLD = 1.1;

/**
 * Let the spray recover.
 *
 * The hold is what makes holding the trigger a spray and tapping a reset: the
 * index does not move for `cycleTime × 1.1` after a shot, which at the AK's
 * 0.1 s cycle is 0.11 s — just longer than the gap between two automatic
 * shots, and shorter than any human tap.
 *
 * @param {object} state
 * @param {number} dt         seconds
 * @param {number} cycleTime  the weapon's seconds between shots
 * @param {number} now        same clock as `fireRecoil`
 */
export function updateRecoilIndex(state, dt, cycleTime, now) {
  if (state.index <= 0) return;
  if (now <= state.lastShotTime + cycleTime * RECOIL_DECAY_THRESHOLD) return;
  state.index *= Math.exp(-dt * Math.LN10 * RECOIL_INDEX_DECAY);
  if (state.index < 1e-4) {
    state.index = 0;
    state.shotsFired = 0;
  }
}

/**
 * The whole pattern, for a crosshair overlay or a training aid: where each
 * bullet of a held spray lands relative to the aim, in DEGREES on screen
 * (x right, y up).
 *
 * This is a simulation rather than a lookup, because the pattern is not the
 * table — it is what the damped punch does when the table is fed into it at
 * the weapon's fire rate.
 *
 * @param {object} weapon  a weapons-pack row
 * @param {number} [shots]
 * @returns {{x: number, y: number}[]}
 */
export function sprayPattern(weapon, shots = 30, { mode = 0 } = {}) {
  const cycle = Array.isArray(weapon.cycleTime) ? weapon.cycleTime[mode] || weapon.cycleTime[0] : weapon.cycleTime || 0.1;
  const state = createRecoilState();
  const out = [];
  const p = [0, 0];
  for (let i = 0; i < shots; i++) {
    aimPunch(state, p);
    // Source QAngle → screen: pitch+ is down and yaw+ is left, so both flip.
    out.push({ x: -p[1], y: -p[0] });
    fireRecoil(state, weapon, { mode, now: i * cycle });
    updateRecoil(state, cycle);
  }
  return out;
}
