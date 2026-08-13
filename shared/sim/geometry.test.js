// Run: node shared/sim/geometry.test.js
//
// Trades, spacing, crossfires — the assertions are the three sentences the
// plan wrote in bold:
//
//   an entry with trade cover is a different action from one without
//   spacing is a price, not a leash
//   two watchers split wide beat two watchers stood together

import {
  SPACING,
  TRADE_WINDOW_SECONDS,
  crossfireScore,
  placementScore,
  spacingPenalty,
  tradeCover
} from './geometry.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const seeAll = () => true;
const seeNone = () => false;

// ---- trade cover ------------------------------------------------------------

{
  const killer = { x: 1000, y: 0 };

  const line = tradeCover({ killerSpot: killer, mate: { x: 0, y: 0 }, canSee: seeAll });
  assert(line.covered && line.how === 'line' && line.seconds === 0, 'a held line is cover now');

  const reach = tradeCover({
    killerSpot: killer,
    mate: { x: 0, y: 0 },
    canSee: seeNone,
    travelSeconds: () => TRADE_WINDOW_SECONDS - 0.5
  });
  assert(reach.covered && reach.how === 'reach', 'reaching inside the window is cover');

  const late = tradeCover({
    killerSpot: killer,
    mate: { x: 0, y: 0 },
    canSee: seeNone,
    travelSeconds: () => TRADE_WINDOW_SECONDS + 1
  });
  assert(!late.covered && late.seconds === Infinity, 'arriving after the window is not');

  const wrongFloor = tradeCover({
    killerSpot: { x: 1000, y: 0, level: 'lower' },
    mate: { x: 990, y: 0, level: 'default' },
    canSee: seeAll
  });
  assert(!wrongFloor.covered, 'a concrete slab is not a trade angle');
}

// ---- spacing is a price, not a leash ----------------------------------------

{
  assert(spacingPenalty(500) === 0, 'inside the band is free');
  const nearMiss = spacingPenalty(SPACING.default.min - 20);
  const stacked = spacingPenalty(10);
  assert(nearMiss > 0 && nearMiss < 0.1, `a small violation is almost free (${nearMiss.toFixed(3)})`);
  assert(stacked > nearMiss, 'a full stack pays more');
  assert(stacked <= 1, 'and the price is bounded — stacking on purpose stays possible');

  assert(spacingPenalty(5000, 'lurk') === 0, 'a lurker has no far limit');
  assert(spacingPenalty(5000, 'execute') === 1, 'an execute strung across the map pays full');
  assert(spacingPenalty(Infinity, 'lurk') === 0, 'unreachable is fine for a lurk');
}

// ---- crossfires -------------------------------------------------------------

{
  const entry = { x: 0, y: 0 };

  // Two watchers stood together: one problem. Split wide: two problems.
  const together = crossfireScore(
    [
      { x: 1000, y: 0 },
      { x: 1000, y: 60 }
    ],
    entry,
    seeAll
  );
  const split = crossfireScore(
    [
      { x: 1000, y: 0 },
      { x: 0, y: 1000 }
    ],
    entry,
    seeAll
  );
  assert(split.spreadDeg > 80, `a split is wide (${split.spreadDeg.toFixed(0)} deg)`);
  assert(together.spreadDeg < 10, `a stack is narrow (${together.spreadDeg.toFixed(0)} deg)`);
  assert(split.spreadDeg > together.spreadDeg, 'the split builds the better crossfire');

  const blind = crossfireScore([{ x: 1000, y: 0 }], entry, seeNone);
  assert(blind.watchers === 0 && blind.spreadDeg === 0, 'no line, no crossfire');

  // Placement: the same two bots, scored over where entries actually happen.
  const corridors = [{ point: entry, mass: 0.8 }, { point: { x: 2000, y: 2000 }, mass: 0.2 }];
  const splitScore = placementScore(
    [
      { x: 1000, y: 0 },
      { x: 0, y: 1000 }
    ],
    corridors,
    seeAll
  );
  const stackScore = placementScore(
    [
      { x: 1000, y: 0 },
      { x: 1000, y: 60 }
    ],
    corridors,
    seeAll
  );
  assert(splitScore > stackScore, 'placement prefers the crossfire over the double stack');
}

console.log('geometry: ok');
