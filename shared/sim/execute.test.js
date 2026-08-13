// Run: node shared/sim/execute.test.js
//
// SIM-PLAN 19.10 (the repair ladder) and 20.13 (assignment is derived).
// What has to hold:
//
//   full means is tier 1
//   a named lineup gone but a smoke in the pocket is tier 2
//   no deny-sight nade at all is tier 3 or 4
//   assignExecute is deterministic
//   removing a smoke changes the assignment (chapter 16)
//
// HAS_NADE_SCORE and friends are `[calibrate]`. The tests never assert them.

import { NADE } from './grenades.js';
import {
  BODY_SUBSTITUTES_FLASH,
  EFFECT,
  NADE_BY_EFFECT,
  assignExecute,
  assignmentChangesWhenNadeMissing,
  executeTemplate,
  repairLadder
} from './execute.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const sig = (a) => a.pairs.map((p) => `${p.row.slot}:${p.col.id}`).sort().join(' ');

const aExec = (over = {}) =>
  executeTemplate({
    id: 'inf-a-exec',
    map: 'de_inferno',
    side: 'T',
    call: 'a-execute',
    anchor: 's3.detonate',
    steps: [
      {
        id: 's1',
        effect: EFFECT.DENY_SIGHT,
        from: 'library',
        to: 'apps-exit',
        means: ['inf_smoke_lib_1', 'inf_smoke_lib_2'],
        window: [-3, 14],
        actor: 'role:2ndMid'
      },
      {
        id: 's2',
        effect: EFFECT.GRANT_EXPOSURE,
        at: 'pit',
        means: ['inf_flash_pit_1'],
        window: [-0.4, 2],
        actor: 'role:Banana',
        requires: ['s1']
      },
      {
        id: 's3',
        effect: EFFECT.DELIVER,
        to: ['apps-exit', 'short'],
        means: [],
        window: [0, 1.6],
        actor: 'core:pack',
        requires: ['s2']
      }
    ],
    ...over
  });

// ---- tier 1: every means still in the pocket --------------------------------

{
  const r = repairLadder({
    template: aExec(),
    availableMeans: new Set(['inf_smoke_lib_1', 'inf_flash_pit_1']),
    availableNades: [NADE.SMOKE, NADE.FLASH],
    bodies: 5
  });
  assert(r.tier === 1, `full means is tier 1 (got ${r.tier})`);
  assert(r.steps.length === 3, 'the DAG is intact');
  assert(r.motive.includes('run it'), `motive: ${r.motive}`);
  assert(!r.motive.includes('—'), 'motive strings carry no em dashes');
}

{
  // Empty means is geometry-only: deliverBodies needs no nade.
  const onlyDeliver = executeTemplate({
    call: 'walk-on',
    steps: [{ id: 's1', effect: EFFECT.DELIVER, means: [] }]
  });
  const r = repairLadder({ template: onlyDeliver, availableMeans: new Set(), availableNades: [], bodies: 3 });
  assert(r.tier === 1, 'geometry-only is tier 1');
}

// ---- tier 2: the lineup is gone, the effect is not --------------------------

{
  const r = repairLadder({
    template: aExec(),
    availableMeans: new Set(),
    availableNades: [NADE.SMOKE, NADE.FLASH],
    bodies: 5
  });
  assert(r.tier === 2, `a smoke in the pocket substitutes the missing lineup (got ${r.tier})`);
  const smoke = r.steps.find((s) => s.id === 's1');
  assert(smoke.substitute === NADE.SMOKE, 'denySightline substitutes the preferred nade');
  assert(NADE_BY_EFFECT[EFFECT.DENY_SIGHT][0] === NADE.SMOKE, 'smoke is the preferred deny');
  assert(r.motive.includes('substitute'), `motive: ${r.motive}`);
}

{
  // Molotov stands in for a smoke: same effect, next nade on the list.
  const r = repairLadder({
    template: aExec(),
    availableMeans: new Set(['inf_flash_pit_1']),
    availableNades: [NADE.MOLOTOV, NADE.FLASH],
    bodies: 5
  });
  assert(r.tier === 2, 'a molotov still denies the sightline');
  assert(r.steps.find((s) => s.id === 's1').substitute === NADE.MOLOTOV, 'second preference');
}

{
  assert(BODY_SUBSTITUTES_FLASH, 'the doctrine flag is on');
  const r = repairLadder({
    template: aExec(),
    availableMeans: new Set(['inf_smoke_lib_1']),
    availableNades: [NADE.SMOKE],
    bodies: 4
  });
  assert(r.tier === 2, 'no flash, but a body can eat the angle');
  assert(r.steps.find((s) => s.id === 's2').substitute === 'body', 'grantExposure substitutes a body');
}

// ---- tier 3 or 4: the effect cannot be produced -----------------------------

{
  const r = repairLadder({
    template: aExec(),
    availableMeans: new Set(),
    availableNades: [NADE.FLASH],
    bodies: 5
  });
  assert(r.tier === 3 || r.tier === 4, `no deny-sight nade is tier 3 or 4 (got ${r.tier})`);
  if (r.tier === 3) {
    assert(r.retrieve.call === 'a-execute', 'tier 3 names the call to retrieve against');
    assert(r.retrieve.missing.includes(NADE.SMOKE), 'and names the missing resource');
  } else {
    assert(r.improvise, 'tier 4 hands the goal to the option layer');
    assert(Array.isArray(r.goal), 'with the remaining effects');
  }
}

{
  // No call to retrieve against: improvise.
  const nameless = executeTemplate({
    steps: [{ id: 's1', effect: EFFECT.DENY_SIGHT, means: ['some_smoke'] }]
  });
  const r = repairLadder({
    template: nameless,
    availableMeans: new Set(),
    availableNades: [],
    bodies: 2
  });
  assert(r.tier === 4 && r.improvise, 'nothing to retrieve, so improvise');
}

// ---- assignExecute is deterministic -----------------------------------------

{
  const steps = [
    { id: 'smoke', effect: EFFECT.DENY_SIGHT, from: { x: 0, y: 0 }, actor: 'role:support' },
    { id: 'flash', effect: EFFECT.GRANT_EXPOSURE, from: { x: 400, y: 0 }, actor: 'role:entry' }
  ];
  const bodies = [
    { slot: 0, x: 10, y: 0, grenades: [NADE.SMOKE], role: 'support' },
    { slot: 1, x: 390, y: 0, grenades: [NADE.FLASH], role: 'entry' },
    { slot: 2, x: 200, y: 0, grenades: [], role: 'lurk' }
  ];

  const a = assignExecute({ steps, bodies });
  const b = assignExecute({ steps, bodies });
  assert(sig(a) === sig(b), `same input, same pairs (${sig(a)})`);
  assert(a.motive === b.motive, 'and the same sentence');

  const who = Object.fromEntries(a.pairs.map((p) => [p.col.id, p.row.slot]));
  assert(who.smoke === 0, `the smoke goes to the body who holds it (${JSON.stringify(who)})`);
  assert(who.flash === 1, 'the flash goes to the body who holds it');
  assert(a.idle.includes(2), 'the empty pocket is idle');
}

{
  // Two smoke holders: closer to `from` wins. Distance is a property, not a
  // memorized order.
  const steps = [{ id: 'smoke', effect: EFFECT.DENY_SIGHT, from: { x: 0, y: 0 } }];
  const near = { slot: 1, x: 50, y: 0, grenades: [NADE.SMOKE] };
  const far = { slot: 2, x: 800, y: 0, grenades: [NADE.SMOKE] };
  const first = assignExecute({ steps, bodies: [near, far] });
  const swapped = assignExecute({ steps, bodies: [far, near] });
  assert(first.pairs[0].row.slot === 1, 'nearer body throws');
  assert(swapped.pairs[0].row.slot === 1, 'list order does not override geometry');
}

// ---- a missing smoke changes the assignment (chapter 16) --------------------

{
  const steps = [
    { id: 'smoke', effect: EFFECT.DENY_SIGHT, from: { x: 0, y: 0 } },
    { id: 'flash', effect: EFFECT.GRANT_EXPOSURE, from: { x: 400, y: 0 } }
  ];
  const bodies = [
    { slot: 0, x: 20, y: 0, grenades: [NADE.SMOKE, NADE.FLASH], role: 'support' },
    { slot: 1, x: 40, y: 0, grenades: [NADE.SMOKE], role: 'entry' },
    { slot: 2, x: 380, y: 0, grenades: [NADE.FLASH], role: 'lurk' }
  ];

  const before = assignExecute({ steps, bodies });
  const without = bodies.map((b) => ({
    ...b,
    grenades: b.grenades.filter((g) => g !== NADE.SMOKE)
  }));
  const after = assignExecute({ steps, bodies: without });

  assert(sig(before) !== sig(after) || after.open.some((s) => s.id === 'smoke'), 'removing a smoke changes pairs or idles the smoke step');

  const thesis = assignmentChangesWhenNadeMissing({ steps, bodies, nade: NADE.SMOKE });
  assert(thesis.changed, 'assignmentChangesWhenNadeMissing is the chapter 16 thesis');
  assert(thesis.before.pairs.length >= 1, 'there was an assignment');
}

{
  // Property: whoever uniquely holds the smoke is who throws it, and taking
  // it out of their pocket either moves the throw or idles the step.
  const steps = [{ id: 'smoke', effect: EFFECT.DENY_SIGHT, from: { x: 0, y: 0 } }];
  for (const holder of [0, 1, 2]) {
    const bodies = [0, 1, 2].map((slot) => ({
      slot,
      x: slot * 100,
      y: 0,
      grenades: slot === holder ? [NADE.SMOKE] : []
    }));
    const a = assignExecute({ steps, bodies });
    assert(a.pairs.length === 1 && a.pairs[0].row.slot === holder, `slot ${holder} holds it, so slot ${holder} throws it`);
    const gone = assignmentChangesWhenNadeMissing({ steps, bodies, nade: NADE.SMOKE });
    assert(gone.changed, `taking the smoke off slot ${holder} changes the matrix`);
    assert(
      gone.after.pairs.length === 0 || gone.after.open.some((s) => s.id === 'smoke'),
      'and the smoke step is no longer bound to that body'
    );
  }
}

console.log('execute: ok');
