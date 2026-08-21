// Run: node src/replays/shared/awpHold.test.js
import assert from 'node:assert/strict';
import { longestHeldGun, weaponHoldTicks, awpHoldSeconds } from './awpHold.js';

assert.equal(longestHeldGun(new Map([['ak47', 10], ['awp', 40]])), 'awp');
assert.equal(longestHeldGun(new Map([['ak47', 10], ['m4a1', 10]])), 'ak47');
assert.equal(longestHeldGun(new Map()), '');

const track = {
  sample(_slot, tick, out) {
    out.alive = tick < 200;
    out.weapon = tick < 80 ? 0 : 1;
    return out;
  }
};
const timing = { tickRate: 64, freezeEndTick: 0, endTick: 192 };
const held = weaponHoldTicks(track, 0, ['weapon_ak47', 'weapon_awp'], timing);
assert.ok(held.guns.get('awp') > held.guns.get('ak47'), 'AWP held longer');
assert.ok(awpHoldSeconds(track, 0, ['weapon_ak47', 'weapon_awp'], timing) > 0);

console.log('awpHold.test.js ok');
