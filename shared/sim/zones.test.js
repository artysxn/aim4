// Run: node shared/sim/zones.test.js
//
// A small map, laid out so the doctrine's four types all appear and so that the
// interesting property is testable: safety PROPAGATES. Ground behind ground you
// hold is safer than ground behind ground you are fighting over, and that is
// the difference between a bomb carrier who is fine and one who is about to
// lose the round.
//
//   spawn -- mid -- site
//              \
//               flank
//
// `gates(z)` answers "every path into z crosses these", which is the whole
// definition of a safe zone in chapter 1.

import { TICK_RATE } from './constants.js';
import { ZONE, bombIsSafe, classifyZones, frontier, zoneLedger } from './zones.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ZONES = ['spawn', 'mid', 'site', 'flank'];
const GATES = {
  spawn: ['mid'],
  mid: ['spawn', 'site', 'flank'],
  site: ['mid'],
  flank: ['mid']
};
const gates = (z) => GATES[z];

function classify({ held = [], mass = {}, swept = {}, tick = 10 * TICK_RATE }) {
  return classifyZones({
    zones: ZONES,
    holding: (z) => held.includes(z),
    enemyMass: (z) => mass[z] ?? 0.5,
    sweptTick: (z) => swept[z] ?? -Infinity,
    gates,
    tick
  });
}

// ---- nothing held: everything is unknown ------------------------------------

{
  const c = classify({ held: [] });
  assert([...c.values()].every((v) => v === ZONE.UNKNOWN), 'with no presence, nothing is known');
  const led = zoneLedger(c);
  assert(led.unknown === 4 && led.safe === 0, 'and the ledger says so');
}

// ---- holding ground you can be contested on is RISK, not safe ---------------

{
  // We hold spawn. Its only gate is mid, which is unknown, so spawn is
  // contestable: an enemy can arrive without us having seen anything.
  const c = classify({ held: ['spawn'] });
  assert(c.get('spawn') === ZONE.RISK, 'held ground behind an unknown is risk');
  assert(c.get('mid') === ZONE.UNKNOWN, 'and the unknown is unknown');
  assert(!bombIsSafe(c, 'spawn'), 'so the bomb does not belong there');
}

// ---- safety propagates -------------------------------------------------------

{
  // Now we hold mid too. Mid is still contestable (site and flank are unknown),
  // but spawn is now behind mid, which we hold, so spawn is genuinely safe.
  const c = classify({ held: ['spawn', 'mid'] });
  assert(c.get('mid') === ZONE.RISK, 'mid is held but contestable');
  assert(c.get('spawn') === ZONE.SAFE, 'and spawn behind it is safe');
  assert(bombIsSafe(c, 'spawn'), 'so the bomb may be there');
  assert(!bombIsSafe(c, 'mid'), 'but not on the contested ground');
}

{
  // Hold everything: every zone is gated only by zones we hold, so it is all
  // safe. This is the state a T side is trying to manufacture.
  const c = classify({ held: ZONES });
  assert([...c.values()].every((v) => v === ZONE.SAFE), 'total control is all safe');
  assert(zoneLedger(c).safe === 4, 'and the ledger agrees');
}

// ---- a swept zone stops being unknown ---------------------------------------

{
  const now = 10 * TICK_RATE;
  const justSwept = classify({ held: ['spawn'], swept: { mid: now - TICK_RATE }, tick: now });
  assert(justSwept.get('mid') !== ZONE.UNKNOWN, 'ground we just cleared is not unknown');

  const longAgo = classify({ held: ['spawn'], swept: { mid: now - 30 * TICK_RATE }, tick: now });
  assert(longAgo.get('mid') === ZONE.UNKNOWN, 'but a stale sweep goes back to unknown');
}

{
  // Belief matters as well as sweeping: ground nobody could be on is not a
  // threat even if we have not looked at it recently.
  const c = classify({ held: ['spawn'], mass: { mid: 0 } });
  assert(c.get('mid') !== ZONE.UNKNOWN, 'ground the belief says is empty is not unknown');
}

// ---- buffers are ground we know about but do not hold ----------------------

{
  // We hold spawn and flank; mid is unheld but believed empty, and the site
  // beyond it is unknown. Mid is the textbook buffer: it costs the enemy
  // resources to take and it buys us time.
  const c = classifyZones({
    zones: ZONES,
    holding: (z) => z === 'spawn' || z === 'flank',
    enemyMass: (z) => (z === 'mid' ? 0 : 0.5),
    sweptTick: () => -Infinity,
    gates,
    tick: 10 * TICK_RATE
  });
  assert(c.get('site') === ZONE.UNKNOWN, 'the site is unknown');
  assert(c.get('mid') === ZONE.BUFFER, `mid is a buffer (${c.get('mid')})`);
}

{
  // Clearing ground and then leaving it makes it a buffer, not a safe zone and
  // not an unknown. Losing a buffer costs the enemy utility and exposure to
  // take it back, which is the whole reason to hold one.
  const now = 10 * TICK_RATE;
  const c = classify({ held: ['spawn'], swept: { mid: now - TICK_RATE }, tick: now });
  assert(c.get('mid') === ZONE.BUFFER, 'swept-then-left ground is a buffer');
  assert(zoneLedger(c).buffer >= 1, 'and the ledger counts it');
}

// ---- the frontier is where a take should point ------------------------------

{
  const c = classify({ held: ['spawn', 'mid'] });
  const f = frontier(c, gates);
  assert(f.includes('site'), 'the site is on the frontier');
  assert(f.includes('flank'), 'and so is the flank');
  assert(!f.includes('spawn'), 'ground we already hold is not');

  // Nothing held means nothing reachable is on a frontier either, because a
  // frontier is defined by having somewhere to step from.
  const none = classify({ held: [] });
  assert(frontier(none, gates).length === 0, 'a team with no ground has no frontier');
}

// ---- the map paints differently per side ------------------------------------

{
  // The same world, from two sides. This is the property that makes the whole
  // classification worth computing rather than painting: T-held ground is not
  // CT-held ground, and each side's bomb rule, buffer, and frontier follow from
  // its own picture.
  const tSide = classify({ held: ['spawn', 'mid'] });
  const ctSide = classify({ held: ['site'] });
  assert(tSide.get('spawn') === ZONE.SAFE, 'spawn is safe for the side holding it');
  assert(ctSide.get('spawn') === ZONE.UNKNOWN, 'and unknown to the side that is not');
  assert(tSide.get('site') === ZONE.UNKNOWN, 'while the site is unknown to the T');
  assert(ctSide.get('site') === ZONE.RISK, 'and contested ground to the CT on it');
}

console.log('zones: ok');
