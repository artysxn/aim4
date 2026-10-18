// Run: node --max-old-space-size=4096 scripts/round-value.test.mjs
//
// aim4 eye's round pricing (src/replays/eye/roundValue.js) against real rounds
// from sampledemos/: what a kill was worth, xK in the moment, and the sums
// those numbers have to obey.

import assert from 'node:assert/strict';

import { momentAtTick, topSwings, valueRound } from '../src/replays/eye/roundValue.js';
import { prepareMap } from './lib/duelCorpus.mjs';
import { eachRound } from './lib/sampledemoPackages.mjs';

const ROUNDS = 6;
const maps = new Map();
const priced = [];
for await (const { meta, track } of eachRound({ limit: 1 })) {
  if (priced.length >= ROUNDS) break;
  const network = await prepareMap(meta.map, maps);
  priced.push({ meta, track, network, value: valueRound({ meta, track, network }) });
}
assert.ok(priced.length > 0, 'sampledemos/ has rounds to price');

let kills = 0;
let gain = 0;
let fights = 0;
for (const { meta, value } of priced) {
  assert.ok(value, `round ${meta.round} is priced`);
  assert.equal(value.xkAvailable, true);
  assert.ok(value.summary.opening_ct_win_pct >= 1 && value.summary.opening_ct_win_pct <= 99);
  value.moments.forEach((m, i) => i && assert.ok(value.moments[i - 1].tick <= m.tick, 'moments run in time order'));

  // Every real kill is a moment, and the ledger is zero-sum: a swing is credited to the killer and taken from the victim.
  const killMoments = value.moments.filter((m) => m.event === 'kill');
  const realKills = (meta.events.kills || []).filter((k) => k.victim && k.tick >= meta.freezeEndTick);
  assert.equal(killMoments.length, realKills.length);
  const ledgerSum = value.players.reduce((a, p) => a + p.wpa_pp, 0);
  assert.ok(Math.abs(ledgerSum) <= 0.15 * value.players.length + 1, `ledger sums to ~0, got ${ledgerSum}`);

  for (const m of killMoments) {
    kills++;
    gain += m.swing_pp;
    assert.ok(Math.abs(m.win_chance.after - m.win_chance.before - m.swing_pp) <= 1.1, 'swing is after minus before');
    if (Math.abs(m.swing_pp) >= 10) assert.ok(m.why.length > 0, `a ${m.swing_pp}pp swing names a factor`);
    if (m.fight?.killer_win_before_kill != null) {
      fights++;
      const p = m.fight.killer_win_before_kill;
      assert.ok(p >= 0 && p <= 100);
      assert.equal(m.fight.killer_read, p < 35 ? 'upset' : p > 65 ? 'favoured' : 'even');
      assert.equal(m.fight.victim_win_at_contact + m.fight.killer_win_at_contact, 100);
      const v = m.fight.victim_win_at_contact;
      assert.equal(m.fight.victim_read, v < 30 ? 'behind' : v > 55 ? 'favoured' : 'close');
    }
  }

  // xK in the moment: each open fight hands out exactly one expected kill between its two players.
  const tick = killMoments.length ? killMoments[0].tick - 24 : meta.freezeEndTick + 640;
  const at = momentAtTick(value, tick);
  assert.equal(at.ct_win_pct + at.t_win_pct, 100);
  const handedOut = at.xk.reduce((a, x) => a + x.xk, 0);
  assert.ok(Math.abs(handedOut - at.open_fights.length) <= 0.02 * Math.max(1, at.xk.length), `xK sums to the number of fights: ${handedOut} vs ${at.open_fights.length}`);
  for (const f of at.open_fights) assert.ok(Math.abs(f.a_win_pct + f.b_win_pct - 100) <= 1);

  assert.ok(topSwings(value, 3).length <= 3);
}
// Kills help the side that made them, on the whole. If this fails the swing has the wrong sign.
assert.ok(kills > 10, `enough kills to judge, got ${kills}`);
assert.ok(gain / kills > 5, `a kill is worth +${(gain / kills).toFixed(1)}pp to its side on average`);
assert.ok(fights > 0, 'at least one kill came out of a priced gunfight');

// With no map geometry the win chance still prices, and xK is honestly absent.
const bare = valueRound({ meta: priced[0].meta, track: priced[0].track, network: null });
assert.ok(bare);
assert.equal(bare.xkAvailable, false);
assert.ok(bare.moments.every((m) => m.fight === null));
assert.deepEqual(momentAtTick(bare, priced[0].meta.freezeEndTick + 640).xk, []);

console.log(`round-value: ${priced.length} rounds, ${kills} kills, mean swing ${(gain / kills).toFixed(1)}pp, ${fights} priced gunfights - ok`);
