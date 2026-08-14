// Run: node shared/sim/playbook.test.js
//
// The playbook is a library of winning tapes. What a unit test can hold:
// pickRound / pickCall vary under softmax, assignRoles prefers the AWPer
// seat, matchSituation turns around on a behind contact, and a miss is null.

import {
  assignRoles,
  dueUtility,
  indexPlaybook,
  matchSituation,
  pickCall,
  pickRound,
  tapeEndSeconds,
  UTILITY_STALE_SECONDS
} from './playbook.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function role(contract, extra = {}) {
  return {
    contract,
    steamId: extra.steamId || contract,
    awp: Boolean(extra.awp),
    waypoints: extra.waypoints || [
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
    side: extra.side || 'T',
    call: extra.call || 'default',
    econ: extra.econ ?? 4,
    plant: extra.plant === undefined ? { site: 'a', t: 40 } : extra.plant,
    firstContact: extra.firstContact || { t: 12, rel: 'front' },
    roles: extra.roles || [
      role('banana'),
      role('apps'),
      role('mid', { awp: true }),
      role('arch'),
      role('library')
    ]
  };
}

const index = indexPlaybook([
  entry('a-rush', { call: 'a-execute', econ: 4 }),
  entry('b-rush', { call: 'b-execute', econ: 4 }),
  entry('default-1', { call: 'default', econ: 3 }),
  entry('default-2', { call: 'default', econ: 4 }),
  entry('default-3', { call: 'default', econ: 4 }),
  entry('behind-turn', {
    call: 'default',
    firstContact: { t: 12, rel: 'behind' },
    plant: null
  }),
  entry('behind-late', {
    call: 'default',
    firstContact: { t: 90, rel: 'behind' },
    plant: null
  })
]);

{
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed += 1) {
    const e = pickRound(index, { side: 'T', call: 'default', rng: new Rng(seed) });
    assert(e, 'pickRound always finds a default tape');
    seen.add(e.id);
  }
  assert(seen.size >= 2, `softmax is not argmax (${[...seen].join(',')})`);
}

{
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    seen.add(pickCall(index, { side: 'T', rng: new Rng(seed) }));
  }
  assert(seen.size >= 2, `pickCall varies (${[...seen].join(',')})`);
  const prefer = pickCall(index, { side: 'T', prefer: 'b-execute', rng: new Rng(1) });
  assert(typeof prefer === 'string', 'a StrategyAI hint still returns a call');
}

{
  const slots = [0, 1, 2, 3, 4];
  const e = entry('awp-mid');
  const map = assignRoles(slots, e, () => null, { awpOf: (s) => s === 3 });
  assert(map.get(3).awp === true, 'the AWPer seat gets the AWP role');
  assert(map.size === 5, 'every seat is assigned');
}

{
  const behindIndex = indexPlaybook([
    entry('behind-turn', {
      call: 'default',
      firstContact: { t: 12, rel: 'behind' },
      plant: null
    }),
    entry('behind-also', {
      call: 'default',
      firstContact: { t: 13, rel: 'behind' },
      plant: null
    })
  ]);
  const hit = matchSituation(behindIndex, {
    side: 'T',
    clock: 12,
    alive: 5,
    enemyAlive: 5,
    contactRel: 'behind',
    call: 'default',
    rng: new Rng(2)
  });
  assert(hit, 'a behind contact finds a matching tape');
  assert(hit.decision === 'turnaround', `behind with no plant is a turnaround (${hit.decision})`);
}

{
  const missIndex = indexPlaybook([
    entry('front-early', { firstContact: { t: 8, rel: 'front' } }),
    entry('front-mid', { firstContact: { t: 12, rel: 'front' } }),
    entry('front-late', { firstContact: { t: 16, rel: 'front' } })
  ]);
  const miss = matchSituation(missIndex, {
    side: 'T',
    clock: 80,
    alive: 5,
    enemyAlive: 5,
    contactRel: 'behind',
    call: 'default',
    rng: new Rng(1)
  });
  // rel mismatch 1.2 plus clock (80 vs ~12) saturates at 1: distance 2.2 > 1.5.
  assert(miss == null, 'a distant mismatch is a miss, not a bad tape');
}

{
  const r = role('banana', {
    waypoints: [
      [0, 't_spawn'],
      [12, 'banana']
    ],
    utility: [{ t: 18, type: 'smokegrenade', from: 'banana', at: 'ct' }]
  });
  assert(tapeEndSeconds(r) === 18, 'tapeEnd is the later of waypoint and throw');
  assert(dueUtility(r, 18).length === 1, 'a throw at its clock is due');
  assert(dueUtility(r, 18 + UTILITY_STALE_SECONDS + 0.1).length === 0, 'and then it goes stale');
  const thrown = new Set([0]);
  assert(dueUtility(r, 18, thrown).length === 0, 'noteThrown equivalent suppresses it');
}

console.log('playbook: ok');
