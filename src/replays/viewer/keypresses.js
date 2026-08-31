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
//   motion   W/A/S/D, inverted out of the movement code (below).
//
// ---------------------------------------------------------------------------
// Recovering the wish direction
//
// Source ground movement is two steps a tick, and both are in this repo
// already (shared/sim3d/motion.js):
//
//   Friction()    v -= v̂ · max(|v|, sv_stopspeed) · sv_friction · dt
//   Accelerate()  v += wishdir · accelspeed
//
// So the acceleration a player's position actually shows is the sum
//
//   a = -v̂ · max(|v|, STOP_SPEED) · FRICTION + wishdir · (accelspeed / dt)
//
// which inverts exactly. Add the friction back on and what is left points
// along the keys being held:
//
//   INPUT = a + v̂ · max(|v|, STOP_SPEED) · FRICTION  ∝  wishdir
//
// That one vector answers both halves of the question at once, with no
// thresholds on "how hard is this deceleration" and no special case:
//
//   holding W          INPUT points forward. At a steady sprint the engine is
//                      spending exactly enough accel to cancel friction, so
//                      INPUT is that much, pointing along the run.
//   counter-strafing   INPUT flips to point BACKWARD, the moment the opposite
//                      key goes down, while the player is still sliding
//                      forward. The velocity says W; the input says S.
//   released           INPUT collapses to zero. Friction is doing all of it,
//                      and there is nothing left over.
//
// That last case is the one a velocity-direction reading cannot get right:
// coasting to a stop looks exactly like running until the player has stopped.
//
// Airborne there is no friction, so INPUT is simply the acceleration; air
// accel is capped hard (sv_air_max_wishspeed) so it is a weaker signal, and
// the floor below is lower to match.
//
// Everything is a pure function of the playhead tick, never of playback
// order, so scrubbing, seeking and playing backwards cannot wedge a key on.
// ---------------------------------------------------------------------------

import { FLAG_AIRBORNE, FLAG_DUCKING, FLAG_SCOPED } from '../shared/tickFormat.js';
import { WEAPON_SPEED, DEFAULT_WEAPON_SPEED } from '../../../shared/sim/constants.js';
import { FRICTION, STOP_SPEED, WALK_SPEED_SCALE } from '../../../shared/sim3d/constants.js';

/**
 * Sector half-width for the 8-way key read: sin(22.5°). An input within
 * 22.5° of an axis lights one key; between axes it lights the diagonal pair.
 */
export const SECTOR = Math.sin(Math.PI / 8);

/**
 * How much input (u/s²) counts as a key going down, on the ground.
 *
 * The engine spends ACCEL × wishspeed while a key is held: about 1375 for a
 * sprint, 715 for a walk, and at a steady sprint it is still spending the
 * ~1300 that cancels friction. Nothing held is a flat zero.
 */
export const INPUT_ON = 350;

/**
 * ...and how little it may fall to before it counts as released.
 *
 * The gap is hysteresis, and it is here because of quantization, not taste.
 * Positions are stored in quarter units, so the second difference below can
 * only land on multiples of one quantum: at this stencil that is ~114 u/s²,
 * and a held key whose true input sits near the line would otherwise strobe
 * across it every other tick. Measured over six rounds of a real match, the
 * band takes runs of 2 ticks or shorter from 31% of all presses down to 3%,
 * and lifts the median press from 5 ticks to 16, without moving how often a
 * standing player is wrongly shown holding something (about 1%).
 */
export const INPUT_OFF = 200;

/** How far back the OFF threshold may look for a press to still belong to. */
export const HYSTERESIS_ROWS = 6;

/**
 * A player going slower than this (u/s) is standing, and only a full-strength
 * press may light a key for them.
 *
 * Below sv_stopspeed the friction term is a FIXED 416 u/s² pointing along the
 * velocity, so it clears the ordinary floor on its own. That is fine while
 * the velocity is a real direction and cancels against a real deceleration,
 * and useless when the "velocity" is a quarter unit of quantization noise
 * divided by the stencil: one quantum reads as 2.7 u/s, so anything under a
 * few of those is indistinguishable from standing.
 *
 * The only legitimate input at a standstill is somebody starting to move or
 * leaning on a wall, and both spend ACCEL × wishspeed: 715 for the slowest
 * walk, 1375 for a sprint. So a standing player is asked for double the usual
 * floor, which keeps those and drops the noise, which cannot reach it. Over
 * six rounds of a real match this costs about one point of coverage in the
 * 10-30 u/s band and halves the keys invented for a player who is not moving.
 */
export const STILL_SPEED = 8;

/**
 * The floor for a strafe read in the air.
 *
 * Air accel is capped by sv_air_max_wishspeed at 30 u/s of wish speed, so the
 * most a key can be worth up there is AIR_ACCEL × 30 ≈ 360 u/s², and only
 * ACROSS the motion: Accelerate() gives nothing at all once the player is
 * already going faster than 30 along the direction they are asking for. That
 * is why holding W through a jump is invisible in the data and why the reader
 * carries the ground read instead of inventing one (see AIR_CARRY_ROWS).
 */
export const AIR_INPUT_MIN = 120;

/**
 * Stencil half-width used while airborne, in rows.
 *
 * Wider than the ground one, and it has to be. Up there the true acceleration
 * of a player who is merely holding a key is exactly zero, so the whole
 * reading is quantization: at the ground stencil that noise measures 161 u/s²
 * on a diagonal, against an air input that can never exceed ~360, and it
 * ALTERNATES direction tick to tick. Read at that width a jumping player is
 * shown the opposite diagonal to the one they are holding, half the time.
 *
 * Noise falls with the square of the span, so doubling it takes the floor to
 * about 40 and leaves a real air-strafe (~190 u/s², measured off the sim) at
 * five times the noise. Air time is ~55 ticks, so a ±6 window still fits
 * inside a jump, and the input barely changes across it anyway.
 */
export const AIR_STENCIL = 6;

/**
 * How far back to look for the last grounded row while airborne.
 *
 * A jump is about 55 ticks of hang time, so a second of rows covers one with
 * room to spare. Past that the player is falling off something long enough
 * that the keys they took off with are no longer evidence of anything.
 */
export const AIR_CARRY_ROWS = 64;

/**
 * Half-width, in stored rows, of the stencil the derivatives are taken over.
 *
 * A second difference of three ADJACENT ticks amplifies the quarter-unit
 * position quantum to about 256 u/s², which is most of the way to INPUT_ON;
 * in a real trace the direction sits rock steady while the magnitude jumps in
 * visible 256-unit steps across the threshold. Noise falls with the square of
 * the span, so ±3 rows cuts it to ~114 while the window is still only 94 ms,
 * and the stencil stays CENTRED on the moment: a key lights when it was
 * pressed, not a few ticks after.
 */
export const STENCIL = 3;

/** Below this ground speed (u/s) the Shift read is not attempted. */
export const MOVE_MIN = 30;
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

/**
 * The wish-direction vector at one row, and how fast the player was going.
 *
 * `mag` is what Accelerate() was spending: ~0 with nothing held, and up to
 * ACCEL × wishspeed with a key down. `x`/`y` point along the keys.
 */
export function inputAt(T, { h, hz, sample, stencil = STENCIL, a = {}, s0 = {}, sp = {}, sn = {} }) {
  const now = sample(T, s0);
  if (!now) return null;
  const H = stencil * h;
  const prev = sample(T - H, sp);
  const next = sample(T + H, sn);
  const span = H / hz;

  const px = prev?.x ?? now.x;
  const py = prev?.y ?? now.y;
  const nx = next?.x ?? now.x;
  const ny = next?.y ?? now.y;

  // Central difference, and the second difference on the same stencil.
  const vx = (nx - px) / (2 * span);
  const vy = (ny - py) / (2 * span);
  const speed = Math.hypot(vx, vy);
  let ix = (nx - 2 * now.x + px) / (span * span);
  let iy = (ny - 2 * now.y + py) / (span * span);

  // Add back the friction the engine took off, and what is left is what
  // Accelerate() put in. In the air there is none to add back.
  const airborne = (now.flags & FLAG_AIRBORNE) !== 0;
  if (!airborne && speed > 1e-4) {
    const drag = Math.max(speed, STOP_SPEED) * FRICTION;
    ix += (vx / speed) * drag;
    iy += (vy / speed) * drag;
  }

  a.x = ix;
  a.y = iy;
  a.mag = Math.hypot(ix, iy);
  a.speed = speed;
  a.airborne = airborne;
  a.duckNext = next ? next.duckAmount || 0 : now.duckAmount || 0;
  return a;
}

/** Scratch states so a 64 Hz caller never allocates. */
const S0 = {};
const SP = {};
const SN = {};
const SP2 = {};
const SN2 = {};
const SE = {};
const IN0 = {};
const INK = {};
const ING = {};
const GS0 = {};
const GSP = {};
const GSN = {};
const HS0 = {};
const HSP = {};
const HSN = {};

/**
 * The keys held at one moment.
 *
 * @param {object} args
 * @param {number} args.at        playhead demo tick (fractional is fine)
 * @param {number} args.rate      demo ticks per second
 * @param {number} [args.stride]  ticks between stored rows (1 when full)
 * @param {number} [args.firstTick] tick of row 0, to snap `at` onto rows
 * @param {number} [args.lastTick]  last tick the buffer holds, so the stencil
 *   is never taken across the end of it
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
  lastTick = Infinity,
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
  // The stencil has to fit inside the buffer. A sampler clamps past the ends,
  // which makes the far side of the difference the same row as the near one
  // and turns a steady run into a phantom brake pointing backwards. There are
  // only a few such ticks a round and they are freezetime and post-round, so
  // they read as no keys rather than as wrong ones.
  if (T - STENCIL * h < firstTick || T + STENCIL * h > lastTick) {
    return Object.assign(out, OFF);
  }

  const ctx = { h, hz, sample, a: IN0, s0: S0, sp: SP, sn: SN };
  const now = inputAt(T, ctx);
  const speed = now.speed;
  const airborne = now.airborne;

  // The vector the keys are read off, and the row it belongs to.
  //
  // On the ground that is this row. In the air it usually is NOT: air accel
  // is capped at sv_air_max_wishspeed, so a player already moving faster than
  // 30 u/s along the key they are holding gets no acceleration from it at
  // all. Holding W through a jump leaves no trace to find. What does leave
  // one is a strafe ACROSS the motion, so a clear sideways input up there is
  // read normally, and everything else carries the last grounded row: the
  // keys somebody took off with are the best evidence of the keys they are
  // still holding, and far better evidence than a shrug.
  let read = now;
  let ground = true;
  if (airborne) {
    // The most recent evidence in this jump, wherever it came from.
    //
    // Air accel only happens while the velocity has not yet caught up with
    // the wish direction, so a real strafe shows itself in a burst of a few
    // ticks and then goes silent with the key still held. Carrying the last
    // reading that was ABOVE the floor keeps that burst on screen for the
    // rest of the jump; walking back to the ground row is the fallback for a
    // jump that never showed anything, which is most of them.
    read = null;
    for (let k = 0; k <= AIR_CARRY_ROWS; k++) {
      const at = T - k * h;
      const st = k === 0 ? S0 : sample(at, SE);
      if (!st) break;
      if (!(st.flags & FLAG_AIRBORNE)) {
        // Back on the ground: read that row the ordinary way.
        if (at - STENCIL * h >= firstTick) {
          read = inputAt(at, { h, hz, sample, a: ING, s0: GS0, sp: GSP, sn: GSN });
          ground = true;
        }
        break;
      }
      if (at - AIR_STENCIL * h >= firstTick && at + AIR_STENCIL * h <= lastTick) {
        const wide = inputAt(at, {
          h,
          hz,
          sample,
          stencil: AIR_STENCIL,
          a: ING,
          s0: GS0,
          sp: GSP,
          sn: GSN
        });
        if (wide && wide.mag >= AIR_INPUT_MIN) {
          read = wide;
          ground = false;
          break;
        }
      }
    }
    if (!read) return Object.assign(out, OFF);
  }

  // On/off with hysteresis. A key that was clearly down within the last few
  // rows may stay down through a dip, which is what stops the quantization
  // steps in `mag` from strobing a held key. Bounded and backward-looking
  // only, so this is still a pure function of T: no playback state, and
  // scrubbing to a tick gives the same answer however it was reached.
  let down;
  if (!ground) {
    down = read.mag >= AIR_INPUT_MIN;
  } else {
    const floor = read.speed < STILL_SPEED ? INPUT_ON * 2 : INPUT_ON;
    down = read.mag >= floor;
    if (!down && read.speed >= STILL_SPEED && read.mag >= INPUT_OFF) {
      for (let k = 1; k <= HYSTERESIS_ROWS; k++) {
        const back = inputAt(T - k * h, { h, hz, sample, a: INK, s0: HS0, sp: HSP, sn: HSN });
        if (!back) break;
        if (back.mag >= INPUT_ON) {
          down = true;
          break;
        }
        if (back.mag < INPUT_OFF) break;
      }
    }
  }

  // View basis, from the row the keys are being read at: a carried ground read
  // has to be resolved against the yaw of that row, not of now, or a player
  // who turns in the air comes down holding the wrong keys.
  const readYaw = read === now ? S0.yaw || 0 : GS0.yaw || 0;
  const yawRad = readYaw * (Math.PI / 180);
  const fx = Math.cos(yawRad);
  const fy = Math.sin(yawRad);
  const rx = fy;
  const ry = -fx;

  let w = false;
  let a = false;
  let s = false;
  let d = false;

  if (down && read.mag > 0) {
    const f = (read.x * fx + read.y * fy) / read.mag;
    const r = (read.x * rx + read.y * ry) / read.mag;
    w = f > SECTOR;
    s = f < -SECTOR;
    d = r > SECTOR;
    a = r < -SECTOR;
  }

  // Ctrl: the duck key is down while the duck amount is rising or held up.
  // Falling means released, whatever the amount still is.
  const duckNow = s0.duckAmount || 0;
  const duckNext = now.duckNext;
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
  if (!airborne && duckNow < 0.4 && speed >= MOVE_MIN) {
    const cap = walkCap(weaponName) + WALK_PAD;
    if (speed <= cap) {
      const n2a = sample(T + 6 * h, SP2);
      const n2b = sample(T + 8 * h, SN2);
      const ahead =
        n2a && n2b ? Math.hypot(n2b.x - n2a.x, n2b.y - n2a.y) / (2 * (h / hz)) : 0;
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
