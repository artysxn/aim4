// The Aim chapter's model and its drawing, over aggregated rows.
//
// The chapter is the only place the v2 rating is explained rather than just
// shown, so the things worth pinning are the ones a reader would be misled by:
// an axis with too little sample must not be drawn as a zero, an unscanned
// player must not be told their aim is bad, and the radar must always have the
// seven spokes the trainer's own radar has.

import assert from 'node:assert/strict';
import {
  AIM_MOTION_FIELDS,
  AIM_V2_MOTION_KEYS,
  aimRatingV2,
  emptyMotion,
  motionObject
} from '../shared/aimMetrics.js';
import {
  AIM_OUTCOME_KEYS,
  aimChapterHtml,
  aimHighlights,
  aimModel,
  aimRadarSvg,
  aimScanningHtml
} from './aimChapter.js';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const spinner = (label) => `<span class="spinner">${label}</span>`;

/** An aggregated player row, the shape statsMath.derivePlayers emits. */
function playerRow(motionOverrides = null) {
  const totals = {
    engagements: 300,
    crosshairErrorSum: 300 * 28,
    fightsReady: 210,
    fightsUnaware: 90,
    shots: 600,
    hits: 170,
    firstBullets: 90,
    firstBulletHits: 34,
    overflicks: 11,
    underflicks: 9
  };
  let motion = null;
  if (motionOverrides) {
    const named = motionObject(emptyMotion());
    Object.assign(named, motionOverrides);
    motion = AIM_MOTION_FIELDS.map((k) => named[k]);
  }
  const aim = aimRatingV2(totals, motion);
  return {
    id: 'p1',
    rounds: 400,
    a4aim: aim.rating,
    a4aimV1: aim.v1,
    aimHasMotion: aim.hasMotion,
    aimComponents: aim.components,
    aimRaw: aim.raw,
    aimSample: aim.sample,
    aimEngines: aim.engines
  };
}

/** A comfortably-sampled motion half. */
const FULL_MOTION = {
  closeN: 120,
  closeSum: 120 * 90,
  flickHit: 70,
  flickOver: 25,
  flickUnder: 25,
  speedN: 120,
  pathDeg: 120 * 55,
  flickMs: 120 * 260,
  directDeg: 120 * 40,
  segments: 70,
  targets: 40,
  reactDirMs: 30 * 260,
  reactDirN: 30,
  reactHoldMs: 30 * 140,
  reactHoldN: 30,
  trackOn: 900,
  trackN: 2600
};

// ---------------------------------------------------------------------------
{
  // A player nobody has measured yet: outcome scored, motion blank, and the
  // rating is the outcome-only one rather than a penalty for missing data.
  const model = aimModel(playerRow(null));
  assert.equal(model.scanned, false, 'not scanned');
  assert.equal(model.rating, model.v1, 'the rating is the outcome-only rating');
  // And the hero does not print the same number twice with a +0.0 next to it.
  const unscannedHtml = aimChapterHtml(model, escapeHtml);
  assert.ok(!unscannedHtml.includes('Outcome only'), 'no second copy of the same rating');
  assert.ok(unscannedHtml.includes('Rounds'), 'the sample is shown instead');
  assert.equal(model.motion.length, AIM_V2_MOTION_KEYS.length, 'seven motion axes regardless');
  assert.equal(model.outcome.length, AIM_OUTCOME_KEYS.length, 'six outcome axes');
  for (const c of model.motion) {
    assert.equal(c.score, null, `${c.key} has no score`);
    assert.ok(c.need > 0, `${c.key} says how much sample it wants`);
  }
  assert.ok(
    model.outcome.every((c) => Number.isFinite(c.score)),
    'every outcome axis scored'
  );

  // Drawn, not dropped: the radar still has seven spokes and seven labels.
  const svg = aimRadarSvg(model);
  for (const { label } of AIM_V2_MOTION_KEYS) {
    assert.ok(svg.includes(`>${label}</tspan>`), `${label} is still an axis`);
  }
  assert.equal((svg.match(/pf-aim-dot thin/g) || []).length, 7, 'all seven read as unmeasured');
}

// ---------------------------------------------------------------------------
{
  // Measured: every motion axis scores, and the rating moves off v1.
  const row = playerRow(FULL_MOTION);
  const model = aimModel(row);
  assert.equal(model.scanned, true, 'scanned');
  for (const c of model.motion) {
    assert.ok(Number.isFinite(c.score), `${c.key} scored`);
    assert.ok(Number.isFinite(c.engine), `${c.key} carries the trainer rating too`);
  }
  assert.notEqual(model.rating, model.v1, 'the motion half changed the number');

  const svg = aimRadarSvg(model);
  assert.equal((svg.match(/pf-aim-dot thin/g) || []).length, 0, 'nothing reads as unmeasured');
  assert.ok(svg.includes('pf-aim-base'), 'the 1.00 outline is drawn');

  const html = aimChapterHtml(model, escapeHtml);
  assert.ok(html.includes('Aim rating'), 'the hero names the rating');
  assert.ok(html.includes('Outcome only'), 'and shows what it was without motion');
  for (const { label } of AIM_V2_MOTION_KEYS) {
    assert.ok(html.includes(`>${label}</th>`), `${label} has a row`);
  }
  for (const { label } of AIM_OUTCOME_KEYS) {
    assert.ok(html.includes(`>${label}</th>`), `${label} has a row`);
  }
  // The motion table is scored on the trainer's own 0.00-2.00 scale.
  assert.ok(html.includes('>Rating</th>'), 'motion is headed Rating');
  assert.ok(html.includes('>Score</th>'), 'outcome is headed Score');
}

// ---------------------------------------------------------------------------
{
  // One axis under its floor is dropped from the rating and labelled with what
  // it still needs, rather than being drawn as a zero anyone would read as bad.
  const thin = { ...FULL_MOTION, trackOn: 4, trackN: 8 };
  const model = aimModel(playerRow(thin));
  const tracking = model.motion.find((c) => c.key === 'tracking');
  assert.equal(tracking.score, null, 'tracking is not scored');
  const html = aimChapterHtml(model, escapeHtml);
  assert.ok(html.includes('8 of 200 samples'), `it says what it needs: ${html.slice(0, 40)}`);
}

// ---------------------------------------------------------------------------
{
  // Highlights pick the extremes across BOTH halves, which is the point of the
  // chapter: "your weakest thing" is not a per-table question.
  const model = aimModel(playerRow(FULL_MOTION));
  const { best, worst } = aimHighlights(model);
  assert.ok(best && worst, 'both ends found');
  assert.ok(best.score >= worst.score, 'and they are the right way round');
  const scores = model.scored.map((c) => c.score);
  assert.equal(best.score, Math.max(...scores), 'best is the maximum');
  assert.equal(worst.score, Math.min(...scores), 'worst is the minimum');
}

// ---------------------------------------------------------------------------
{
  // The loading state counts down in matches, and says nothing it cannot know.
  const checking = aimScanningHtml(null, spinner);
  assert.ok(checking.includes('Checking your matches'), 'no counts before the first answer');
  assert.ok(!checking.includes('matches left'), 'and no invented number');

  const mid = aimScanningHtml({ total: 30, pending: 12 }, spinner);
  assert.ok(mid.includes('12 matches left'), 'the count is the pending count');
  assert.ok(mid.includes('18 of 30 measured'), 'and the progress line agrees with it');
  assert.ok(mid.includes('width:60%'), 'the bar matches');

  const one = aimScanningHtml({ total: 30, pending: 1 }, spinner);
  assert.ok(one.includes('1 match left'), 'singular reads as singular');
}

// ---------------------------------------------------------------------------
{
  // No row at all is an empty chapter, not a crash.
  assert.equal(aimModel(null), null, 'no stats, no model');
  assert.ok(aimChapterHtml(null, escapeHtml).includes('No aim data'), 'and it says so');
  assert.equal(aimRadarSvg(null), '', 'nothing to draw');
}

console.log('aimChapter.test.js: model, radar, thin axes and the loading state all pass');
