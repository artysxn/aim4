// Run: node src/cs3d/practiceMatch.test.js

import { createPracticeMatch, defaultPistol, itemPrice, practiceKit, reserveFor } from './practiceMatch.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const t = createPracticeMatch({ side: 'T' });
assert(t.side === 'T', 'starts T');
assert(t.held === 'glock', 'T starts with glock');
assert(t.state.money === 16000, 'practice starts at cap');
assert(t.ammoOf('glock').clip === 20, 'glock mag');
assert(t.ammoOf('glock').reserve === reserveFor('glock'), 'glock reserve');

const ak = t.buy('ak47');
assert(ak.ok, 'can buy ak');
assert(t.state.money === 16000 - itemPrice('ak47'), 'ak spent');
assert(t.state.primary === 'ak47', 'ak in primary');
assert(t.held === 'ak47', 'ak in hand');
assert(t.slot(1) === 'ak47' && t.slot(2) === 'glock' && t.slot(3) === 'knife', 'slots');

assert(t.canFire(), 'full mag can fire');
t.ammoOf('ak47').clip = 1;
t.consumeAmmo('ak47');
assert(t.ammoOf('ak47').clip === 0, 'last round gone');
assert(!t.canFire('ak47'), 'empty mag cannot fire');
assert(!t.reloading, 'empty mag does not start a silent reload');
assert(t.beginReload('ak47'), 'R starts reload');
assert(t.reloading, 'reload timer running');
assert(!t.canFire('ak47'), 'cannot fire while reloading');
assert(!t.beginReload('ak47'), 'second R is ignored');
assert(t.ammoOf('ak47').clip === 0, 'mag still empty until timer ends');
t.tick(2.5);
assert(t.ammoOf('ak47').clip === 30, 'reload fills mag');
assert(!t.reloading, 'reload finished');

t.ammoOf('ak47').clip = 10;
assert(t.beginReload('ak47'), 'partial mag can reload');
t.reload('ak47');
assert(t.ammoOf('ak47').clip === 30, 'reload fills mag');
assert(!t.reloading, 'complete reload clears timer');

t.ammoOf('ak47').clip = 5;
assert(t.beginReload('ak47'), 'reload then switch');
t.hold('glock');
assert(!t.reloading, 'weapon switch cancels reload');
assert(t.ammoOf('ak47').clip === 5, 'cancelled reload does not fill');

const broke = createPracticeMatch({ side: 'T' });
broke.setMoney(100);
assert(!broke.buy('ak47').ok, 'too poor for ak');
broke.setMoney(200);
assert(broke.buy('glock').ok, 'pistol is cheap');

const nades = createPracticeMatch({ side: 'T' });
assert(nades.buy('smokegrenade').ok, 'smoke');
assert(nades.buy('flashbang').ok, 'flash 1');
assert(nades.buy('flashbang').ok, 'flash 2');
assert(nades.buy('flashbang').reason === 'flash_limit', 'flash cap');
assert(nades.buy('hegrenade').ok, 'he');
assert(nades.buy('decoy').reason === 'grenade_limit', 'four nade cap');
nades.consumeNade('flashbang');
assert(nades.state.nades.filter((g) => g === 'flashbang').length === 2, 'practice nades are infinite');

assert(nades.buy('ak47').ok === false || nades.side === 'T', 'still T');
assert(nades.buy('m4a1').reason === 'wrong_side', 'CT rifle denied on T');
nades.give('m4a1');
assert(nades.state.primary === 'm4a1', 'give ignores side');

const ct = createPracticeMatch({ side: 'CT' });
assert(ct.held === defaultPistol('CT'), 'CT usp');
ct.setSide('T');
assert(ct.side === 'T' && ct.state.pistol === 'glock', 'side swap default pistol');
assert(ct.state.primary === 'ak47', 'side swap gives T rifle');
assert(ct.state.nades.includes('molotov') && !ct.state.nades.includes('incgrenade'), 'T fire nade');

ct.setSide('CT');
assert(ct.state.primary === 'm4a1' && ct.state.pistol === 'usp_silencer', 'CT kit');
assert(ct.state.nades.includes('incgrenade') && !ct.state.nades.includes('molotov'), 'CT fire nade');

const kitT = practiceKit('T');
assert(kitT.primary === 'ak47' && kitT.pistol === 'glock', 'T kit guns');
assert(kitT.nades.join() === 'smokegrenade,molotov,flashbang,hegrenade', 'T nades');
const kitCt = practiceKit('CT');
assert(kitCt.primary === 'm4a1' && kitCt.pistol === 'usp_silencer', 'CT kit guns');
assert(kitCt.nades.join() === 'smokegrenade,incgrenade,flashbang,hegrenade', 'CT nades');

const armed = createPracticeMatch({ side: 'T' });
armed.givePracticeKit();
assert(armed.held === 'ak47', 'kit in hand');
assert(armed.slot(1) === 'ak47' && armed.slot(2) === 'glock', 'kit slots');
assert(armed.state.nades.length === 4, 'four nades');

ct.setGod(true);
ct.hurt(80);
assert(ct.state.hp === 100, 'god blocks damage');
ct.setGod(false);
ct.hurt(40);
assert(ct.state.hp === 60, 'hurt lands');
ct.tick(10);
assert(ct.state.clock === 105, 'clock runs');
ct.restart();
assert(ct.state.hp === 100 && ct.state.primary === '' && ct.held === 'usp_silencer', 'restart pistol round');

const feed = createPracticeMatch();
feed.addKill({ killer: 'You', victim: 'BOT', weapon: 'ak47' });
assert(feed.state.roundKills === 1 && feed.state.kills.length === 1, 'kill feed');

const bag = createPracticeMatch({ side: 'T' });
bag.givePracticeKit();
bag.ammoOf('ak47').clip = 11;
const droppedAk = bag.dropHeld();
assert(droppedAk.ok && droppedAk.item.name === 'ak47', 'G drops the rifle');
assert(droppedAk.item.ammo.clip === 11, 'dropped mag keeps its ammo');
assert(!bag.state.primary, 'rifle left the pocket');
assert(droppedAk.next === 'glock' && bag.held === 'glock', 'next gun after rifle drop');
assert(bag.canPickup('ak47'), 'empty rifle slot can pick up');
assert(bag.takePickup('ak47', droppedAk.item.ammo, { replace: false }).ok, 'walk-over restores rifle');
assert(bag.state.primary === 'ak47', 'rifle is back');
assert(bag.ammoOf('ak47').clip === 11, 'picked mag is the dropped mag');

const nadeDrop = createPracticeMatch({ side: 'T' });
nadeDrop.givePracticeKit();
nadeDrop.hold('smokegrenade');
const droppedSmoke = nadeDrop.dropHeld();
assert(droppedSmoke.ok && droppedSmoke.item.name === 'smokegrenade', 'G drops the nade in hand');
assert(!nadeDrop.state.nades.includes('smokegrenade'), 'nade left the pocket');
assert(droppedSmoke.next === 'ak47', 'last gun after nade drop');
assert(nadeDrop.takePickup('smokegrenade').ok, 'nade pickup restores');
assert(nadeDrop.state.nades.includes('smokegrenade'), 'nade is back');

const knifeDrop = createPracticeMatch({ side: 'T' });
knifeDrop.givePracticeKit();
knifeDrop.hold('knife');
assert(!knifeDrop.dropHeld().ok, 'knife stays');

const death = createPracticeMatch({ side: 'T' });
death.givePracticeKit();
death.hold('glock');
const pile = death.dropDeath();
assert(pile.items.some((i) => i.name === 'glock'), 'death drops the active gun');
assert(!pile.items.some((i) => i.name === 'ak47'), 'the other gun stays unless it was active');
assert(pile.items.filter((i) => i.slot === 'nade').length === 4, 'death drops every nade');
assert(death.state.primary === 'ak47', 'inactive rifle stays in the pocket');
assert(death.state.pistol === '', 'active pistol slot empty');
assert(death.state.nades.length === 0, 'nade pocket empty');
assert(death.held === 'knife', 'knife last after death drop');
death.givePracticeKit();
assert(death.held === 'ak47' && death.state.nades.length === 4, 'respawn kit is a new loadout');

const swap = createPracticeMatch({ side: 'T' });
swap.givePracticeKit();
assert(!swap.takePickup('m4a1', { clip: 7, reserve: 90 }, { replace: false }).ok, 'walk-over will not replace a rifle');
const swapped = swap.takePickup('m4a1', { clip: 7, reserve: 90 }, { replace: true });
assert(swapped.ok && swapped.displaced?.name === 'ak47', 'E replaces and returns the old rifle');
assert(swap.state.primary === 'm4a1' && swap.ammoOf('m4a1').clip === 7, 'E pickup keeps dropped ammo');

console.log('practiceMatch.test.js: ok');
