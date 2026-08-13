// Run: node shared/sim/comms.test.js
//
// The channel is the honesty layer for two features at once (19.6, 20.7), so
// the assertions are about the properties that make it honest rather than about
// any particular latency:
//
//   nothing is heard on the tick it was said, and everything is heard after
//   two things said at the same moment arrive at different moments
//   the same seed says them at exactly the same moments twice
//   an ask that nobody serves dies on its deadline and is COUNTED
//   the storm cap refuses the fifth ask of a round
//   a percept smuggled into an ask is refused, at both layers
//   a negative confirmation moves the team blackboard on ARRIVAL, not before
//
// The last one is the interesting test: it is 20.7's whole correction, and the
// way to see it is that the blackboard still believes in banana for the length
// of the delay after the bot who cleared banana already knows better.

import {
  CommBus,
  LEVEL,
  REQUESTS_PER_ROUND,
  applyArrival,
  attentionCost,
  commDelaySeconds,
  sanitizeRequest,
  willSay
} from './comms.js';
import { COMM_DELAY_MAX, COMM_DELAY_MIN, TICK_RATE } from './constants.js';
import { JointBelief } from './knowledge.js';
import { Rng } from './rng.js';
import { skillProfile } from './skill.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const bus = (seed = 1, cfg = {}) => new CommBus({ rng: new Rng(seed), ...cfg });

const clear = (from, ...anchors) => ({ level: LEVEL.NEGATIVE, from, negative: { anchors } });
const ask = (from, over = {}) => ({
  level: LEVEL.REQUEST,
  from,
  request: { what: 'flash', where: 'banana_logs', by: 4.2, worth: 0.061, ...over }
});

// ---- the delay is a delay ----------------------------------------------------

{
  const b = bus(1);
  const { ok, msg } = b.send(1000, clear(0, 'banana'));
  assert(ok, 'a well-formed comm goes out');
  assert(msg.arriveTick > 1000, 'nothing is heard on the tick it was said');
  assert(msg.delay >= COMM_DELAY_MIN && msg.delay < COMM_DELAY_MAX, `the draw is in 5.1's range (${msg.delay})`);

  // Not visible before, visible at and after. deliver() is destructive, so walk
  // a fresh bus per probe rather than asking the same one twice.
  for (let t = 1000; t < msg.arriveTick; t += 1) {
    assert(b.deliver(t).length === 0, `silence at tick ${t}`);
  }
  const heard = b.deliver(msg.arriveTick);
  assert(heard.length === 1 && heard[0].id === msg.id, 'and it lands on its arrival tick');
  assert(b.deliver(msg.arriveTick + 500).length === 0, 'a message is delivered once and forgotten');
  assert(b.pending() === 0, 'nothing lingers in the channel: there is no transcript');
}

{
  // Late pickup: a controller that skipped ticks still gets it, once.
  const b = bus(2);
  const { msg } = b.send(0, clear(1, 'mid'));
  const heard = b.deliver(msg.arriveTick + 200);
  assert(heard.length === 1, 'a late deliver() still hands over what arrived');
}

// ---- one draw per message, and they are independent ---------------------------

{
  const b = bus(3);
  const a = b.send(500, clear(0, 'banana')).msg;
  const c = b.send(500, clear(1, 'mid')).msg;
  assert(a.arriveTick !== c.arriveTick, `two calls at once arrive apart (${a.arriveTick} vs ${c.arriveTick})`);

  // Across many pairs the spread should be real, not a rounding artifact.
  let apart = 0;
  const many = bus(4);
  for (let i = 0; i < 100; i += 1) {
    const x = many.send(0, clear(0, 'a')).msg;
    const y = many.send(0, clear(1, 'b')).msg;
    if (Math.abs(x.arriveTick - y.arriveTick) > TICK_RATE * 0.1) apart += 1;
  }
  assert(apart > 60, `and usually by a tenth of a second or more (${apart}/100)`);
}

// ---- determinism is sacred ----------------------------------------------------

{
  const run = () => {
    const b = bus(12345);
    const out = [];
    for (let i = 0; i < 20; i += 1) out.push(b.send(i * 10, clear(i % 5, 'banana')).msg.arriveTick);
    return out;
  };
  const first = run();
  const second = run();
  assert(first.join(',') === second.join(','), 'the same seed says everything at the same moment twice');

  // And the helper is the same draw the bus makes, so nobody has two channels.
  const r1 = new Rng(9);
  const r2 = new Rng(9);
  const solo = commDelaySeconds(r1);
  const viaBus = new CommBus({ rng: r2 }).send(0, clear(0, 'x')).msg.delay;
  assert(Math.abs(solo - viaBus) < 1e-12, 'commDelaySeconds is the bus draw, not a second one');
}

// ---- the support request (19.6) -----------------------------------------------

{
  const b = bus(5);
  const { ok, msg } = b.send(0, ask(0));
  assert(ok, 'an ask goes out');
  assert(msg.request.type === 'request', 'and is a request');
  assert(msg.expiresTick === Math.round(4.2 * TICK_RATE), '`by` is a horizon in seconds from when it was said');

  const heard = b.deliver(msg.arriveTick);
  assert(heard.length === 1, 'it arrives like anything else');
  assert(b.openRequests().length === 1, 'and stands as an open offer until somebody acts');
  assert(b.secondsLeft(msg, msg.arriveTick) < 4.2, 'with less time left than it asked for: the delay was paid');

  // Serving is a choice the receiver makes. The bus never made it for him.
  assert(b.serve(msg.id), 'a receiver may serve it');
  assert(!b.serve(msg.id), 'but only once');
  assert(b.openRequests().length === 0, 'and the offer closes');
  assert(b.stats.requests.served === 1 && b.stats.requests.expired === 0, 'served, not expired');
  assert(b.unservedRequestRate() === 0, 'so the unserved rate is zero');
}

{
  // Unserved is the diagnostic 19.6 asks for: it expires on its deadline and it
  // is counted, per kind, without anybody investigating.
  const b = bus(6);
  const { msg } = b.send(0, ask(0, { what: 'flash', by: 2 }));
  b.deliver(msg.arriveTick);
  assert(b.openRequests().length === 1, 'the ask is live');
  const dead = b.deliver(msg.expiresTick);
  assert(dead.length === 0 && b.openRequests().length === 0, 'and dies on its deadline, unserved');
  assert(b.stats.requests.expired === 1, 'counted');
  assert(b.stats.byWhat.flash.expired === 1, 'and attributed to the flash that never came');
  assert(b.unservedRequestRate() === 1, 'the unserved rate is a number, not an investigation');
  assert(b.unservedRequestRate('smoke') === 0, 'and it is per kind');
}

{
  // An ask whose own deadline is shorter than the channel is dead on arrival.
  // That is a modelled outcome, not an error: it never gets delivered at all.
  const b = bus(7);
  const { msg } = b.send(0, ask(0, { by: 0.4 }));
  assert(msg.expiresTick < msg.arriveTick, 'a 0.4 s ask cannot outrun a 0.5 s channel');
  assert(b.deliver(msg.arriveTick).length === 0, 'so nobody ever hears it');
  assert(b.stats.requests.expired === 1, 'and it counts as unserved');
}

{
  // The storm cap (19.6: "a request storm is a real failure mode and the cap is
  // the only defence"). Per bot, per round, and it resets with the round.
  const b = bus(8);
  for (let i = 0; i < REQUESTS_PER_ROUND; i += 1) {
    assert(b.send(i, ask(0)).ok, `ask ${i + 1} of ${REQUESTS_PER_ROUND} is allowed`);
  }
  assert(b.requestsLeft(0) === 0, 'the bot has spent its round');
  const over = b.send(99, ask(0));
  assert(!over.ok && over.reason === 'capped', `the ${REQUESTS_PER_ROUND + 1}th is refused`);
  assert(b.stats.requests.capped === 1, 'and the refusal is counted');
  assert(b.send(99, ask(1)).ok, 'the cap is per bot, not per team');
  assert(b.send(99, clear(0, 'banana')).ok, 'and only requests are capped: a bot may still call');

  b.newRound();
  assert(b.requestsLeft(0) === REQUESTS_PER_ROUND, 'a new round refills the cap');
  assert(b.pending() === 0, 'and empties the channel');
  assert(b.stats.requests.expired > 0, 'asks that died with the round went unserved too');
}

// ---- it is not a back channel (decision 58) -----------------------------------

{
  const b = bus(9);

  // Layer one: a field on the ask that is not on the whitelist.
  const smuggled = b.send(0, {
    level: LEVEL.REQUEST,
    from: 0,
    request: { what: 'flash', where: 'banana_logs', by: 4.2, worth: 0.061, enemyAt: 'car' }
  });
  assert(!smuggled.ok && smuggled.reason === 'percept_in_request', 'a percept on the ask is refused');
  assert(smuggled.stripped.includes('enemyAt'), 'and named, so the caller learns what he did');
  assert(b.pending() === 0, 'nothing was sent');
  assert(b.requestsLeft(0) === REQUESTS_PER_ROUND, 'a refused ask does not spend the cap');

  // Layer two: the envelope itself carrying a second payload.
  const twoChannels = b.send(0, {
    level: LEVEL.REQUEST,
    from: 0,
    request: { what: 'smoke', where: 'ct_cross', by: 3, worth: 0.04 },
    observation: { enemySlot: 2, anchor: 'car' }
  });
  assert(!twoChannels.ok && twoChannels.reason === 'percept_in_request', 'an ask may not ride with an observation');

  // Layer three: what actually crosses is rebuilt, not passed through, so a
  // later mutation of the caller's object cannot rewrite what was said.
  const mine = { what: 'molotov', where: 'pit', by: 5, worth: 0.02 };
  const sent = b.send(0, { level: LEVEL.REQUEST, from: 1, request: mine }).msg;
  mine.where = 'a_site';
  mine.enemyAt = 'pit';
  assert(sent.request.where === 'pit', 'the ask is a copy, not the caller\'s object');
  assert(sent.request.enemyAt === undefined, 'and cannot grow a percept after the fact');
  let threw = false;
  try {
    sent.request.enemyAt = 'pit';
  } catch {
    threw = true;
  }
  assert(threw && sent.request.enemyAt === undefined, 'a delivered ask is frozen against a receiver too');

  // And the schema is enforced rather than assumed.
  assert(!b.send(0, ask(2, { what: 'rotate' })).ok, 'only 19.6\'s five kinds are asks');
  assert(!b.send(0, ask(2, { by: -1 })).ok, 'a deadline must be in the future');
  assert(!b.send(0, { level: 9, from: 0 }).ok, 'there are five levels');
  assert(!b.send(0, { level: LEVEL.NEGATIVE, from: 0, intent: {} }).ok, 'a level carries its own payload only');
  assert(!b.send(0, { level: LEVEL.NEGATIVE, from: 0, negative: {}, hp: 12 }).ok, 'and nothing else');

  const bare = sanitizeRequest({ what: 'info', where: 'mid', by: 2, worth: 0, seen: ['b_site'] });
  assert(bare.stripped.length === 1 && bare.stripped[0] === 'seen', 'sanitizeRequest names the smuggle');
}

// ---- negative information is a comm, not a fact (20.7) ------------------------

{
  const A = ['a_site', 'a_short', 'pit'];
  const B = ['b_site', 'banana', 'car'];
  const anchors = [...A, ...B, 'mid'];
  const inB = (a) => B.includes(a);

  const rng = new Rng(21);
  // Two tiers: the clearing bot's own view, and the team blackboard.
  const mine = new JointBelief({ anchors, rng: rng.fork() });
  const blackboard = new JointBelief({ anchors, rng: rng.fork() });
  const before = blackboard.expected(inB);
  assert(before > 0.3, 'the team believes in B');

  // He clears it. His own view updates immediately; nobody else's does.
  mine.cleared(B);
  assert(mine.pEmpty(inB) > 0.99, 'the bot who swept B knows B is empty');
  assert(Math.abs(blackboard.expected(inB) - before) < 1e-9, 'the team does not, because he has not said it');

  const b = bus(22);
  const { msg } = b.send(0, { level: LEVEL.NEGATIVE, from: 3, negative: { anchors: B } });

  // For the whole length of the delay the blackboard is still wrong. This is
  // the gap chapter 3 says separates "one short" from "only one short".
  for (let t = 0; t < msg.arriveTick; t += 1) {
    for (const m of b.deliver(t)) applyArrival(m, blackboard);
  }
  assert(Math.abs(blackboard.expected(inB) - before) < 1e-9, 'still stale one tick before he is heard');

  let applied = false;
  for (const m of b.deliver(msg.arriveTick)) applied = applyArrival(m, blackboard) || applied;
  assert(applied, 'the call lands');
  assert(blackboard.pEmpty(inB) > 0.99, 'and only now does the team blackboard empty B');
  assert(blackboard.expected((a) => A.includes(a)) > 0, 'with the mass moved onto the rest of the map');
}

{
  // Level 1 is the part of a contact call the radar does not carry. Levels 3
  // to 5 are decisions, not evidence, and must not touch a belief.
  const anchors = ['a_site', 'car', 'mid'];
  const belief = new JointBelief({ anchors, rng: new Rng(23) });
  const b = bus(24);

  const one = b.send(0, { level: LEVEL.OBSERVATION, from: 0, observation: { enemySlot: 2, anchor: 'car', weapon: 'awp' } }).msg;
  for (const m of b.deliver(one.arriveTick)) applyArrival(m, belief);
  assert(belief.massAt('car', 'default', 'awp') > 0.99, 'a heard contact call collapses that slot on arrival');

  const plan = b.send(0, { level: LEVEL.ASP, from: 0, asp: { if: 'clear', then: 'rotate' } }).msg;
  const snapshot = belief.expected((a) => a === 'mid');
  for (const m of b.deliver(plan.arriveTick)) {
    assert(!applyArrival(m, belief), 'a plan is not evidence');
  }
  assert(belief.expected((a) => a === 'mid') === snapshot, 'and changes no belief');
}

// ---- comm quality is a trait, and silence discipline is a cost ----------------

{
  // 20.7: a mix team is not blind; it just does not say what it cleared.
  const count = (level, profile, seed) => {
    const rng = new Rng(seed);
    let said = 0;
    for (let i = 0; i < 400; i += 1) if (willSay(level, profile, rng)) said += 1;
    return said;
  };
  const mix = skillProfile('mix');
  const pro = skillProfile('pro');
  assert(count(2, pro, 31) > count(2, mix, 31) + 150, 'a pro side says what it cleared and a mix side does not');
  assert(count(1, mix, 32) > 200, 'but everybody calls contact');
  assert(count(5, mix, 33) < count(5, pro, 33), 'and the after-situation plan is the rarest thing on the ladder');

  const b = bus(34);
  const terse = b.send(0, clear(0, 'banana')).msg;
  const wordy = b.send(0, ask(0)).msg;
  assert(attentionCost(terse, { inDuel: false }) === 0, 'a message costs a free bot nothing');
  assert(attentionCost(terse, { inDuel: true }) > 0, 'and costs a bot in a duel attention');
  assert(
    attentionCost(wordy, { inDuel: true }) > attentionCost(terse, { inDuel: true }),
    'explanation is a longer message for the same action content, so it costs more'
  );
}

// ---- the bus refuses to exist without a seeded rng ----------------------------

{
  let threw = false;
  try {
    new CommBus({});
  } catch {
    threw = true;
  }
  assert(threw, 'a comm delay that is not seeded is not a comm delay');
}

console.log('comms: ok');
