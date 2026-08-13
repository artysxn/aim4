// Run: node shared/sim/conservation.test.js
//
// SIM-PLAN 19.7 is three claims, and each one is only worth having if it holds
// as a PROPERTY rather than at a number:
//
//   utility only ever falls, and never below zero, because a side cannot
//     un-throw a grenade
//   a fake must be affordable, so P(fake) falls monotonically as the believed
//     reserve falls, with no rule anywhere that mentions fakes
//   silence is evidence, and it resolves into three hypotheses that all keep
//     real mass rather than into one default
//   a side priced out of a fair fight is expected further forward and more
//     stacked, and the same arithmetic run the other way expects a rich side
//     to sit back, which is the check that it is derived rather than typed in
//   the bodies read is the belief's own count, not a second one that could
//     disagree with it
//
// The numbers in conservation.js are `[calibrate]` guesses. Nothing below
// asserts one, on purpose: every assertion here survives any plausible
// recalibration of them.

import {
  EXECUTE_HEAVY_NEED,
  EnemyEconomy,
  EnemyUtilityTracker,
  LOADOUTS,
  SILENCE_HYPOTHESES,
  bodiesRead,
  enemyRiskPosture,
  expectedEquipValue,
  loadoutPosterior,
  massOf,
  nadePrice,
  pFake,
  posturePrior,
  readConservation,
  silencePosterior,
  utilityBound
} from './conservation.js';
import { NADE } from './grenades.js';
import { JointBelief } from './knowledge.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- law 1: bodies are the belief's, not a second opinion ---------------------

const ANCHORS = ['a_site', 'a_short', 'b_site', 'banana', 'mid'];
const inA = (a) => a === 'a_site' || a === 'a_short';

{
  const b = new JointBelief({ anchors: ANCHORS, rng: new Rng(7) });
  assert(bodiesRead(b).alive === b.aliveCount(), 'the bodies read is the belief count');
  assert(bodiesRead(b).alive === 5, 'five to start');

  b.killed(1);
  b.killed(3);
  const read = bodiesRead(b);
  assert(read.alive === b.aliveCount(), 'and it still is after the feed moves');
  assert(read.alive === 3 && read.dead === 2, 'two dead, three alive');
  assert(read.deadSlots.join(',') === '1,3', 'and it names them');

  // With a zone, it answers the question a fake has to survive: how many are
  // committed here, and how many are left to be the real thing.
  const zoned = bodiesRead(b, inA);
  assert(close(zoned.committed, b.expected(inA), 1e-12), 'committed is the belief expectation');
  assert(close(zoned.pEmpty, b.countDist(inA)[0], 1e-12), 'and pEmpty is its own zero bin');
  assert(zoned.committed + zoned.elsewhere <= 5 + 1e-9, 'bodies are conserved across the split');
}

// ---- law 2: the bound, and the decrement ------------------------------------

{
  const bound = utilityBound({ side: 'T', alive: 5, utilityBudget: 900 });
  assert(bound.byType[NADE.SMOKE] === 3, '900 dollars buys at most three smokes');
  assert(bound.byType[NADE.MOLOTOV] === 2, 'or two molotovs');
  assert(bound.total === 4, 'and at most four grenades of any kind');
  assert(utilityBound({ side: 'CT' }).byType[NADE.INCENDIARY] != null, 'CTs hold incendiaries');
  assert(nadePrice(NADE.INCENDIARY) > nadePrice(NADE.MOLOTOV), 'and pay more for the same fire');

  const slots = utilityBound({ alive: 5 });
  assert(slots.total === 20, 'with money no object, carry slots are the bound');
  assert(slots.byType[NADE.FLASH] === 10, 'two flashes each');
}

{
  // A detonation we saw decrements the believed inventory, and it never goes
  // negative however many we see.
  const t = new EnemyUtilityTracker({ side: 'T', alive: 5 });
  const before = t.remaining(NADE.SMOKE);
  assert(before === 5, 'five bodies could hold five smokes');

  t.sawDetonation({ type: NADE.SMOKE, tick: 100 });
  assert(t.remaining(NADE.SMOKE) === before - 1, 'a seen detonation decrements the reserve');
  assert(t.totalSpent() === 1, 'and lands in the spend history');

  for (let i = 0; i < 20; i += 1) t.sawDetonation({ type: NADE.SMOKE, tick: 200 + i });
  assert(t.remaining(NADE.SMOKE) === 0, 'the reserve bottoms out at zero');
  assert(t.remainingTotal() >= 0, 'and the total never goes negative');
  assert(t.projectedReserve().heavy >= 0, 'nor does the heavy count');
  assert(t.log.length === 21, 'every percept is on the record');
}

{
  // A throw we heard and then watched land is ONE grenade. Double counting here
  // would deflate the reserve and walk a bot onto a site believing they are dry.
  const t = new EnemyUtilityTracker({ side: 'T', alive: 5 });
  t.heardThrow({ type: NADE.SMOKE, tick: 10 });
  assert(t.spentOf(NADE.SMOKE) === 1, 'a heard throw is already spent');
  t.sawDetonation({ type: NADE.SMOKE, tick: 40 });
  assert(t.spentOf(NADE.SMOKE) === 1, 'and the detonation is the same grenade');

  // A throw we could not name spends the total rather than a type, and the
  // detonation that follows resolves it.
  const u = new EnemyUtilityTracker({ side: 'T', alive: 5 });
  u.heardThrow({ tick: 10 });
  assert(u.totalSpent() === 1 && u.remaining(NADE.SMOKE) === 5, 'an unnamed throw spends no type');
  u.sawDetonation({ type: NADE.SMOKE, tick: 40 });
  assert(u.totalSpent() === 1, 'and it was that smoke all along');
  assert(u.remaining(NADE.SMOKE) === 4, 'which now shows against the smokes');

  // A grenade the buy was not believed to contain is still a grenade: the
  // spend is counted off the percept, and the total falls even though the read
  // said they could not have one.
  const v = new EnemyUtilityTracker({ side: 'T', bound: { byType: { [NADE.SMOKE]: 2 }, total: 3 } });
  v.sawDetonation({ type: NADE.HE });
  assert(v.totalSpent() === 1, 'an unbudgeted HE is spent all the same');
  assert(v.remaining(NADE.HE) === 0, 'it just leaves nothing behind');
  assert(v.remainingTotal() === 2, 'and it comes off the total');
}

{
  // The late round is a count, not a guess.
  const t = new EnemyUtilityTracker({
    side: 'CT',
    bound: { byType: { [NADE.SMOKE]: 1, [NADE.INCENDIARY]: 3 }, total: 4 }
  });
  for (let i = 0; i < 3; i += 1) t.sawDetonation({ type: NADE.INCENDIARY });
  t.sawDetonation({ type: NADE.SMOKE });
  const reserve = t.projectedReserve();
  assert(reserve.total === 0 && reserve.heavy === 0, 'three molotovs and a smoke was the whole buy');
  assert(reserve.exact, 'so "they have nothing left" is arithmetic, not a feeling');
  assert(close(reserve.resolved, 1), 'the buy is fully accounted for');

  // A body that dies takes his unthrown utility with him: law 1 on law 2.
  const s = new EnemyUtilityTracker({ side: 'T', alive: 5 });
  const full = s.projectedReserve().total;
  s.bodiesLost(2);
  assert(s.projectedReserve().total < full, 'two survivors cannot hold five players of utility');
}

{
  // The tracker FEEDS the existing ledger rather than reimplementing it.
  const t = new EnemyUtilityTracker({ side: 'T', bound: { byType: { [NADE.SMOKE]: 2, [NADE.FLASH]: 2 }, total: 4 } });
  const led = t.ledger({ ours: [NADE.SMOKE, NADE.HE], spentByUs: 1 });
  assert(led.theirHeavy === 2 && led.theirLight === 2, 'the believed inventory reads as a ledger row');
  assert(led.ourHeavy === 1 && led.ourLight === 1, 'ours is exact, theirs is believed');
  assert(led.heavyBalance === -1, 'and the balance is the number late rounds turn on');
  assert(led.spentByThem === 0, 'nothing of theirs has been spent yet');
}

// ---- law 2: a fake must be affordable ----------------------------------------

{
  // Two smokes on B. The tracker has already taken them off the board, so what
  // is left is what could pay for the real execute, and P(fake) drops out with
  // no rule that mentions fakes anywhere.
  const t = new EnemyUtilityTracker({
    side: 'T',
    bound: { byType: { [NADE.SMOKE]: 2, [NADE.MOLOTOV]: 2, [NADE.FLASH]: 2 }, total: 6 }
  });

  const series = [t.pFake().p];
  for (const type of [NADE.SMOKE, NADE.SMOKE, NADE.MOLOTOV, NADE.MOLOTOV]) {
    t.sawDetonation({ type });
    series.push(t.pFake().p);
  }
  for (let i = 1; i < series.length; i += 1) {
    assert(series[i] < series[i - 1], `P(fake) must fall as utility falls (step ${i})`);
  }
  assert(series[series.length - 1] === 0, 'a side with nothing left cannot afford a lie');
  assert(t.projectedReserve().heavy === 0, 'because the heavies are the thing being counted');

  // Every value stays a probability, and more reserve is always more fake.
  for (const r of [0, 1, 2, 3, 5, 8, 40]) {
    const p = pFake({ reserveHeavy: r }).p;
    assert(p >= 0 && p <= 1, `P(fake) is a probability at reserve ${r}`);
  }
  assert(pFake({ reserveHeavy: 4 }).p > pFake({ reserveHeavy: 1 }).p, 'monotone in the reserve');
  assert(
    pFake({ reserveHeavy: 40 }).affordability === 1,
    'and it saturates rather than running past the base rate'
  );
  assert(EXECUTE_HEAVY_NEED > 0, 'the need is what the reserve is measured against');

  // Law 1 arrives at the same answer from the other side: a fake with four
  // bodies committed to it is not a fake.
  const rich = { reserveHeavy: 5, alive: 5 };
  assert(pFake({ ...rich, committed: 4 }).p < pFake({ ...rich, committed: 1 }).p, 'bodies price the lie too');
  assert(pFake({ ...rich, committed: 5 }).p === 0, 'everybody there is not a fake');
}

// ---- law 3: a distribution over loadouts, not a class ------------------------

{
  assert(LOADOUTS.length === 6, "the six econ digits the site already stores");
  const rich = loadoutPosterior({ money: 5200 });
  const broke = loadoutPosterior({ money: 900 });
  assert(close(massOf(rich, LOADOUTS.map((l) => l.key)), 1), 'a posterior sums to one');
  assert(massOf(rich, ['full', 'fullAwp']) > massOf(rich, ['eco']), 'money buys guns');
  assert(massOf(broke, ['eco']) > massOf(broke, ['full', 'fullAwp']), 'and a broke side saves');
  assert(massOf(broke, ['full']) === 0, 'you cannot buy what you cannot pay for');
  assert(massOf(loadoutPosterior({ money: 800 }), ['pistol']) === 0, 'digit 0 is a pistol round only');
  assert(massOf(loadoutPosterior({ money: 800, isPistolRound: true }), ['pistol']) > 0, 'and then it is live');

  // Seeing an expensive gun is strong evidence; a saved gun is the channel that
  // stops it from being conclusive (weapons carry forward).
  const seenAwp = loadoutPosterior({ money: 5000, seenWeapons: ['awp'] });
  const seenAwpSaved = loadoutPosterior({ money: 5000, seenWeapons: ['awp'], savedGuns: 5 });
  assert(massOf(seenAwp, ['fullAwp']) > massOf(loadoutPosterior({ money: 5000 }), ['fullAwp']), 'an AWP is an AWP round');
  assert(massOf(seenAwpSaved, ['eco']) > massOf(seenAwp, ['eco']), 'unless they saved it last round');
  assert(massOf(seenAwpSaved, ['fullAwp']) < massOf(seenAwp, ['fullAwp']), 'which costs the AWP hypothesis mass');

  // A cheap gun is weak evidence, deliberately: a full buy can be holding a
  // pistol, an eco cannot be holding an AWP.
  const seenGlock = loadoutPosterior({ money: 5200, seenWeapons: ['glock'] });
  assert(close(massOf(seenGlock, ['full']), massOf(rich, ['full']), 1e-12), 'a pistol rules nothing out');

  assert(expectedEquipValue(rich) > expectedEquipValue(broke), 'and the equipment value follows');
}

{
  // The bank is carried by economy.js's own settlement, so the ladder, the
  // payouts, and the cap cannot drift from the engine's.
  const e = new EnemyEconomy({ side: 'T', players: 5 });
  assert(close(e.perPlayerMoney(), 800), 'a half starts at 800 a head');

  e.startRound({ isPistolRound: true });
  assert(e.history.length === 1, 'the buy is on the record');
  assert(e.history[0].expectedSpend > 0, 'with what it is expected to have cost');
  assert(e.bank < 4000, 'and the bank is down by it');

  e.roundEnded({ won: false, reason: 'elimination', survivors: 1 });
  assert(e.lossStreak === 1, 'the public ladder advances');
  assert(e.perPlayerMoney() > 800, 'the loss bonus is paid');
  assert(e.history[0].bankAfter === e.bank, 'and the round row is closed out');

  const poor = massOf(e.startRound(), ['full', 'fullAwp']);
  e.roundEnded({ won: true, reason: 'bomb', planted: true, kills: ['ak47', 'ak47'], survivors: 3 });
  assert(e.lossStreak === 0, 'a win steps the streak back down');
  const flush = massOf(e.startRound(), ['full', 'fullAwp']);
  assert(flush > poor, 'a won round moves the read toward a full buy');
  assert(e.savedGuns > 0, 'and survivors carry their guns into it');
  assert(e.utilityBudget() > 0, 'the same posterior prices their grenades');

  // Law 3 feeding law 2: the buy prices the ceiling the tracker counts down from.
  const t = new EnemyUtilityTracker({ side: 'T', bound: e.utilityBound() });
  assert(t.projectedReserve().total > 0, 'a full buy can hold utility');
  const brokeEcon = new EnemyEconomy({ side: 'T', players: 5, teamMoney: 1500 });
  brokeEcon.startRound();
  assert(brokeEcon.utilityBudget() < e.utilityBudget(), 'and an eco cannot');
}

// ---- absence of evidence is evidence ----------------------------------------

{
  const quiet = silencePosterior({ seconds: 0 });
  const forty = silencePosterior({ seconds: 40 });

  for (const p of [quiet, forty]) {
    let total = 0;
    for (const h of SILENCE_HYPOTHESES) total += p[h];
    assert(close(total, 1), 'the three hypotheses are a distribution');
  }
  for (const h of SILENCE_HYPOTHESES) {
    assert(close(quiet[h], quiet.prior[h]), 'no silence is no evidence: the posterior is the prior');
  }

  // Forty seconds of nothing is three live hypotheses, not one default.
  for (const h of SILENCE_HYPOTHESES) {
    assert(forty[h] > 0.1, `${h} keeps real mass after forty seconds (got ${forty[h].toFixed(3)})`);
    assert(forty[h] < 0.6, `and none of them takes over (${h} at ${forty[h].toFixed(3)})`);
  }
  assert(forty.moved > 0.05, 'but the silence moved the belief');
  assert(forty.saving > quiet.saving, 'toward the hypotheses that predict quiet');
  assert(forty.stacking < quiet.stacking, 'and away from the one that would have leaked by now');

  // The econ read is the prior: a side believed broke is likelier to be saving.
  const onEco = silencePosterior({ seconds: 40, loadout: loadoutPosterior({ money: 900 }) });
  const onFull = silencePosterior({ seconds: 40, loadout: loadoutPosterior({ money: 5200 }) });
  assert(onEco.saving > onFull.saving, 'a broke side that shows nothing is saving');
  assert(onFull.hiding > onEco.hiding, 'a rich one that shows nothing is hiding something');

  // Grenades they have already thrown are evidence against a save.
  const threw = silencePosterior({ seconds: 40, utilitySpent: 3 });
  assert(threw.saving < forty.saving, 'a side that has thrown three grenades is not saving');

  // Ground conceded reads as a stack or a save, not as deception.
  const conceded = silencePosterior({ seconds: 40, spaceConceded: 1 });
  assert(conceded.hiding < forty.hiding, 'a side that gave up the map is not hiding a buy');
}

// ---- the posture the belief should expect ------------------------------------

{
  const parity = enemyRiskPosture({ theirEquip: 4700, ourEquip: 4700 });
  assert(close(parity.varianceSeeking, 0), 'an even buy expects nothing in particular');
  assert(close(parity.forward, 1) && close(parity.stack, 1), 'so every prior is untouched');
  assert(close(parity.arrivalBias, 0), 'and the clocks are the defaults');

  // A side priced out of a fair fight correctly seeks variance (6.7), so the
  // belief expects them further forward, more stacked, off their defaults.
  const priced = enemyRiskPosture({ theirEquip: 800, ourEquip: 4700 });
  assert(priced.varianceSeeking > 0, 'a disadvantaged enemy is a variance seeker');
  assert(priced.forward > 1, 'expect them further forward');
  assert(priced.stack > 1, 'expect them stacked');
  assert(priced.offAngle > 1, 'expect them off their default angles');
  assert(priced.earlyAggression > 1, 'and expect it early');
  assert(priced.arrivalBias > 0, 'which is seconds off the arrival clock');

  // The same arithmetic run the other way. This is the check that the posture
  // is derived from the decision theory rather than typed in.
  const ahead = enemyRiskPosture({ theirEquip: 4700, ourEquip: 800 });
  assert(ahead.varianceSeeking < 0, 'a side holding the advantage plays the low-variance game');
  assert(ahead.forward < 1 && ahead.stack < 1, 'so expect them back and spread');
  assert(ahead.forward > 0 && ahead.stack > 0, 'and never expect a negative prior');

  // Monotone in the gap, and bodies price it the same way money does.
  const small = enemyRiskPosture({ theirEquip: 3700, ourEquip: 4700 });
  const big = enemyRiskPosture({ theirEquip: 2700, ourEquip: 4700 });
  assert(big.forward > small.forward, 'the further behind, the further forward');
  assert(enemyRiskPosture({ theirAlive: 3, ourAlive: 5 }).forward > 1, 'a 5v3 prices the same way');

  // Run on an inferred economy rather than a known one, which is the only way
  // the sim will ever have it.
  const them = new EnemyEconomy({ side: 'CT', players: 5, teamMoney: 5000 });
  them.startRound();
  const derived = enemyRiskPosture({ theirEquip: expectedEquipValue(them.posterior()), ourEquip: 4700 });
  assert(derived.varianceSeeking > 0, 'a believed eco is a believed variance seeker');
}

{
  // The adjustments are consumable by a belief prior, which is the whole claim:
  // priors, not rules.
  const tag = (a) => ({ forward: a === 'a_site' ? 1 : 0, offDefault: a === 'pit' });
  const posture = enemyRiskPosture({ theirEquip: 800, ourEquip: 4700 });
  const prior = posturePrior({ prior: () => 1, posture, tag });
  assert(prior('a_site') > prior('back'), 'forward ground gains mass');
  assert(prior('pit') > prior('back'), 'so do the off angles');
  assert(close(prior('back'), 1), 'and everything else is left alone');

  const ahead = posturePrior({ prior: () => 1, posture: enemyRiskPosture({ theirEquip: 4700, ourEquip: 800 }), tag });
  assert(ahead('a_site') < ahead('back'), 'a rich side is expected to hold instead');

  // And a JointBelief actually takes it.
  const b = new JointBelief({ anchors: ['a_site', 'back'], rng: new Rng(11), prior });
  assert(b.expected((a) => a === 'a_site') > b.expected((a) => a === 'back'), 'the belief leans forward');
}

// ---- all three laws through one surface --------------------------------------

{
  const belief = new JointBelief({ anchors: ANCHORS, rng: new Rng(3) });
  belief.killed(0);
  const utility = new EnemyUtilityTracker({ side: 'T', alive: 4 });
  utility.sawDetonation({ type: NADE.SMOKE });
  const economy = new EnemyEconomy({ side: 'T', players: 5, teamMoney: 3000 });
  economy.startRound();

  const read = readConservation({
    belief,
    utility,
    economy,
    inZone: inA,
    silenceSeconds: 40,
    ourEquip: 4700
  });
  assert(read.bodies.alive === belief.aliveCount(), 'bodies come from the belief');
  assert(read.reserve.total >= 0 && read.reserve.spent === 1, 'utility comes from the tracker');
  assert(close(massOf(read.loadout, LOADOUTS.map((l) => l.key)), 1), 'money comes from the posterior');
  assert(read.pFake.p >= 0 && read.pFake.p <= 1, 'and the fake read is priced off both');
  assert(read.silence && close(read.silence.saving + read.silence.stacking + read.silence.hiding, 1), 'silence too');
  assert(read.posture.varianceSeeking > 0, 'a thin buy expects a forward enemy');
}

console.log('conservation: ok');
