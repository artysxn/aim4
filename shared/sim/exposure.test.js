// Run: node shared/sim/exposure.test.js
//
// The footprint is the bot's estimate of the enemy's knowledge of it, so the
// assertions are about the properties that make the estimate spendable:
//
//   silence really is silence: no emissions, no knowledge
//   a shot is hard and radius-scoped; a wall of distance keeps a secret
//   soft evidence accumulates: one step is a hint, a jog crosses the threshold
//   damage names a slot, wherever it stands
//   death tells everyone
//   the advantage estimate speaks the fitted tracker's language: same cap,
//     one-sided awareness takes the cap, stale clocks void through the grace
//
// pathDistance is euclidean here. The engine passes a geodesic one; the module
// takes it as an argument for exactly the reason sound.js does.

import {
  EXPOSURE_GRACE_SECONDS,
  INFO_ADV_CAP,
  SelfFootprint
} from './exposure.js';
import { SOUND_RADIUS, TICK_RATE } from './constants.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const at = (x, y, extra = {}) => ({ anchor: 'spot', level: 'default', x, y, ...extra });

// ---- silence is silence -----------------------------------------------------

{
  const fp = new SelfFootprint();
  assert(fp.pKnowsMe(at(100, 100), 500, dist) === 0, 'no emissions, no knowledge');
  assert(
    fp.infoAdvSecsHat(at(100, 100), 500, dist) === 0,
    'no clocks on either side reads as even'
  );
}

// ---- a shot is hard, and radius-scoped --------------------------------------

{
  const fp = new SelfFootprint();
  fp.noteShot(1000, { x: 0, y: 0 });
  const near = fp.pKnowsMe(at(500, 0), 1000, dist);
  const far = fp.pKnowsMe(at(SOUND_RADIUS.gunshot + 200, 0), 1000, dist);
  assert(near === 1, `a hypothesis inside the radius knows (${near})`);
  assert(far === 0, `a hypothesis beyond the radius does not (${far})`);

  const silenced = new SelfFootprint();
  silenced.noteShot(1000, { x: 0, y: 0, silenced: true });
  assert(
    silenced.pKnowsMe(at(SOUND_RADIUS.gunshotSilenced + 100, 0), 1000, dist) === 0,
    'a silencer buys a smaller radius'
  );
  assert(
    silenced.pKnowsMe(at(SOUND_RADIUS.gunshotSilenced - 100, 0), 1000, dist) === 1,
    'but not silence'
  );
}

// ---- soft evidence accumulates ----------------------------------------------

{
  const fp = new SelfFootprint();
  fp.noteFootstep(1000, { x: 0, y: 0 });
  const one = fp.pKnowsMe(at(200, 0), 1000, dist);
  assert(one > 0 && one < 0.5, `one step is a hint (${one.toFixed(2)})`);
  assert(fp.firstKnownTick(at(200, 0), 1000, dist) === null, 'and starts no clock');

  fp.noteFootstep(1010, { x: 30, y: 0 });
  fp.noteFootstep(1020, { x: 60, y: 0 });
  const jog = fp.pKnowsMe(at(200, 0), 1020, dist);
  assert(jog > 0.5, `a jog is a broadcast (${jog.toFixed(2)})`);
  const clock = fp.firstKnownTick(at(200, 0), 1020, dist);
  assert(clock === 1010, `the clock starts at the crossing step (${clock})`);
}

// ---- knowledge fades --------------------------------------------------------

{
  const fp = new SelfFootprint();
  fp.noteShot(0, { x: 0, y: 0 });
  const fresh = fp.pKnowsMe(at(500, 0), 0, dist);
  const stale = fp.pKnowsMe(at(500, 0), 12 * TICK_RATE, dist);
  assert(fresh === 1 && stale < 0.35, `a 12 s old shot has faded (${stale.toFixed(2)})`);
  fp.prune(20 * TICK_RATE);
  assert(fp.evidence.length === 0, 'and past the TTL it is gone entirely');
}

// ---- damage names a slot, death tells everyone ------------------------------

{
  const fp = new SelfFootprint();
  fp.noteDamageDealt(1000, 3);
  assert(
    fp.pKnowsMe(at(9999, 9999, { slot: 3 }), 1000, dist) === 1,
    'the slot I shot knows, wherever it stands'
  );
  assert(fp.pKnowsMe(at(9999, 9999, { slot: 2 }), 1000, dist) === 0, 'its teammate does not');

  fp.noteDeath(1200);
  assert(fp.pKnowsMe(at(0, 0, { slot: 2 }), 1200, dist) === 1, 'death tells everyone');
}

// ---- anchor evidence: being overlooked, utility they watched ----------------

{
  const fp = new SelfFootprint();
  fp.noteSeenBy(1000, ['logs', 'car'], 2.0);
  const watched = fp.pKnowsMe(at(0, 0, { anchor: 'logs' }), 1000, dist);
  const blind = fp.pKnowsMe(at(0, 0, { anchor: 'sandbags' }), 1000, dist);
  assert(watched > 0.5, `two seconds in an open lane is real exposure (${watched.toFixed(2)})`);
  assert(blind === 0, 'an anchor without the angle learned nothing');

  const dash = new SelfFootprint();
  dash.noteSeenBy(1000, ['logs'], 0.4);
  const quick = dash.pKnowsMe(at(0, 0, { anchor: 'logs' }), 1000, dist);
  assert(quick < watched, `a dash exposes less than a loiter (${quick.toFixed(2)})`);

  fp.noteUtilityLanded(1100, ['pit']);
  assert(
    fp.pKnowsMe(at(0, 0, { anchor: 'pit' }), 1100, dist) > 0,
    'a watched detonation is evidence'
  );
}

// ---- the advantage estimate speaks the tracker's language -------------------

{
  // One-sided, my favour: I have seen them, they have no evidence of me.
  const fp = new SelfFootprint();
  const h = at(2000, 0);
  const adv = fp.infoAdvSecsHat(h, 1000, dist, { myFirstSeenTick: 800, myLastSeenTick: 990 });
  assert(adv === INFO_ADV_CAP, `holding an unaware enemy takes the cap (${adv})`);

  // One-sided, their favour: they heard my shot, I have never seen them.
  fp.noteShot(900, { x: 2100, y: 0 });
  const held = fp.infoAdvSecsHat(h, 1000, dist);
  assert(held === -INFO_ADV_CAP, `being known but blind takes the negative cap (${held})`);

  // Two-sided: I saw them at 800, they learned of me at 900 — I am ahead.
  const both = fp.infoAdvSecsHat(h, 1000, dist, { myFirstSeenTick: 800, myLastSeenTick: 990 });
  const expect = (900 - 800) / TICK_RATE;
  assert(
    Math.abs(both - expect) < 1e-9,
    `two live clocks read as their difference (${both} vs ${expect})`
  );

  // The clamp: a huge head start still reads as the cap.
  const early = fp.infoAdvSecsHat(h, 1000, dist, { myFirstSeenTick: 100, myLastSeenTick: 990 });
  assert(early === INFO_ADV_CAP, 'the difference clamps at the cap');
}

// ---- stale clocks void through the grace ------------------------------------

{
  const fp = new SelfFootprint();
  const h = at(500, 0);
  fp.noteShot(1000, { x: 0, y: 0 });

  const graceTicks = EXPOSURE_GRACE_SECONDS * TICK_RATE;
  const later = 1000 + graceTicks + 64;

  // Their clock is stale: the engagement is over, a fresh one starts even.
  assert(fp.firstKnownTick(h, later, dist) === null, 'their clock voids past the grace');

  // My clock is stale too: last contact long gone reads as no clock, so the
  // shot they heard leaves them ahead only while THEIR clock lives.
  const advStaleMine = fp.infoAdvSecsHat(h, later, dist, {
    myFirstSeenTick: 900,
    myLastSeenTick: 1000
  });
  assert(advStaleMine === 0, `both clocks stale reads as even (${advStaleMine})`);

  // A fresh emission restarts THEIR engagement clock at the new evidence.
  fp.noteShot(later, { x: 0, y: 0 });
  assert(
    fp.firstKnownTick(h, later, dist) === later,
    'a fresh shot starts a fresh engagement, not a resumed one'
  );
}

console.log('exposure: ok');
