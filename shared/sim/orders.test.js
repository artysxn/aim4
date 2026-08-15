// Run: node shared/sim/orders.test.js
//
// 6.1's acceptance is two sentences and both are checked here: bots may
// refuse, and human calls never enter the learning paths. The refusal half is
// unit-tested against evaluateOrder; the quarantine half is checked where it
// actually has to hold, which is the firewall predicate every write path asks.

import {
  ORDER_SOURCE,
  ORDER_VERDICT,
  REFUSAL,
  REFUSAL_MIN_SUPPORT,
  createOrderQueue,
  evaluateOrder,
  humanTouched,
  makeOrder
} from './orders.js';
import { isHumanCalled, markHumanCalled, assertNotHumanCalled } from './firewall.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const LEGAL = ['a-exec', 'b-split', 'default'];
const alive = (slot, channel = null) => ({ slot, alive: true, channel });

// ---- what an order is ------------------------------------------------------

{
  const o = makeOrder({ call: ' b-split ', side: 'T', slots: [1, 1, 2], tick: 400 });
  assert(o.call === 'b-split', 'the call is trimmed');
  assert(o.slots.length === 2, 'a slot list is deduped');
  assert(o.source === ORDER_SOURCE.HUMAN, 'an order is human unless it says otherwise');
  // The dangerous default is the other way round: an unlabelled order that
  // counted as the caller's own would walk straight into the index.
  assert(makeOrder({ call: 'x', source: 'nonsense' }).source === ORDER_SOURCE.HUMAN,
    'and an unrecognised source is human, not trusted');
}

// ---- bots may refuse -------------------------------------------------------

{
  const base = { legalCalls: LEGAL, bodies: [alive(0), alive(1)], currentCall: 'default' };

  const illegal = evaluateOrder({ ...base, order: makeOrder({ call: 'mid-rush', side: 'T' }) });
  assert(illegal.verdict === ORDER_VERDICT.REFUSED, 'a call this side cannot make is refused');
  assert(illegal.reason === REFUSAL.ILLEGAL, 'and says why');

  const defusing = evaluateOrder({
    ...base,
    bodies: [alive(0, 'defusing'), alive(1)],
    order: makeOrder({ call: 'a-exec', side: 'T', slots: [0] })
  });
  assert(defusing.reason === REFUSAL.CHANNEL, 'a bot mid-defuse will not break off');

  const dead = evaluateOrder({
    ...base,
    bodies: [{ slot: 0, alive: false, channel: null }],
    order: makeOrder({ call: 'a-exec', side: 'T' })
  });
  assert(dead.reason === REFUSAL.DEAD, 'nobody alive is a refusal, not a plan');

  const late = evaluateOrder({ ...base, clock: 110, order: makeOrder({ call: 'a-exec', side: 'T' }) });
  assert(late.reason === REFUSAL.LATE, 'an execute with no time left is refused');
}

// ---- the priced refusal ----------------------------------------------------

{
  const bodies = [alive(0), alive(1)];
  const priceOf = (call) =>
    call === 'default'
      ? { mean: 0.62, n: 5000 }
      : call === 'a-exec'
        ? { mean: 0.3, n: 5000 }
        : { mean: 0.58, n: 5000 };

  const bad = evaluateOrder({
    legalCalls: LEGAL,
    bodies,
    currentCall: 'default',
    priceOf,
    order: makeOrder({ call: 'a-exec', side: 'T' })
  });
  assert(bad.verdict === ORDER_VERDICT.REFUSED, 'a call priced far below the plan is refused');
  assert(bad.reason === REFUSAL.PRICE, 'on price');
  assert(/30%/.test(bad.motive) && /62%/.test(bad.motive), `the motive quotes both: ${bad.motive}`);

  const fine = evaluateOrder({
    legalCalls: LEGAL,
    bodies,
    currentCall: 'default',
    priceOf,
    order: makeOrder({ call: 'b-split', side: 'T' })
  });
  assert(fine.verdict === ORDER_VERDICT.ACCEPTED, 'a slightly worse call is taken: humans may be wrong');

  // The guard that stops a thin cell from talking a human out of a call.
  const thin = evaluateOrder({
    legalCalls: LEGAL,
    bodies,
    currentCall: 'default',
    priceOf: (c) => (c === 'default' ? { mean: 0.62, n: 5000 } : { mean: 0.3, n: REFUSAL_MIN_SUPPORT - 1 }),
    order: makeOrder({ call: 'a-exec', side: 'T' })
  });
  assert(thin.verdict === ORDER_VERDICT.ACCEPTED, 'a head with no support does not get to refuse');

  const noHead = evaluateOrder({ legalCalls: LEGAL, bodies, currentCall: 'default', order: makeOrder({ call: 'a-exec', side: 'T' }) });
  assert(noHead.verdict === ORDER_VERDICT.ACCEPTED, 'and with no head at all, the order stands');
}

// ---- the queue -------------------------------------------------------------

{
  const q = createOrderQueue([
    { call: 'a-exec', side: 'T', tick: 0 },
    { call: 'b-split', side: 'CT', tick: 100 },
    { call: 'default', side: 'T', tick: 500 }
  ]);
  assert(q.due(0, 'T').length === 1, 'a freeze order is due at tick 0');
  assert(q.due(0, 'T').length === 0, 'and is handed out exactly once');
  assert(q.due(200, 'CT').length === 1, 'the CT order comes due later');
  assert(q.due(200, 'T').length === 0, 'a T drain does not see it');
  assert(q.forSide('T').length === 2, 'peeking never consumes');
}

// ---- human calls never enter the learning paths ----------------------------

{
  const clean = { round: 1 };
  const called = markHumanCalled({ round: 2 });
  assert(!isHumanCalled(clean), 'an unwatched round is clean');
  assert(isHumanCalled(called), 'a called one is not');
  // Same string-survives-a-round-trip hazard the synthetic check guards.
  assert(isHumanCalled({ humanCalled: 'true' }), 'a stringified flag still counts');
  assert(!isHumanCalled({ humanCalled: false }), 'and an explicit false does not');

  let threw = false;
  try {
    assertNotHumanCalled(called, 'the BC extractor');
  } catch {
    threw = true;
  }
  assert(threw, 'a learning reader refuses a human-called round');

  // A REFUSED order still taints the round: a human was in the loop.
  assert(
    humanTouched([{ source: ORDER_SOURCE.HUMAN, verdict: ORDER_VERDICT.REFUSED }]),
    'a refusal is still a human having called'
  );
  assert(!humanTouched([{ source: ORDER_SOURCE.DRILL }]), 'a drill is not a human');
}

console.log('orders: ok (refusals priced and hard, human calls quarantined)');
