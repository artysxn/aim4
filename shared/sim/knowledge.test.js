// Run: node shared/sim/knowledge.test.js
//
// The belief is the piece the rest of the plan reads from, so the assertions
// here are about the properties that make it worth reading rather than about
// any particular number:
//
//   bodies are conserved, and the kill feed removes them
//   clearing ground moves mass onto the rest of the map, for every slot at once
//   a corpse is a hard constraint, not a hint
//   the count distribution is a distribution, and "how many on B" is answerable
//   attention degrades the JOINT into the MARGINALS, which is the design's
//     central claim and the reason the filter is joint at all
//
// The last one is the interesting test: it demonstrates that a coupling exists
// which marginals cannot represent, then shows attention destroying it.

import { JointBelief, personalView } from './knowledge.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const A = ['a_site', 'a_short', 'pit'];
const B = ['b_site', 'banana', 'car'];
const MID = ['mid'];
const ANCHORS = [...A, ...B, ...MID];

const zones = [
  { name: 'A', test: (a) => A.includes(a) },
  { name: 'B', test: (a) => B.includes(a) },
  { name: 'mid', test: (a) => MID.includes(a) }
];
const inA = (a) => A.includes(a);
const inB = (a) => B.includes(a);

const fresh = (seed = 1, prior = null) =>
  new JointBelief({ anchors: ANCHORS, rng: new Rng(seed), prior: prior || undefined });

// ---- shape ------------------------------------------------------------------

{
  const b = fresh();
  assert(b.particles.length === 256, 'a full particle set');
  assert(b.aliveCount() === 5, 'five enemies to start');

  const d = b.countDist(inA);
  assert(d.length === 6, 'the count distribution covers 0..5');
  const total = d.reduce((x, y) => x + y, 0);
  assert(Math.abs(total - 1) < 1e-9, `and sums to one (${total})`);

  const expected = b.expected(inA);
  assert(expected > 0 && expected < 5, `and expects a sensible number on A (${expected.toFixed(2)})`);
}

// ---- bodies are conserved ---------------------------------------------------

{
  const b = fresh();
  b.killed(2);
  b.killed(4);
  assert(b.aliveCount() === 3, 'the feed removed two');
  for (const p of b.particles) {
    assert(p.slots[2] === null && p.slots[4] === null, 'and no layout still places them');
    const live = p.slots.filter(Boolean).length;
    assert(live === 3, 'every layout has exactly three bodies in it');
  }
  // Which means at most three can be anywhere.
  assert(b.countDist(inA)[4] === 0, 'four on A is now impossible');
  assert(b.countDist(inA)[5] === 0, 'and so is five');
}

// ---- a sighting collapses one slot, and only that slot ----------------------

{
  const b = fresh();
  b.sighting(0, 'car');
  for (const p of b.particles) {
    assert(p.slots[0].anchor === 'car', 'every layout agrees about a seen enemy');
  }
  const others = new Set();
  for (const p of b.particles) others.add(p.slots[1].anchor);
  assert(others.size > 1, 'while the unseen ones are still spread out');
}

// ---- negative information moves mass onto the rest of the map ---------------

{
  const b = fresh(3);
  const beforeA = b.expected(inA);
  const beforeB = b.expected(inB);
  assert(beforeB > 0.3, 'B starts with real mass on it');

  const ok = b.cleared(B);
  assert(ok, 'the sweep was consistent with the belief');

  const afterA = b.expected(inA);
  const afterB = b.expected(inB);

  assert(afterB < 1e-9, `sweeping B empties it (${afterB})`);
  // The part a product of marginals cannot do: clearing one place makes the
  // OTHER place thicker, for every slot at once.
  assert(afterA > beforeA, `and makes A thicker (${beforeA.toFixed(2)} -> ${afterA.toFixed(2)})`);
  assert(Math.abs(b.countDist(inA).reduce((x, y) => x + y, 0) - 1) < 1e-9, 'and it is still a distribution');
  assert(b.pEmpty(inB) > 0.99, 'and B now reads as empty');
}

{
  // A sweep that contradicts everything means the belief was wrong, not the
  // sweep. It rebuilds rather than dividing by zero, and says it did.
  const b = fresh(9);
  b.sighting(0, 'car');
  b.sighting(1, 'car');
  b.sighting(2, 'car');
  b.sighting(3, 'car');
  b.sighting(4, 'car');
  const ok = b.cleared(['car']);
  assert(!ok, 'a contradicted belief reports that it rebuilt');
  assert(b.normalize(), 'and is still a valid distribution afterwards');
}

// ---- the corpse constraint --------------------------------------------------

{
  const b = fresh(5);
  // A teammate died somewhere only pit and a_short overlook.
  const overlooks = new Set(['pit', 'a_short']);
  b.deathRecord({ canSeeFrom: (anchor) => overlooks.has(anchor) });

  // Every surviving layout must place SOMEBODY where the shot could have come
  // from. Note what this does not claim: the other four enemies are still free
  // to be anywhere, because a corpse says where the killer was and nothing at
  // all about his teammates.
  for (const p of b.particles) {
    if (p.weight <= 0) continue;
    const someone = p.slots.some((sl) => sl && overlooks.has(sl.anchor));
    assert(someone, 'every surviving layout has a body that had the angle');
  }
  let mass = 0;
  for (const anchor of overlooks) mass += b.massAt(anchor);
  assert(mass > 0.9, `and the overlooking spots carry the mass (${mass.toFixed(2)})`);

  // A spot with no sightline can still hold a body: it just cannot be the one
  // that fired. Asserting otherwise would be asserting a bug.
  const elsewhere = b.massAt('b_site');
  assert(elsewhere > 0, `bodies without the angle are still somewhere (${elsewhere.toFixed(2)})`);
}

{
  // With a weapon class, the constraint is sharper still: only layouts where a
  // body holding THAT gun had the angle survive.
  const b = new JointBelief({
    anchors: ANCHORS,
    rng: new Rng(6),
    weapons: ['ak47', 'awp']
  });
  b.deathRecord({ canSeeFrom: (a) => a === 'pit', weapon: 'awp' });
  assert(b.massAt('pit', 'default', 'awp') > 0.9, 'the AWP is believed to be at pit');
}

// ---- the split, which is the whole point ------------------------------------

{
  const b = fresh(7);
  const h0 = b.splitEntropy(zones);
  assert(h0 > 1, `an unknown split has real entropy (${h0.toFixed(2)} bits)`);

  b.sighting(0, 'b_site');
  b.sighting(1, 'banana');
  b.sighting(2, 'car');
  b.cleared(MID);
  const h1 = b.splitEntropy(zones);
  assert(h1 < h0, `information reduces it (${h0.toFixed(2)} -> ${h1.toFixed(2)})`);

  const modes = b.layoutModes(zones);
  assert(modes.length > 0, 'and there is a most likely layout');
  // Three are SEEN on B, so fewer than three is impossible; the remaining two
  // are unseen and may be anywhere, so the modal layout is three or four.
  const bCount = b.countDist(inB);
  assert(bCount[0] + bCount[1] + bCount[2] < 1e-9, 'fewer than three on B is ruled out');
  assert(bCount[3] + bCount[4] + bCount[5] > 0.99, 'and three or more is certain');
  assert(/B:[345]/.test(modes[0].signature), `the modal layout reflects that (${modes[0].signature})`);
  assert(modes[0].signature.includes('mid:0'), 'and mid is known to be empty');
  assert(modes[0].mass > 0.2, 'with real mass behind it');
}

{
  // pAtMostOne is the read a fast hit is bet on.
  const b = fresh(11);
  b.sighting(0, 'a_site');
  for (let s = 1; s < 5; s += 1) b.sighting(s, 'b_site');
  assert(b.pAtMost(inA, 1) > 0.99, 'one on A, and the team knows it');
  assert(b.pEmpty(inA) < 0.01, 'but A is not empty');
}

// ---- the prior actually biases ----------------------------------------------

{
  const heavyB = new JointBelief({
    anchors: ANCHORS,
    rng: new Rng(13),
    prior: (a) => (inB(a) ? 10 : 1)
  });
  const flat = fresh(13);
  assert(
    heavyB.expected(inB) > flat.expected(inB) + 0.5,
    'a flow prior pulls unseen enemies toward where that side actually stands'
  );
}

// ---- propagation and resampling ---------------------------------------------

{
  const near = { a_site: ['a_short'], a_short: ['a_site', 'mid'], mid: ['a_short', 'car'], car: ['banana', 'mid'], banana: ['car', 'b_site'], b_site: ['banana'], pit: ['a_site'] };
  const neighbours = (a) => near[a] || [];

  const b = fresh(17);
  b.sighting(0, 'b_site');
  const before = b.massAt('b_site');
  for (let i = 0; i < 20; i += 1) b.propagate(neighbours);
  const after = b.massAt('b_site');
  assert(after < before, `an unseen enemy drifts away from a stale sighting (${before.toFixed(2)} -> ${after.toFixed(2)})`);

  // Resampling keeps diversity rather than collapsing onto one layout.
  const b2 = fresh(19);
  b2.heard((a) => (a === 'car' ? 1 : 0.05));
  const essBefore = b2.ess();
  b2.resample(neighbours);
  assert(b2.ess() > essBefore, `resampling restores sample size (${essBefore.toFixed(0)} -> ${b2.ess().toFixed(0)})`);
  const anchors = new Set();
  for (const p of b2.particles) for (const sl of p.slots) if (sl) anchors.add(sl.anchor);
  assert(anchors.size > 1, 'and the set does not collapse to one place');
}

{
  // Sound reweights toward, without collapsing onto.
  const b = fresh(23);
  const before = b.massAt('car');
  b.heard((a) => (a === 'car' ? 1 : 0.1));
  const after = b.massAt('car');
  assert(after > before, `a footstep raises belief where it came from (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  assert(after < 1, 'but never makes it certain');
}

// ---- attention turns the joint into the marginals ---------------------------

{
  // Build a belief with a real COUPLING in it: the enemy is either 3A/2B or
  // 2A/3B, never anything else. The marginals of that are ~2.5 each, and a
  // product of marginals would happily allow 0A/5B, which the joint does not.
  const b = fresh(29);
  b.particles = [];
  for (let i = 0; i < 256; i += 1) {
    const threeA = i % 2 === 0;
    b.particles.push({
      slots: [
        { anchor: 'a_site', level: 'default', weapon: 'ak47' },
        { anchor: 'a_short', level: 'default', weapon: 'ak47' },
        { anchor: threeA ? 'pit' : 'car', level: 'default', weapon: 'ak47' },
        { anchor: 'b_site', level: 'default', weapon: 'ak47' },
        { anchor: 'banana', level: 'default', weapon: 'ak47' }
      ],
      weight: 1 / 256
    });
  }

  const d = b.countDist(inA);
  assert(Math.abs(d[2] - 0.5) < 0.01 && Math.abs(d[3] - 0.5) < 0.01, 'the joint knows it is 3-2 or 2-3');
  assert(d[0] === 0 && d[5] === 0, 'and that nothing else is possible');
  assert(b.splitEntropy(zones) < 1.1, 'so the split is nearly resolved');

  // A bot attending every slot sees that structure.
  const sharp = personalView(b, [0, 1, 2, 3, 4]);
  assert(sharp.attended.size === 5, 'a high-attention bot keeps the joint');

  // A bot attending one slot has thrown the coupling away for the rest: it can
  // tell you the marginal mass of slot 2 being at pit, and nothing about how
  // that relates to slot 3.
  const dull = personalView(b, [0]);
  const atPit = dull.marginalAt(2, 'pit');
  const atCar = dull.marginalAt(2, 'car');
  assert(Math.abs(atPit - 0.5) < 0.02, `the marginal survives (${atPit.toFixed(2)})`);
  assert(Math.abs(atCar - 0.5) < 0.02, 'in both directions');
  assert(dull.marginalAt(0, 'a_site') === 0, 'while attended slots are not in the marginal table at all');
}

console.log('knowledge: ok');
