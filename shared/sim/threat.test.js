// Run: node shared/sim/threat.test.js
//
// SIM-PLAN 19.3. The properties that make a typed threat field worth reading:
//
//   threat is a per-LAYOUT indicator, so one hypothesis holding two angles
//     onto a spot counts once — the thing a per-anchor mass sum gets wrong
//   the class channels separate: the AWP field and the rifle field disagree,
//     which is the entire point of typing threat at all
//   the candidate set is capped, because the field is priced inside 6.7's
//     machine budget rather than surveying the map
//   the NEGATIVE read is exact and sharp: clearing two of four candidate
//     spots doubles the leading hypothesis and buys exactly one bit
//   nothing here mutates the belief, and the ear is a likelihood the caller
//     applies rather than a fact this module writes into the filter
//
// Synthetic throughout: a hand-built particle set and a four-spot fake
// catalogue, so every number below is arithmetic rather than a map bake.

import { JointBelief } from './knowledge.js';
import { Rng } from './rng.js';
import { SOUND, emit, perceive, shotReport, heardShot, RANGE_BAND } from './sound.js';
import {
  DEFAULT_SPOT_CAP,
  SNIPER_CLASS,
  awpThreat,
  buildClassIndex,
  concentration,
  gunshotLikelihood,
  shotEvidence,
  sniperMass,
  threatField
} from './threat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- a four-spot world ------------------------------------------------------
//
// Enemy anchors: pit, apps, mid, car, banana. My candidate spots and who
// overlooks them: `long` is the double-covered angle, `quiet` is off the map.

const ANCHORS = ['pit', 'apps', 'mid', 'car', 'banana'];
const DEPTH = { pit: 2400, apps: 700, mid: 1900, car: 900, banana: 1500 };

const SPOTS = [
  { id: 'long', x: 0, y: 0 },
  { id: 'short', x: 100, y: 0 },
  { id: 'ct', x: 200, y: 0 },
  { id: 'quiet', x: 300, y: 0 }
];
const EXPOSURE = {
  long: ['pit', 'apps'],
  short: ['apps'],
  ct: ['mid'],
  quiet: []
};

const catalogue = {
  exposedTo(x, y) {
    const spot = SPOTS.find((s) => s.x === x && s.y === y);
    if (!spot) return [];
    // Two yaws per anchor: an anchor that overlooks a spot from several
    // sectors must still be one visit and one hypothesis.
    return (EXPOSURE[spot.id] || []).flatMap((anchor, i) => [
      { index: i * 2, anchor, level: 'default', yaw: 0 },
      { index: i * 2 + 1, anchor, level: 'default', yaw: 90 }
    ]);
  },
  depthAt(anchor) {
    return DEPTH[anchor] || 0;
  }
};

/** A belief whose particles are built by hand, so the answers are exact. */
function mk(slotsFor, seed = 7) {
  const b = new JointBelief({
    anchors: ANCHORS,
    rng: new Rng(seed),
    weapons: ['ak47', 'awp']
  });
  b.particles = [];
  for (let i = 0; i < b.count; i += 1) b.particles.push({ slots: slotsFor(i), weight: 1 / b.count });
  return b;
}

const at = (anchor, weapon) => ({ anchor, level: 'default', weapon });

// ---- threat counts LAYOUTS, not angles --------------------------------------

{
  // Every layout: two AWPs, on the two anchors that both overlook `long`.
  const b = mk(() => [at('pit', 'awp'), at('apps', 'awp'), null, null, null]);
  const f = threatField({ belief: b, catalogue, spots: SPOTS });

  assert(near(awpThreat(f, 0), 1), `two angles, one hypothesis, one unit of threat (${awpThreat(f, 0)})`);
  assert(f.rows[0].anchors === 2, 'and the two anchors were visited once each, not once per yaw');
  assert(near(f.at(SPOTS[0], SNIPER_CLASS), 1), 'the row is reachable by the spot object too');
  assert(near(f.at(0), 1), 'and the untyped total agrees');
  assert(near(awpThreat(f, 3), 0), 'ground nobody overlooks is free');
  assert(f.aliveMass(SNIPER_CLASS) >= awpThreat(f, 0), 'threat never exceeds the mass that could cause it');
}

// ---- the class channels separate --------------------------------------------

{
  // The AWP holds pit; the rifle holds mid. Two spots, two completely
  // different answers, and the untyped field cannot tell them apart.
  const b = mk(() => [at('pit', 'awp'), at('mid', 'ak47'), null, null, null]);
  const f = threatField({ belief: b, catalogue, spots: SPOTS });

  assert(near(awpThreat(f, 0), 1), 'the long angle is an AWP angle');
  assert(near(f.at(0, 'rifle'), 0), 'and no rifle can touch it');
  assert(near(awpThreat(f, 2), 0), 'the CT spot is not an AWP angle');
  assert(near(f.at(2, 'rifle'), 1), 'it is a rifle angle held at rifle depth');
  assert(near(f.at(1, 'rifle'), 0) && near(awpThreat(f, 1), 0), 'and short is nobody');
  assert(f.classes.includes('rifle') && f.classes.includes(SNIPER_CLASS), 'both classes are live');

  const only = threatField({ belief: b, catalogue, spots: SPOTS, classes: [SNIPER_CLASS] });
  assert(only.rows[0].byClass.rifle === undefined, 'a caller can ask for one channel');
  assert(near(awpThreat(only, 0), 1), 'and still get it');
}

// ---- the candidate set is capped (6.7's budget) ------------------------------

{
  const b = mk(() => [at('pit', 'awp'), null, null, null, null]);
  const many = [];
  for (let i = 0; i < 20; i += 1) many.push({ id: 'x', x: 9000 + i, y: 0 });
  const f = threatField({ belief: b, catalogue, spots: many });
  assert(DEFAULT_SPOT_CAP === 8, 'the default is the plan\'s eight');
  assert(f.spots.length === 8, `and the field priced eight of twenty (${f.spots.length})`);
  const wide = threatField({ belief: b, catalogue, spots: many, cap: 12 });
  assert(wide.spots.length === 12, 'widening it costs the same currency, so it is a parameter');
}

// ---- the negative read is the valuable one -----------------------------------

{
  // The AWP is on one of four spots, a quarter each. The riflers are parked
  // somewhere else so the arithmetic is only about him.
  const b = mk((i) => [
    at(['pit', 'apps', 'mid', 'car'][i % 4], 'awp'),
    at('banana', 'ak47'),
    null,
    null,
    null
  ]);

  const mass = sniperMass(b, catalogue);
  assert(near(mass.total, 1), 'a sniper is believed alive');
  assert(mass.ranked.length === 4, 'across four candidate spots');
  for (const r of mass.ranked) assert(near(r.share, 0.25), `each holding a quarter (${r.share})`);
  assert(mass.ranked.every((r) => r.depth === DEPTH[r.anchor]), 'ranked rows carry the catalogue depth');

  // Sweep two of them and find nothing. Nothing was seen; the read is sharper
  // anyway, which is the most human inference in the document.
  const c = concentration({ belief: b, cleared: ['pit', 'apps'], catalogue });
  assert(!c.contradicted, 'the sweep is consistent with the belief');
  assert(near(c.surviving, 0.5), `half the layouts survive it (${c.surviving})`);
  assert(near(c.total, 1), 'he is still alive, he is just not there');
  assert(c.after.length === 2, 'and he is in one of the two spots left');
  assert(near(c.top.share, 0.5), `which doubles the leading hypothesis (${c.top.share})`);
  assert(near(c.gain, 2), `stated as a gain (${c.gain})`);
  assert(near(c.bits, 1), `clearing half the candidates buys exactly one bit (${c.bits})`);
  assert(c.before.length === 4, 'and the before picture is kept for comparison');

  // Three of six is the plan's example, and it concentrates enormously: the
  // same sweep run to the end leaves one hypothesis standing.
  const last = concentration({ belief: b, cleared: ['pit', 'apps', 'mid'], catalogue });
  assert(last.after.length === 1 && last.after[0].anchor === 'car', 'clear three of four and he is on the fourth');
  assert(near(last.top.share, 1), 'with no doubt left in the class marginal');
  assert(near(last.bits, 2), 'and the whole two bits collected');

  // Sweeping everywhere contradicts the belief. knowledge.js rebuilds; a read
  // cannot rebuild anything, so it says it has nothing to say.
  const nothing = concentration({ belief: b, cleared: ANCHORS, catalogue });
  assert(nothing.contradicted, 'a sweep that empties the map is a contradiction, not a read');
  assert(nothing.top === null && nothing.gain === 1, 'and reports nothing rather than dividing by zero');
}

{
  // The sweep is the JOINT one: clearing ground deletes layouts that put
  // ANYBODY there, so a rifler standing on a swept anchor takes the AWP
  // hypotheses that travelled with him. `sweepClass` asks the weaker question
  // a sighting answers ("that was a rifler, so it is not the AWP").
  //
  //   quarter 0: AWP pit,  rifle car      dies to both readings
  //   quarter 1: AWP mid,  rifle pit      dies only to the honest sweep
  //   quarter 2: AWP mid,  rifle car      survives
  //   quarter 3: AWP car,  rifle banana   survives
  const layouts = [
    ['pit', 'car'],
    ['mid', 'pit'],
    ['mid', 'car'],
    ['car', 'banana']
  ];
  const b = mk((i) => [at(layouts[i % 4][0], 'awp'), at(layouts[i % 4][1], 'ak47'), null, null, null]);

  const joint = concentration({ belief: b, cleared: ['pit'] });
  const soft = concentration({ belief: b, cleared: ['pit'], sweepClass: SNIPER_CLASS });
  const mass = (c, anchor) => c.after.find((r) => r.anchor === anchor)?.mass ?? 0;

  assert(near(joint.surviving, 0.5), `an empty pit kills every layout that put anybody there (${joint.surviving})`);
  assert(near(soft.surviving, 0.75), `ruling out only the AWP kills fewer (${soft.surviving})`);
  assert(near(mass(joint, 'mid'), 0.5) && near(mass(joint, 'car'), 0.5), 'and leaves mid and car level');
  assert(near(mass(soft, 'mid'), 2 / 3), `while the weaker claim leaves mid ahead (${mass(soft, 'mid')})`);
  // The coupling a product of marginals cannot represent: the STRONGER sweep
  // says LESS about mid, because the layout it deleted was one that had the
  // AWP there and the rifler on the swept anchor.
  assert(mass(soft, 'mid') > mass(joint, 'mid'), 'the two sweeps are genuinely different reads');
}

// ---- nothing in here writes to the belief ------------------------------------

{
  const b = mk((i) => [at(['pit', 'apps', 'mid', 'car'][i % 4], 'awp'), at('banana', 'ak47'), null, null, null]);
  const before = JSON.stringify(b.particles);
  const index = buildClassIndex(b);

  threatField({ index, catalogue, spots: SPOTS });
  sniperMass(b, catalogue, { index });
  concentration({ index, cleared: ['pit', 'mid'] });
  gunshotLikelihood({ percept: null });

  assert(JSON.stringify(b.particles) === before, 'the belief is untouched: a read is not an update');
  // And the shared index is what makes that cheap: one pass, every bot.
  const f1 = threatField({ index, catalogue, spots: SPOTS });
  const f2 = threatField({ index, catalogue, spots: [SPOTS[2]] });
  assert(near(f1.at(2, 'rifle'), f2.at(0, 'rifle')), 'two bots reading one index agree');
}

// ---- the ear: a claim, a confusion matrix, and a likelihood -------------------

{
  for (const w of ['awp', 'ak47', 'galilar', 'm4a1', 'p90', 'nova']) {
    const row = shotReport(w, RANGE_BAND.MID);
    const sum = Object.values(row).reduce((a, x) => a + x, 0);
    assert(near(sum, 1, 1e-12), `${w}'s row is a distribution (${sum})`);
  }
  assert(shotReport('awp', RANGE_BAND.CLOSE).awp > 0.95, 'an AWP is unmistakable');
  assert(
    shotReport('ak47', RANGE_BAND.FAR).ak47 < shotReport('ak47', RANGE_BAND.CLOSE).ak47,
    'range costs identification'
  );
  assert(heardShot('awp', RANGE_BAND.CLOSE) === 'awp', 'with no rng the claim is the modal one');
  assert(heardShot(null, RANGE_BAND.CLOSE) === null, 'and a sound with no gun makes no claim');

  // With an rng the ear is sometimes plainly wrong, deterministically so.
  const rng = new Rng(11);
  const drawn = new Set();
  for (let i = 0; i < 200; i += 1) drawn.add(heardShot('galilar', RANGE_BAND.FAR, rng));
  assert(drawn.has('ak47'), 'a Galil gets called an AK');
  assert(drawn.has('galilar'), 'and sometimes gets called a Galil');
}

{
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  const listener = { x: 0, y: 0, level: 'default', slot: 0, side: 'T' };
  const shot = (weapon) =>
    perceive(
      emit({
        type: SOUND.GUNSHOT,
        x: 500,
        y: 0,
        level: 'default',
        slot: 3,
        side: 'CT',
        tick: 64,
        weapon
      }),
      listener,
      dist
    );

  const awpShot = shot('awp');
  assert(awpShot.weaponClass === 'sniper', 'the percept carries a canonical class');
  assert(awpShot.weaponHeard === 'awp', 'and names the gun when a player would');
  assert(awpShot.x === undefined && awpShot.y === undefined, 'and never a position');
  assert(awpShot.sector >= 0 && awpShot.sector < 8, 'still eight-way');
  assert(shot(null).weaponClass === null, 'a shot from an unknown gun claims nothing');

  const POOL = ['ak47', 'galilar', 'm4a1', 'awp'];
  assert(near(shotEvidence(awpShot, 'awp', { weapons: POOL }), 1), 'hearing an AWP is nearly proof');
  assert(
    shotEvidence(awpShot, 'ak47', { weapons: POOL }) < 0.1,
    'and is proof the rifle hypotheses are wrong'
  );

  // The two asymmetries the plan names.
  const akShot = shot('ak47');
  const galil = shotEvidence(akShot, 'galilar', { weapons: POOL });
  const m4 = shotEvidence(akShot, 'm4a1', { weapons: POOL });
  const awp = shotEvidence(akShot, 'awp', { weapons: POOL });
  assert(galil > 0.4, `a Galil and an AK are hard to tell apart (${galil.toFixed(2)})`);
  assert(m4 < 0.15, `an AK and an M4 are not (${m4.toFixed(2)})`);
  assert(galil > 4 * m4, 'and the gap between those two facts is the whole read');
  assert(awp <= m4, 'an AWP sounds like nothing else at all');
}

{
  // The likelihood is returned, not applied. The caller hands it to heard().
  const b = mk((i) => [at(i % 2 === 0 ? 'pit' : 'car', 'awp'), at('mid', 'ak47'), null, null, null]);
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  const percept = perceive(
    emit({ type: SOUND.GUNSHOT, x: 400, y: 0, level: 'default', slot: 3, side: 'CT', tick: 64, weapon: 'awp' }),
    { x: 0, y: 0, level: 'default', slot: 0, side: 'T' },
    dist
  );

  const geometry = (anchor) => (anchor === 'pit' ? 1 : 0.1);
  const lik = gunshotLikelihood({ percept, geometry, weapons: b.weapons });

  // The arity seam: heard() calls likelihood(anchor, level) today, so the
  // weapon term is absent and the function degrades to geometry rather than
  // crashing or lying.
  assert(near(lik('pit', 'default'), 1), 'geometry alone still answers');
  assert(near(lik('car', 'default'), 0.1), 'in both directions');
  assert(lik('pit', 'default', 'awp') > 10 * lik('pit', 'default', 'ak47'), 'and the weapon sharpens it an order of magnitude');

  const before = b.massAt('pit');
  b.heard(lik);
  const after = b.massAt('pit');
  assert(after > before, `the reweight is usable as-is (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  assert(after < 1, 'and reweights rather than collapsing');
  assert(near(b.particles.reduce((s, p) => s + p.weight, 0), 1, 1e-9), 'the belief is still a distribution');
}

console.log('threat: ok');
