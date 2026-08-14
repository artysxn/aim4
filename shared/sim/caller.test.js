// Run: node shared/sim/caller.test.js
//
// The hivemind: sample a tape, copy it, keep it in motion. A contact behind
// is a read, not a recall. Default keeps walking a 5v4; VP freezes.

import {
  createCaller,
  CALLER_MODE,
  CALL_DECISION,
  classifyContactRel,
  pictureWinrate,
  shouldRecall
} from './caller.js';
import { indexPlaybook } from './playbook.js';
import { Rng } from './rng.js';
import { INTERRUPT } from './interrupts.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function role(contract, extra = {}) {
  return {
    contract,
    steamId: contract,
    awp: Boolean(extra.awp),
    waypoints: [
      [0, 't_spawn'],
      [8, contract]
    ],
    utility: extra.utility || []
  };
}

function entry(id, extra = {}) {
  return {
    id,
    map: 'INF',
    side: 'T',
    call: extra.call || 'default',
    econ: 4,
    plant: extra.plant === undefined ? { site: 'a', t: 40 } : extra.plant,
    firstContact: extra.firstContact || { t: 12, rel: 'front' },
    roles: [
      role('banana'),
      role('apps'),
      role('mid', { awp: true }),
      role('arch'),
      role('library', {
        utility: [
          {
            t: 5,
            type: 'smokegrenade',
            from: 'banana',
            at: 'ct',
            fx: 1,
            fy: 2,
            ax: 3,
            ay: 4,
            flight: 1.2
          }
        ]
      })
    ]
  };
}

{
  assert(
    classifyContactRel({ x: -400, y: 0, spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 } }) ===
      'behind',
    'negative projection is behind'
  );
  assert(
    classifyContactRel({ x: 2000, y: 0, spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 } }) === 'site',
    'near the goal is site'
  );
  assert(
    classifyContactRel({ x: 800, y: 0, spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 } }) === 'front',
    'along the axis is front'
  );
}

const slots = [0, 1, 2, 3, 4];
const awpOf = (s) => s === 3;
const contractOf = () => null;

function picture(extra = {}) {
  return { side: 'T', alive: 5, enemyAlive: 5, clock: 12, planted: false, ...extra };
}

{
  const even = pictureWinrate(picture());
  const up = pictureWinrate(picture({ enemyAlive: 4 }));
  const down = pictureWinrate(picture({ alive: 3, enemyAlive: 5 }));
  assert(up > even && even > down, 'a man up raises predicted winrate');

  const keepBehind = shouldRecall({ picture: picture({ contactRel: 'behind' }), posture: 'default' });
  assert(keepBehind.recall === false, '5v5 behind is a read, not a recall');

  const defaultUp = shouldRecall({ picture: picture({ enemyAlive: 4 }), posture: 'default' });
  assert(defaultUp.recall === false, 'default does not freeze a 5v4');

  const vpUp = shouldRecall({ picture: picture({ enemyAlive: 4 }), posture: 'vp' });
  assert(vpUp.recall === true && vpUp.decision === CALL_DECISION.FREEZE, 'VP freezes a 5v4');

  const freezeUp = shouldRecall({ picture: picture({ enemyAlive: 4 }), posture: 'freeze' });
  assert(freezeUp.decision === CALL_DECISION.FREEZE, 'Freeze posture also pauses when ahead');

  const losing = shouldRecall({
    picture: picture({ alive: 3, enemyAlive: 5, clock: 10, teamBroken: true }),
    posture: 'default'
  });
  assert(losing.recall === true, '3v5 with the call dissolved is a recall');
}

{
  const index = indexPlaybook([
    entry('tape-a', { call: 'default' }),
    entry('tape-b', { call: 'default' }),
    entry('tape-c', { call: 'a-execute' })
  ]);
  const seen = new Set();
  for (let seed = 1; seed <= 50; seed += 1) {
    const c = createCaller({ playbook: index, rng: new Rng(seed), map: 'INF', side: 'T', slots });
    const start = c.roundStart({
      spawn: { x: 0, y: 0 },
      goal: { x: 2000, y: 0 },
      contractOf,
      awpOf
    });
    assert(start.mode === CALLER_MODE.TAPE, 'a playbook starts on a tape');
    seen.add(c.entry()?.id);
    assert(c.isOnTape(3), 'the AWPer is on the tape');
    assert(c.waypoint(0, 9) === 'banana' || c.waypoint(0, 9), 'waypoints resolve');
  }
  assert(seen.size >= 2, `roundStart softmax varies (${[...seen].join(',')})`);
}

{
  const index = indexPlaybook([
    entry('front-commit', { firstContact: { t: 12, rel: 'front' }, plant: { site: 'a', t: 35 } }),
    entry('behind-turn', { firstContact: { t: 12, rel: 'behind' }, plant: null }),
    entry('behind-also', { firstContact: { t: 14, rel: 'behind' }, plant: null })
  ]);
  const c = createCaller({ playbook: index, rng: new Rng(3), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  const before = c.entry()?.id;
  const intel = c.considerIntel({
    x: -500,
    y: 0,
    clock: 12,
    alive: 5,
    enemyAlive: 5,
    contractOf,
    awpOf
  });
  assert(intel.rel === 'behind', 'the contact classifies as behind');
  assert(intel.kept === true, '5v5 behind keeps the plan in motion');
  assert(c.entry()?.id === before, 'and it is the same tape');
  assert(c.teamMode() === CALLER_MODE.TAPE, 'still on a tape');
}

{
  const index = indexPlaybook([
    entry('front-only', { firstContact: { t: 10, rel: 'front' }, plant: { site: 'a', t: 30 } }),
    entry('also-front', { firstContact: { t: 11, rel: 'front' }, plant: { site: 'b', t: 32 } }),
    entry('front-late', { firstContact: { t: 12, rel: 'front' }, plant: { site: 'a', t: 40 } })
  ]);
  const c = createCaller({ playbook: index, rng: new Rng(1), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  const intel = c.considerIntel({
    x: -500,
    y: 0,
    clock: 80,
    alive: 4,
    enemyAlive: 5,
    contractOf,
    awpOf
  });
  assert(intel.rel === 'behind', 'still behind');
  assert(intel.mode === CALLER_MODE.FREESTYLE, 'a -EV miss is freestyle, not a bad tape');
  assert(!c.isOnTape(0), 'nobody stays on the old tape');
}

{
  const c = createCaller({ playbook: null, rng: new Rng(1), map: 'INF', side: 'T', slots });
  const start = c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 } });
  assert(start.mode === CALLER_MODE.FREESTYLE, 'missing playbook is ordinary freestyle');
}

{
  const index = indexPlaybook([entry('one'), entry('two'), entry('three')]);
  const c = createCaller({ playbook: index, rng: new Rng(4), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  c.onInterrupt({ clazz: INTERRUPT.LOCAL, slots: [1], contractOf, awpOf, clock: 8, alive: 5, enemyAlive: 5 });
  assert(c.isOnTape(0) && !c.isOnTape(1), 'local interrupt drops one bot');
  assert(c.brokenCount() === 1, 'and counts them');
}

{
  const index = indexPlaybook([entry('one')]);
  const c = createCaller({ playbook: index, rng: new Rng(1), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  let thrower = null;
  for (const s of slots) {
    if (c.due(s, 6).length) thrower = s;
  }
  assert(thrower != null, 'the library role has a throw at t=5');
  const first = c.due(thrower, 6);
  assert(first.length === 1, 'due yields the throw once');
  c.noteThrown(thrower, first[0].index);
  assert(c.due(thrower, 6).length === 0, 'noteThrown suppresses it');
}

{
  const index = indexPlaybook([entry('stale')]);
  const c = createCaller({ playbook: index, rng: new Rng(1), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  let thrower = null;
  for (const s of slots) {
    if (c.due(s, 6).length) thrower = s;
  }
  assert(thrower != null, 'there is a throw to go stale');
  assert(c.due(thrower, 16).length === 0, 'a throw 10 s stale is dropped');
}

{
  const index = indexPlaybook([entry('life')]);
  const c = createCaller({ playbook: index, rng: new Rng(1), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  assert(c.isOnTape(0, 5), 'early clock is on the tape');
  assert(!c.isOnTape(0, 25), 'past tapeEnd plus grace is off');
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  c.retire();
  assert(!c.isOnTape(0, 5), 'retire drops every slot');
  assert(c.teamMode() === CALLER_MODE.FREESTYLE, 'and the side is freestyle');
}

{
  const index = indexPlaybook([
    entry('front-commit', { firstContact: { t: 12, rel: 'front' }, plant: { site: 'a', t: 35 } }),
    entry('behind-turn', { firstContact: { t: 12, rel: 'behind' }, plant: null }),
    entry('behind-also', { firstContact: { t: 14, rel: 'behind' }, plant: null })
  ]);
  const c = createCaller({ playbook: index, rng: new Rng(4), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  const first = c.onInterrupt({
    clazz: INTERRUPT.TEAM,
    contractOf,
    awpOf,
    clock: 10,
    alive: 3,
    enemyAlive: 5
  });
  const idAfter = c.entry()?.id;
  const second = c.onInterrupt({
    clazz: INTERRUPT.TEAM,
    contractOf,
    awpOf,
    clock: 11,
    alive: 3,
    enemyAlive: 5
  });
  assert(second.kept === true && second.reason === 'cooldown', 'a second redecide inside 3s keeps the tape');
  assert(c.entry()?.id === idAfter, `and it is the same entry (${idAfter})`);
  assert(first.kept !== true || first.reason !== 'cooldown', 'the first redecide was not on cooldown');
}

{
  const index = indexPlaybook([entry('one'), entry('two'), entry('three')]);
  const c = createCaller({ playbook: index, rng: new Rng(1), map: 'INF', side: 'T', slots });
  c.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  const id = c.entry()?.id;
  const team = c.onInterrupt({
    clazz: INTERRUPT.TEAM,
    contractOf,
    awpOf,
    clock: 12,
    alive: 5,
    enemyAlive: 5
  });
  assert(team.kept === true, 'TEAM while 5v5 keeps the plan');
  assert(c.entry()?.id === id, 'and the same tape');
}

{
  const index = indexPlaybook([entry('one'), entry('two'), entry('three')]);
  const def = createCaller({ playbook: index, rng: new Rng(1), map: 'INF', side: 'T', slots });
  def.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  const defId = def.entry()?.id;
  const defPic = def.considerPicture({ side: 'T', clock: 12, alive: 5, enemyAlive: 4 }, { contractOf, awpOf });
  assert(defPic.kept === true, 'default 5v4 keeps walking');
  assert(def.decision() !== CALL_DECISION.FREEZE, 'and does not freeze');
  assert(def.entry()?.id === defId, 'same tape');

  const vp = createCaller({
    playbook: index,
    rng: new Rng(1),
    map: 'INF',
    side: 'T',
    slots,
    posture: 'freeze'
  });
  vp.roundStart({ spawn: { x: 0, y: 0 }, goal: { x: 2000, y: 0 }, contractOf, awpOf });
  const vpId = vp.entry()?.id;
  const frozen = vp.considerPicture({ side: 'T', clock: 12, alive: 5, enemyAlive: 4 }, { contractOf, awpOf });
  assert(frozen.decision === CALL_DECISION.FREEZE, 'Freeze posture pauses a 5v4');
  assert(frozen.kept === true, 'without swapping the tape');
  assert(vp.entry()?.id === vpId, 'same tape while frozen');
  assert(vp.freezeKeyword() === 'freeze', 'and names the hold keyword');
  assert(vp.isOnTape(0), 'bots stay on the tape');
}

console.log('caller: ok');
