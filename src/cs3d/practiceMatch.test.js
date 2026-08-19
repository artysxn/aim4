// Run: node src/cs3d/practiceMatch.test.js

import { createPracticeMatch, defaultPistol, itemPrice, reserveFor } from './practiceMatch.js';

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
t.reload('ak47');
assert(t.ammoOf('ak47').clip === 30, 'reload fills mag');

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
assert(nades.state.nades.filter((g) => g === 'flashbang').length === 1, 'threw one flash');

assert(nades.buy('ak47').ok === false || nades.side === 'T', 'still T');
assert(nades.buy('m4a1').reason === 'wrong_side', 'CT rifle denied on T');
nades.give('m4a1');
assert(nades.state.primary === 'm4a1', 'give ignores side');

const ct = createPracticeMatch({ side: 'CT' });
assert(ct.held === defaultPistol('CT'), 'CT usp');
ct.setSide('T');
assert(ct.side === 'T' && ct.state.pistol === 'glock', 'side swap default pistol');

ct.setGod(true);
ct.hurt(80);
assert(ct.state.hp === 100, 'god blocks damage');
ct.setGod(false);
ct.hurt(40);
assert(ct.state.hp === 60, 'hurt lands');
ct.tick(10);
assert(ct.state.clock === 105, 'clock runs');
ct.restart();
assert(ct.state.hp === 100 && ct.state.primary === '' && ct.held === 'glock', 'restart pistol round');

const feed = createPracticeMatch();
feed.addKill({ killer: 'You', victim: 'BOT', weapon: 'ak47' });
assert(feed.state.roundKills === 1 && feed.state.kills.length === 1, 'kill feed');

console.log('practiceMatch.test.js: ok');
