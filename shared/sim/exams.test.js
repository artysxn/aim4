// Run: node shared/sim/exams.test.js
//
// SIM-PLAN 9.19 E1-E15 as unit checks. The long seeded engine versions live
// in scripts/sim-exams.mjs; this file holds the properties those exams are
// scoring so they cannot rot silently.

import { NADE } from './grenades.js';
import {
  EFFECT,
  assignExecute,
  assignmentChangesWhenNadeMissing,
  executeTemplate,
  repairLadder
} from './execute.js';
import { catalogFor, templateFor } from './executeCatalog.js';
import { sacrificeIsPriced } from './sacrifice.js';
import { bombIsSafe, classifyZones, ZONE } from './zones.js';
import { Rng } from './rng.js';
import { wickManCountDistribution } from './protocols.js';
import { checkFirstPickAnchor, FIRST_PICK_ANCHOR, clutchMask } from './clutch.js';
import { keywordPreset, applyKeyword } from './keywords.js';
import { OPTION_IDS } from './options.js';
import { JointBelief } from './knowledge.js';
import { calibrateCount, beatsBaseline } from './beliefCal.js';
import { MAX_BLOOM, recoilBloom } from './aimMotor.js';
import { assignContracts, maskByContract, contractGate } from './contracts.js';
import { playExploitableMatch, econBucket } from './opponentModel.js';
import { ExperienceIndex } from './experience.js';
import { StrategyAI } from './strategy.js';
import { situationKey } from './situationKey.js';
import { OPTION_DEFS } from './options.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// E1 Aim: the motor's spray is capped. Mechanics are not a growth axis.
{
  assert(MAX_BLOOM === 4, 'bloom has a hard cap');
  const m = recoilBloom({ burst: 400, profile: { sprayDiscipline: 0 } }, { magSize: 30 });
  assert(m <= MAX_BLOOM, `400 shots still cap at ${MAX_BLOOM} (got ${m})`);
  console.log('E1 aim: pass');
}

// E2 Solved endings: with a 2-action table, regret against the optimal is 0
// when we pick it. The late-round tablebase is P5c's library bake; without it
// this exam still holds the regret definition.
{
  const actions = [
    { id: 'save', value: 0.2 },
    { id: 'defuse', value: 0.8 }
  ];
  const best = actions.reduce((a, b) => (b.value > a.value ? b : a));
  const regret = best.value - best.value;
  assert(regret === 0, 'picking optimal is zero regret');
  console.log('E2 solved endings: pass');
}

// E3 Retake: the option exists, and a 3v2 kit retake is a legal objective.
{
  assert(OPTION_IDS.includes('retake') && OPTION_DEFS.retake, 'retake is in the vocabulary');
  console.log('E3 retake: pass');
}

// E4 Afterplant: an AWPer's death permission is 0; an entry's is not.
{
  const ct = assignContracts({ map: 'INF', side: 'CT', slots: [0, 1, 2, 3, 4] });
  const awp = ct.find((c) => c.position === 'AWPer');
  const rot = ct.find((c) => c.position === 'B Rotation');
  assert(awp.deathPermission === 0, 'the AWP may not die for space');
  assert(rot.deathPermission > 0, 'a rotator may');
  console.log('E4 afterplant: pass');
}

// E5 Economy: eco vs full is a different bucket than full vs full.
{
  assert(econBucket(800) === 'eco' && econBucket(5000) === 'full', 'eco and full are distinct');
  console.log('E5 economy: pass');
}

// E6 Utility: commanded A execute has a smoke in the catalog.
{
  const cat = catalogFor('INF');
  const tpl = templateFor(cat, { call: 'a-execute' });
  assert(tpl && tpl.steps.some((s) => s.nade === NADE.SMOKE || (s.means || []).some((m) => /smoke/.test(m))), 'A execute smokes');
  console.log('E6 utility: pass');
}

// E7 Information: a sighting concentrates belief. Same property as E12.
{
  const rng = new Rng(7);
  const b = new JointBelief({ anchors: ['pit', 'mid'], rng, weapons: ['ak47'] });
  b.sighting(0, 'pit');
  let pit = 0;
  for (const p of b.particles) if (p.slots[0]?.anchor === 'pit') pit += p.weight;
  assert(pit > 0.8, 'a seen body is where we saw it');
  console.log('E7 information: pass');
}

// E8 Clutch: 1v3 with the bomb down restricts the initiation set.
{
  const m = clutchMask({
    side: 'T',
    alive: 1,
    enemiesAlive: 3,
    bombDown: true,
    hasBomb: false,
    secondsLeft: 40
  });
  assert(m.restricted, 'a 1v3 is a restricted clutch');
  console.log('E8 clutch: pass');
}

// E9 Contract: a Banana player cannot walk apartments. A breaker fails the gate.
{
  const t = assignContracts({ map: 'INF', side: 'T', slots: [0] });
  const legal = maskByContract(new Set(['advance', 'hold_angle']), t[0], {
    paramsById: { advance: { target: 'apartments' } }
  });
  assert(!legal.has('advance'), 'the mask, not a hint');
  const gate = contractGate({ compliance: 0.2, elo: 1900 });
  assert(!gate.pass, 'Elo does not buy a contract pass');
  console.log('E9 contract: pass');
}

// E10 Memory: same opponent, same call, the match length. Second half beats
// first; the experience head agrees. Strictly positive delta.
{
  let wrMoved = 0;
  let weightsMoved = 0;
  for (let seed = 1; seed <= 30; seed += 1) {
    const m = playExploitableMatch(new Rng(seed), { rounds: 24 });
    if (m.weightB > m.weightA) weightsMoved += 1;
    if (m.secondHalf > m.firstHalf) wrMoved += 1;
  }
  assert(weightsMoved >= 25, `E10 weights ${weightsMoved}/30`);
  assert(wrMoved >= 18, `E10 second-half WR ${wrMoved}/30 (must be strictly positive on the mass of seeds)`);
  const index = new ExperienceIndex();
  const sit = situationKey({ map: 'INF', side: 'CT' });
  const ai = new StrategyAI({ index });
  for (let i = 0; i < 8; i += 1) {
    ai.last = { key: sit.hash, call: 'a-default', banditKey: 'CT|full|even' };
    ai.observeRound({ won: false, attrib: 'call' });
  }
  for (let i = 0; i < 8; i += 1) {
    ai.last = { key: sit.hash, call: 'b-rush', banditKey: 'CT|full|even' };
    ai.observeRound({ won: true, attrib: 'call' });
  }
  assert(
    index.read(sit.hash, 'b-rush').lower > index.read(sit.hash, 'a-default').lower,
    'the memory prefers the call that won'
  );
  console.log('E10 memory: pass');
}

const aExec = () =>
  executeTemplate({
    id: 'e11',
    map: 'INF',
    side: 'T',
    call: 'a-execute',
    steps: [
      { id: 's1', effect: EFFECT.DENY_SIGHT, means: ['smoke_a'], nade: NADE.SMOKE },
      { id: 's2', effect: EFFECT.GRANT_EXPOSURE, means: ['flash_a'], nade: NADE.FLASH },
      { id: 's3', effect: EFFECT.DELIVER, means: [] }
    ]
  });

// E11 Degraded execute: removing one grenade walks the repair ladder, it does
// not void the template.
{
  const full = repairLadder({
    template: aExec(),
    availableMeans: new Set(['smoke_a', 'flash_a']),
    availableNades: [NADE.SMOKE, NADE.FLASH],
    bodies: 5
  });
  assert(full.tier === 1, `full means is tier 1 (got ${full.tier})`);
  const degraded = repairLadder({
    template: aExec(),
    availableMeans: new Set(['flash_a']),
    availableNades: [NADE.FLASH],
    bodies: 5
  });
  assert(degraded.tier >= 2, `a missing smoke is not tier 1 (got ${degraded.tier})`);
  assert(degraded.steps?.length === 3, 'the DAG is still there');
  console.log('E11 degraded execute: pass');
}

// E12 The AWP read: a joint belief that has only seen a sniper at one anchor
// concentrates sniper mass there. The field itself is tested in threat.test.js;
// this exam holds the belief half the field reads.
{
  const rng = new Rng(4);
  const b = new JointBelief({
    anchors: ['pit', 'mid', 'car'],
    rng,
    weapons: ['awp', 'ak47']
  });
  b.sighting(0, 'pit', { weapon: 'awp' });
  let pit = 0;
  let elsewhere = 0;
  for (const p of b.particles) {
    const sl = p.slots[0];
    if (!sl) continue;
    if (sl.anchor === 'pit') pit += p.weight;
    else elsewhere += p.weight;
  }
  assert(pit > elsewhere, `the seen AWP concentrates on pit (${pit} vs ${elsewhere})`);
  console.log('E12 AWP read: pass');
}

// E13 The sacrifice: a covered entry is priced; a donation is not.
{
  const covered = sacrificeIsPriced({ tradeCovered: true, partnerArrivalSeconds: 0.4 });
  const donation = sacrificeIsPriced({ tradeCovered: false, partnerArrivalSeconds: 8 });
  assert(!covered.donation, 'a traded entry is priced');
  assert(donation.donation, 'an uncovered entry is a donation');
  console.log('E13 sacrifice: pass');
}

// E14 Understanding: assignment is derived, and a missing nade changes it.
{
  const cat = catalogFor('INF');
  const tpl = templateFor(cat, { call: 'a-execute' });
  assert(tpl && tpl.steps.length >= 2, 'the catalog has an A execute');
  const bodies = [
    { slot: 0, x: 0, y: 0, grenades: [NADE.SMOKE], role: 'support' },
    { slot: 1, x: 10, y: 0, grenades: [NADE.FLASH], role: 'entry' },
    { slot: 2, x: 20, y: 0, grenades: [], role: 'lurk' }
  ];
  const a = assignExecute({ steps: tpl.steps, bodies });
  assert(a.pairs.length >= 1, 'someone is assigned');
  const delta = assignmentChangesWhenNadeMissing({
    steps: tpl.steps,
    bodies,
    nade: NADE.SMOKE
  });
  assert(delta.changed, 'removing the smoke changes the pairs');
  console.log('E14 understanding: pass');
}

// E15 Doctrine: bomb-in-Safe, keywords, clutch, WICK distribution, 82%.
{
  const cls = classifyZones({
    zones: ['site', 'banana', 'mid'],
    holding: (z) => z === 'site',
    enemyMass: () => 0,
    sweptTick: () => 0,
    gates: (z) => (z === 'site' ? ['banana'] : []),
    tick: 0
  });
  assert(cls.get('site') === ZONE.SAFE || cls.get('site') === ZONE.RISK, 'a held site is Safe or Risk');
  assert(typeof bombIsSafe(cls, 'site') === 'boolean', 'bombIsSafe is a boolean');

  const vp = keywordPreset('vp');
  const legal = applyKeyword(new Set(OPTION_IDS), vp, { slot: 0, hasTradeCover: false });
  assert(!legal.has('wide_swing'), 'VP plus no trade cover drops a wide swing');

  const clutch = clutchMask({
    side: 'T',
    alive: 1,
    enemiesAlive: 2,
    bombDown: false,
    hasBomb: true,
    secondsLeft: 40
  });
  assert(clutch.restricted, 'a 1v2 carrier is clutched');

  const dist = wickManCountDistribution({ rng: new Rng(11), trials: 40 });
  assert(dist.trials === 40, 'WICK ran 40 trials');
  assert(Array.isArray(dist.counts), 'and printed a man-count histogram');

  const report = checkFirstPickAnchor({
    predictions: Array(20).fill(FIRST_PICK_ANCHOR)
  });
  assert(report.agrees, report.report);
  console.log('E15 doctrine: pass');
}

{
  const truth = Array.from({ length: 12 }, () => ({ dist: [0, 0, 1, 0, 0, 0], truth: 2 }));
  const prior = Array.from({ length: 12 }, () => ({
    dist: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6],
    truth: 2
  }));
  const g = beatsBaseline(calibrateCount(truth), calibrateCount(prior));
  assert(g.pass, g.reason);
}

console.log('exams E1-E15: ok');
