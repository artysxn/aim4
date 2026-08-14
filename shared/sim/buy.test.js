// Run: node shared/sim/buy.test.js
//
// The old table was wrong in ways that changed what game the bots played, so
// these assert the rules rather than the numbers: a side buys guns it is
// allowed to buy, somebody eventually holds an AWP, and a broke side saves
// together instead of buying five half-buys.

import { buyFor, buySide, econBucketOf, KEVLAR, HELMET_KIT, RIFLES, SMGS } from './buy.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
  console.log('  ' + msg);
}

// ---- side legality ---------------------------------------------------------

{
  // The bug that started this: the MAC-10 is a T gun and the CT equivalent is
  // the MP9. A CT holding a MAC-10 is not a balance problem, it is a wrong
  // game.
  assert(!SMGS.CT.includes('mac10'), 'a CT is never offered the MAC-10');
  assert(SMGS.CT.includes('mp9'), 'and is offered the MP9 instead');
  assert(SMGS.T.includes('mac10'), 'the T keeps the MAC-10');
  assert(!RIFLES.T.includes('m4a1'), 'a T is never offered an M4');
  assert(!RIFLES.CT.includes('ak47'), 'a CT is never offered an AK');
  assert(
    RIFLES.CT.includes('m4a1') && RIFLES.CT.includes('m4a1_silencer'),
    'both M4s exist, which the old table did not know'
  );

  for (const side of ['T', 'CT']) {
    for (const money of [800, 1400, 2600, 3900, 5200, 16000]) {
      const b = buyFor({ money, side });
      assert(
        b.cost <= money,
        `${side} at $${money} never overspends (took $${b.cost} for ${b.weapon})`
      );
      const legal = [...RIFLES[side], ...SMGS[side], 'awp', 'tec9', 'p250', 'glock', 'fiveseven', 'usp_silencer'];
      assert(legal.includes(b.weapon), `${side} at $${money} bought a legal gun (${b.weapon})`);
    }
  }
}

// ---- the AWP exists --------------------------------------------------------

{
  const rich = buyFor({ money: 16000, side: 'CT', awper: true });
  assert(rich.weapon === 'awp', 'a nominated AWPer with money buys the AWP');
  assert(rich.armor > 0 && rich.helmet, 'and still has armour, because armour is bought first');

  const poor = buyFor({ money: 4000, side: 'CT', awper: true });
  assert(poor.weapon !== 'awp', 'an AWPer who cannot afford it buys a rifle instead');

  const side = buySide({
    slots: [0, 1, 2, 3, 4],
    moneyOf: () => 16000,
    side: 'T',
    awpSlot: 2
  });
  const awps = [...side.values()].filter((b) => b.weapon === 'awp').length;
  assert(awps === 1, 'a full-buy side fields exactly one AWP, not five and not none');
  assert(side.get(2).weapon === 'awp', 'and it is the nominated player who holds it');
}

// ---- the save is a team decision ------------------------------------------

{
  const broke = buySide({ slots: [0, 1, 2, 3, 4], moneyOf: () => 2200, side: 'T', awpSlot: 1 });
  const guns = [...broke.values()].map((b) => b.weapon);
  assert(
    guns.every((g) => ['tec9', 'p250', 'glock'].includes(g)),
    'a side that cannot arm itself saves together rather than buying five half-buys'
  );
  assert(
    [...broke.values()].every((b) => b.cost < 1000),
    'and keeps its money for the round that matters'
  );

  const forced = buySide({
    slots: [0, 1, 2, 3, 4],
    moneyOf: () => 2200,
    side: 'T',
    forceBuy: true
  });
  assert(
    [...forced.values()].some((b) => SMGS.T.includes(b.weapon)),
    'forcing overrides the save, which is what a last round is'
  );

  const rich = buySide({ slots: [0, 1, 2, 3, 4], moneyOf: () => 9000, side: 'CT' });
  assert(
    [...rich.values()].every((b) => b.armor > 0),
    'a full buy puts armour on everybody'
  );
  assert(
    [...rich.values()].filter((b) => b.hasKit).length === 1,
    'exactly one CT carries the kit'
  );
  assert(
    [...rich.values()].every((b) => b.grenades.length > 0),
    'and everybody has utility, which is the thing the bots never had'
  );
}

// ---- utility legality ------------------------------------------------------

{
  const t = buyFor({ money: 9000, side: 'T' });
  const ct = buyFor({ money: 9000, side: 'CT' });
  assert(!t.grenades.includes('incgrenade'), 'a T buys a molotov, never an incendiary');
  assert(!ct.grenades.includes('molotov'), 'a CT buys an incendiary, never a molotov');
  assert(t.grenades.length <= 4 && ct.grenades.length <= 4, 'nobody carries more than four nades');
  assert(
    t.grenades.filter((g) => g === 'flashbang').length <= 2,
    'and no more than two flashes, which is the real limit'
  );
}

{
  const pistols = Array.from({ length: 5 }, () => ({
    weapon: 'glock',
    armor: 0,
    helmet: false,
    grenades: []
  }));
  assert(econBucketOf(pistols) === 0, 'pistols-only is bucket 0');
  const rifles = Array.from({ length: 5 }, () => ({
    weapon: 'ak47',
    armor: 100,
    helmet: true,
    grenades: ['flashbang', 'smokegrenade']
  }));
  assert(econBucketOf(rifles) === 4, 'five rifles is a full buy');
  const withAwp = rifles.map((b, i) => (i === 0 ? { ...b, weapon: 'awp' } : b));
  assert(econBucketOf(withAwp) === 5, 'and an AWP on a full buy is bucket 5');
}

console.log('buy: ok (side legality, the AWP, team saves, utility rules)');
