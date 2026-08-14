// Run: node shared/sim/prw.test.js
//
// The two PRWs (18.6b). A row carries what we believed and never where
// anybody stood; the truth is sealed until the round is over; the residual
// becomes a bias on a situation, gated like every other memory.

import {
  FRAME_EVERY_TICKS,
  PERC_MARGIN,
  PICTURE_FIELDS,
  PRW_REASON,
  calibrationBias,
  calibrationFromRows,
  createPrwLog,
  prwCurves,
  prwOf,
  rankAgrees,
  residualStats,
  scrubPicture,
  truePictureFrom,
  valueSamples
} from './prw.js';
import { ExperienceIndex } from './experience.js';
import { pictureWinrate } from './caller.js';
import { BOMB_SECONDS, TICK_RATE } from './constants.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function picture(extra = {}) {
  return {
    side: 'T',
    alive: 5,
    enemyAlive: 5,
    clock: 20,
    secondsLeft: 95,
    planted: false,
    ...extra
  };
}

// ---- the honesty guard ----------------------------------------------------

{
  const dirty = picture({
    x: 1234,
    y: -900,
    anchor: 'banana',
    enemies: [{ slot: 7, x: 10, y: 20 }],
    particles: new Map([['a', 1]]),
    lastSeenAt: { x: 5, y: 6 }
  });
  const clean = scrubPicture(dirty);
  for (const bad of ['x', 'y', 'anchor', 'enemies', 'particles', 'lastSeenAt']) {
    assert(!(bad in clean), `${bad} does not survive the scrub`);
  }
  assert(clean.alive === 5 && clean.enemyAlive === 5, 'the counts do survive');
  for (const field of Object.keys(clean)) {
    assert(PICTURE_FIELDS.includes(field), `${field} is on the allowlist`);
  }
}

{
  const log = createPrwLog({ side: 'T', map: 'INF' });
  log.log({
    tick: 100,
    reason: PRW_REASON.RECALL,
    situation: 'sit-a',
    picture: picture({ x: 900, y: 12, enemies: [1, 2] }),
    pWinBelief: 0.8,
    fightEv: 0.02,
    decision: 'freeze',
    motive: 'ahead: next fight is not required',
    truth: picture({ alive: 5, enemyAlive: 5, x: 1, y: 2 })
  });
  const [row] = log.rows();
  assert(!('x' in row.picture) && !('enemies' in row.picture), 'a logged row carries no positions');
  assert(row.pWin_belief === 0.8 && row.attrib === null, 'the row is 18.6b shaped');
  assert(row.pWin_true === undefined, 'truth is sealed before the round ends');
  assert(row.residual === undefined, 'and so is the residual');

  log.grade();
  const [scored] = log.rows();
  assert(Number.isFinite(scored.pWin_true), 'grading opens the seal');
  assert(
    Math.abs(scored.residual - (scored.pWin_true - scored.pWin_belief)) < 1e-9,
    'residual is truth minus belief'
  );
}

// ---- density: the team frame, not 8 Hz ------------------------------------

{
  const log = createPrwLog({ side: 'CT' });
  for (let t = 0; t < FRAME_EVERY_TICKS * 3; t += 1) {
    log.log({ tick: t, reason: PRW_REASON.FRAME, picture: picture({ side: 'CT' }), truth: picture({ side: 'CT' }) });
  }
  assert(log.size() === 3, `frames are rate-limited (${log.size()})`);
  log.log({ tick: 1, reason: PRW_REASON.DEATH, picture: picture({ side: 'CT' }), truth: picture({ side: 'CT' }) });
  log.log({ tick: 2, reason: PRW_REASON.RECALL, picture: picture({ side: 'CT' }), truth: picture({ side: 'CT' }) });
  assert(log.size() === 5, 'events are never rate-limited');
}

// ---- the same arithmetic on both sides ------------------------------------

{
  // Believed an empty site, truth is that it was full. Same function, same
  // model, one picture each: the residual is the picture and nothing else.
  const believed = picture({ siteExpectedTarget: 0, packAtTarget: 3 });
  const truth = picture({ siteExpectedTarget: 3, packAtTarget: 3 });
  assert(prwOf(believed) > prwOf(truth), 'a site believed empty prices better than a full one');

  const log = createPrwLog({ side: 'T' });
  log.log({ tick: 10, reason: PRW_REASON.RECALL, situation: 'empty-site', picture: believed, truth });
  const [row] = log.grade();
  assert(row.residual < 0, 'and the residual says the picture was overconfident');
}

// ---- truth from an engine, in the believed picture's shape ----------------

{
  const engine = {
    state: {
      tick: 640,
      liveTick: 0,
      plantTick: 0,
      bomb: { planted: false },
      bodies: [
        { alive: true, health: 100, hasKit: false },
        { alive: true, health: 40, hasKit: false },
        { alive: false, health: 0, hasKit: false },
        { alive: true, health: 100, hasKit: false },
        { alive: true, health: 100, hasKit: false },
        { alive: true, health: 100, hasKit: true, site: 'a' },
        { alive: true, health: 100, hasKit: false, site: 'a' },
        { alive: false, health: 0, hasKit: false },
        { alive: true, health: 100, hasKit: false, site: 'b' },
        { alive: true, health: 100, hasKit: false, site: null }
      ]
    },
    clock: () => 85
  };
  const t = truePictureFrom(engine, {
    side: 'T',
    ourSlots: [0, 1, 2, 3, 4],
    enemySlots: [5, 6, 7, 8, 9],
    inTarget: (b) => b.site === 'a',
    inOther: (b) => b.site === 'b'
  });
  assert(t.alive === 4 && t.enemyAlive === 4, 'true counts are counted, not believed');
  assert(t.siteExpectedTarget === 2, 'two of them really are on the site we called');
  assert(t.siteExpectedOther === 1, 'and one is on the other');
  assert(t.bombSecondsLeft === BOMB_SECONDS && t.planted === false, 'no plant, no bomb clock');
  assert(t.clock === 10, `clock is seconds since live (${t.clock})`);
  assert(!('x' in t) && !('bodies' in t), 'the true picture is scalars too');
  assert(Math.abs(TICK_RATE * 10 - engine.state.tick) < 1, 'the fixture is 10 s in');
}

// ---- calibration is a memory, so it is gated ------------------------------

{
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    rows.push({ situation: 'thin', residual: -0.4, pWin_true: 0.3, pWin_belief: 0.7, tick: i });
  }
  for (let i = 0; i < 20; i += 1) {
    rows.push({ situation: 'thick', residual: -0.4, pWin_true: 0.3, pWin_belief: 0.7, tick: i });
  }
  const cal = calibrationFromRows(rows);
  assert(cal.get('thin').bias === 0, 'three rows is not a lesson');
  assert(cal.get('thick').bias < 0, 'twenty rows is');
  assert(cal.get('thick').bias >= -0.15, 'and the bias is capped');
  assert(Math.abs(cal.get('thick').mean + 0.4) < 1e-9, 'the mean itself is unclamped');
  assert(calibrationBias({ n: 100, sum: 100 }) === 0.15, 'the cap holds in both directions');
}

{
  const stats = residualStats([
    { residual: -0.3 },
    { residual: -0.1 },
    { residual: 0.2 },
    { residual: 0.4 }
  ]);
  assert(stats.n === 4, 'four rows');
  assert(Math.abs(stats.mean - 0.05) < 1e-9, 'mean residual');
  assert(Math.abs(stats.mae - 0.25) < 1e-9, 'mean absolute residual');
  assert(stats.over === 1 && stats.under === 2, 'over- and under-confident rows are counted apart');
}

// ---- the bias reaches the live number, and only the number ----------------

{
  const base = pictureWinrate(picture());
  const biased = pictureWinrate(picture({ calBias: -0.1 }));
  assert(Math.abs(base - biased - 0.1) < 1e-9, 'calBias shifts the believed winrate');
  const pinned = pictureWinrate(picture({ alive: 5, enemyAlive: 0, calBias: 0.5 }));
  assert(pinned <= 1, 'and stays a probability');
}

{
  const index = new ExperienceIndex();
  assert(index.calibrationFor('key-a') === 0, 'an unseen situation has no bias');
  for (let i = 0; i < 12; i += 1) index.writeCalibration({ key: 'key-a', residual: -0.3 });
  const bias = index.calibrationFor('key-a');
  assert(bias < 0 && bias >= -0.15, `the index gates and caps the bias (${bias})`);
  assert(index.calibrationRow('key-a').n === 12, 'and keeps the count');
  assert(index.read('key-a').cal === bias, 'a read carries it');
}

// ---- perc does not move call value ----------------------------------------

{
  const index = new ExperienceIndex();
  for (let i = 0; i < 6; i += 1) {
    index.write({ key: 'sit', call: 'b-split', won: i % 2 === 0, attrib: 'call' });
  }
  const before = index.read('sit', 'b-split');
  index.write({ key: 'sit', call: 'b-split', won: false, attrib: 'perc' });
  index.writeCalibration({ key: 'sit', residual: -0.25 });
  const after = index.read('sit', 'b-split');

  assert(after.n === before.n, 'a perceptual loss adds no pull');
  assert(after.w === before.w, 'and no win counter moves');
  assert(after.lower === before.lower, 'so the call value is untouched');
  assert(after.mean === before.mean, 'by mean as well as by bound');
  assert(after.attrib.perc > before.attrib.perc, 'but the bucket is counted');
  assert(after.attrib.call === before.attrib.call, 'and not as a calling mistake');
}

// ---- rankings, curves and the aux head ------------------------------------

{
  const believed = [
    { id: 'hold', value: 0.4 },
    { id: 'rotate', value: 0.2 }
  ];
  assert(rankAgrees(believed, [{ id: 'hold', value: 0.1 }, { id: 'rotate', value: 0.05 }]), 'same top option agrees');
  assert(!rankAgrees(believed, [{ id: 'hold', value: 0.1 }, { id: 'rotate', value: 0.9 }]), 'a flipped top disagrees');
  assert(!rankAgrees([], believed), 'nothing to compare does not agree');
}

{
  const log = createPrwLog({ side: 'T', map: 'INF' });
  log.log({ tick: 200, reason: PRW_REASON.FREEZE, situation: 's1', picture: picture(), truth: picture(), motive: 'default a-split' });
  log.log({ tick: 300, reason: PRW_REASON.DEATH, situation: 's1', picture: picture({ alive: 4 }), truth: picture({ alive: 4, enemyAlive: 5 }) });
  const graded = log.grade();
  const curves = prwCurves(graded);
  assert(curves.length === 2, 'both rows are on the clock');
  assert(curves[0].tick < curves[1].tick, 'sorted by tick');
  assert(curves.every((c) => Number.isFinite(c.believed) && Number.isFinite(c.truth)), 'both curves are drawable');
  assert(curves[0].motive === 'default a-split', 'the motive string rides along');

  const samples = valueSamples(graded, { side: 'T', map: 'INF', obsAt: (t) => [t / 1000, 0.5] });
  assert(samples.length === 2, 'one aux-head float per decision');
  assert(samples[0].pWin_true === graded[0].pWin_true, 'the head trains on true PRW, not on W/L');
  assert(samples[0].obs.length === 2, 'with the observation beside it when there is one');

  const drained = log.drain();
  assert(drained.length === 2 && log.size() === 0, 'draining hands the round over');
}

assert(PERC_MARGIN > 0.05 && PERC_MARGIN < 0.5, 'the perception margin is a margin');

console.log('prw: ok');
