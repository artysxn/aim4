// What must hold when the round win chance is read through the fights open in
// it, for any duel model and any map.
//
// These are not accuracy tests. They check the arithmetic the claim rests on:
// that a 99% favourite really does hand 99% of the post-trade round to their
// side, that stating a fight from either end gives the same round, and that a
// player caught in two fights at once dies once rather than twice.

import { expectedCtOverDuels } from './duelLookahead.js';
import { winProbability, winProbabilityWithDuels } from './winProbability.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/** Slots 0-4 CT, 5-9 T, everyone whole and on the same buy. */
function board(n = 5) {
  const bySlot = {};
  for (let s = 0; s < n; s++) bySlot[s] = { side: 'CT', weight: 1, value: 4000 };
  for (let s = 5; s < 5 + n; s++) bySlot[s] = { side: 'T', weight: 1, value: 4000 };
  return bySlot;
}

const state = (ct, t) => ({
  map: 'DD2',
  ctAlive: ct,
  tAlive: t,
  ctEff: ct,
  tEff: t,
  ctEquip: 4000,
  tEquip: 4000
});

const at = (ct, t) => winProbability(state(ct, t)).ct;

const ahead = (s, duels, bySlot, ctSum, tSum) =>
  winProbabilityWithDuels({ state: s, duels, bySlot, ctSum, tSum });

// --- the claim itself -------------------------------------------------------
{
  const bySlot = board();
  for (const pa of [0.99, 0.75, 0.5, 0.25, 0.01]) {
    const got = ahead(state(5, 5), [{ aSlot: 0, bSlot: 5, pa }], bySlot, 20000, 20000);
    const want = pa * at(5, 4) + (1 - pa) * at(4, 5);
    assert(
      close(got.ct, want, 1e-9),
      `a ${pa} favourite must hand ${pa} of the 5v4 round over, got ${got.ct} want ${want}`
    );
  }
}

// A fight is not a body. The bodies on screen do not move until it resolves.
{
  const got = ahead(state(5, 5), [{ aSlot: 0, bSlot: 5, pa: 0.99 }], board(), 20000, 20000);
  assert(got.parts.duels.length === 1, 'the open fight should be reported');
  assert(close(got.parts.duelBaseCt, at(5, 5), 1e-9), 'the pre-fight reading should be kept');
}

// --- stating the same fight from either end ---------------------------------
{
  const bySlot = board(3);
  const s = state(3, 3);
  const fwd = ahead(s, [{ aSlot: 0, bSlot: 5, pa: 0.8 }], bySlot, 12000, 12000);
  const rev = ahead(s, [{ aSlot: 5, bSlot: 0, pa: 0.2 }], bySlot, 12000, 12000);
  assert(close(fwd.ct, rev.ct, 1e-9), 'a fight must read the same from both ends');
}

// --- a player in two fights dies once ---------------------------------------
{
  const got = ahead(
    state(5, 5),
    [
      { aSlot: 0, bSlot: 5, pa: 0.5 },
      { aSlot: 0, bSlot: 6, pa: 0.5 }
    ],
    board(),
    20000,
    20000
  );
  // He beats both (5v3), trades either way round (4v4 twice), or loses both —
  // and losing both still costs his side exactly one body.
  const want = 0.25 * at(5, 3) + 0.5 * at(4, 4) + 0.25 * at(4, 5);
  assert(close(got.ct, want, 1e-9), `two fights on one player: got ${got.ct} want ${want}`);
}

// --- a fight that is the whole round ----------------------------------------
{
  const bySlot = { 0: { side: 'CT', weight: 1, value: 4000 }, 5: { side: 'T', weight: 1, value: 4000 } };
  const got = ahead(state(1, 1), [{ aSlot: 0, bSlot: 5, pa: 0.9 }], bySlot, 4000, 4000);
  assert(close(got.ct, 90, 1e-9), `a 1v1 round is its duel, got ${got.ct}`);
}

// --- rounds already over are not predicted ----------------------------------
{
  const s = { ...state(3, 2), decided: 'CT' };
  const got = ahead(s, [{ aSlot: 0, bSlot: 5, pa: 0.01 }], board(3), 12000, 8000);
  assert(got.ct === 100, 'a decided round must not be walked back by a fight in it');
  assert(!got.parts.duels, 'a decided round reports no lookahead');
}

// --- fights the round model cannot see are dropped --------------------------
{
  const bySlot = board();
  delete bySlot[5]; // already in the kill log, gone from the live board
  const got = ahead(state(5, 4), [{ aSlot: 0, bSlot: 5, pa: 0.9 }], bySlot, 20000, 16000);
  assert(close(got.ct, at(5, 4), 1e-9), 'a fight with a buried player must not move the round');
}

// --- the branch weights are a probability distribution ----------------------
{
  const bySlot = board();
  let mass = 0;
  expectedCtOverDuels({
    base: { ctAlive: 5, tAlive: 5, ctEff: 5, tEff: 5, ctSum: 20000, tSum: 20000 },
    duels: [
      { aSlot: 0, bSlot: 5, pa: 0.7 },
      { aSlot: 1, bSlot: 6, pa: 0.3 },
      { aSlot: 2, bSlot: 7, pa: 0.55 }
    ],
    bySlot,
    evaluate: () => {
      mass += 1;
      return 1;
    }
  });
  assert(mass === 8, `three fights are eight branches, walked ${mass}`);
}
{
  const bySlot = board();
  const flat = expectedCtOverDuels({
    base: { ctAlive: 5, tAlive: 5, ctEff: 5, tEff: 5, ctSum: 20000, tSum: 20000 },
    duels: [
      { aSlot: 0, bSlot: 5, pa: 0.7 },
      { aSlot: 1, bSlot: 6, pa: 0.3 },
      { aSlot: 2, bSlot: 7, pa: 0.55 }
    ],
    bySlot,
    evaluate: () => 100
  });
  assert(close(flat.ct, 100, 1e-9), `branch weights must sum to 1, got ${flat.ct / 100}`);
}

// --- more fights than can be enumerated: the decisive ones win the slots -----
{
  const bySlot = board();
  const duels = [
    { aSlot: 0, bSlot: 5, pa: 0.5 },
    { aSlot: 1, bSlot: 6, pa: 0.5 },
    { aSlot: 2, bSlot: 7, pa: 0.5 },
    { aSlot: 3, bSlot: 8, pa: 0.99 },
    { aSlot: 4, bSlot: 9, pa: 0.5 },
    { aSlot: 0, bSlot: 6, pa: 0.01 }
  ];
  const got = ahead(state(5, 5), duels, bySlot, 20000, 20000);
  assert(got.parts.duels.length === 5, 'the enumeration is capped');
  const kept = got.parts.duels.map((d) => d.pa);
  assert(kept[0] === 0.99 || kept[0] === 0.01, 'the most decisive fight is kept first');
  assert(kept.includes(0.99) && kept.includes(0.01), 'both decided fights survive the cap');
}

console.log('duelLookahead.test.js: ok');
