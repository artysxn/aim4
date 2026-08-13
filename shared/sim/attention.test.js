// Run: node shared/sim/attention.test.js
//
// The two caps of 5.7, tested as caps:
//
//   the attention budget runs concentration into slots, the dead contribute a
//     capped bonus, and a fractional budget intermittently checks the lurker
//   the latency gate holds a deliberate re-plan to a LogNormal draw, opens
//     instantly for reflexes, and never lets a team think faster than its
//     caller can speak plus the comm delay

import {
  LatencyGate,
  REFLEX_EVENTS,
  attentionBudget,
  chooseAttended,
  teamAttention,
  teamReplanTick
} from './attention.js';
import {
  ATTENTION_SLOTS_MAX,
  ATTENTION_SLOTS_MIN,
  COMM_DELAY_MIN,
  DEAD_ATTENTION_BONUS_CAP,
  DECISION_LATENCY_MEDIAN_PRO,
  TICK_RATE
} from './constants.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const profile = (concentration, decisionSpeed = 0.5) => ({ concentration, decisionSpeed });

// ---- the attention budget ---------------------------------------------------

{
  assert(attentionBudget(profile(0)) === ATTENTION_SLOTS_MIN, 'mix tracks the minimum');
  assert(attentionBudget(profile(1)) === ATTENTION_SLOTS_MAX, 'pro tracks the maximum');

  const profiles = [profile(1), profile(1), profile(1), profile(1), profile(1)];
  const allAlive = teamAttention(profiles, [true, true, true, true, true]);
  assert(
    allAlive.every((k) => k === ATTENTION_SLOTS_MAX),
    'a full living team gets its own budgets and nothing else'
  );

  const twoDead = teamAttention(profiles, [true, true, true, false, false]);
  assert(twoDead[3] === 0 && twoDead[4] === 0, 'the dead track nothing themselves');
  assert(twoDead[0] > ATTENTION_SLOTS_MAX, 'the living inherit spectator eyes');

  // The cap: even four dead pros may add at most the bonus cap in total.
  const lastAlive = teamAttention(profiles, [true, false, false, false, false]);
  assert(
    lastAlive[0] <= ATTENTION_SLOTS_MAX + DEAD_ATTENTION_BONUS_CAP + 1e-9,
    `a wiped team is not more aware than a full one (${lastAlive[0]})`
  );

  // Tilted players stop calling: low-concentration dead contribute less.
  const tiltedDead = [profile(1), profile(0), profile(0), profile(0), profile(0)];
  const tilted = teamAttention(tiltedDead, [true, false, false, false, false]);
  assert(tilted[0] < lastAlive[0], 'a tilted spectator is worth less than a focused one');
}

// ---- fractional budgets check the lurker intermittently ---------------------

{
  const priorities = [
    { slot: 0, priority: 3 },
    { slot: 1, priority: 2 },
    { slot: 2, priority: 1 }
  ];
  const whole = chooseAttended(2, priorities, new Rng(7));
  assert(whole.length === 2 && whole[0] === 0 && whole[1] === 1, 'a whole budget takes the top');

  let thirds = 0;
  const trials = 2000;
  const rng = new Rng(11);
  for (let i = 0; i < trials; i += 1) {
    if (chooseAttended(2.4, priorities, rng).length === 3) thirds += 1;
  }
  const rate = thirds / trials;
  assert(
    rate > 0.35 && rate < 0.45,
    `a 2.4 budget checks the third slot about 40% of steps (${rate.toFixed(2)})`
  );

  const replay = [];
  for (let i = 0; i < 5; i += 1) replay.push(chooseAttended(2.4, priorities, new Rng(3)).length);
  assert(
    replay.every((n) => n === replay[0]),
    'the draw is deterministic under the seed, like everything else'
  );
}

// ---- the latency gate -------------------------------------------------------

{
  const gate = new LatencyGate({ rng: new Rng(5), profile: profile(0.5, 1) });
  assert(!gate.mayDecide(1000), 'no pending event, no deliberate change');

  const opens = gate.onEvent(1000, 'zone_empty');
  assert(opens > 1000, 'a deliberate event waits for the draw');
  assert(!gate.mayDecide(opens - 1), 'closed a tick early');
  assert(gate.mayDecide(opens), 'open at the window');
  assert(gate.mayDecide(opens + 50), 'and stays open until consumed');
  gate.decided();
  assert(!gate.mayDecide(opens + 51), 'deciding consumes the window');

  // The floor: a superhuman decisionSpeed still pays the pro median.
  const fast = new LatencyGate({ rng: new Rng(5), profile: profile(0.5, 99) });
  assert(
    Math.abs(fast.median - DECISION_LATENCY_MEDIAN_PRO) < 1e-9,
    'decision speed clamps at the pro floor'
  );
  const slow = new LatencyGate({ rng: new Rng(5), profile: profile(0.5, 0) });
  assert(slow.median > fast.median, 'a weak profile deliberates longer');

  // Reflexes are spinal: the same events 10.2 calls local.
  assert(REFLEX_EVENTS.has('damage') && REFLEX_EVENTS.has('contact'), 'the reflex set');
  const spinal = new LatencyGate({ rng: new Rng(5), profile: profile(0.5, 0.5) });
  spinal.onEvent(2000, 'damage');
  assert(spinal.mayDecide(2000), 'taking damage opens the window now');

  // Events race and the earliest window wins.
  const race = new LatencyGate({ rng: new Rng(9), profile: profile(0.5, 0.5) });
  const first = race.onEvent(3000, 'zone_empty');
  const second = race.onEvent(3001, 'bomb_dropped');
  assert(second <= Math.max(first, second) && race.openAtTick <= first, 'a later event never pushes the window later');
}

// ---- a team thinks no faster than its caller speaks -------------------------

{
  const caller = new LatencyGate({ rng: new Rng(5), profile: profile(0.5, 1) });
  const rng = new Rng(21);
  let earliest = Infinity;
  for (let i = 0; i < 200; i += 1) {
    earliest = Math.min(earliest, teamReplanTick(5000, caller, rng));
  }
  const floor = 5000 + COMM_DELAY_MIN * TICK_RATE;
  assert(
    earliest > floor,
    `no draw beats the comm delay plus a word of thought (${earliest} vs ${floor})`
  );
}

console.log('attention: ok');
