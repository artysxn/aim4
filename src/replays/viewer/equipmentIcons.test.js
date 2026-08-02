// Regression tests for the sidebar inventory.
//
// The bug these cover: the `inventory` prop gives display names ("Smoke
// Grenade"), and normalizeLoadout collapsed them with bareWeapon, which only
// turns spaces into underscores. So `smoke_grenade` never matched the
// `smokegrenade` key the util list is built from, and multi-word grenades
// vanished from a player's utility. Flashbang and Molotov are single words and
// matched by luck, which is what made the symptom look like "only shows the
// grenades a player has held".

import { inventoryAt, normalizeLoadout } from './equipmentIcons.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const FULL_T_BUY = [
  'AK-47',
  'Glock-18',
  'Smoke Grenade',
  'Flashbang',
  'Flashbang',
  'High Explosive Grenade',
  'Molotov'
];

{
  const items = normalizeLoadout(FULL_T_BUY);
  for (const stem of ['smokegrenade', 'flashbang', 'hegrenade', 'molotov']) {
    assert(items.includes(stem), `normalizeLoadout keeps ${stem}`);
  }
  assert(items.filter((i) => i === 'flashbang').length === 2, 'duplicate flashes survive');
}

{
  // Every grenade in the buy shows, not just the single-word ones.
  const inv = inventoryAt({
    loadout: FULL_T_BUY,
    grenades: [],
    itemEvents: [],
    playerId: 'p1',
    tick: 100,
    state: { armor: 100, flags: 0 },
    activeWeapon: 'weapon_ak47'
  });
  assert(inv.util.filter((u) => u === 'flashbang').length === 2, 'two flashes');
  assert(inv.util.includes('smokegrenade'), 'smoke is shown');
  assert(inv.util.includes('hegrenade'), 'HE is shown');
  assert(inv.util.includes('molotov'), 'molotov is shown');
  assert(inv.primary === 'ak47', 'primary is the rifle, not a grenade');
}

{
  // CT display names, including the two that are neither "molotov" nor a
  // single word: Incendiary Grenade and Decoy Grenade.
  const inv = inventoryAt({
    loadout: ['M4A1-S', 'Incendiary Grenade', 'Decoy Grenade', 'Smoke Grenade', 'Defuse Kit'],
    grenades: [],
    itemEvents: [],
    playerId: 'ct1',
    tick: 10,
    state: { armor: 100, flags: 0 },
    activeWeapon: 'weapon_m4a1_silencer'
  });
  assert(inv.util.includes('incgrenade'), 'incendiary is shown');
  assert(inv.util.includes('decoy'), 'decoy is shown');
  assert(inv.util.includes('defuser'), 'defuse kit is shown');
}

{
  // Thrown grenades leave the inventory at the tick they are thrown, and only
  // one of a pair goes with each throw.
  const grenades = [
    { player: 'p1', type: 'Flashbang', throwTick: 50 },
    { player: 'p1', type: 'Smoke Grenade', throwTick: 80 }
  ];
  const at = (tick) =>
    inventoryAt({
      loadout: FULL_T_BUY,
      grenades,
      itemEvents: [],
      playerId: 'p1',
      tick,
      state: { armor: 100, flags: 0 },
      activeWeapon: 'weapon_ak47'
    }).util;

  assert(at(10).filter((u) => u === 'flashbang').length === 2, 'both flashes before the throw');
  assert(at(60).filter((u) => u === 'flashbang').length === 1, 'one flash after the first throw');
  assert(at(60).includes('smokegrenade'), 'smoke still held at 60');
  assert(!at(90).includes('smokegrenade'), 'smoke gone once thrown');
  assert(at(90).includes('hegrenade'), 'unthrown HE is untouched');
}

{
  // Another player's throws must not empty this player's inventory.
  const inv = inventoryAt({
    loadout: FULL_T_BUY,
    grenades: [{ player: 'someone-else', type: 'Smoke Grenade', throwTick: 10 }],
    itemEvents: [],
    playerId: 'p1',
    tick: 100,
    state: { armor: 100, flags: 0 },
    activeWeapon: 'weapon_ak47'
  });
  assert(inv.util.includes('smokegrenade'), "another player's throw is ignored");
}

{
  // Ground pickups after freezetime land in the util list too.
  const inv = inventoryAt({
    loadout: ['AK-47'],
    grenades: [],
    itemEvents: [{ tick: 20, player: 'p1', item: 'Smoke Grenade', op: 'pickup' }],
    playerId: 'p1',
    tick: 30,
    state: { armor: 0, flags: 0 },
    activeWeapon: 'weapon_ak47'
  });
  assert(inv.util.includes('smokegrenade'), 'picked-up smoke is shown');
}

console.log('equipmentIcons: all assertions passed');
