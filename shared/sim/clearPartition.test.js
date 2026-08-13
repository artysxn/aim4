// Run: node shared/sim/clearPartition.test.js
//
// The clear partition (SIM-PLAN 19.5). What has to hold:
//
//   the first man pre-aims the highest-mass angle and NOTHING ELSE
//   that angle goes to the earliest-arriving CAPABLE body, not just the first
//   uncovered mass is exactly the mass nobody was assigned: the honest price
//   one body fewer raises that price, which is man-down execution for free
//   an angle worth nothing is not worth a crosshair
//   the arrival penalty makes the pack pre-aim in the order it walks
//   the same input gives the same partition twice, exact ties included
//   post-round, covered means a duel was lost and uncovered means we were wrong
//   the same solver derives the execute's utility order (20.13)

import {
  MAX_PARTITION_ANGLES,
  angleFor,
  assignAtMostOne,
  clearPartition,
  gradeEntry,
  manDown,
  massFromBelief,
  pTradedFromGeometry
} from './clearPartition.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const shape = (p) => p.assignment.map((a) => `${a.slot}:${a.key}`).join(' ');

// A B-site entry: four angles down the corridor, three bodies strung out
// behind each other. Quad is empty ground, which the floor should notice.
const ANGLE_MASS = { car: 0.5, ct: 0.3, dark: 0.12, quad: 0 };
const angles = () => [
  { anchor: 'car', level: 'default', opensAt: 1 },
  { anchor: 'ct', level: 'default', opensAt: 2 },
  { anchor: 'dark', level: 'default', opensAt: 3 },
  { anchor: 'quad', level: 'default', opensAt: 4 }
];
const mass = (a) => ANGLE_MASS[a.anchor] ?? 0;
const pack = () => [
  { slot: 0, arrival: 1, pos: { x: 0, y: 0 } },
  { slot: 1, arrival: 2, pos: { x: -100, y: 0 } },
  { slot: 2, arrival: 3, pos: { x: -200, y: 0 } }
];
const base = (over = {}) => ({
  angles: angles(),
  bodies: pack(),
  mass,
  pWin: () => 0.6,
  pTraded: () => 0.8,
  arrival: () => 0,
  ...over
});

// ---- one body, one slice ----------------------------------------------------

{
  const p = clearPartition(base());

  const slots = p.assignment.map((a) => a.slot);
  assert(slots.length === 3, `three bodies took three angles (${slots.length})`);
  assert(new Set(slots).size === slots.length, 'a body is never assigned two angles');
  const keys = p.assignment.map((a) => a.key);
  assert(new Set(keys).size === keys.length, 'and an angle is never handed to two bodies');

  assert(angleFor(p, 0).label === 'car', `the first man takes the highest mass (${shape(p)})`);
  assert(angleFor(p, 1).label === 'ct', 'the second takes the second');
  assert(angleFor(p, 2).label === 'dark', 'and the third the third');

  const quad = p.dropped.find((d) => d.label === 'quad');
  assert(quad && quad.why === 'floor', 'empty ground never reaches the solver');
  assert(!p.assignment.some((a) => a.label === 'quad'), 'and nobody pre-aims it');

  assert(p.uncovered.length === 0 && p.uncoveredMass === 0, 'three angles, three bodies, no price');
  assert(close(p.coveredMass, 0.92), `covered mass is the read (${p.coveredMass})`);
  assert(p.flashTarget === null, 'nothing to ask a teammate for');
  assert(typeof p.motive === 'string' && p.motive.includes('3 of 3'), `and it says why: ${p.motive}`);
  assert(!p.motive.includes('—'), 'motive strings carry no em dashes');

  const row = angleFor(p, 0);
  assert(
    close(row.cover, 0.5 * 0.6 * 0.8) && close(row.value, row.cover - row.penalty),
    'the row carries its own arithmetic: mass x win x trade, less the mismatch'
  );
  assert(row.motive.includes('car') && row.motive.includes('0.50'), `per-body motive: ${row.motive}`);
}

// ---- the earliest CAPABLE body ----------------------------------------------

{
  // The first man cannot win at car (he arrives into it at a dead sprint).
  const p = clearPartition(
    base({ pWin: (body, angle) => (body.slot === 0 && angle.anchor === 'car' ? 0 : 0.6) })
  );
  assert(angleFor(p, 1).label === 'car', `car goes to the earliest capable body (${shape(p)})`);
  assert(angleFor(p, 0).label === 'ct', 'and the first man takes the best angle left to him');
  assert(p.uncovered.length === 0, 'the breadth is still covered');
}

// ---- the honest price -------------------------------------------------------

{
  const two = clearPartition(base({ bodies: pack().slice(0, 2) }));
  assert(two.assignment.length === 2, 'two bodies take two angles');
  assert(two.uncovered.length === 1 && two.uncovered[0].label === 'dark', 'dark is left open');
  assert(close(two.uncoveredMass, ANGLE_MASS.dark), 'the price is exactly the unassigned mass');
  assert(
    close(two.uncoveredMass, two.consideredMass - two.coveredMass),
    'and the books balance: considered = covered + uncovered'
  );
  assert(two.flashTarget.label === 'dark', 'the flash request has its target (19.6)');
  assert(two.motive.includes('dark'), `the motive names the open angle: ${two.motive}`);
}

// ---- man-down execution, for free -------------------------------------------

{
  const down = manDown(base(), 2);
  assert(down.before.uncoveredMass === 0, 'five up, nothing open');
  assert(close(down.after.uncoveredMass, ANGLE_MASS.dark), 'one down, dark opens');
  assert(down.addedMass > 0, `fewer bodies raises the price (+${down.addedMass})`);
  assert(down.after.assignment.length === 2, 'and the pack re-solves rather than re-scripting');
  assert(down.motive.includes('slot 2'), `with a sentence attached: ${down.motive}`);

  const twoDown = manDown(base(), [1, 2]);
  assert(
    twoDown.after.uncoveredMass > down.after.uncoveredMass,
    'two down raises it further, monotonically'
  );
  assert(
    close(twoDown.after.uncoveredMass, ANGLE_MASS.ct + ANGLE_MASS.dark),
    'to exactly what the missing bodies were holding'
  );
}

// ---- an angle worth nothing is not worth covering ---------------------------

{
  // Floor at zero forces quad all the way to the solver, which refuses it.
  const p = clearPartition(
    base({ massFloor: 0, bodies: [...pack(), { slot: 3, arrival: 4, pos: { x: -300, y: 0 } }] })
  );
  assert(p.assignment.length === 3, 'the fourth body is not given a worthless angle');
  assert(!p.assignment.some((a) => a.label === 'quad'), 'quad stays uncovered');
  assert(p.idle.includes(3), 'the spare body is free for the plant or the trade');
  assert(p.uncoveredMass === 0, 'and an angle worth nothing costs nothing to leave open');

  // Same refusal when the body simply cannot win there: value, not mass, decides.
  const hopeless = clearPartition(base({ bodies: pack().slice(0, 1), pWin: () => 0 }));
  assert(hopeless.assignment.length === 0, 'a body who wins nowhere pre-aims nothing');
  assert(close(hopeless.uncoveredMass, 0.92), 'and the whole read is the price');
}

// ---- arrival mismatch -------------------------------------------------------

{
  // Far carries more mass but opens five seconds later than near.
  const timed = (over = {}) => ({
    angles: [
      { id: 'near', anchor: 'near', opensAt: 1 },
      { id: 'far', anchor: 'far', opensAt: 6 }
    ],
    bodies: [
      { slot: 0, arrival: 1 },
      { slot: 1, arrival: 6 }
    ],
    mass: (a) => (a.id === 'far' ? 0.4 : 0.35),
    ...over
  });

  const free = clearPartition(timed({ arrivalWeight: 0 }));
  assert(angleFor(free, 0).label === 'far', 'unpriced, the first man reaches for the fat angle');

  const priced = clearPartition(timed());
  assert(angleFor(priced, 0).label === 'near', `priced, he takes the angle he walks into first (${shape(priced)})`);
  assert(angleFor(priced, 1).label === 'far', 'and the late body holds the late angle');
  assert(priced.uncoveredMass === 0, 'the breadth is covered either way, in the right order');
}

// ---- determinism ------------------------------------------------------------

{
  const a = clearPartition(base());
  const b = clearPartition(base());
  assert(shape(a) === shape(b), 'same input, same partition');

  // Every angle equally likely: nothing but the tie-break decides.
  const flat = () => clearPartition(base({ mass: () => 0.3, angles: angles() }));
  const t1 = flat();
  const t2 = flat();
  assert(shape(t1) === shape(t2), `an exact tie resolves the same way twice (${shape(t1)})`);
  assert(
    angleFor(t1, 0).label === 'car' && angleFor(t1, 1).label === 'ct' && angleFor(t1, 2).label === 'dark',
    `and it resolves down the corridor, in order (${shape(t1)})`
  );
}

// ---- one anchor is one hypothesis -------------------------------------------

{
  // Two yaw sectors of car overlook the corridor. That is one enemy, not two.
  const p = clearPartition(
    base({
      bodies: [],
      angles: [
        { anchor: 'car', level: 'default', yaw: 0, opensAt: 2 },
        { anchor: 'car', level: 'default', yaw: 90, opensAt: 1 }
      ]
    })
  );
  assert(p.uncovered.length === 1, 'the two sectors collapse to one angle');
  assert(close(p.uncoveredMass, ANGLE_MASS.car), 'and its mass is counted once');
  assert(p.uncovered[0].opensAt === 1, 'kept at the moment it first opens');
}

// ---- the cap ----------------------------------------------------------------

{
  const many = [];
  for (let i = 0; i < 20; i += 1) many.push({ id: `a${i}`, opensAt: i });
  const p = clearPartition(
    base({ angles: many, bodies: pack().slice(0, 1), mass: (a) => 0.5 - Number(a.id.slice(1)) * 0.01 })
  );
  assert(
    p.assignment.length + p.uncovered.length === MAX_PARTITION_ANGLES,
    `the considered set is capped at ${MAX_PARTITION_ANGLES}`
  );
  assert(
    p.dropped.filter((d) => d.why === 'cap').length === 20 - MAX_PARTITION_ANGLES,
    'the rest are reported, not silently lost'
  );
  assert(p.droppedMass > 0, 'their mass is real and it is stated');
  assert(angleFor(p, 0).label === 'a0', 'and the one body still takes the fattest angle');
}

// ---- the post-round grade ---------------------------------------------------

{
  const p = clearPartition(base({ bodies: pack().slice(0, 2) }));

  const duel = gradeEntry(p, { anchor: 'car', level: 'default' });
  assert(duel.verdict === 'covered' && duel.blame === 'duel', 'covered: the read was right');
  assert(duel.slot === 0 && duel.line.includes('lost the duel'), `${duel.line}`);

  const partition = gradeEntry(p, { anchor: 'dark', level: 'default' });
  assert(
    partition.verdict === 'uncovered' && partition.blame === 'partition',
    'uncovered: we saw it, priced it, and went anyway'
  );
  assert(close(partition.mass, ANGLE_MASS.dark), 'the grade carries what it cost');

  const cut = gradeEntry(p, { anchor: 'quad', level: 'default' });
  assert(cut.verdict === 'unconsidered' && cut.blame === 'read', 'below the floor blames the read');
  assert(cut.line.includes('floor'), `${cut.line}`);

  const nowhere = gradeEntry(p, { anchor: 'balcony', level: 'default' });
  assert(nowhere.verdict === 'unconsidered' && nowhere.mass === 0, 'and so does off the map entirely');
}

// ---- adapters ---------------------------------------------------------------

{
  const belief = {
    massAt: (anchor, level, weaponClass) =>
      weaponClass === 'awp' ? (anchor === 'car' ? 0.4 : 0) : 0.2
  };
  assert(massFromBelief(belief, 'awp')({ anchor: 'car' }) === 0.4, 'typed threat reads the AWP field');
  assert(massFromBelief(belief)({ anchor: 'car' }) === 0.2, 'untyped reads the whole team');

  const me = { slot: 0, pos: { x: 0, y: 0 } };
  const mate = { slot: 1, pos: { x: 50, y: 0 } };
  const ctx = { bodies: [me, mate] };
  const angle = { anchor: 'car' };
  const spotOf = () => ({ x: 1000, y: 0 });

  const held = pTradedFromGeometry({ spotOf, canSee: () => true })(me, angle, ctx);
  const reachable = pTradedFromGeometry({
    spotOf,
    canSee: () => false,
    travelSeconds: () => 1
  })(me, angle, ctx);
  const alone = pTradedFromGeometry({ spotOf, canSee: () => false })(me, angle, ctx);
  assert(held > reachable && reachable > alone, `line beats reach beats nothing (${held}, ${reachable}, ${alone})`);
  assert(alone > 0, 'an untraded death still takes the angle off the table for a moment');
}

// ---- the same solver, on the execute (20.13) --------------------------------

{
  // Chapter 16's B execute, derived rather than memorized: the molly wants the
  // second man, the smoke the third, the flash the fourth, and the first man
  // carries nothing because he is first contact.
  const line = [
    { id: 'first', line: 1 },
    { id: 'second', line: 2 },
    { id: 'third', line: 3 },
    { id: 'fourth', line: 4 }
  ];
  const jobs = [
    { job: 'molotov', wants: 2 },
    { job: 'smoke', wants: 3 },
    { job: 'flash', wants: 4 }
  ];
  const fit = (b, j) => 1 / (1 + Math.abs(b.line - j.wants));

  const solved = assignAtMostOne({ rows: line, cols: jobs, valueOf: fit });
  const who = Object.fromEntries(solved.pairs.map((p) => [p.col.job, p.row.id]));
  assert(
    who.molotov === 'second' && who.smoke === 'third' && who.flash === 'fourth',
    `the order falls out of the costs (${JSON.stringify(who)})`
  );
  assert(solved.idleRows.length === 1 && line[solved.idleRows[0]].id === 'first', 'and the entry holds');

  // A missing grenade changes the matrix rather than invalidating the script.
  const short = assignAtMostOne({
    rows: line,
    cols: jobs,
    valueOf: (b, j) => (b.id === 'third' && j.job === 'smoke' ? -Infinity : fit(b, j))
  });
  const who2 = Object.fromEntries(short.pairs.map((p) => [p.col.job, p.row.id]));
  assert(who2.smoke !== 'third', 'nobody throws what he does not hold');
  // Second and fourth are worth more where they already are, so the repair is
  // the first man picking the smoke up at a worse fit. A worse execute, still
  // an execute: the matrix changed, the script did not have to.
  assert(who2.smoke === 'first', `somebody else picks it up (${who2.smoke})`);
  assert(who2.molotov === 'second' && who2.flash === 'fourth', 'the rest of the order survives');
  const rows = short.pairs.map((p) => p.row.id);
  assert(new Set(rows).size === rows.length, 'and still at most one job each');
}

console.log('clearPartition: ok');
