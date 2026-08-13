// Run: node shared/sim/arbiter.test.js
//
// The arbiter is the layer the /sim page watches, so the assertions are the
// watchable properties:
//
//   the best-priced option wins, and says why in English
//   the three anti-dither clocks hold: commitment blocks, hysteresis sticks
//   the price budget is a budget: no candidate beyond it is evaluated
//   the `decisions` trait moves the pick off the argmax, deterministically
//   triggers outrank the status quo; teamwork pulls toward home
//   the mask is the contract: an illegal candidate is never chosen

import { DesireArbiter, HYSTERESIS, PRICE_BUDGET } from './arbiter.js';
import { OptionRunner } from './options.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const traits = (over = {}) => ({
  decisions: 1,
  teamwork: 0.5,
  aggression: 0.5,
  offBall: 0.5,
  ...over
});

const arb = (t = {}, seed = 1, budget = PRICE_BUDGET) =>
  new DesireArbiter({ traits: traits(t), rng: new Rng(seed), priceBudget: budget });

const freeRunner = () => new OptionRunner({ slot: 0 });

// ---- the best price wins, with a motive -------------------------------------

{
  const prices = { swing: 0.6, hold: 0.45, rotate: 0.5 };
  const out = arb().decide({
    tick: 1000,
    runner: freeRunner(),
    candidates: [
      { id: 'wide_swing', params: { spot: 'car' }, prior: 0.5, key: 'swing' },
      { id: 'hold_angle', params: { spot: 'pit' }, prior: 0.5, key: 'hold' },
      { id: 'rotate', params: { site: 'b' }, prior: 0.5, key: 'rotate' }
    ],
    price: (c) => ({ pWin: prices[c.key] })
  });
  assert(out.chosen?.id === 'wide_swing', `the best price wins (${out.chosen?.id})`);
  assert(typeof out.motive === 'string' && out.motive.includes('pp'), `and says why: ${out.motive}`);
  assert(out.log.length === 3, 'every priced candidate is in the log');
}

// ---- commitment blocks the whole question -----------------------------------

{
  const runner = freeRunner();
  runner.begin(1000, 'wide_swing', { spot: 'car' });
  let priceCalls = 0;
  const out = arb().decide({
    tick: 1005, // inside minCommitTicks
    runner,
    candidates: [{ id: 'rotate', params: { site: 'b' } }],
    price: () => {
      priceCalls += 1;
      return { pWin: 0.99 };
    }
  });
  assert(out.chosen === null, 'no replacement inside the commitment window');
  assert(priceCalls === 0, 'and no budget spent asking');
  assert(out.motive.includes('committed'), `the motive says so: ${out.motive}`);
}

// ---- hysteresis sticks ------------------------------------------------------

{
  const runner = freeRunner();
  runner.begin(1000, 'hold_angle', { spot: 'pit' });
  const decideWith = (challengerPWin) =>
    arb().decide({
      tick: 2000, // long past commitment
      runner,
      candidates: [{ id: 'wide_swing', params: { spot: 'car' }, key: 'swing' }],
      price: (c) => ({ pWin: c.isIncumbent ? 0.5 : challengerPWin })
    });

  const marginal = decideWith(0.51);
  assert(marginal.chosen === null, 'a marginal edge does not displace the incumbent');
  assert(marginal.motive.startsWith('staying'), `it reads as staying: ${marginal.motive}`);

  const clear = decideWith(0.5 + HYSTERESIS / 2 + 0.05);
  assert(clear.chosen?.id === 'wide_swing', 'a clear edge does');
}

// ---- the budget is a budget -------------------------------------------------

{
  let priced = 0;
  arb({}, 1, 2).decide({
    tick: 1000,
    runner: freeRunner(),
    candidates: [
      { id: 'wide_swing', params: {}, prior: 0.9 },
      { id: 'rotate', params: {}, prior: 0.8 },
      { id: 'hold_angle', params: {}, prior: 0.2 },
      { id: 'lurk', params: {}, prior: 0.1 }
    ],
    price: () => {
      priced += 1;
      return { pWin: 0.5 };
    }
  });
  assert(priced === 2, `only the cheap-ranked top two are priced (${priced})`);
}

// ---- the decisions trait moves the pick off the argmax ----------------------

{
  const candidates = [
    { id: 'wide_swing', params: {}, key: 'best' },
    { id: 'hold_angle', params: {}, key: 'worse' },
    { id: 'rotate', params: {}, key: 'worst' }
  ];
  const prices = { best: 0.6, worse: 0.55, worst: 0.5 };

  const runs = (decisions, seed) =>
    arb({ decisions }, seed).decide({
      tick: 1000,
      runner: freeRunner(),
      candidates,
      price: (c) => ({ pWin: prices[c.key] })
    }).chosen?.id;

  let sharpOff = 0;
  let dullOff = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    if (runs(1, seed) !== 'wide_swing') sharpOff += 1;
    if (runs(0, seed) !== 'wide_swing') dullOff += 1;
  }
  assert(sharpOff === 0, `a sharp bot never misses the argmax (${sharpOff})`);
  assert(
    dullOff > 30,
    `a dull bot picks the wrong option a real fraction of the time (${dullOff}/300)`
  );

  assert(runs(0, 7) === runs(0, 7), 'and the wobble is deterministic under the seed');
}

// ---- triggers and teamwork --------------------------------------------------

{
  // Equal prices: the trigger-armed candidate wins on its bonus, and the
  // motive is the trigger's English.
  const out = arb().decide({
    tick: 1000,
    runner: freeRunner(),
    candidates: [
      { id: 'hold_angle', params: { spot: 'pit' } },
      {
        id: 'punish_window',
        params: { spot: 'car' },
        trigger: { id: 'awp_cycling', motive: 'their AWP fired and is cycling' }
      }
    ],
    price: () => ({ pWin: 0.5 })
  });
  assert(out.chosen?.id === 'punish_window', 'the armed option outranks the status quo');
  assert(out.motive === 'their AWP fired and is cycling', `the trigger speaks: ${out.motive}`);

  // Home pulls harder on a team player than on a soloist.
  const homeDecide = (teamwork) =>
    arb({ teamwork }).decide({
      tick: 1000,
      runner: freeRunner(),
      candidates: [
        { id: 'take_space', params: { target: 'mid' } },
        { id: 'hold_angle', params: { spot: 'banana' }, isHome: true }
      ],
      price: (c) => ({ pWin: c.isHome ? 0.5 : 0.52 })
    }).chosen?.id;
  assert(homeDecide(1) === 'hold_angle', 'a team player goes home');
  assert(homeDecide(0) === 'take_space', 'a soloist chases the edge');
}

// ---- the mask is the contract -----------------------------------------------

{
  const out = arb().decide({
    tick: 1000,
    runner: freeRunner(),
    candidates: [
      { id: 'defuse', params: {}, prior: 0.99 },
      { id: 'hold_angle', params: { spot: 'pit' } }
    ],
    price: () => ({ pWin: 0.5 }),
    initiation: new Set(['hold_angle'])
  });
  assert(out.chosen?.id === 'hold_angle', 'an illegal candidate is never chosen');

  const empty = arb().decide({
    tick: 1000,
    runner: freeRunner(),
    candidates: [{ id: 'defuse', params: {} }],
    price: () => ({ pWin: 0.5 }),
    initiation: new Set()
  });
  assert(empty.chosen === null && empty.motive.includes('nothing legal'), 'or at all');
}

console.log('arbiter: ok');
