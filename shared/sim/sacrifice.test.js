// Run: node shared/sim/sacrifice.test.js
//
// SIM-PLAN 19.9 is a gate, not a courage knob. What has to hold:
//
//   no trade cover is a donation, and a donation is never priced, even when
//     the death-value the caller computed is huge
//   cover with a partner who misses the killer window is not priced
//   cover, on-time partner, peek strictly better than wait AND reroute: priced
//   equal to wait is not priced (strictly greater)
//   refragArmed is true inside the window and false after it
//
// KILLER_WINDOW_SECONDS is `[calibrate]`. Nothing below asserts 1.4.

import { TICK_RATE } from './constants.js';
import { TRADE_WINDOW_SECONDS } from './geometry.js';
import {
  KILLER_WINDOW_SECONDS,
  coverForSacrifice,
  killerLosPredicate,
  refragArmed,
  sacrificeIsPriced
} from './sacrifice.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const peek = (over = {}) => ({
  tradeCovered: true,
  partnerArrivalSeconds: 0,
  killerWindowSeconds: KILLER_WINDOW_SECONDS,
  dPRWdie: 0.3,
  dPRWlive: 0.3,
  dPRWwait: 0.2,
  dPRWreroute: 0.2,
  ...over
});

// ---- no cover is a donation -------------------------------------------------

{
  const none = sacrificeIsPriced(
    peek({ tradeCovered: false, dPRWdie: 10, dPRWlive: 10, dPRWwait: 0, dPRWreroute: 0 })
  );
  assert(!none.priced, 'a peek without cover is never priced');
  assert(none.donation, 'it is a donation, not a sacrifice');
  assert(none.value === 0, 'and the death buys nothing');
  assert(none.motive.includes('donation'), `the motive says so: ${none.motive}`);
  assert(!none.motive.includes('—'), 'motive strings carry no em dashes');
}

{
  // Same sentence from geometry rather than from a boolean: coverForSacrifice
  // is tradeCover, so a mate with no line and no reach is a donation.
  const cover = coverForSacrifice({
    killerSpot: { x: 1000, y: 0 },
    mate: { x: 0, y: 0 },
    canSee: () => false
  });
  assert(!cover.covered, 'no line and no reach is not cover');
  const fromGeom = sacrificeIsPriced(peek({ tradeCovered: cover }));
  assert(fromGeom.donation && !fromGeom.priced, 'the geometry object is the same gate');
}

// ---- cover, but the partner misses the killer window ------------------------

{
  const late = sacrificeIsPriced(
    peek({ partnerArrivalSeconds: KILLER_WINDOW_SECONDS + 0.25 })
  );
  assert(!late.priced, 'a partner outside the killer window is not a sacrifice');
  assert(!late.donation, 'cover held, so it is not a donation either');
  assert(late.motive.includes('window'), `the motive names the window: ${late.motive}`);
}

{
  // On the boundary the partner is still inside: arrival lands IN the window.
  const edge = sacrificeIsPriced(peek({ partnerArrivalSeconds: KILLER_WINDOW_SECONDS }));
  assert(edge.priced, 'arriving at the window end is still inside it');
}

// ---- cover + on-time + better than wait and reroute -------------------------

{
  const go = sacrificeIsPriced(peek());
  assert(go.priced && !go.donation, 'the conjunction holds, so it is priced');
  assert(close(go.value, 0.3 + 0.3), 'value is dPRWdie + dPRWlive, nothing extra for dying');
  assert(go.value > peek().dPRWwait && go.value > peek().dPRWreroute, 'and it beats both alternatives');
}

{
  // Geometry path: a held line is cover, and sacrificeIsPriced will compute it
  // when the boolean is omitted.
  const fromLine = sacrificeIsPriced(
    peek({
      tradeCovered: undefined,
      killerSpot: { x: 1000, y: 0 },
      mate: { x: 0, y: 0 },
      canSee: () => true
    })
  );
  assert(fromLine.priced, 'a held line is the cover the plan asked for');
}

// ---- equal to wait is not priced --------------------------------------------

{
  const wait = 0.4;
  const eqWait = sacrificeIsPriced(
    peek({
      dPRWdie: wait / 2,
      dPRWlive: wait / 2,
      dPRWwait: wait,
      dPRWreroute: wait / 2
    })
  );
  assert(!eqWait.priced, 'equal to wait is not priced: must be strictly greater');
  assert(close(eqWait.value, wait), 'the peek value is still reported');

  const eqReroute = sacrificeIsPriced(
    peek({
      dPRWdie: wait / 2,
      dPRWlive: wait / 2,
      dPRWwait: wait / 2,
      dPRWreroute: wait
    })
  );
  assert(!eqReroute.priced, 'equal to reroute is not priced either');
}

{
  // Property: for any peek value, beating both alternatives prices it, matching
  // either one does not. The numbers are constructed, not mined.
  for (const v of [0.1, 0.5, 1.2]) {
    const beats = sacrificeIsPriced(peek({ dPRWdie: v, dPRWlive: 0, dPRWwait: v / 2, dPRWreroute: v / 2 }));
    const ties = sacrificeIsPriced(peek({ dPRWdie: v, dPRWlive: 0, dPRWwait: v, dPRWreroute: 0 }));
    assert(beats.priced, `strictly better peek ${v} is priced`);
    assert(!ties.priced, `peek ${v} tied with wait is not`);
  }
}

// ---- refragArmed ------------------------------------------------------------

{
  const death = 1000;
  const w = KILLER_WINDOW_SECONDS;
  assert(refragArmed({ tick: death, deathTick: death, windowSeconds: w }), 'armed on the death tick');
  assert(
    refragArmed({ tick: death + Math.floor(w * TICK_RATE * 0.5), deathTick: death, windowSeconds: w }),
    'armed halfway through the window'
  );
  assert(
    !refragArmed({ tick: death + Math.ceil(w * TICK_RATE) + 1, deathTick: death, windowSeconds: w }),
    'closed after the window'
  );
  assert(!refragArmed({ tick: death - 1, deathTick: death, windowSeconds: w }), 'not armed before the death');
}

{
  // Property: for any positive window, now is inside and now+window is not.
  for (const w of [0.5, 1.4, 3]) {
    const death = 64;
    assert(refragArmed({ tick: death, deathTick: death, windowSeconds: w }), `open at 0 of ${w}s`);
    assert(
      !refragArmed({ tick: death + Math.ceil(w * TICK_RATE) + 1, deathTick: death, windowSeconds: w }),
      `closed after ${w}s`
    );
  }
}

// ---- the corpse adapter (optional) ------------------------------------------

{
  const catalogue = {
    canSee: (ax, ay, bx, by) => ax === 10 && bx === 50,
    anchor: (id) => (id === 'pit' ? { x: 10, y: 0, level: 'default' } : { x: 99, y: 0, level: 'default' })
  };
  const canSeeFrom = killerLosPredicate(catalogue, { x: 50, y: 0 });
  assert(canSeeFrom('pit', 'default'), 'pit had the line to the corpse');
  assert(!canSeeFrom('car', 'default'), 'car did not');
}

assert(TRADE_WINDOW_SECONDS > KILLER_WINDOW_SECONDS || TRADE_WINDOW_SECONDS > 0, 'both windows are real durations');

console.log('sacrifice: ok');
