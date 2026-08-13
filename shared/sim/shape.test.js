// Run: node shared/sim/shape.test.js
//
// The formation frame. What has to hold:
//
//   a shape is one post per slot, and home is always an answer
//   initiative reads like the ball: control, the bomb, the last exchange
//   a transition event resets the shape at per-bot speeds, familiarity slow
//   backfill moves the hole through the shape instead of leaving it
//   an anchor never abandons its site to plug the other one

import {
  backfill,
  homeOf,
  initiative,
  isTransitionEvent,
  makeShape,
  shapeReset,
  uncoveredPosts
} from './shape.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ctShape = () =>
  makeShape({
    call: 'default_ct',
    posts: [
      { slot: 0, role: 'anchor', home: 'a_site' },
      { slot: 1, role: 'support', home: 'a_short' },
      { slot: 2, role: 'rotator', home: 'mid' },
      { slot: 3, role: 'support', home: 'banana' },
      { slot: 4, role: 'anchor', home: 'b_site' }
    ]
  });

// ---- shape shape ------------------------------------------------------------

{
  const s = ctShape();
  assert(homeOf(s, 4).home === 'b_site', 'a post answers where home is');
  assert(homeOf(s, 9) === null, 'an unknown slot answers nothing');

  let threw = false;
  try {
    makeShape({ call: 'x', posts: [{ slot: 0, home: 'a' }, { slot: 0, home: 'b' }] });
  } catch {
    threw = true;
  }
  assert(threw, 'two posts for one slot is a config error, loudly');
}

// ---- initiative -------------------------------------------------------------

{
  assert(initiative({ controlShare: 0.7, side: 'CT' }) === 'mine', 'owning the map is the ball');
  assert(initiative({ controlShare: 0.3, side: 'CT' }) === 'theirs', 'losing it is not');
  assert(initiative({ controlShare: 0.5, side: 'CT' }) === 'contested', 'even is even');
  assert(
    initiative({ controlShare: 0.5, lastContactWonBy: 'mine', side: 'CT' }) === 'mine',
    'the last exchange tips an even map'
  );
  assert(
    initiative({ controlShare: 0.7, bombDown: true, side: 'CT' }) === 'theirs',
    'a planted bomb is the ball, whatever the ground says'
  );
  assert(
    initiative({ controlShare: 0.3, bombDown: true, side: 'T' }) === 'mine',
    'and it is the T side holding it'
  );
}

// ---- transitions ------------------------------------------------------------

{
  assert(isTransitionEvent({ type: 'death' }, { mine: true }), 'our death loses the ball');
  assert(!isTransitionEvent({ type: 'death' }, { mine: false }), 'theirs does not');
  assert(isTransitionEvent({ type: 'control_cut' }), 'a severing smoke does');
  assert(!isTransitionEvent({ type: 'shot' }), 'gunfire alone does not');

  const s = ctShape();
  const familiarity = (slot) => (slot === 3 ? 0 : 1);
  const orders = shapeReset(s, [true, true, false, true, true], familiarity);
  assert(orders.length === 4, 'the dead take no orders');
  const fast = orders.find((o) => o.slot === 0);
  const slow = orders.find((o) => o.slot === 3);
  assert(
    slow.delaySeconds > fast.delaySeconds,
    `the stand-in is slower into shape (${slow.delaySeconds}s vs ${fast.delaySeconds}s)`
  );
}

// ---- backfill ---------------------------------------------------------------

{
  const s = ctShape();
  const alive = [true, true, true, true, true];
  // Travel times: the mid rotator is nearest to banana.
  const travel = (slot, home) => {
    const t = {
      '2|banana': 4,
      '1|banana': 9,
      '0|banana': 11,
      '4|banana': 20
    };
    return t[`${slot}|${home}`] ?? 30;
  };

  const fill = backfill(s, 3, alive, travel);
  assert(fill?.slot === 2, 'the nearest compatible teammate inherits');
  assert(fill.home === 'banana' && fill.cascade.from === 'mid', 'and the hole moves to mid');

  // The B anchor is nearest but may not abandon its site for banana.
  const anchorNearest = (slot, home) => (slot === 4 ? 1 : travel(slot, home));
  const fill2 = backfill(s, 3, alive, anchorNearest);
  assert(fill2?.slot === 2, 'an anchor never abandons its site to backfill');

  const nobody = backfill(s, 3, [true, false, false, true, true], () => 30);
  assert(nobody === null, 'too far for everyone is a real answer');
}

// ---- coverage ---------------------------------------------------------------

{
  const s = ctShape();
  const everyoneHome = () => 1;
  assert(uncoveredPosts(s, [true, true, true, true, true], everyoneHome).length === 0, 'all covered');

  // Everyone piled on A: banana and B read uncovered.
  const piledOnA = (slot, home) => (home === 'a_site' || home === 'a_short' || home === 'mid' ? 2 : 30);
  const holes = uncoveredPosts(s, [true, true, true, true, true], piledOnA);
  assert(holes.includes('banana') && holes.includes('b_site'), `nobody is watching B (${holes})`);
}

console.log('shape: ok');
