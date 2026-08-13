// Run: node shared/sim/economy.test.js
//
// SIM-PLAN 15 names these as golden tests and blocks any RL run from seeing
// money until they pass, for a good reason: an economy bug does not crash, it
// teaches. A $250 error in the afterplant compounds over 24 rounds into a team
// that has learned to hunt when it should hold, and the only symptom is bots
// that are slightly worse than they should be, forever.
//
// The two orderings in the last block are the point of the whole file: same
// plant, same one CT alive, differing only in whether that CT dies at 39 s or
// the bomb pops at 40 s.

import {
  DEFAULT_KILL_AWARD,
  LOSS_LADDER,
  MONEY_CAP,
  PLANT_BONUS,
  T_PLANT_LOSS_BONUS,
  WIN_BOMB,
  WIN_ELIM,
  canBuy,
  isKnownWeapon,
  killAward,
  lossBonus,
  nextLossStreak,
  settleRound,
  startMoney,
  winPayout
} from './economy.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- kill awards: all four buckets ------------------------------------------

assert(killAward('awp') === 100, 'AWP pays 100');
assert(killAward('cz75a') === 100, 'CZ pays 100');
assert(killAward('ak47') === 300, 'rifles pay 300');
assert(killAward('deagle') === 300, 'pistols pay 300');
assert(killAward('p90') === 300, 'the P90 pays 300, not the SMG rate');
assert(killAward('g3sg1') === 300, 'autosnipers pay 300');
assert(killAward('mac10') === 600, 'SMGs pay 600');
assert(killAward('mp5sd') === 600, 'including the MP5');
assert(killAward('nova') === 900, 'shotguns pay 900');
assert(killAward('xm1014') === 900, 'all of them');
assert(killAward('knife') === 1500, 'the knife pays 1500');
assert(killAward('taser') === 0, 'the Zeus pays nothing');
assert(killAward('ak47', true) === -300, 'a team kill costs 300');
assert(killAward('not_a_gun') === DEFAULT_KILL_AWARD, 'anything unlisted pays the standard award');

// ---- the loss ladder --------------------------------------------------------

assert(lossBonus(1) === 1400, 'first loss is 1400');
assert(lossBonus(5) === 3400, 'fifth is 3400');
assert(lossBonus(9) === 3400, 'and it stops climbing');
assert(lossBonus(0) === 1400, 'a zero streak is clamped up');
assert(LOSS_LADDER.length === 5, 'the ladder has five rungs');

// A win decrements the streak; it does not reset it. Getting this wrong makes a
// team that steals one round richer for the rest of the half.
assert(nextLossStreak(4, true) === 3, 'a win steps the streak down by one');
assert(nextLossStreak(4, false) === 5, 'a loss steps it up');
assert(nextLossStreak(5, false) === 5, 'and it caps at the ladder length');
assert(nextLossStreak(0, true) === 0, 'and never goes negative');

// ---- win payouts ------------------------------------------------------------

assert(winPayout({ winner: 'T', reason: 'bomb' }) === 3500, 'the bomb pays 3500');
assert(winPayout({ winner: 'T', reason: 'elimination' }) === 3250, 'eliminating pays 3250');
assert(winPayout({ winner: 'CT', reason: 'defuse' }) === 3500, 'a defuse pays 3500');
assert(winPayout({ winner: 'CT', reason: 'time' }) === 3250, 'running the clock pays 3250');
assert(winPayout({ winner: 'CT', reason: 'elimination' }) === 3250, 'so does eliminating');

// ---- settle: the shapes that bite -------------------------------------------

const team = (side, money = 0) =>
  [0, 1, 2, 3, 4].map((i) => ({
    slot: side === 'T' ? i : i + 5,
    side,
    alive: true,
    money
  }));
const roster = (money = 0) => [...team('T', money), ...team('CT', money)];

{
  // Time expiry with no plant: the losing Ts get nothing at all. Not the win,
  // not the loss bonus. It is the one round type where a side ends with only
  // what it walked in with, and it is why bleeding the clock as T is expensive.
  const r = settleRound({
    outcome: { winner: 'CT', reason: 'time', planted: false, planterSlot: null, defuserSlot: null },
    players: roster(1000),
    lossStreak: { T: 0, CT: 0 }
  });
  assert(r.money[0] === 1000, `a losing T on a time expiry gains nothing (got ${r.money[0]})`);
  assert(r.money[5] === 1000 + 3250, 'while the CT get the win');
}

{
  // Planted and still lost: the ladder plus the 800 consolation, and the
  // planter keeps his 300 on top of it.
  const r = settleRound({
    outcome: { winner: 'CT', reason: 'defuse', planted: true, planterSlot: 2, defuserSlot: 7 },
    players: roster(0),
    lossStreak: { T: 0, CT: 0 }
  });
  assert(r.money[0] === 1400 + T_PLANT_LOSS_BONUS, 'a losing T who planted gets ladder + 800');
  assert(r.money[2] === 1400 + T_PLANT_LOSS_BONUS + PLANT_BONUS, 'and the planter gets his 300');
  assert(r.money[7] === 3500 + 300, 'the defuser gets the win plus his bonus');
}

{
  // The cap applies at payout, after everything.
  const r = settleRound({
    outcome: { winner: 'T', reason: 'bomb', planted: true, planterSlot: 0, defuserSlot: null },
    players: roster(15000),
    killCash: { 0: 900 },
    lossStreak: { T: 0, CT: 0 }
  });
  assert(r.money[0] === MONEY_CAP, `money is capped at ${MONEY_CAP} (got ${r.money[0]})`);
  assert(r.money[5] <= MONEY_CAP, 'for both sides');
}

{
  // Streaks advance for both sides from one settle.
  const r = settleRound({
    outcome: { winner: 'T', reason: 'elimination', planted: false, planterSlot: null, defuserSlot: null },
    players: roster(0),
    lossStreak: { T: 3, CT: 1 }
  });
  assert(r.lossStreak.T === 2, "the winner's streak steps down");
  assert(r.lossStreak.CT === 2, "the loser's steps up");
  // And the loss bonus paid was for the streak AFTER this loss, not before it.
  assert(r.money[5] === lossBonus(2), `the CT are paid the second rung (got ${r.money[5]})`);
}

// ---- the one that decides the afterplant ------------------------------------

{
  // Same plant. Same single CT alive. The only difference is whether he dies at
  // 0:39 or the bomb finishes at 0:40. SIM-PLAN 4.9 requires both orderings to
  // be locked before any RL run is allowed to see money.
  const base = { planted: true, planterSlot: 0, defuserSlot: null };
  const players = roster(0);

  // Hunted him down with an SMG at 39 s: T win by elimination.
  const hunted = settleRound({
    outcome: { ...base, winner: 'T', reason: 'elimination' },
    players,
    killCash: { 1: 600 },
    lossStreak: { T: 0, CT: 0 }
  });

  // Held the angles and let it explode at 40 s: T win by bomb, no closing kill.
  const held = settleRound({
    outcome: { ...base, winner: 'T', reason: 'bomb' },
    players,
    lossStreak: { T: 0, CT: 0 }
  });

  assert(hunted.money[2] === WIN_ELIM, `a bystander on the hunt gets ${WIN_ELIM}`);
  assert(held.money[2] === WIN_BOMB, `and on the hold gets ${WIN_BOMB}`);
  assert(held.money[2] - hunted.money[2] === 250, 'holding is worth 250 more to every T');

  // The hunter himself is better off: he gives up 250 of team money and
  // collects a 600 kill award, so his pocket is 350 up while the team is 1000
  // down across five players. That tension is the decision, and it only exists
  // if both numbers are right.
  assert(hunted.money[1] === WIN_ELIM + 600, 'the hunter banks the kill award');
  assert(hunted.money[1] - held.money[1] === 350, 'so he personally nets 350 by hunting');

  const teamHunt = [0, 1, 2, 3, 4].reduce((a, s) => a + hunted.money[s], 0);
  const teamHold = [0, 1, 2, 3, 4].reduce((a, s) => a + held.money[s], 0);
  assert(teamHold - teamHunt === 650, `the team is 650 better off holding (got ${teamHold - teamHunt})`);

  // The planter's bonus survives both orderings.
  assert(hunted.money[0] === WIN_ELIM + PLANT_BONUS, 'planter bonus paid on the hunt');
  assert(held.money[0] === WIN_BOMB + PLANT_BONUS, 'and on the hold');
}

// ---- buy legality -----------------------------------------------------------

const buyer = (over = {}) => ({
  money: 5000,
  side: 'T',
  inBuyZone: true,
  inventory: { grenades: [] },
  ...over
});

assert(canBuy({ player: buyer(), item: 'ak47', price: 2700, inBuyTime: true }).ok, 'a rich T buys a rifle');
assert(
  !canBuy({ player: buyer(), item: 'ak47', price: 2700, inBuyTime: false }).ok,
  'not after the buy period'
);
assert(
  !canBuy({ player: buyer({ inBuyZone: false }), item: 'ak47', price: 2700, inBuyTime: true }).ok,
  'not outside the buy zone'
);
assert(
  canBuy({ player: buyer({ money: 100 }), item: 'ak47', price: 2700, inBuyTime: true }).reason ===
    'insufficient_funds',
  'and not without the money'
);
assert(
  !canBuy({ player: buyer(), item: 'defuser', price: 400, inBuyTime: true }).ok,
  'a T cannot buy a defuse kit'
);
assert(
  canBuy({ player: buyer({ side: 'CT' }), item: 'defuser', price: 400, inBuyTime: true }).ok,
  'a CT can'
);

{
  const four = buyer({ inventory: { grenades: ['smokegrenade', 'flashbang', 'flashbang', 'molotov'] } });
  assert(
    canBuy({ player: four, item: 'hegrenade', price: 300, inBuyTime: true }).reason === 'grenade_limit',
    'four grenades is the limit'
  );
  const twoFlash = buyer({ inventory: { grenades: ['flashbang', 'flashbang'] } });
  assert(
    canBuy({ player: twoFlash, item: 'flashbang', price: 200, inBuyTime: true }).reason === 'flash_limit',
    'and two flashes is the flash limit'
  );
  const oneSmoke = buyer({ inventory: { grenades: ['smokegrenade'] } });
  assert(
    canBuy({ player: oneSmoke, item: 'smokegrenade', price: 300, inBuyTime: true }).reason ===
      'duplicate_grenade',
    'one of every other type'
  );
  assert(
    canBuy({ player: oneSmoke, item: 'flashbang', price: 200, inBuyTime: true }).ok,
    'but a flash is still legal'
  );
}

assert(isKnownWeapon('ak47') && isKnownWeapon('awp'), 'known weapons are known');
assert(!isKnownWeapon('bfg9000'), 'and unknown ones are not, so the buy head cannot invent a gun');

assert(startMoney() === 800, 'a half starts at 800');
assert(startMoney(true) === 10000, 'overtime at 10000');

console.log('economy: ok');
