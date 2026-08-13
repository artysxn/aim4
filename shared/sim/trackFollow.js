// ---------------------------------------------------------------------------
// shared/sim/trackFollow.js
// Shadow a recorded round: press the keys toward where the tape says to be.
//
// This is the mimicry runtime (SIM-PLAN 10.3 layer 3, 10.4). The tape is a
// per-slot sequence of poses from a real round; the follower NEVER teleports
// onto it. It walks, with the same integrator as everything else, toward where
// the recording is a beat from now, and when it cannot keep up (a jump the 2D
// engine cannot take, a boost, a fight that dragged it off) the error is the
// signal: falling off the tape is a local interrupt, because the brain should
// notice it is not where the plan said.
//
// Tracks are source-agnostic on purpose. A recorded sim round and a parsed
// demo round produce the same shape, so the whole follow-and-interrupt
// machinery is testable today with synthetic tapes and swaps to real Spirit
// rounds on the server, where the library lives.
// ---------------------------------------------------------------------------

import { TICK_RATE, ticksFor } from './constants.js';

/** Geodesic error beyond which the follower has fallen off the tape. */
export const FOLLOW_ERROR_UNITS = 180;
/** How long the error must persist before it counts (10.2). */
export const FOLLOW_ERROR_SECONDS = 1.5;
/**
 * How far ahead of "now" the follower aims. Far enough that the carrot stays
 * ahead of the body through a whole decision step at run speed, near enough
 * that corners are still taken as the tape took them.
 */
export const LOOKAHEAD_SECONDS = 0.4;
/** Re-sync: return within this range of the tape to rejoin it. */
export const RESYNC_UNITS = 80;
export const RESYNC_WINDOW_SECONDS = 2;

/**
 * A track: one slot's recorded poses at a fixed rate.
 *
 * @typedef {object} Track
 * @property {number} tickRate   samples per second of the SOURCE recording
 * @property {number} firstTick  source tick of sample 0
 * @property {Array<{x: number, y: number, yaw: number, alive?: boolean}>} samples
 */

/** The recorded pose at a clock (seconds since the track began), clamped. */
export function sampleAt(track, seconds) {
  const raw = seconds * track.tickRate;
  const i = Math.max(0, Math.min(track.samples.length - 1, Math.floor(raw)));
  return track.samples[i];
}

/** Does the tape still have road left at this clock? */
export function tapeAlive(track, seconds) {
  if (!track?.samples?.length) return false;
  const i = Math.floor(seconds * track.tickRate);
  if (i >= track.samples.length) return false;
  const s = track.samples[Math.min(i, track.samples.length - 1)];
  return s.alive !== false;
}

/**
 * Build tracks from a recorder's frames, so a sim round can be a tape.
 *
 * This is the test path AND the ghost-tape path: the same conversion runs on a
 * parsed demo's tick buffer on the server, where `frames` come from readRecord
 * instead. Nothing downstream can tell the difference, which is the point.
 *
 * @param {Array<Array<object>>} frames  RoundRecorder.frames
 * @param {number} [tickRate]
 */
export function tracksFromFrames(frames, tickRate = TICK_RATE) {
  const slots = frames[0]?.length || 0;
  const tracks = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const samples = [];
    for (const frame of frames) {
      const f = frame[slot];
      samples.push(
        f
          ? { x: f.x, y: f.y, yaw: f.yaw, alive: (f.flags & 1) !== 0 }
          : { x: 0, y: 0, yaw: 0, alive: false }
      );
    }
    tracks.push({ tickRate, firstTick: 0, samples });
  }
  return tracks;
}

/**
 * Per-bot follow state. Owned by the translator, not the engine: following is
 * a way of choosing intents, and the engine never knows the tape exists.
 */
export function createFollower(track) {
  return {
    track,
    /** Ticks the error has been over the line, for the 1.5 s rule. */
    errorTicks: 0,
    /** Fell off and was released to the Individual AI. */
    broken: false,
    brokenAtSeconds: 0,
    /** One re-sync is allowed (10.2); after that, autonomous until a replan. */
    resyncUsed: false
  };
}

/**
 * One follow step. Returns where to walk and how, or a break report.
 *
 * @param {object} follower  createFollower state, mutated
 * @param {object} args
 * @param {number} args.seconds     clock since the tape started
 * @param {{x: number, y: number}} args.pos  the body, now
 * @param {(x: number, y: number) => {cx: number, cy: number}|null} args.toCell
 * @param {(a: object, b: object) => number} args.geodesic  units between poses
 * @param {number} [args.dtTicks]   ticks since the last step (decision cadence)
 * @returns {{
 *   status: 'follow'|'done'|'broken'|'resynced',
 *   moveTo?: object, yaw?: number, gait?: string, error?: number
 * }}
 */
export function stepFollower(follower, { seconds, pos, toCell, geodesic, dtTicks = 8 }) {
  const track = follower.track;
  if (!tapeAlive(track, seconds)) return { status: 'done' };

  const now = sampleAt(track, seconds);
  const error = geodesic(pos, now);

  if (follower.broken) {
    // The one re-sync: back within range, once, and only inside the window.
    const windowOpen = seconds - follower.brokenAtSeconds <= RESYNC_WINDOW_SECONDS;
    if (!follower.resyncUsed && windowOpen && error <= RESYNC_UNITS) {
      follower.broken = false;
      follower.resyncUsed = true;
      follower.errorTicks = 0;
      return { status: 'resynced', error };
    }
    return { status: 'broken', error };
  }

  if (error > FOLLOW_ERROR_UNITS) {
    follower.errorTicks += dtTicks;
    if (follower.errorTicks >= ticksFor(FOLLOW_ERROR_SECONDS)) {
      follower.broken = true;
      follower.brokenAtSeconds = seconds;
      return { status: 'broken', error };
    }
  } else {
    follower.errorTicks = 0;
  }

  // Aim a beat ahead so the follower walks the recording's path rather than
  // chasing its current point from behind.
  const ahead = sampleAt(track, seconds + LOOKAHEAD_SECONDS);
  const cell = toCell(ahead.x, ahead.y);
  if (!cell) return { status: 'broken', error };

  // Gait is inferred from the tape's own speed: a recording that is walking
  // should be walked after, or the follower arrives early and loud. Two
  // corrections that field experience forced:
  //
  //   The walk threshold sits well under the walk cap (112), because corner
  //   samples of a RUNNING recording dip below full speed, and classifying
  //   those as walking taxes the follower 100 units a second until it breaks.
  //
  //   Following is closed-loop: once behind by more than half the break
  //   distance, run regardless of what the tape is doing. Fidelity of gait is
  //   worth nothing from 180 units back, and the sound cost of catching up is
  //   exactly what a human shadowing a route does too.
  const next = sampleAt(track, seconds + 1 / track.tickRate);
  const speed = Math.hypot(next.x - now.x, next.y - now.y) * track.tickRate;
  const behind = error > FOLLOW_ERROR_UNITS * 0.5;
  const gait = speed < 5 ? 'stop' : speed < 95 ? 'walk' : 'run';

  return {
    status: 'follow',
    moveTo: cell,
    yaw: now.yaw,
    gait: behind ? 'run' : gait === 'stop' ? 'walk' : gait,
    holdStill: gait === 'stop' && !behind,
    error
  };
}

/**
 * Median and p90 geodesic error over a window: the P3 acceptance numbers
 * (median < 60 u, p90 < 150 u over the first 20 s against a frozen world).
 */
export function followErrorStats(errors) {
  if (!errors.length) return { median: Infinity, p90: Infinity, n: 0 };
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    n: sorted.length
  };
}
