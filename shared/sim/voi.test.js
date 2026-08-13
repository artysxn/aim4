// Run: node shared/sim/voi.test.js
//
// 19.4 is arithmetic over prices computed elsewhere, so every assertion here is
// about the arithmetic having the right SHAPE. Nothing is priced: the matrices
// are written by hand, which is the point — this module must never call
// foresight.priceOption.
//
//   unanimity is worth exactly nothing: VOI === 0, strictly, and commit
//   a top-two swap is worth something: VOI > 0
//   the three regimes of 19.4's table come out of ONE surplus inequality,
//     re-derived from the returned parts to prove it
//   a closing window commits at any plausible VOI, and checks nothing else
//   uncertainty about the WORLD gathers instead of widening
//   the novelty cap (20.11) zeroes the budget and locks the commitment
//   nothing here reads a clock or a die

import {
  budgetDecision,
  noveltyCap,
  resolvableShare,
  visualizationBudget,
  voi,
  CONTINGENCY_CAPTURE,
  CONTINGENCY_SECONDS,
  NOVELTY_COMMIT_MULT,
  WIDEN_SECONDS
} from './voi.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/** options.js MIN_COMMIT_TICKS, passed in rather than imported (6.6 owns it). */
const BASE_COMMIT_TICKS = 24;

// ---- the formula ------------------------------------------------------------

{
  // Every hypothesis wants swing. Clairvoyance buys nothing at all.
  const p = voi({
    prices: [
      [0.6, 0.7, 0.62],
      [0.4, 0.5, 0.48]
    ],
    ids: ['swing', 'hold']
  });
  assert(p.value === 0, `unanimity is worth exactly 0 (${p.value})`);
  assert(p.unanimous, 'and says so');
  assert(p.bestId === 'swing', 'the modal option is the one everybody wants');
  assert(p.bestShare === 1, 'which dominates every hypothesis');
  assert(p.clairvoyant === p.mixture, 'the two terms are the same number, bit for bit');

  const d = budgetDecision({ voi: p, dPRWPerSecond: 0.01, minCommitTicks: BASE_COMMIT_TICKS });
  assert(d.decision === 'commit', 'a zero read commits immediately');
  assert(/more thinking cannot change the pick/.test(d.reason), `motive: ${d.reason}`);
}

{
  // The top two swap: swing wins if they are on car, hold wins if they are pit.
  const p = voi({
    prices: [
      [0.6, 0.4],
      [0.4, 0.6]
    ],
    ids: ['swing', 'hold']
  });
  assert(Math.abs(p.value - 0.1) < 1e-12, `a swap is worth the gap (${p.value})`);
  assert(!p.unanimous, 'and it is not unanimous');
  assert(p.bestShare === 0.5, 'the modal option leads half the mass');
  assert(p.clairvoyant > p.mixture, 'clairvoyance beats the mixture whenever they disagree');
}

{
  // A collapsed belief: one hypothesis carries the mass, so there is nothing to
  // learn even though the options disagree wildly.
  const p = voi({
    prices: [
      [0.6, 0.1],
      [0.4, 0.9]
    ],
    weights: [1, 0]
  });
  assert(p.value === 0, `a known world makes clairvoyance free (${p.value})`);

  // One option is not a choice.
  const single = voi({ prices: [[0.6, 0.2, 0.9]] });
  assert(single.value === 0, 'a single option has nothing to decide');
  assert(resolvableShare(single) === 0, 'and nothing thinking can fix');

  // Degenerate input does not throw at 8 Hz.
  assert(voi({}).value === 0, 'an empty matrix is worth nothing');
  let threw = false;
  try {
    voi({ prices: [[0.5, 0.5], [0.5]] });
  } catch {
    threw = true;
  }
  assert(threw, 'a ragged matrix is a caller bug and says so');
}

// ---- resolvable: arithmetic uncertainty versus world uncertainty ------------

{
  // Same tiny lead in every hypothesis: the margin has no spread, so no number
  // of extra draws moves it. This is the world talking, not the sample.
  const settled = voi({
    prices: [
      [0.60, 0.50, 0.40],
      [0.59, 0.49, 0.39]
    ]
  });
  assert(resolvableShare(settled) === 0, 'an agreed margin is not resolvable by thinking');

  // A margin that lives inside its own noise: another batch could flip it.
  const noisy = voi({
    prices: [
      [0.70, 0.30, 0.55],
      [0.30, 0.70, 0.54]
    ]
  });
  assert(
    resolvableShare(noisy) > 0.8,
    `a margin inside the noise is mostly resolvable (${resolvableShare(noisy).toFixed(3)})`
  );
}

// ---- 19.4's three regimes, out of one inequality -----------------------------

{
  // Row 1: early, a second is nearly free, the hypotheses disagree.
  const early = budgetDecision({
    voi: 0.05,
    resolvable: 0.5,
    dPRWPerSecond: 0.008,
    cap: 12,
    layoutCount: 4,
    minCommitTicks: BASE_COMMIT_TICKS
  });

  // Row 2: mid round, a lean exists, the clock has started to bite.
  const mid = budgetDecision({
    voi: 0.015,
    resolvable: 0.35,
    dPRWPerSecond: 0.05,
    cap: 12,
    layoutCount: 8,
    minCommitTicks: BASE_COMMIT_TICKS
  });

  // Row 3: the window shuts before the thinking finishes.
  const closing = budgetDecision({
    voi: 0.06,
    resolvable: 0.5,
    dPRWPerSecond: 0.35,
    cap: 12,
    layoutCount: 8,
    minCommitTicks: BASE_COMMIT_TICKS
  });

  assert(early.decision === 'widen' && early.alsoGather, `early widens and gathers: ${early.reason}`);
  assert(early.budget === 8, 'and buys the next batch');

  assert(mid.decision === 'commit', `a lean commits: ${mid.reason}`);
  assert(mid.contingency, 'with one cheap contingency armed');
  assert(mid.budget === 8, 'and spends no more hypotheses');

  assert(closing.decision === 'commit', `a closing window commits: ${closing.reason}`);
  assert(!closing.contingency, 'and checks nothing else');
  assert(/check nothing else/.test(closing.reason), `motive: ${closing.reason}`);

  // The claim the plan makes: the third row is the same inequality, not a
  // special case. Re-derive all three decisions from the surpluses alone.
  const derived = (r) => {
    const { widenSurplus: w, gatherSurplus: g } = r.parts;
    if (w <= 0 && g <= 0) return 'commit';
    return w >= g ? 'widen' : 'gather';
  };
  for (const r of [early, mid, closing]) {
    assert(derived(r) === r.decision, `${r.decision} is the surplus test and nothing else`);
    assert(
      r.parts.widenSurplus === r.parts.widenGain - r.parts.widenCost,
      'surplus is gain minus cost, everywhere'
    );
  }
  // Three distinct behaviours, and the only thing that differed between the
  // three calls is the state: same function, same arguments, same line.
  const behaviour = (r) => `${r.decision}/${r.alsoGather}/${r.contingency}`;
  assert(
    new Set([behaviour(early), behaviour(mid), behaviour(closing)]).size === 3,
    'three behaviours out of one function'
  );
}

// ---- a closing window beats any plausible read ------------------------------

{
  // Fully resolvable by thinking, and a very high VOI. The window still wins:
  // inside a punish window (6.15, ~1.4 s) no plausible VOI beats a second.
  const d = budgetDecision({
    voi: 0.09,
    resolvable: 1,
    dPRWPerSecond: 0.35,
    cap: 12,
    layoutCount: 4
  });
  assert(d.decision === 'commit', `the window dominates the read: ${d.reason}`);
  assert(d.parts.widenSurplus < 0, 'because thinking costs more than it buys');
  assert(
    d.parts.widenCost === WIDEN_SECONDS * 0.35,
    'and the cost is exactly the seconds times the clock price'
  );

  // The same read with a calm clock widens: the clock is what moved it.
  const calm = budgetDecision({ voi: 0.09, resolvable: 1, dPRWPerSecond: 0.01, cap: 12, layoutCount: 4 });
  assert(calm.decision === 'widen', 'the same read widens when the clock is cheap');
}

// ---- world uncertainty gathers, it does not widen ---------------------------

{
  const args = { voi: 0.05, dPRWPerSecond: 0.008, cap: 12, layoutCount: 4 };

  const world = budgetDecision({ ...args, resolvable: 0 });
  assert(world.decision === 'gather', `unresolvable uncertainty gathers: ${world.reason}`);
  assert(world.parts.widenGain === 0, 'thinking is on the shelf at zero value');
  assert(/no amount of thinking resolves it/.test(world.reason), `motive: ${world.reason}`);

  const arithmetic = budgetDecision({ ...args, resolvable: 1 });
  assert(arithmetic.decision === 'widen', 'and the same read widens when thinking can fix it');

  // Nothing to jiggle with, nothing to throw: the purchase is not on the shelf.
  const nothing = budgetDecision({ ...args, resolvable: 0, gatherAvailable: false });
  assert(nothing.decision === 'commit', 'an action that does not exist cannot be bought');

  // At the machine ceiling there is no widening left however cheap the clock.
  const full = budgetDecision({ ...args, resolvable: 1, layoutCount: 12 });
  assert(full.parts.headroom === false, '6.7 is a hard ceiling');
  assert(full.decision !== 'widen', 'and the tactical budget cannot spend past it');
}

// ---- the novelty cap (20.11) ------------------------------------------------

{
  const blind = { retrievalMatched: false, splitEntropy: 2.4, dominance: 0.4 };
  const args = {
    voi: 0.05,
    resolvable: 1,
    dPRWPerSecond: 0.008,
    cap: 12,
    layoutCount: 4,
    minCommitTicks: BASE_COMMIT_TICKS
  };

  const capped = budgetDecision({ ...args, novelty: blind });
  assert(capped.decision === 'commit', `genuine novelty commits: ${capped.reason}`);
  assert(capped.budget === 0, 'the budget is zeroed deliberately, not spent down');
  assert(
    capped.commitTicks === BASE_COMMIT_TICKS * NOVELTY_COMMIT_MULT,
    `the hysteresis lock bounds the deviation (${capped.commitTicks} ticks)`
  );
  assert(capped.commitTicks / 64 > 1, 'by more than a second of not switching');
  assert(capped.comm?.level === 5, 'and a Level 5 comm goes out');
  assert(
    typeof capped.comm.asp.if === 'string' && typeof capped.comm.asp.then === 'string',
    'carrying an ASP so the team commits with you'
  );
  assert(/pick a wall and follow it/.test(capped.reason), `motive: ${capped.reason}`);

  // All three conjuncts are load-bearing: drop any one and the arithmetic is
  // trusted again, which is what proves the cap is what bound the bot.
  const familiar = budgetDecision({ ...args, novelty: { ...blind, retrievalMatched: true } });
  const settled = budgetDecision({ ...args, novelty: { ...blind, splitEntropy: 0.3 } });
  const dominant = budgetDecision({ ...args, novelty: { ...blind, dominance: 0.95 } });
  assert(familiar.decision === 'widen', 'a remembered situation is not novel');
  assert(settled.decision === 'widen', 'a settled split is not novel');
  assert(dominant.decision === 'widen', 'a dominant price needs no cap');
  assert(
    familiar.budget === 8 && familiar.commitTicks === BASE_COMMIT_TICKS,
    'and none of them lock the commitment'
  );

  // The cap reads the modal option's dominance off the price matrix when the
  // caller hands over the whole voi() result.
  const swap = voi({ prices: [[0.6, 0.4], [0.4, 0.6]], ids: ['swing', 'hold'] });
  const fromMatrix = budgetDecision({
    ...args,
    voi: swap,
    novelty: { retrievalMatched: false, splitEntropy: 2.4 }
  });
  assert(fromMatrix.decision === 'commit', 'bestShare 0.5 is not dominance');
  assert(/commit swing:/.test(fromMatrix.reason), `the motive names the pick: ${fromMatrix.reason}`);

  // Standalone, without a minCommitTicks the caller keeps its own base.
  const bare = noveltyCap(blind);
  assert(bare.capped && bare.commitTicks === null, 'the multiplier travels, the base does not');
  assert(noveltyCap({}).capped === false, 'the default situation is a familiar one');
}

// ---- traits set how much of the ceiling exists ------------------------------

{
  const cap = 12; // foresight.HYPOTHESIS_COUNT, passed in by the caller
  const pro = visualizationBudget({ cap, traits: { concentration: 1, composure: 1, anticipation: 1 } });
  const weak = visualizationBudget({ cap, traits: { concentration: 0, composure: 0, anticipation: 0 } });
  assert(pro.cap === 12, 'full concentration spends the whole ceiling');
  assert(weak.cap < pro.cap, `low concentration spends less of it (${weak.cap})`);
  assert(pro.lookaheadSeconds > weak.lookaheadSeconds, 'anticipation looks further ahead');

  // Composure is the only thing that resists pressure: a 1v2 collapses the
  // breadth of a bot that has none, which is what a tier-2 clutch looks like.
  const calm = visualizationBudget({ cap, traits: { concentration: 0.6, composure: 1 }, pressure: 1 });
  const rattled = visualizationBudget({ cap, traits: { concentration: 0.6, composure: 0 }, pressure: 1 });
  assert(rattled.cap < calm.cap, `pressure collapses the rattled bot (${rattled.cap} vs ${calm.cap})`);
  assert(rattled.cap >= 1, 'but something always gets priced');

  // The drain, marked speculative in the plan: thinking wide early costs late.
  const fresh = visualizationBudget({ cap, traits: { concentration: 0.8 } });
  const spent = visualizationBudget({ cap, traits: { concentration: 0.8 }, spent: 36 });
  assert(spent.cap < fresh.cap, `early breadth costs late breadth (${spent.cap} vs ${fresh.cap})`);
}

// ---- determinism ------------------------------------------------------------

{
  const call = () =>
    budgetDecision({
      voi: voi({ prices: [[0.6, 0.4, 0.55], [0.4, 0.62, 0.5]], ids: ['swing', 'hold'] }),
      resolvable: 0.4,
      dPRWPerSecond: 0.03,
      cap: 12,
      layoutCount: 6,
      minCommitTicks: BASE_COMMIT_TICKS,
      novelty: { retrievalMatched: false, splitEntropy: 1.9 }
    });
  assert(JSON.stringify(call()) === JSON.stringify(call()), 'the same matrix decides the same way');

  // The contingency's crossover is the same line with a smaller cost: it is the
  // only difference between 19.4's second and third rows.
  const armed = (v, perSecond) =>
    budgetDecision({ voi: v, resolvable: 0, gatherAvailable: false, dPRWPerSecond: perSecond })
      .contingency;
  const perSecond = 0.05;
  const edge = (CONTINGENCY_SECONDS * perSecond) / CONTINGENCY_CAPTURE;
  assert(armed(edge * 1.5, perSecond), 'above the crossover one trigger stays armed');
  assert(!armed(edge * 0.5, perSecond), 'below it, nothing else gets checked');
}

console.log('voi: ok');
