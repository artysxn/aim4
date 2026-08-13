// Run: node shared/sim/sync.test.js
//
// SIM-PLAN 19.11: a team cannot sync by reacting. What has to hold:
//
//   a clock hit inside tolerance is go, and a miss is not
//   an event go fires on a matching percept and not on a stranger
//   mixAnchor is deterministic under Rng, and throws without one
//
// MIX_CLOCK_P and DEFAULT_TOLERANCE_SECONDS are `[calibrate]`. The assertions
// are properties of the inequalities, not of those numbers.

import { Rng } from './rng.js';
import { SOUND } from './sound.js';
import {
  ANCHOR,
  MIX_CLOCK_P,
  SYNC_EVENT,
  makeSync,
  mixAnchor,
  partialBreak,
  reached
} from './sync.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- clock hit / miss -------------------------------------------------------

{
  const at = 92;
  const tol = 2;
  const sync = makeSync({ kind: ANCHOR.CLOCK, atSeconds: at, toleranceSeconds: tol });
  assert(sync.kind === ANCHOR.CLOCK, 'clock kind');
  assert(sync.motive.includes('1:32'), `go at 1:32 is remaining seconds: ${sync.motive}`);
  assert(!sync.motive.includes('—'), 'motive strings carry no em dashes');

  assert(reached(sync, { secondsLeft: at }).go, 'exactly on the mark is go');
  assert(reached(sync, { secondsLeft: at + tol }).go, 'the far edge of tolerance is still go');
  assert(reached(sync, { secondsLeft: at - tol }).go, 'and so is the near edge');
  assert(!reached(sync, { secondsLeft: at + tol + 0.01 }).go, 'past the far edge is a miss');
  assert(!reached(sync, { secondsLeft: at - tol - 0.01 }).go, 'past the near edge is a miss');
  assert(reached(sync, { secondsLeft: at - tol - 1 }).late, 'and once the clock has gone past, it is late');
  assert(!reached(sync, { secondsLeft: at + tol + 1 }).late, 'waiting for the mark is not late');
}

{
  // Property: for any mark and any positive tolerance, the closed interval
  // around the mark is go and the outside is not.
  for (const [at, tol] of [
    [30, 0.5],
    [90, 1],
    [115, 3]
  ]) {
    const sync = makeSync({ kind: ANCHOR.CLOCK, atSeconds: at, toleranceSeconds: tol });
    assert(reached(sync, { secondsLeft: at }).go, `hit at ${at}`);
    assert(!reached(sync, { secondsLeft: at + tol + 1 }).go, `miss after ${at}+${tol}`);
    assert(reached(sync, { secondsLeft: at - tol - 1 }).late, `late before ${at}-${tol}`);
  }
}

// ---- event go on a matching percept -----------------------------------------

{
  const sync = makeSync({ kind: ANCHOR.EVENT, event: SYNC_EVENT.CT_SMOKE });
  assert(sync.kind === ANCHOR.EVENT, 'event kind');
  assert(reached(sync, { percepts: [{ type: 'ct_smoke' }] }).go, 'the named percept is go');
  assert(reached(sync, { percepts: [{ type: SOUND.GRENADE, nade: 'smokegrenade' }] }).go, 'a smoke detonation is the CT smoke');
  assert(!reached(sync, { percepts: [{ type: SOUND.FOOTSTEP }] }).go, 'a footstep is not');
  assert(!reached(sync, { percepts: [] }).go, 'and neither is silence');
  assert(!reached(sync, { percepts: [{ type: SOUND.FOOTSTEP }] }).late, 'event anchors do not go late on a stranger');
}

{
  const flash = makeSync({ kind: ANCHOR.EVENT, event: SYNC_EVENT.FLASH });
  assert(reached(flash, { percepts: [{ type: 'flashbang' }] }).go, 'a flash percept is go');
  assert(!reached(flash, { percepts: [{ type: 'smokegrenade' }] }).go, 'a smoke is not a flash');
}

// ---- mixAnchor --------------------------------------------------------------

{
  const a = mixAnchor(new Rng(7));
  const b = mixAnchor(new Rng(7));
  assert(a === b, 'same seed, same kind');
  assert(a === ANCHOR.CLOCK || a === ANCHOR.EVENT, 'a kind the plan named');

  const again = mixAnchor(new Rng(7));
  assert(again === a, 'a fresh generator on the same seed repeats');
}

{
  let clock = 0;
  let event = 0;
  for (let s = 1; s <= 200; s += 1) {
    const k = mixAnchor(new Rng(s));
    if (k === ANCHOR.CLOCK) clock += 1;
    else event += 1;
  }
  assert(clock > 0 && event > 0, 'mixing produces both anchors');
  assert(MIX_CLOCK_P > 0 && MIX_CLOCK_P < 1, 'the mix is a real mixture, not a constant');
}

{
  let missing = false;
  try {
    mixAnchor();
  } catch (e) {
    missing = /rng/i.test(e.message);
  }
  assert(missing, 'missing rng throws');

  let nil = false;
  try {
    mixAnchor(null);
  } catch (e) {
    nil = /rng/i.test(e.message);
  }
  assert(nil, 'null rng throws');
}

// ---- partial break: flags for the caller to re-solve ------------------------

{
  const one = partialBreak({ lateSlots: [2], bodies: 5, tolerance: 0.4 });
  assert(one.goShort && !one.wait, 'one late of five: go short-handed');
  assert(one.remaining === 4, 'four still here');

  const two = partialBreak({ lateSlots: [2, 3], bodies: 5, tolerance: 0.4 });
  assert(two.wait && !two.goShort, 'two late: wait');
  assert(two.remaining === 3, 'three still here');
}

console.log('sync: ok');
