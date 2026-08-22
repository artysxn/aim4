// Run: node src/replays/analytics/shapeUtility.test.js
//
// A grenade selection owns the utility types it was drawn with.
//
// The four utility buttons used to be one global switch that every grenade
// selection re-read at search time. Two boxes therefore could not ask two
// different questions: turning smokes off to draw a molotov box silently
// rewrote the smoke box drawn a minute earlier, and the list called both of
// them "Grenade in rect N" because that was the only name that could be true.
//
// They are now a snapshot taken when the box is drawn. The buttons go back to
// meaning "what the next box will be about", and "molotov in A, smoke in B,
// smoke in C, all by the T side" is one search.

import assert from 'node:assert/strict';
import {
  UTIL_KEYS,
  loadShapes,
  saveShapes,
  shapePassesWindow,
  shapeUtilityKeys
} from './shapeFilters.js';

// localStorage, enough of it for a round trip.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

const TICK_RATE = 64;
const THROW_TICK = 5 * TICK_RATE;

const A = { type: 'rect', x: 0, y: 0, w: 100, h: 100 };       // box A
const B = { type: 'rect', x: 500, y: 500, w: 100, h: 100 };   // box B
const IN_A = { x: 50, y: 50 };
const IN_B = { x: 550, y: 550 };

const only = (...keys) => Object.fromEntries(UTIL_KEYS.map((k) => [k, keys.includes(k)]));

/** One round: our player molotovs box A and smokes box B, in the same phase. */
const meta = {
  tickRate: TICK_RATE,
  startTick: 0,
  freezeEndTick: 0,
  endTick: 115 * TICK_RATE,
  team1Side: 'T',
  team2Side: 'CT',
  players: [
    { id: 'me', slot: 0, team: 1 },
    { id: 'them', slot: 5, team: 2 }
  ],
  events: {
    kills: [],
    grenades: [
      { type: 'molotov', player: 'me', at: IN_A, detonateTick: THROW_TICK },
      { type: 'smokegrenade', player: 'me', at: IN_B, detonateTick: THROW_TICK }
    ]
  }
};

const grenadeShape = (geometry, utility) => ({
  id: 'g', feature: 'grenade_in', geometry, enabled: true,
  ...(utility ? { utility } : {})
});

const passes = (shape, globalUtility = null) =>
  shapePassesWindow({
    meta,
    tickBuffer: null,
    playerId: 'me',
    phase: 'early',
    shape,
    utility: globalUtility
  });

// ---- each box answers its own question --------------------------------------
{
  const molotovInA = grenadeShape(A, only('molotov'));
  const smokeInB = grenadeShape(B, only('smoke'));

  assert.equal(passes(molotovInA), true, 'the molotov landed in A');
  assert.equal(passes(smokeInB), true, 'the smoke landed in B');

  // The point of the change: swapping the boxes must fail, and it must fail
  // for the right reason — each box is about one type, not about "a grenade".
  assert.equal(passes(grenadeShape(A, only('smoke'))), false, 'no smoke in A');
  assert.equal(passes(grenadeShape(B, only('molotov'))), false, 'no molotov in B');

  // And neither is disturbed by what the buttons happen to say now. Under the
  // old behaviour, this argument WAS the filter.
  for (const now of [only('smoke'), only('he'), only(...UTIL_KEYS), null]) {
    assert.equal(passes(molotovInA, now), true, 'A still means molotov');
    assert.equal(passes(smokeInB, now), true, 'B still means smoke');
  }
}

// ---- all four means any grenade, and keeps meaning it -----------------------
{
  const any = grenadeShape(A, only(...UTIL_KEYS));
  assert.equal(passes(any), true, 'the molotov in A is a grenade in A');
  // Pinned, not live: turning smokes off later does not narrow a box that was
  // drawn to mean "any".
  assert.equal(passes(grenadeShape(B, only(...UTIL_KEYS)), only('molotov')), true);
  assert.equal(shapeUtilityKeys(any), null, 'and it is named generically');
}

// ---- none selected is a query nobody meant ----------------------------------
{
  const nothing = grenadeShape(A, only());
  assert.equal(passes(nothing), true, 'read as "any", not as a box that can never match');
}

// ---- a selection drawn before this existed still follows the switches -------
{
  const legacy = grenadeShape(A, null);
  assert.equal(passes(legacy, only('molotov')), true, 'global says molotov, A has one');
  assert.equal(passes(legacy, only('smoke')), false, 'global says smoke, A has none');
  assert.equal(shapeUtilityKeys(legacy), null, 'and it has no name of its own');
}

// ---- what the list calls them -----------------------------------------------
{
  assert.deepEqual(shapeUtilityKeys(grenadeShape(A, only('smoke'))), ['smoke']);
  assert.deepEqual(
    shapeUtilityKeys(grenadeShape(A, only('molotov', 'he'))),
    ['molotov', 'he'],
    'in button order, so two boxes with the same pair read the same'
  );
  // Only grenade selections have one.
  assert.equal(
    shapeUtilityKeys({ feature: 'player_in', geometry: A, utility: only('smoke') }),
    null
  );
}

// ---- it survives the round trip through storage -----------------------------
{
  saveShapes('DUST2', [
    grenadeShape(A, only('molotov')),
    { ...grenadeShape(B, only('smoke')), id: 'g2' },
    { id: 'p1', feature: 'player_in', geometry: A, enabled: true }
  ]);
  const back = loadShapes('DUST2');
  assert.equal(back.length, 3);
  assert.deepEqual(shapeUtilityKeys(back[0]), ['molotov'], 'A is still molotov after a reload');
  assert.deepEqual(shapeUtilityKeys(back[1]), ['smoke'], 'B is still smoke');
  assert.equal(back[2].utility, undefined, 'and a player selection carries none');
  assert.equal(passes(back[0]), true);
  assert.equal(passes(back[1]), true);
}

console.log('shapeUtility.test.js: ok');
