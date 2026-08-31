// ---------------------------------------------------------------------------
// replays/viewer/keypresses.js
// Which keys a demo player is holding, reconstructed per tick.
//
// A GOTV demo does not network the client's button mask (verified against the
// full field list of a live CS2 demo: no m_nButtonDownMaskPrev reaches the
// spectator stream). What it does carry, at full tick rate, is everything the
// buttons DID: continuous duck, walk-capped speed, airborne edges, scoping,
// and a weapon_fire event per shot. So this module reads keys from two kinds
// of source and is honest about which is which:
//
//   state    Ctrl (duck amount rising/held), Mouse2 (scoped), Space (airborne
//            edge that gained height), Mouse1 (weapon_fire ticks). These
//            mirror the engine's own per-tick fields.
//   motion   W/A/S/D from velocity decomposed into the view basis, and Shift
//            from a sustained walk-capped speed. Inference: right whenever the
//            player is accelerating or turning, ambiguous only at constant
//            full speed in a straight line.
//
// Everything is a pure function of the playhead tick, never of playback
// order, so scrubbing, seeking and playing backwards cannot wedge a key on.
// ---------------------------------------------------------------------------

import { FLAG_AIRBORNE, FLAG_DUCKING, FLAG_SCOPED } from '../shared/tickFormat.js';
import { WEAPON_SPEED, DEFAULT_WEAPON_SPEED } from '../../../shared/sim/constants.js';
import { WALK_SPEED_SCALE } from '../../../shared/sim3d/constants.js';

/** Below this ground speed (u/s) no movement key is shown. */
export const MOVE_MIN = 30;
/**
 * Sector half-width for the 8-way key read: sin(22.5°). A velocity within
 * 22.5° of an axis lights one key; between axes it lights the diagonal pair.
 */
export const SECTOR = Math.sin(Math.PI / 8);
/**
 * Deceleration (u/s²) beyond what ground friction alone produces. Friction at
 * full sprint brakes at roughly 5.2 × speed ≈ 1300 u/s²; a counter-strafe key
 * adds accelerate on top and lands well above this line.
 */
export const COUNTER_DECEL = 1900;
/** How long a jump press stays lit (seconds). */
export const SPACE_HOLD = 0.35;
/** How long one shot keeps Mouse1 lit (seconds). ~600 RPM reads continuous. */
export const M1_HOLD = 0.14;
/** Speed slack over the exact walk cap, absorbing quantization noise. */
const WALK_PAD = 8;

/** The walk speed cap for a held weapon (bare name, e.g. "ak47"). */
export function walkCap(weaponName) {
  const max = WEAPON_SPEED[weaponName] ?? DEFAULT_WEAPON_SPEED;
  return max * WALK_SPEED_SCALE;
}

const OFF = Object.freeze({
  w: false, a: false, s: false, d: false,
  ctrl: false, shift: false, space: false,
  m1: false, m2: false
});

/** Scratch states so a 64 Hz caller never allocates. */
const S0 = {};
const SP = {};
const SN = {};
const SP2 = {};
const SN2 = {};
const SE = {};

/**
 * The keys held at one moment.
 *
 * @param {object} args
 * @param {number} args.at        playhead demo tick (fractional is fine)
 * @param {number} args.rate      demo ticks per second
 * @param {number} [args.stride]  ticks between stored rows (1 when full)
 * @param {number} [args.firstTick] tick of row 0, to snap `at` onto rows
 * @param {(tick: number, out: object) => object|null} args.sample
 *        one player's state at a tick (tickFormat readRecord shape)
 * @param {Array<{tick: number, player?: string}>} [args.shots]
 *        weapon_fire events for the round
 * @param {string} [args.playerId]   id shots are matched against
 * @param {string} [args.weaponName] bare held-weapon name, for the walk cap
 * @param {object} [args.out]        reused result object
 */
export function keysAt({
  at,
  rate,
  stride = 1,
  firstTick = 0,
  sample,
  shots = null,
  playerId = undefined,
  weaponName = '',
  out = {}
}) {
  const h = Math.max(1, stride | 0);
  const hz = Math.max(1, rate || 64);
  // Snap onto a stored row so neighbours are real rows, not interpolations.
  const T = firstTick + Math.round((at - firstTick) / h) * h;

  const s0 = sample(T, S0);
  if (!s0 || !s0.alive) return Object.assign(out, OFF);

  const prev = sample(T - h, SP);
  const next = sample(T + h, SN);
  const dt = h / hz;

  // Central-difference velocity halves the quantization noise; one-sided at
  // the ends of the buffer, where the sampler clamps.
  const px = prev?.x ?? s0.x;
  const py = prev?.y ?? s0.y;
  const nx = next?.x ?? s0.x;
  const ny = next?.y ?? s0.y;
  const vx = (nx - px) / (2 * dt);
  const vy = (ny - py) / (2 * dt);
  const speed = Math.hypot(vx, vy);

  // a = (next - 2·now + prev) / dt², the discrete second derivative.
  const ax = (nx - 2 * s0.x + px) / (dt * dt);
  const ay = (ny - 2 * s0.y + py) / (dt * dt);

  // View basis. Source yaw: 0 = +X, counter-clockwise, degrees.
  const yawRad = (s0.yaw || 0) * (Math.PI / 180);
  const fx = Math.cos(yawRad);
  const fy = Math.sin(yawRad);
  const rx = fy;
  const ry = -fx;

  let w = false;
  let a = false;
  let s = false;
  let d = false;

  // Counter-strafe first: while braking harder than friction can, the held
  // key is the one OPPOSITE the motion, and the acceleration vector points at
  // it. Without this the classic jiggle would read as the wrong key for its
  // whole second half.
  const decel = speed > 1 ? -(ax * vx + ay * vy) / speed : 0;
  const aMag = Math.hypot(ax, ay);
  const prevSpeed = prev ? Math.hypot(s0.x - px, s0.y - py) / dt : 0;
  const countering =
    (speed > MOVE_MIN && decel > COUNTER_DECEL) ||
    (speed <= MOVE_MIN && prevSpeed > 60 && aMag > COUNTER_DECEL);

  if (countering && aMag > 1) {
    const af = (ax * fx + ay * fy) / aMag;
    const ar = (ax * rx + ay * ry) / aMag;
    w = af > SECTOR;
    s = af < -SECTOR;
    d = ar > SECTOR;
    a = ar < -SECTOR;
  } else if (speed >= MOVE_MIN) {
    const f = (vx * fx + vy * fy) / speed;
    const r = (vx * rx + vy * ry) / speed;
    w = f > SECTOR;
    s = f < -SECTOR;
    d = r > SECTOR;
    a = r < -SECTOR;
  }

  // Ctrl: the duck key is down while the duck amount is rising or held up.
  // Falling means released, whatever the amount still is.
  const duckNow = s0.duckAmount || 0;
  const duckNext = next ? next.duckAmount || 0 : duckNow;
  const ctrl =
    (s0.flags & FLAG_DUCKING) !== 0 || (duckNow > 0.02 && duckNext >= duckNow - 1e-3);

  // Shift: on the ground, upright, at a speed the walk cap explains, and
  // still under that cap well ahead of now. The forward window is what stops
  // a sprint's run-up through the walk band (~100 ms of every start from
  // standstill) reading as a tapped Shift: mid run-up the speed a tenth of a
  // second later is already past any weapon's cap, while a real walker is
  // still under it. Starting to WALK from standstill stays under it too, so
  // walking lights up from its first ticks.
  let shift = false;
  const airborne = (s0.flags & FLAG_AIRBORNE) !== 0;
  if (!airborne && duckNow < 0.4 && speed >= MOVE_MIN) {
    const cap = walkCap(weaponName) + WALK_PAD;
    if (speed <= cap) {
      const n2a = sample(T + 6 * h, SP2);
      const n2b = sample(T + 8 * h, SN2);
      const ahead =
        n2a && n2b ? Math.hypot(n2b.x - n2a.x, n2b.y - n2a.y) / (2 * dt) : 0;
      shift = ahead <= cap;
    }
  }

  // Space: lit for a moment after an airborne edge that GAINED height. A walk
  // off a ledge is airborne too, but it falls; only a jump climbs.
  let space = false;
  const holdRows = Math.ceil((SPACE_HOLD * hz) / h);
  let air = airborne;
  for (let k = 0; k <= holdRows && air; k++) {
    const atEdge = sample(T - k * h, SE);
    if (!atEdge || !(atEdge.flags & FLAG_AIRBORNE)) break;
    const before = sample(T - (k + 1) * h, SP2);
    if (before && !(before.flags & FLAG_AIRBORNE)) {
      const after = sample(T - (k - 1) * h, SN2);
      if (after && after.z > before.z + 0.5) space = true;
      break;
    }
    air = true;
  }

  // Mouse1: a weapon_fire in the trailing window. Held long enough that a
  // full-auto spray reads as one continuous press.
  let m1 = false;
  if (shots && shots.length) {
    const back = M1_HOLD * hz;
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      if (playerId !== undefined && sh.player !== playerId) continue;
      if (sh.tick <= T && T - sh.tick <= back) {
        m1 = true;
        break;
      }
    }
  }

  const m2 = (s0.flags & FLAG_SCOPED) !== 0;

  out.w = w;
  out.a = a;
  out.s = s;
  out.d = d;
  out.ctrl = ctrl;
  out.shift = shift;
  out.space = space;
  out.m1 = m1;
  out.m2 = m2;
  return out;
}
