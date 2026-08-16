// ---------------------------------------------------------------------------
// shared/sim3d/deriveFlags.js
// Recover airborne and ducked state from a stored tick buffer, for rounds
// parsed before the adapter asked the demo for them by their real names.
//
// Why this exists rather than a reparse: the library holds thousands of
// parsed rounds and no .dem files, so the only ground truth left is the tick
// buffer itself — positions at ¼ unit, 64 Hz. That turns out to be enough,
// because both states leave a signature in the position series that nothing
// else a player does reproduces:
//
//   airborne  z follows a ballistic parabola. Over a jump, consecutive z
//             deltas shrink by g·dt² = 800/64² = 0.195 u per tick — the same
//             signature scripts/cs3d-oracle.mjs fits 393k arcs with, at
//             g = 800.14 across the corpus. Stairs are steps (bad fit),
//             ramps are lines (curvature ~0), lifts are linear: all reject.
//
//   ducked    the ducked speed cap is 0.34 of the weapon's run speed, well
//             clear of walk (0.52) and run (1.0). A sustained plateau in that
//             band is a crouch-walk. Standing still is genuinely ambiguous —
//             a stationary crouched player and a stationary standing one
//             produce identical rows — so the classifier holds the last
//             decided state through stillness, which is right for the shape
//             this actually takes in play: crouch-walk into position, hold
//             the angle, stand up to reposition.
//
// The run speed is calibrated per (player, weapon) from the round's own
// speeds rather than trusted from the weapon table, because the corpus
// disagrees with that table for knives (250, not 215) and for grenades in
// hand (~245). Self-calibration also survives future table drift.
//
// Accuracy, stated honestly: airborne is near-exact (the oracle validates the
// same detector end to end). Ducked is a good approximation of moving crouch
// and a heuristic for stationary crouch. Both are strictly better than the
// zeros they replace, and `derived: true` travels with the result so nothing
// downstream mistakes them for what the demo actually said.
// ---------------------------------------------------------------------------

import { readRecord, FLAG_AIRBORNE, FLAG_DUCKING } from '../../src/replays/shared/tickFormat.js';

/**
 * Measured, so nobody has to re-derive the disappointment.
 * scripts/cs3d-verify-derived.mjs, 19 rounds of a CS2 match, scored against
 * the .dem's own m_bDucked / m_fFlags (1.5M tick-player rows):
 *
 *   airborne   accuracy 96.3%   precision 91.0%   recall 43.9%
 *   ducked     accuracy 90.8%   precision 34.4%   recall 27.9%
 *
 * Airborne is worth having: when it says airborne it is right 91% of the
 * time, and the misses are short scuffs rather than whole jumps.
 *
 * Ducked is not, and the reason is physical, not algorithmic. 56% of crouched
 * ticks are stationary, and a stationary crouch moves the ORIGIN not at all —
 * measured over 1878 stationary duck transitions, Z changed on 11, by 0.000
 * in every sampled case. CS2 replicates the feet and derives eye height from
 * m_flDuckAmount, so the camera drop a viewer would look for is precisely the
 * field that was never stored. Guessing anyway scores WORSE than assuming
 * nobody ever crouches (96% by doing nothing), because two thirds of the
 * crouches it draws are invented.
 *
 * Hence: airborne on, duck off unless a caller explicitly opts in. The real
 * fix for crouch is PARSER_REVISION 3 plus the .dem — there is no other.
 */
export const DUCK_IS_NOT_RECOVERABLE = true;

/** Ducked cap as a fraction of run speed, with tolerance for accel/decel. */
const DUCK_BAND_LO = 0.22;
const DUCK_BAND_HI = 0.44;
/** Above this fraction of run speed the player is certainly not ducked. */
const STAND_BAND = 0.5;
/** Speeds under this (u/s) carry no information; hold the last state. */
const STILL_SPEED = 12;
/** A crouch-walk has to last this long to count, in ticks. */
const DUCK_MIN_RUN = 6;

/** Ballistic curvature test bounds, u/s² (g = 800 with room for noise). */
const G_MIN = 500;
const G_MAX = 1150;
/** Flat-ground tolerance per tick, in units — a shade over the ¼-unit floor. */
const FLAT_EPS = 0.3;
/** Above this per-tick jump, the row pair is a teleport, not motion. */
const TELEPORT = 40;

/** Least-squares quadratic; returns curvature and fit error. */
function fitParabola(zs, from, to, dt) {
  const n = to - from;
  if (n < 5) return null;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, sz = 0, szt = 0, szt2 = 0;
  const tm = ((n - 1) / 2) * dt;
  for (let i = 0; i < n; i++) {
    const t = i * dt - tm;
    const t2 = t * t;
    s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
    const z = zs[from + i];
    sz += z; szt += z * t; szt2 += z * t2;
  }
  const det = n * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return null;
  const c0 = (sz * (s2 * s4 - s3 * s3) - s1 * (szt * s4 - s3 * szt2) + s2 * (szt * s3 - s2 * szt2)) / det;
  const c1 = (n * (szt * s4 - szt2 * s3) - sz * (s1 * s4 - s3 * s2) + s2 * (s1 * szt2 - szt * s2)) / det;
  const c2 = (n * (s2 * szt2 - s3 * szt) - s1 * (s1 * szt2 - szt * s2) + sz * (s1 * s3 - s2 * s2)) / det;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt - tm;
    const e = zs[from + i] - (c0 + c1 * t + c2 * t * t);
    rss += e * e;
  }
  return { c2, rms: Math.sqrt(rss / n) };
}

/**
 * Mark ballistic stretches of one player's z-series.
 * @param {Float64Array} zs
 * @param {Uint8Array} alive
 * @param {Float64Array} horiz  per-tick horizontal step, for teleport rejection
 */
function deriveAirborne(zs, alive, horiz, n, dt, out) {
  const flat = (i) => i > 0 && Math.abs(zs[i] - zs[i - 1]) <= FLAT_EPS;
  let i = 1;
  while (i < n) {
    if (!alive[i] || flat(i)) {
      i++;
      continue;
    }
    // z started moving: walk to where it settles again.
    const start = i - 1;
    let j = i;
    let flats = 0;
    while (j < n && alive[j] && flats < 3) {
      if (Math.abs(zs[j] - zs[j - 1]) > TELEPORT || horiz[j] > TELEPORT) break;
      if (flat(j)) flats++;
      else flats = 0;
      j++;
    }
    const end = j - flats;
    const len = end - start;
    if (len >= 6 && len < 400) {
      // Fit the interior: the first and last ticks are partial (takeoff and
      // landing happen mid-tick under subtick) and flatten the curvature.
      // Trim only what the length affords, so short hops still get a fit.
      const trim = len >= 12 ? 2 : 1;
      const fit = fitParabola(zs, start + trim, end - trim, dt);
      if (fit && fit.rms < 0.6) {
        const g = -2 * fit.c2;
        // The whole excursion is airborne, endpoints included: the trim above
        // is about fitting cleanly, not about when the feet left the floor.
        if (g > G_MIN && g < G_MAX) for (let k = start; k <= end && k < n; k++) out[k] = 1;
      }
    }
    i = j + 1;
  }
}

/**
 * Mark crouch-walks: sustained, low-variance speed plateaus inside the ducked
 * band. Nothing else is claimed.
 *
 * An earlier version carried a decided state forward through stillness, on
 * the theory that a player who crouch-walks into position holds the crouch.
 * Measured against the demo it was a bad trade — precision 34%, and an
 * overall accuracy below simply saying nobody ever crouches. Players stand
 * up while stationary far too often for the hold to pay.
 *
 * So this reports only what the speed actually evidences, and under-reports
 * by design: a stationary crouched player is IDENTICAL in the tick buffer to
 * a stationary standing one — same origin, same angles — and no amount of
 * cleverness recovers a bit that was never written. That is 56% of all
 * crouched ticks, and it is the reason derivation is a stopgap for old rounds
 * rather than a substitute for reparsing (see PARSER_REVISION 3).
 */
function deriveDucked(speed, alive, airborne, runSpeed, n, out) {
  let i = 0;
  while (i < n) {
    if (!alive[i] || airborne[i] || speed[i] < STILL_SPEED) {
      i++;
      continue;
    }
    const run = runSpeed[i] || 215;
    if (speed[i] < run * DUCK_BAND_LO || speed[i] > run * DUCK_BAND_HI) {
      i++;
      continue;
    }
    // Grow the plateau while it stays in band and actually moving.
    let j = i;
    let sum = 0;
    let sum2 = 0;
    while (j < n && alive[j] && !airborne[j]) {
      const r = runSpeed[j] || 215;
      const v = speed[j];
      if (v < Math.max(STILL_SPEED, r * DUCK_BAND_LO) || v > r * DUCK_BAND_HI) break;
      sum += v;
      sum2 += v * v;
      j++;
    }
    const len = j - i;
    if (len >= DUCK_MIN_RUN) {
      // A player accelerating through the band does not linger in it; a
      // crouch-walk sits at its cap. Low variance is what separates them.
      const mean = sum / len;
      const sd = Math.sqrt(Math.max(0, sum2 / len - mean * mean));
      if (sd < mean * 0.22) for (let k = i; k < j; k++) out[k] = 1;
    }
    i = j > i ? j : i + 1;
  }
}

/** p95 of a numeric array, for run-speed self-calibration. */
function p95(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

/**
 * Does this round already carry real movement flags? Sampled rather than
 * fully scanned: a round where the parser supplied them has them everywhere.
 */
export function hasMovementFlags(view, header) {
  const rows = Math.min(header.tickCount, 2000);
  const tmp = {};
  for (let i = 0; i < rows; i++) {
    for (let s = 0; s < (header.playerCount || 10); s++) {
      readRecord(view, i, s, tmp);
      if (tmp.flags & (FLAG_AIRBORNE | FLAG_DUCKING)) return true;
    }
  }
  return false;
}

/**
 * Derive per-tick airborne and ducked state for every slot in a round.
 *
 * @param {DataView} view    a tickFormat v1 buffer
 * @param {object} header    from readHeader
 * Airborne is reported. Ducked is NOT, unless explicitly asked for — see
 * DUCK_IS_NOT_RECOVERABLE below.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.weapons]      the round's weapon dictionary
 * @param {(name: string) => number} [opts.runSpeedFor]  weapon → u/s, optional
 * @param {boolean} [opts.duck]  opt in to the crouch-walk guess (default off)
 * @returns {{ airborne: Uint8Array[], ducked: Uint8Array[], derived: true }}
 *   indexed [slot][row]
 */
export function deriveMovementFlags(view, header, opts = {}) {
  const n = header.tickCount;
  const slots = header.playerCount || 10;
  const rate = header.tickRate || 64;
  const dt = 1 / rate;
  const weapons = opts.weapons || [];
  const runSpeedFor = opts.runSpeedFor || (() => 0);

  const airborne = [];
  const ducked = [];
  const zs = new Float64Array(n);
  const speed = new Float64Array(n);
  const horiz = new Float64Array(n);
  const alive = new Uint8Array(n);
  const runSpeed = new Float64Array(n);
  const weaponAt = new Int32Array(n);
  const tmp = {};

  for (let slot = 0; slot < slots; slot++) {
    let px = 0;
    let py = 0;
    for (let i = 0; i < n; i++) {
      const r = readRecord(view, i, slot, tmp);
      zs[i] = r.z;
      alive[i] = r.alive ? 1 : 0;
      weaponAt[i] = r.weapon;
      const d = i === 0 ? 0 : Math.hypot(r.x - px, r.y - py);
      horiz[i] = d;
      speed[i] = d * rate;
      px = r.x;
      py = r.y;
    }

    // Run speed per (this player, weapon), calibrated from their own round.
    const byWeapon = new Map();
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const w = weaponAt[i];
      let list = byWeapon.get(w);
      if (!list) byWeapon.set(w, (list = []));
      if (speed[i] > 0) list.push(speed[i]);
    }
    const runFor = new Map();
    for (const [w, list] of byWeapon) {
      const table = runSpeedFor(weapons[w] || '') || 0;
      // Trust whichever is larger: the table is wrong low for knives and
      // grenades, and p95 is wrong low for a player who never ran with it.
      const est = Math.max(p95(list), table, 120);
      runFor.set(w, Math.min(est, 260));
    }
    for (let i = 0; i < n; i++) runSpeed[i] = runFor.get(weaponAt[i]) || 215;

    const air = new Uint8Array(n);
    const duck = new Uint8Array(n);
    deriveAirborne(zs, alive, horiz, n, dt, air);
    if (opts.duck) deriveDucked(speed, alive, air, runSpeed, n, duck);
    airborne.push(air);
    ducked.push(duck);
  }

  return { airborne, ducked, derived: true };
}
