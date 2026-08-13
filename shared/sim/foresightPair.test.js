// Run: node shared/sim/foresightPair.test.js
//
// The paired price (SIM-PLAN 19.6) exists because single-body foresight puts
// the value of a bait on the wrong body: the peeker draws the shot and the
// PARTNER collects it, so a solo pricer sees a peek that costs exposure and
// returns nothing, and correctly refuses to ever do it. The properties worth
// testing are therefore about attribution, not about a number:
//
//   the pair beats the sum of its parts when the bait actually buys the
//   partner something, and does not when it does not
//   the peeker's exposure is charged to the pair rather than ignored
//   pricing never mutates the state it prices (a pricer with side effects
//   would make the second candidate priced differently from the first)

import { loadBake } from '../../server/sim/bakes.js';
import { navGraphFromBake } from './navGraph.js';
import { loadAngles } from './angles.js';
import { JointBelief } from './knowledge.js';
import { SelfFootprint } from './exposure.js';
import { priceOptionPair, BAIT_INFO_SECONDS } from './foresight.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
  console.log('  ' + msg);
}

const nav = await loadBake('navcache', 'INF');
const anglesBake = await loadBake('angles', 'INF');
if (!nav || !anglesBake) {
  console.log('foresightPair: skipped (no baked map)');
  process.exit(0);
}

const graph = navGraphFromBake(nav.bake);
const angles = loadAngles(anglesBake.bake);
const rng = new Rng(11);

const anchorIds = [...graph.anchors.keys()];
const belief = new JointBelief({ anchors: anchorIds, rng: rng.fork() });
const footprint = new SelfFootprint();

const spot = graph.anchor(anchorIds[0]);
const mate = graph.anchor(anchorIds[1]);

const round = {
  map: 'INF',
  mySide: 'T',
  elapsed: 30,
  secondsLeft: 60,
  ctAlive: 5,
  tAlive: 5,
  ctEquipSum: 20000,
  tEquipSum: 20000,
  planted: false,
  bombSecondsLeft: 0,
  ctHasKit: true,
  teammates: [
    { slot: 0, side: 'T', hp: 100, value: 4000 },
    { slot: 1, side: 'T', hp: 100, value: 4000 }
  ]
};

const shared = {
  belief,
  footprint,
  tick: 64 * 30,
  pathDistance: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by),
  anchorWorld: (id) => {
    const a = graph.anchor(id);
    return a ? { x: a.world.x, y: a.world.y, level: a.level } : null;
  },
  canSee: (ax, ay, bx, by, level) => angles.canSee(ax, ay, bx, by, level),
  round,
  contacts: { 0: { myFirstSeenTick: 64 * 25, myLastSeenTick: 64 * 28 } },
  rng: rng.fork(),
  layoutCount: 6
};

const body = (slot, id, world, optionId) => ({
  option: { id: optionId, params: { spot: id } },
  pose: { x: world.x, y: world.y, level: 'default', yaw: 0, seconds: 1 },
  me: { slot, side: 'T', hp: 100, armor: 100, helmet: true, weapon: 'ak47' }
});

// ---- the pair is priced as one decision ------------------------------------

{
  const pair = priceOptionPair({
    bait: body(0, anchorIds[0], spot.world, 'jiggle'),
    punish: body(1, anchorIds[1], mate.world, 'hold_angle'),
    shared
  });

  assert(Number.isFinite(pair.pWin), 'the pair prices to a number');
  assert(pair.parts.soloBait !== undefined, 'and shows what each body was worth alone');
  assert(
    pair.parts.baitCost >= 0,
    'the peeker is charged for showing himself, never paid for it'
  );
  assert(
    Math.abs(pair.pWin - (pair.parts.soloPunish + pair.parts.partnerGain - pair.parts.baitCost)) <
      1e-9,
    'and the card adds up to the price'
  );
  assert(
    typeof pair.parts.worthIt === 'boolean',
    'the card says outright whether the drawn shot paid for the peek'
  );
}

// ---- pricing does not move the world ----------------------------------------

{
  const args = {
    bait: body(0, anchorIds[0], spot.world, 'shoulder_peek'),
    punish: body(1, anchorIds[1], mate.world, 'hold_angle'),
    shared: { ...shared, rng: new Rng(5) }
  };
  const first = priceOptionPair(args);
  const second = priceOptionPair({ ...args, shared: { ...shared, rng: new Rng(5) } });
  assert(
    Math.abs(first.pWin - second.pWin) < 1e-9,
    'the same pair priced twice costs the same (no hidden state)'
  );
  assert(
    shared.contacts[0].myLastSeenTick === 64 * 28,
    'and the contact log the bait window reads was not mutated'
  );
}

// ---- the bait window is a stated constant ------------------------------------

{
  assert(BAIT_INFO_SECONDS > 0 && BAIT_INFO_SECONDS < 3, 'the drawn-shot window is a real window');
}

console.log('foresightPair: ok (paired price, attribution, no side effects)');
