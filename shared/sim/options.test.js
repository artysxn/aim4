// Run: node shared/sim/options.test.js
//
// The option layer is a boundary, so the assertions are about the boundary
// holding rather than about any particular behavior being clever:
//
//   the vocabulary is well-formed and versioned
//   termination is a table: the right events end the right options, and only
//     for the bot they happened to
//   commitment is real: no deliberate replacement inside minCommitTicks, and
//     the latency gate stacks on top
//   micros compile to legal-shaped intents and carry their little state
//     machines (jiggle flips, repeek waits, clear walks its corners)
//   combat is never inside an option: no micro ever emits a motor value

import {
  MIN_COMMIT_TICKS,
  OPTION_DEFS,
  OPTION_IDS,
  OptionRunner,
  beginOption,
  checkTermination,
  mayReplace,
  microIntent
} from './options.js';
import { INTENTS_VERSION, MOVE_MODES, COMBAT_POSTURES } from './intents.js';
import { LatencyGate } from './attention.js';
import { ticksFor } from './constants.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the vocabulary is well-formed ------------------------------------------

{
  assert(OPTION_IDS.length >= 25, `a real vocabulary (${OPTION_IDS.length} options)`);
  for (const id of OPTION_IDS) {
    const def = OPTION_DEFS[id];
    assert(def.family, `${id} has a family`);
    assert(Array.isArray(def.terminate), `${id} has a termination table`);
    assert(def.timeoutSeconds > 0, `${id} times out eventually`);
    assert(def.exposure >= 0 && def.exposure <= 1, `${id} has a priceable exposure share`);
  }
  // The families the plan names, all represented.
  const families = new Set(OPTION_IDS.map((id) => OPTION_DEFS[id].family));
  for (const f of ['hold', 'peek', 'move', 'support', 'objective']) {
    assert(families.has(f), `family ${f} exists`);
  }
}

// ---- termination is a table -------------------------------------------------

{
  const active = beginOption('wide_swing', { spot: 'car' }, 1000);

  // Damage to ME ends it; damage to a teammate does not.
  const mine = checkTermination(active, 1010, [{ type: 'damage', slot: 3 }], { slot: 3 });
  assert(mine?.reason === 'damaged', 'my damage ends my swing');
  const theirs = checkTermination(active, 1010, [{ type: 'damage', slot: 2 }], { slot: 3 });
  assert(theirs === null, "a teammate's damage does not end mine");

  // Arrived ends options that have an arrival.
  const arrived = checkTermination(active, 1010, [], { slot: 3, arrived: true });
  assert(arrived?.reason === 'arrived', 'arrival ends a swing');
  const hold = beginOption('hold_angle', { spot: 'car' }, 1000);
  assert(
    checkTermination(hold, 1010, [], { slot: 3, arrived: true }) === null,
    'a hold has no arrival to reach'
  );

  // Timeout uses the def's horizon.
  const t = beginOption('shoulder_peek', { spot: 'car', cover: 'pit' }, 1000);
  assert(checkTermination(t, 1000 + ticksFor(1.4), [], { slot: 0 }) === null, 'not yet');
  assert(
    checkTermination(t, 1000 + ticksFor(1.6), [], { slot: 0 })?.reason === 'timeout',
    'a shoulder peek is over in moments'
  );

  // The follow option ends the way 10.2 says a tape ends.
  const f = beginOption('follow', { trackSlot: 2 }, 1000);
  assert(
    checkTermination(f, 1001, [{ type: 'follow_error', slot: 0 }], { slot: 0 })?.reason ===
      'follow_error',
    'falling off the tape ends the follow'
  );
}

// ---- commitment is real -----------------------------------------------------

{
  const active = beginOption('hold_angle', { spot: 'car' }, 1000);
  assert(!mayReplace(active, 1000 + MIN_COMMIT_TICKS - 1, null), 'committed inside the window');
  assert(mayReplace(active, 1000 + MIN_COMMIT_TICKS, null), 'free after it, with no gate');

  // With a gate, the commit window AND the latency window both have to open.
  const gate = new LatencyGate({ rng: new Rng(3), profile: { decisionSpeed: 0.5 } });
  assert(!mayReplace(active, 1000 + MIN_COMMIT_TICKS, gate), 'gate closed: no event yet');
  const opens = gate.onEvent(1000, 'zone_empty');
  assert(
    mayReplace(active, Math.max(opens, 1000 + MIN_COMMIT_TICKS), gate),
    'both windows open: replace away'
  );
}

// ---- micros compile to legal-shaped intents ---------------------------------

{
  const check = (intent, label) => {
    assert(intent.v === INTENTS_VERSION, `${label} is versioned`);
    assert(MOVE_MODES.includes(intent.move.mode), `${label} uses a real move mode`);
    const posture = intent.combat?.posture || 'free';
    assert(COMBAT_POSTURES.includes(posture), `${label} uses a real posture`);
    // Combat is never inside an option: no micro may emit motor values.
    assert(!('aim' in intent) && !('fire' in intent), `${label} owns feet, not the crosshair`);
  };

  for (const id of OPTION_IDS) {
    const a = beginOption(
      id,
      {
        spot: 'car',
        cover: 'pit',
        yaw: 'logs',
        target: 'car',
        site: 'a',
        entry: 'car',
        mate: 1,
        enemyAnchor: 'logs',
        trackSlot: 2,
        cornerSeq: ['car', 'logs'],
        utilityType: 'smoke',
        at: 'logs',
        delaySeconds: 1
      },
      1000
    );
    check(microIntent(a, 1000, {}), id);
  }

  // hold_angle: hold the spot, pre-aim the yaw, do not chase.
  const hold = beginOption('hold_angle', { spot: 'car', yaw: 'logs' }, 0);
  const hi = microIntent(hold, 0);
  assert(hi.move.mode === 'hold' && hi.move.target === 'car', 'a hold holds');
  assert(hi.combat.posture === 'holdAngle' && hi.combat.preAim === 'logs', 'and pre-aims');

  // jiggle: out to the spot, back to cover, out again.
  const jig = beginOption('jiggle', { spot: 'car', cover: 'pit' }, 0);
  const first = microIntent(jig, 0).move.target;
  const mid = microIntent(jig, ticksFor(0.45)).move.target;
  const again = microIntent(jig, ticksFor(1.0)).move.target;
  assert(first === 'car' && mid === 'pit' && again === 'car', `jiggle flips (${first}/${mid}/${again})`);

  // shoulder peek never fights: information at the price of a silhouette.
  const sp = beginOption('shoulder_peek', { spot: 'car', cover: 'pit' }, 0);
  assert(microIntent(sp, 0).combat.posture === 'avoid', 'a shoulder peek baits, never takes');

  // repeek waits at cover, then goes.
  const rp = beginOption('repeek', { spot: 'car', cover: 'pit', delaySeconds: 1 }, 0);
  assert(microIntent(rp, 0).move.target === 'pit', 'repeek waits at cover');
  assert(microIntent(rp, ticksFor(1.2)).move.target === 'car', 'then goes');

  // clear walks its corners and pre-aims the one about to open.
  const cl = beginOption('clear', { cornerSeq: ['car', 'logs', 'top'] }, 0);
  const c0 = microIntent(cl, 0, {});
  assert(c0.move.target === 'car' && c0.combat.preAim === 'logs', 'first corner, next pre-aimed');
  const c1 = microIntent(cl, 8, { arrived: true });
  assert(c1.move.target === 'logs' && c1.combat.preAim === 'top', 'arrival advances the list');

  // utility_setup carries the one-shot; save runs with the gun down.
  const us = beginOption('utility_setup', { spot: 'car', utilityType: 'smoke', at: 'logs' }, 0);
  const ui = microIntent(us, 0);
  assert(ui.utility?.type === 'smoke' && ui.utility?.at === 'logs', 'the throw rides the intent');
  const sv = beginOption('save', { target: 'pit' }, 0);
  assert(microIntent(sv, 0).combat.posture === 'avoid', 'a save does not stop to fight');

  // plant speaks in objectives, and the translator owns the walk.
  const pl = beginOption('plant', { spot: 'a_site' }, 0);
  assert(microIntent(pl, 0).objective === 'plant', 'plant is an objective, not a path');
}

// ---- the runner's lifecycle -------------------------------------------------

{
  const runner = new OptionRunner({ slot: 2 });
  assert(runner.mayReplace(0), 'nothing running: free to choose');

  runner.begin(1000, 'wide_swing', { spot: 'car' });
  const { intent, ended } = runner.step(1004, [], {});
  assert(intent.move.target === 'car' && ended === null, 'the swing runs');
  assert(!runner.mayReplace(1010), 'and is committed');

  const hit = runner.step(1010, [{ type: 'damage', slot: 2 }], {});
  assert(hit.ended?.reason === 'damaged', 'damage ends it');
  assert(runner.active === null && runner.lastEnd.reason === 'damaged', 'and the runner knows');
  assert(runner.mayReplace(1011), 'a dead option blocks nothing');

  runner.begin(1012, 'hold_angle', { spot: 'pit' });
  runner.begin(1013, 'fall_back', { target: 'pit' });
  assert(runner.lastEnd.reason === 'orderChanged', 'replacement is an orderChanged ending');
}

console.log('options: ok');
