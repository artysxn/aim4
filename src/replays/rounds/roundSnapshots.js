// ---------------------------------------------------------------------------
// replays/rounds/roundSnapshots.js
// One round, walked into labelled training samples.
//
// Every sample is the round state at a tick, tagged with its phase, and labelled
// with which side actually went on to win. Three of them per round are marked as
// exam points:
//
//   examEarly  the early to mid transition   (phaseBounds.midStartTick)
//   examMid    the mid to late transition    (phaseBounds.lateStartTick)
//   examFinal  ten seconds before the round ended
//
// Those three are graded separately in the trainer, because "how good is this
// model" has three different answers depending on when you ask. Predicting a
// round forty seconds in, with everyone alive and nothing decided, is a
// genuinely different problem from predicting it ten seconds before the end
// when there is one player left holding a bombsite.
//
// Ticks where the round is already factually over are excluded. A wipe or a
// completed defuse has no prediction left in it, and including those moments
// would hand the model a large slice of free, perfect accuracy that would
// flatter every number downstream.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { timingFor } from '../viewer/roundClock.js';
import { phaseAtTick, phaseBounds } from '../coach/roundPhases.js';
import { decidedSideAt } from '../coach/winProbability.js';
import { createReloadTracker } from '../duels/reloadTracker.js';
import { roundFeaturesAt } from './roundFeatures.js';

/** Ticks between samples. 64 at 64 tick is one per second. */
export const DEFAULT_STRIDE = 64;

/** How long before the round ended the final exam is taken. */
export const FINAL_EXAM_LEAD_SECONDS = 10;

/**
 * Walk one round.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {import('../tickStore.js').TickTrack} args.track
 * @param {object} [args.network]   prepared zone network
 * @param {string} args.mapCode
 * @param {object} [args.presence]  zone presence, for possession shares
 * @param {number} [args.stride]
 * @returns {{ samples: Array, stats: object }}
 */
export function extractRoundSnapshots({
  meta,
  track,
  network = null,
  mapCode,
  presence = null,
  stride = DEFAULT_STRIDE
}) {
  const timing = timingFor(meta);
  const tickRate = timing.tickRate || 64;
  const bounds = phaseBounds(meta);
  const start = timing.freezeEndTick;
  const end = Math.min(timing.endTick, track.lastTick);

  // Which side won, as the label. Rounds with no recorded winner are unusable.
  const winnerSide = meta.winnerSide === 'CT' || meta.winnerSide === 'T' ? meta.winnerSide : null;
  const stats = { samples: 0, decidedSkipped: 0, exams: 0, noWinner: winnerSide ? 0 : 1 };
  if (!winnerSide) return { samples: [], stats };

  const y = winnerSide === 'CT' ? 1 : 0;
  const reloadTracker = createReloadTracker({ meta });
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };

  // The three moments that get their own exam. Clamped into the round, and
  // deduplicated: a very short round can put two of them on the same tick.
  const examTicks = new Map();
  const claim = (name, tick) => {
    const t = Math.max(start, Math.min(end, Math.round(tick)));
    if (!examTicks.has(t)) examTicks.set(t, name);
  };
  claim('examEarly', bounds.midStartTick);
  claim('examMid', bounds.lateStartTick);
  claim('examFinal', end - FINAL_EXAM_LEAD_SECONDS * tickRate);

  const samples = [];
  const states = [];

  const sampleAt = (tick, exam) => {
    track.sampleAll(tick, states);
    const f = roundFeaturesAt({
      meta,
      track,
      tick,
      states,
      network,
      mapCode,
      presence,
      reloadTracker
    });

    // A round that is already over is not a prediction.
    const decided = decidedSideAt({
      tick,
      endTick: end,
      winnerSide,
      ctAlive: f.ctAlive,
      tAlive: f.tAlive,
      bomb: meta.events?.bomb
    });
    if (decided) {
      stats.decidedSkipped++;
      return;
    }

    samples.push({
      tick,
      phase: phaseAtTick(tick, bounds),
      exam: exam || '',
      y,
      f
    });
    stats.samples++;
    if (exam) stats.exams++;
  };

  const walked = new Set();
  for (let tick = start; tick <= end; tick += stride) {
    walked.add(tick);
    sampleAt(tick, examTicks.get(tick) || '');
  }
  // The exam ticks are fixed moments and almost never land on the stride, so
  // they are taken explicitly rather than snapped to the nearest sample.
  for (const [tick, name] of examTicks) {
    if (!walked.has(tick)) sampleAt(tick, name);
  }

  samples.sort((a, b) => a.tick - b.tick);
  return {
    samples,
    stats: {
      ...stats,
      round: meta.round,
      map: mapCode,
      winnerSide,
      teamSides,
      midStartTick: bounds.midStartTick,
      lateStartTick: bounds.lateStartTick
    }
  };
}
