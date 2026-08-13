// Run: node shared/sim/foresight.test.js
//
// Foresight is arithmetic over models fitted elsewhere, so the assertions are
// about the arithmetic having the right SHAPE, not about absolute numbers:
//
//   unawareness is worth money: the same swing prices better before I have
//     fired than after (infoAdvSecs through the fitted duel model)
//   being outnumbered hurts: two watchers price worse than one
//   peek style is a price: a jiggle pays a quarter of a wide swing's exposure
//   an empty read prices as the round, not as a fight
//   the draw is deterministic under the seed
//
// The world is a stub: two anchors, euclidean distance, everything sees
// everything. The models are the real fitted ones — that is the point.

import { priceOption, drawLayouts, simPhase, syntheticFighter } from './foresight.js';
import { JointBelief } from './knowledge.js';
import { SelfFootprint } from './exposure.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const WORLD = {
  car: { x: 1000, y: 0, level: 'default' },
  pit: { x: 1000, y: 800, level: 'default' },
  cover: { x: 0, y: 0, level: 'default' }
};
const anchorWorld = (id) => WORLD[id] || null;
const canSee = () => true;
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

/** A belief collapsed onto a known layout, with the rest of the slots dead. */
function beliefWith(placements, seed = 1) {
  const b = new JointBelief({ anchors: Object.keys(WORLD), rng: new Rng(seed) });
  for (let s = 0; s < 5; s += 1) {
    if (placements[s]) b.sighting(s, placements[s]);
    else b.killed(s);
  }
  return b;
}

const baseRound = (mySide = 'T') => ({
  map: 'INF',
  mySide,
  elapsed: 30,
  secondsLeft: 85,
  ctAlive: mySide === 'CT' ? 1 : 1,
  tAlive: mySide === 'T' ? 1 : 1,
  ctEquipSum: 4000,
  tEquipSum: 4000,
  planted: false,
  teammates: [{ slot: 0, side: mySide, hp: 100, value: 4000 }]
});

const price = (overrides = {}) =>
  priceOption({
    option: { id: 'wide_swing', params: { spot: 'car' } },
    pose: { x: 400, y: 0, level: 'default', yaw: 0, seconds: 1 },
    me: { slot: 0, side: 'T', hp: 100, weapon: 'ak47' },
    belief: beliefWith({ 0: 'car' }),
    footprint: new SelfFootprint(),
    tick: 2000,
    pathDistance: dist,
    anchorWorld,
    canSee,
    round: baseRound('T'),
    contacts: { 0: { myFirstSeenTick: 1900, myLastSeenTick: 1990 } },
    rng: new Rng(42),
    ...overrides
  });

// ---- shape ------------------------------------------------------------------

{
  const p = price();
  assert(p.pWin > 0 && p.pWin < 1, `a price is a probability (${p.pWin.toFixed(3)})`);
  assert(p.parts.layouts === 12, 'twelve hypotheses drawn');
  assert(p.parts.pContact === 1, 'a collapsed belief meets contact in every layout');
  assert(p.parts.duels === 12, 'one duel per layout against the one live enemy');
}

// ---- unawareness is worth money ---------------------------------------------

{
  const quiet = price();

  const loud = new SelfFootprint();
  loud.noteShot(1995, { x: 400, y: 0 }); // they heard me; my edge is gone
  const heard = price({ footprint: loud });

  assert(
    quiet.pWin > heard.pWin,
    `the same swing prices better unheard (${quiet.pWin.toFixed(3)} vs ${heard.pWin.toFixed(3)})`
  );
}

// ---- being outnumbered hurts ------------------------------------------------

{
  const oneEnemy = price();
  const twoEnemies = price({
    belief: beliefWith({ 0: 'car', 1: 'pit' }),
    contacts: {
      0: { myFirstSeenTick: 1900, myLastSeenTick: 1990 },
      1: { myFirstSeenTick: 1900, myLastSeenTick: 1990 }
    }
  });
  assert(
    twoEnemies.pWin < oneEnemy.pWin,
    `a second watcher lowers the price (${twoEnemies.pWin.toFixed(3)} vs ${oneEnemy.pWin.toFixed(3)})`
  );
}

// ---- peek style is a price --------------------------------------------------

{
  const swing = price();
  const jiggle = price({ option: { id: 'jiggle', params: { spot: 'car', cover: 'cover' } } });
  assert(
    jiggle.pWin > swing.pWin,
    `a jiggle exposes less than a swing into the same lane (${jiggle.pWin.toFixed(3)} vs ${swing.pWin.toFixed(3)})`
  );
}

// ---- an empty read prices as the round --------------------------------------

{
  // Everyone believed dead except a slot placed out of line of sight.
  const blind = price({
    canSee: () => false,
    belief: beliefWith({ 0: 'pit' })
  });
  assert(blind.parts.duels === 0, 'no line of sight, no duels');
  assert(blind.parts.pContact === 0, 'and no contact');
  assert(blind.pWin > 0 && blind.pWin < 1, 'the round still has a price');
}

// ---- determinism ------------------------------------------------------------

{
  const a = price({ rng: new Rng(7) });
  const b = price({ rng: new Rng(7) });
  assert(a.pWin === b.pWin, 'the same seed prices the same');
}

// ---- the small helpers ------------------------------------------------------

{
  assert(simPhase({ elapsed: 10 }) === 'early', 'a fresh round is early');
  assert(simPhase({ elapsed: 100 }) === 'late', 'a dying clock is late');
  assert(
    simPhase({ elapsed: 10, ctAlive: 2, tAlive: 3 }) === 'late',
    'a 2v3 is late whatever the clock says'
  );

  const f = syntheticFighter({ slot: 0, side: 'T', x: 0, y: 0, weapon: 'awp' });
  assert(f.category === 'sniper' && f.price > 4000, 'a synthetic AWPer holds an AWP');

  const b = beliefWith({ 0: 'car' });
  const layouts = drawLayouts(b, 5, new Rng(3));
  assert(layouts.length === 5, 'five layouts drawn');
  assert(
    layouts.every((l) => l[0]?.anchor === 'car' && !l[1] && !l[2] && !l[3] && !l[4]),
    'a collapsed belief draws its one layout'
  );
}

console.log('foresight: ok');
