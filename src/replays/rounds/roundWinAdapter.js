// ---------------------------------------------------------------------------
// replays/rounds/roundWinAdapter.js
// The trained round model, wearing the old model's interface.
//
// coach/winProbability.js has been the round win predictor since before any of
// this was fitted, and half a dozen call sites speak its dialect: percentages
// from 0 to 100, a `{ ct, t, parts }` bag, and a `winProbabilityAtTick` that
// takes a round's meta plus a slot-indexed states array. Rewriting every one of
// those to speak probabilities and feature bags would be a large diff whose
// only purpose is translation, so the translation lives here instead and the
// call sites barely change.
//
// What this is NOT is a second model. There is one set of weights, fitted once,
// and `predictRound` is the only thing that scores anything. This file converts
// units and assembles an explanation.
//
// The old file keeps its measurement half. `liveEquipment`, `plantSituationAt`,
// `ctHasDefuseKitAt`, `deadPlayersAt`, `decidedSideAt`, `NADE_COST` and the two
// defuse deadlines are all still the shared source of truth, and the trained
// model imports them. Only the scoring is replaced.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { phaseAtTick, phaseBounds } from '../coach/roundPhases.js';
import { decidedSideAt } from '../coach/winProbability.js';
import { roundFeaturesAt } from './roundFeatures.js';
import { predictRound, roundLogit } from './roundModel.js';
import { predictRoundCalibrated } from './roundCalibration.js';
import { roundCalibration, roundParamVector } from './roundModelParams.js';

/**
 * Floor and ceiling on the reported percentage.
 *
 * Matches the old model's FLOOR/CEIL so nothing downstream that compares
 * against 1 or 99 changes meaning. A round is never truly certain until it is
 * over, and the ones that are over are answered by `decided` instead.
 */
const FLOOR = 1;
const CEIL = 99;

const clampPct = (p) => Math.max(FLOOR, Math.min(CEIL, p * 100));

/**
 * Score a feature bag, in the old model's units.
 *
 * @param {object} f       from roundFeaturesAt
 * @param {string} mapCode
 * @param {'early'|'mid'|'late'} phase
 * @param {'CT'|'T'|null} decided
 * @returns {{ ct: number, t: number, parts: object }}
 */
export function roundWinFromFeatures(f, mapCode, phase, decided = null) {
  if (decided === 'CT') return { ct: 100, t: 0, parts: { decided } };
  if (decided === 'T') return { ct: 0, t: 100, parts: { decided } };

  const v = roundParamVector();
  const calib = roundCalibration();
  const p = predictRoundCalibrated(f, v, mapCode, phase, calib);
  const ct = clampPct(p);
  return {
    ct,
    t: 100 - ct,
    parts: {
      decided: null,
      logit: roundLogit(f, v, mapCode),
      raw: predictRound(f, v, mapCode),
      phase,
      geometryKnown: f.geometryKnown !== false,
      features: f
    }
  };
}

/**
 * The round's win probability at a tick, mirroring `winProbabilityAtTick`.
 *
 * `network`, `presence`, `track` and `reloadTracker` are all optional. Without
 * them the geometry features go neutral and the reading falls back to bodies,
 * economy, the clock and the plant, which is precisely the information the old
 * model had. Callers that can supply geometry get a sharper answer; callers
 * that cannot are no worse off than before.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {Array} args.states           slot-indexed tick records or kill-log stubs
 * @param {number} args.tick
 * @param {object} [args.network]
 * @param {object} [args.presence]
 * @param {object} [args.track]
 * @param {object} [args.reloadTracker]
 * @param {object} [args.bounds]         precomputed phaseBounds, to avoid rework
 * @returns {object|null}
 */
export function roundWinAtTick({
  meta,
  states,
  tick,
  network = null,
  presence = null,
  track = null,
  reloadTracker = null,
  bounds = null
}) {
  if (!meta) return null;
  const mapCode = meta.map || '';
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const winnerSide = meta.winnerSide || (meta.winner === 1 ? teamSides[1] : teamSides[2]);
  const endTick = meta.endTick ?? meta.freezeEndTick ?? 0;

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

  const decided = decidedSideAt({
    tick,
    endTick,
    winnerSide,
    ctAlive: f.ctAlive,
    tAlive: f.tAlive,
    bomb: meta.events?.bomb
  });

  const phase = phaseAtTick(tick, bounds || phaseBounds(meta));
  const wp = roundWinFromFeatures(f, mapCode, phase, decided);

  return {
    tick,
    ct: wp.ct,
    t: wp.t,
    ctAlive: f.ctAlive,
    tAlive: f.tAlive,
    ctEff: f.ctEff,
    tEff: f.tEff,
    ctEquip: f.equipDiff,
    tEquip: -f.equipDiff,
    parts: wp.parts
  };
}
