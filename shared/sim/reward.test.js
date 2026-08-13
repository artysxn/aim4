// Run: node shared/sim/reward.test.js
//
// 9.5 and 9.10 are contracts, not numbers. The assertions are the properties
// a wrong reward would break:
//
//   the winner is paid +1, the loser −1
//   a plant is worth more than the identical step without one
//   Φ shaping has the right SIGN: rising P(win) is positive, falling is not
//   τ = 1 is the team, τ = 0 is the self
//   dying is not a bonus (no death key, or a non-positive contribution)
//   the same inputs always produce the same parts
//   Monte Carlo returns cut at `done` and discount at γ

import {
  DEFAULT_BETA,
  GAMMA,
  TAU_END,
  TAU_START,
  annealTau,
  discountedReturns,
  mixAgent,
  ownShaping,
  potentialRound,
  shaped,
  stepReward,
  teamSpirit,
  terminalReward
} from './reward.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function near(a, b, eps = 1e-12) {
  return Math.abs(a - b) <= eps;
}

function engineStub({ ctAlive = 5, tAlive = 5, planted = false, secondsLeft = 90 } = {}) {
  const bodies = [];
  for (let i = 0; i < ctAlive; i += 1) {
    bodies.push({ alive: true, side: 'CT', health: 100, hasKit: false });
  }
  for (let i = 0; i < tAlive; i += 1) {
    bodies.push({ alive: true, side: 'T', health: 100, hasKit: false });
  }
  return {
    state: { bodies, bomb: { planted } },
    clock: () => secondsLeft
  };
}

// ---- terminal --------------------------------------------------------------

{
  assert(terminalReward('T', 'T') === 1, 'terminal +1 for the winner');
  assert(terminalReward('CT', 'T') === -1, 'and −1 for the loser');
  assert(terminalReward('CT', 'CT') === 1, 'CT win is +1 for CT');
}

// ---- plant is an objective event -------------------------------------------

{
  const base = stepReward({
    prevPhi: 0.5,
    nextPhi: 0.5,
    side: 'T',
    events: []
  });
  const planted = stepReward({
    prevPhi: 0.5,
    nextPhi: 0.5,
    side: 'T',
    events: ['plant']
  });
  assert(planted.team > base.team, 'a plant event increases reward vs the identical step without one');
  assert(near(planted.parts.objective, DEFAULT_BETA[3] * 0.3), 'and the β4 part is plant × 0.3');
}

// ---- Φ shaping sign --------------------------------------------------------

{
  const up = shaped(0.4, 0.6);
  const down = shaped(0.6, 0.4);
  assert(up > 0, `0.4 → 0.6 winprob is a positive potential (${up})`);
  assert(down < 0, `0.6 → 0.4 is negative (${down})`);
  assert(near(up, GAMMA * 0.6 - 0.4), 'and it is exactly γΦ′ − Φ');

  const rise = stepReward({ prevPhi: 0.4, nextPhi: 0.6, side: 'T' });
  const fall = stepReward({ prevPhi: 0.6, nextPhi: 0.4, side: 'T' });
  assert(rise.team > 0 && fall.team < 0, 'stepReward carries the same sign through β1');
}

// ---- team spirit -----------------------------------------------------------

{
  assert(teamSpirit(3, 10, 1) === 10, 'τ = 1 is pure team');
  assert(teamSpirit(3, 10, 0) === 3, 'τ = 0 is pure own');
  assert(near(teamSpirit(3, 10, 0.5), 6.5), 'and the mix is linear');
  assert(mixAgent(10, 3, 1) === 10, 'mixAgent is teamSpirit with team as the mean');
  assert(mixAgent(10, 3, 0) === 3, 'mixAgent at τ = 0 is the own crumb');
  assert(near(annealTau(0), TAU_START) && near(annealTau(1), TAU_END), 'τ anneals 0.3 → 1.0');
}

// ---- dying is not a bonus --------------------------------------------------

{
  const r = stepReward({
    prevPhi: 0.5,
    nextPhi: 0.5,
    side: 'T',
    events: ['death']
  });
  assert(!('death' in r.parts), 'parts has no death key');
  const own = ownShaping({ damageDealt: 0, damageTaken: 80, traded: false });
  assert(own <= 0, 'own shaping never pays you for taking damage, let alone dying');
}

// ---- anti-hacking rails ----------------------------------------------------

{
  const three = stepReward({
    prevPhi: 0.5,
    nextPhi: 0.5,
    side: 'CT',
    coachHits: 3
  });
  const ten = stepReward({
    prevPhi: 0.5,
    nextPhi: 0.5,
    side: 'CT',
    coachHits: 10
  });
  assert(near(three.parts.coach, ten.parts.coach), 'coach penalty caps at 3');
  assert(!('possession' in three.parts), 'no possession term');
}

// ---- deterministic ---------------------------------------------------------

{
  const a = stepReward({
    prevPhi: 0.41,
    nextPhi: 0.58,
    side: 'CT',
    events: ['defuse'],
    damageDealt: 40,
    damageTaken: 10,
    infoGain: 0.2,
    traded: true,
    coachHits: 1,
    planAdhered: false
  });
  const b = stepReward({
    prevPhi: 0.41,
    nextPhi: 0.58,
    side: 'CT',
    events: ['defuse'],
    damageDealt: 40,
    damageTaken: 10,
    infoGain: 0.2,
    traded: true,
    coachHits: 1,
    planAdhered: false
  });
  assert(a.team === b.team, 'stepReward is deterministic');
  assert(JSON.stringify(a.parts) === JSON.stringify(b.parts), 'including every named part');
}

// ---- god-view potential reads the engine -----------------------------------

{
  const even = potentialRound(engineStub(), 'CT');
  const up = potentialRound(engineStub({ tAlive: 4 }), 'CT');
  assert(up > even, 'a man up raises Φ_round for that side');
}

// ---- discounted returns / GAE-less advantages ------------------------------

{
  const G = discountedReturns([1, 1, 1], [0, 0, 1], 0.5);
  assert(near(G[2], 1), 'a done step is just its own reward');
  assert(near(G[1], 1 + 0.5 * 1), 'the step before discounts once');
  assert(near(G[0], 1 + 0.5 * (1 + 0.5)), 'and the start sees the whole tail');

  const cut = discountedReturns([1, 9, 1], [1, 0, 1], 1);
  assert(near(cut[0], 1), 'done cuts the bootstrap: the 9 does not leak backward');
  assert(near(cut[1], 10), 'the next episode still sums');
}

console.log('reward: ok (terminal, plant, Φ sign, τ, no death bonus, deterministic, returns)');
