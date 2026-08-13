// Run: node shared/sim/callValidator.test.js

import {
  CALL_VALIDATOR_GATE,
  structuralMatch,
  validateCall,
  validatorRate
} from './callValidator.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const hit = structuralMatch({
    commanded: 'a-execute',
    plantSite: 'a',
    log: []
  });
  assert(hit.hit, 'a plant on the commanded site is a hit');

  const miss = structuralMatch({
    commanded: 'a-execute',
    plantSite: 'b',
    log: [{ id: 'execute_entry', params: { site: 'b' } }]
  });
  assert(!miss.hit, 'the other site is a miss');

  const majority = structuralMatch({
    commanded: 'b-execute',
    log: [
      { id: 'execute_entry', params: { site: 'b' } },
      { id: 'execute_entry', params: { site: 'b' } },
      { id: 'rotate', params: { site: 'a' } }
    ]
  });
  assert(majority.hit, 'a majority toward the site is a hit');
}

{
  const none = structuralMatch({ commanded: 'default', log: [] });
  assert(none.hit, 'a command with no site cannot fail the structural check');
}

{
  const r = validatorRate([
    { commanded: 'a-execute', plantSite: 'a' },
    { commanded: 'a-execute', plantSite: 'a' },
    { commanded: 'a-execute', plantSite: 'b' }
  ]);
  assert(r.n === 3, 'n is the round count');
  assert(Math.abs(r.rate - 2 / 3) < 1e-9, 'two of three planted A');
  assert(r.pass === 2 / 3 >= CALL_VALIDATOR_GATE, 'the gate is the P4 bar');
}

{
  const tagged = validateCall({ commanded: 'default', mapCode: 'OVP', side: 'T', facts: {} });
  assert(tagged.how, 'unknown maps fall through rather than throw');
}

console.log('callValidator: ok');
