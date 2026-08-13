// Run: node shared/sim/contracts.test.js

import {
  assignContracts,
  maskByContract,
  zoneCompliance,
  reassignOnDeath,
  contractGate,
  contractCompliance,
  CONTRACT_GATE
} from './contracts.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const ct = assignContracts({ map: 'INF', side: 'CT', slots: [0, 1, 2, 3, 4] });
  assert(ct.length === 5, 'five contracts');
  assert(ct[0].position === 'B Rotation', `Inferno CT starts at B Rotation (${ct[0].position})`);
  assert(ct.every((c) => c.zones && c.utilBudget && c.window && c.tradeDuty && 'deathPermission' in c), 'five clauses');
}

{
  const t = assignContracts({ map: 'INF', side: 'T', slots: [0, 1, 2, 3, 4] });
  const banana = t.find((c) => c.position === 'Banana');
  assert(banana, 'Banana is a T position');
  const legal = new Set(['advance', 'hold_angle', 'plant', 'execute_entry']);
  const masked = maskByContract(legal, banana, { paramsById: { advance: { target: 'apartments' } } });
  assert(!masked.has('advance'), 'Banana cannot walk apartments');
  assert(masked.has('hold_angle'), 'holds stay');
  assert(masked.has('plant'), 'objectives stay');
}

{
  const t = assignContracts({ map: 'INF', side: 'T', slots: [0] });
  const banana = t[0];
  assert(!zoneCompliance(banana, 'apartments').ok, 'off-role is a miss');
  assert(zoneCompliance(banana, 'banana').ok, 'ranked zone is a hit');
}

{
  const ct = assignContracts({ map: 'INF', side: 'CT', slots: [0, 1, 2] });
  const r = reassignOnDeath({ contracts: ct, deadSlot: 1, tick: 40 });
  assert(r.directive.type === 'reassign', 'death is a logged directive');
  assert(r.directive.fromSlot === 1, 'naming who died');
}

{
  const breaker = contractCompliance([
    { contract: assignContracts({ map: 'INF', side: 'T', slots: [0] })[0], zone: 'apartments' },
    { contract: assignContracts({ map: 'INF', side: 'T', slots: [0] })[0], zone: 'pit' },
    { contract: assignContracts({ map: 'INF', side: 'T', slots: [0] })[0], zone: 'apps' }
  ]);
  const gate = contractGate({ compliance: breaker.rate, elo: 1800 });
  assert(!gate.pass, 'a role-breaking agent fails the contract gate');
  assert(gate.elo === 1800, 'while winning on Elo');
  assert(CONTRACT_GATE === 0.7, 'the bar is 70%');
}

console.log('contracts: ok');
