// ---------------------------------------------------------------------------
// replays/rounds/roundExplain.js
// Why the round model said what it said.
//
// The old model's explainer read out its own hand-written vocabulary: a map
// base percentage, an even-man T lean, plant bonus tiers. None of those exist
// any more, so the breakdown has to be rebuilt from what the trained model
// actually computes.
//
// The method is ablation, the same one used to verify the model was wired
// correctly in the first place: neutralise one group of inputs, re-score, and
// report the difference. That gives an honest answer in the model's own
// currency (log-odds) without anyone hand-maintaining a parallel description
// that could drift from the code.
//
// Groups rather than individual parameters, because "manW contributed 1.4" is
// not a sentence a person reading a win chart wants. "Players alive" is.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { roundLogit } from './roundModel.js';
import { roundParamVector } from './roundModelParams.js';

/**
 * Each group, and what the round would look like if that aspect were even.
 *
 * The neutral form matters: it has to be the value the model treats as "no
 * information", which for every difference term is zero and for the clock is a
 * full round remaining.
 */
const GROUPS = [
  ['Players alive', (f) => ({ ...f, ctAlive: f.tAlive, ctEff: f.tEff })],
  ['Health', (f) => ({ ...f, ctEff: f.ctAlive, tEff: f.tAlive })],
  ['Equipment', (f) => ({ ...f, equipDiff: 0 })],
  ['Open gunfights', (f) => ({ ...f, duelEdge: 0, bombDuelEdge: 0 })],
  ['Utility', (f) => ({ ...f, utilDiff: 0 })],
  ['Map control', (f) => ({ ...f, possessionDiff: 0 })],
  ['Positioning', (f) => ({ ...f, centroidDist: 0, nearestDist: 0 })],
  ['Time left', (f) => ({ ...f, secondsLeft: ROUND_SECONDS })],
  [
    'Bomb',
    (f) => ({
      ...f,
      planted: false,
      bombSecondsLeft: 0,
      ctHasKit: false,
      bombDistDiff: 0,
      ctBombDist: 0,
      tBombDist: 0,
      ctInSite: 0,
      tInSite: 0,
      keyZoneNet: 0,
      defuseSlack: 0,
      defuseImpossible: false
    })
  ]
];

/** Contributions below this are noise and not worth a line. */
const MIN_LOGIT = 0.02;

/**
 * Per-group contributions to the current prediction, largest first.
 *
 * @param {object} sample  from roundWinAtTick
 * @param {string} mapCode
 * @returns {Array<{ label: string, logit: number, pp: number }>}
 */
export function explainRound(sample, mapCode = '') {
  const f = sample?.parts?.features;
  if (!f) return [];
  const v = roundParamVector();
  const full = roundLogit(f, v, mapCode);
  const base = 1 / (1 + Math.exp(-full));

  const out = [];
  for (const [label, neutralise] of GROUPS) {
    const without = roundLogit(neutralise(f), v, mapCode);
    const logit = full - without;
    if (Math.abs(logit) < MIN_LOGIT) continue;
    // Also express it as the percentage points it is worth at this operating
    // point, since a log-odds number means nothing to most readers and the
    // same log-odds is worth far less near 95% than near 50%.
    const pp = (base - 1 / (1 + Math.exp(-without))) * 100;
    out.push({ label, logit, pp });
  }
  out.sort((a, b) => Math.abs(b.logit) - Math.abs(a.logit));
  return out;
}

/**
 * The breakdown as display lines, replacing the old `explainProbability`.
 *
 * @param {object} sample
 * @param {string} mapCode
 * @returns {string[]}
 */
export function explainRoundLines(sample, mapCode = '') {
  if (sample?.parts?.decided) {
    return [`Round already decided for ${sample.parts.decided}`];
  }
  const lines = [];
  if (sample?.parts?.geometryKnown === false) {
    lines.push('Positions unavailable, reading bodies and economy only');
  }
  const parts = explainRound(sample, mapCode);
  if (!parts.length) return lines.length ? lines : ['Nothing separating the sides'];

  for (const p of parts) {
    const who = p.pp >= 0 ? 'CT' : 'T';
    lines.push(`${p.label}: ${who} ${Math.abs(p.pp).toFixed(1)}pp`);
  }
  return lines;
}
