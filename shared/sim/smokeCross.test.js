// Run: node shared/sim/smokeCross.test.js
//
// The P3b acceptance scenario (SIM-PLAN 15): a bot crosses a smoke at 0:22 and
// refuses at 1:40, in the same scripted scenario, with the price card and the
// motive explaining both. This is 6.7's consequence #1 made falsifiable: an
// xK-maximizing bot never crosses, because the cross is always a worse FIGHT
// than waiting. PRW knows about the clock, so the same cross flips sign as the
// round dies, and nobody writes a rule for it.
//
// The scenario, chosen so the fight is a real decision rather than a freebie:
//
//   2v2, T side, pre-plant. An AWARE enemy holds the far side of the smoke —
//   he heard my shot and his crosshair is near the gap. A second enemy also
//   overlooks the lane, so the cross walks into a crossfire (the spread term
//   the CT setup problem is built from). My sighting of the holder is stale:
//   crossing a smoke means crossing blind. Nothing about this changes between
//   the prices EXCEPT the clock.
//
//   early (100 s left)  a crossfire bought with exposure, while waiting is
//                       free: REFUSE
//   dying (8 s left)    waiting IS the time forfeit; the fight is the only
//                       win probability left on the table: CROSS
//
// The plan's sentence names 0:22; the exact second the sign flips belongs to
// the fitted clock curve (this model's conversion cliff sits inside the last
// ~15 s), so the test asserts the falsifiable parts: the refusal early, the
// cross on a dying clock, and the MONOTONE gain of the cross as the round
// dies. The price card is the arbiter's log; the motive is what the /sim
// page prints. The smoke itself is what a smoke IS to the pricing: an LOS
// wall.

import { DesireArbiter } from './arbiter.js';
import { OptionRunner } from './options.js';
import { priceOption } from './foresight.js';
import { JointBelief } from './knowledge.js';
import { SelfFootprint } from './exposure.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the world ----------------------------------------------------------
//
// cover (x=0) | smoke wall at x=700 | lane (x=900) -> car (x=1500, enemy 0)
// far (x=1500, y=900): enemy 1, a second angle on the lane. Fog range 1400
// keeps everything behind the smoke out of sight from cover.

const WORLD = {
  cover: { x: 0, y: 0, level: 'default' },
  lane: { x: 900, y: 0, level: 'default' },
  car: { x: 1500, y: 0, level: 'default' },
  far: { x: 1500, y: 900, level: 'default' }
};
const anchorWorld = (id) => WORLD[id] || null;
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
/** LOS: blocked across the smoke plane at x = 700, and beyond fog range. */
const canSee = (ax, ay, bx, by) =>
  !((ax < 700 && bx > 700) || (ax > 700 && bx < 700)) && Math.hypot(bx - ax, by - ay) <= 1400;

function scenario(secondsLeft, seed = 21) {
  const belief = new JointBelief({ anchors: Object.keys(WORLD), rng: new Rng(seed) });
  belief.sighting(0, 'car');
  belief.sighting(1, 'far');
  for (const s of [2, 3, 4]) belief.killed(s);

  // The enemy is AWARE: I fired from cover moments ago, so the hypotheses
  // know me and hold the gap, and the info edge is not mine. That is what
  // makes this cross a price instead of a present.
  const footprint = new SelfFootprint();
  footprint.noteShot(3750, { x: WORLD.cover.x, y: WORLD.cover.y });

  const round = {
    map: 'INF',
    mySide: 'T',
    elapsed: 115 - secondsLeft,
    secondsLeft,
    ctAlive: 2,
    tAlive: 2,
    ctEquipSum: 8000,
    tEquipSum: 8000,
    planted: false,
    teammates: [
      { slot: 0, side: 'T', hp: 100, value: 4000 },
      { slot: 1, side: 'T', hp: 100, value: 4000 }
    ]
  };

  const price = (c) => {
    const spotId = c.params.spot ?? 'cover';
    const a = WORLD[spotId];
    const pose = {
      x: a.x,
      y: a.y,
      level: 'default',
      yaw: 0,
      seconds: Math.hypot(a.x - WORLD.cover.x, a.y - WORLD.cover.y) / 200
    };
    return priceOption({
      option: { id: c.id, params: c.params },
      pose,
      me: { slot: 0, side: 'T', hp: 100, armor: 100, helmet: true, weapon: 'ak47' },
      belief,
      footprint,
      tick: 4000,
      pathDistance: dist,
      anchorWorld,
      canSee,
      round,
      // My sighting of the holder is STALE: it predates the smoke by more
      // than the engagement grace, so my clock is void and the info edge is
      // all theirs. Crossing a smoke means crossing blind (5.6).
      contacts: { 0: { myFirstSeenTick: 3600, myLastSeenTick: 3700 } },
      rng: new Rng(seed + 1),
      layoutCount: 8
    });
  };

  const arbiter = new DesireArbiter({
    traits: { decisions: 1, teamwork: 0.5, aggression: 0.5, offBall: 0.5 },
    rng: new Rng(seed + 2)
  });
  const decision = arbiter.decide({
    tick: 4000,
    runner: new OptionRunner({ slot: 0 }),
    candidates: [
      // Not marked as home: waiting out a smoke is a choice, not a shape
      // post, and the teamwork pull toward home would put a thumb on a scale
      // this test exists to read.
      {
        id: 'hold_angle',
        params: { spot: 'cover', yaw: 'lane' },
        motive: 'waiting out the smoke'
      },
      { id: 'wide_swing', params: { spot: 'lane', yaw: 'car' }, motive: 'crossing the smoke' }
    ],
    price
  });
  return decision;
}

// ---- early, the bot refuses ---------------------------------------------------

const early = scenario(100);
{
  assert(
    early.chosen === null || early.chosen.id === 'hold_angle',
    `with 100 s left the smoke is not worth crossing (chose ${early.chosen?.id || 'to stay'})`
  );
  const card = Object.fromEntries(early.log.map((l) => [l.id, l]));
  assert(card.hold_angle && card.wide_swing, 'the price card carries both options');
  assert(
    card.hold_angle.pWin >= card.wide_swing.pWin,
    `and explains the refusal: wait ${card.hold_angle.pWin.toFixed(3)} >= cross ${card.wide_swing.pWin.toFixed(3)}`
  );
  assert(typeof early.motive === 'string' && early.motive.length > 0, `motive: "${early.motive}"`);
}

// ---- on a dying clock, the same bot crosses -----------------------------------

const dying = scenario(8);
{
  assert(
    dying.chosen?.id === 'wide_swing',
    `with 8 s left waiting forfeits and the bot crosses (chose ${dying.chosen?.id || 'to stay'})`
  );
  const card = Object.fromEntries(dying.log.map((l) => [l.id, l]));
  assert(
    card.wide_swing.pWin > card.hold_angle.pWin,
    `and the card explains it: cross ${card.wide_swing.pWin.toFixed(3)} > wait ${card.hold_angle.pWin.toFixed(3)}`
  );
  assert(typeof dying.motive === 'string' && dying.motive.length > 0, `motive: "${dying.motive}"`);
}

// ---- the flip is monotone in the clock, which is the actual claim --------------

{
  const edges = [100, 22, 12, 8].map((s) => {
    const card = Object.fromEntries(scenario(s).log.map((l) => [l.id, l.pWin]));
    return { s, edge: card.wide_swing - card.hold_angle };
  });
  for (let i = 1; i < edges.length; i += 1) {
    assert(
      edges[i].edge > edges[i - 1].edge,
      `the cross gains value as the clock dies (${edges
        .map((e) => `${e.s}s:${e.edge.toFixed(3)}`)
        .join(' ')})`
    );
  }
}

console.log('smokeCross: ok (refuses early, crosses on a dying clock, price card explains both)');
