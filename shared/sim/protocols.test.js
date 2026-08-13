// Run: node shared/sim/protocols.test.js
//
// SIM-PLAN 20.5. A protocol is an option one tier up, so the assertions are
// the properties that would make it a second vocabulary instead:
//
//   every row is well-formed: roles, initiation clauses, a terminate table
//   initiationCheck names the clause that refused, and never invents an id
//   three-man take starts on Unknown + three bodies + a grenade, and not
//     without any one of those
//   wickManCountDistribution runs the real machine and returns a distribution

import { Rng } from './rng.js';
import { ZONE } from './zones.js';
import { OPTION_DEFS } from './options.js';
import {
  PROTOCOL_DEFS,
  PROTOCOL_IDS,
  initiationCheck,
  protocolInitiationSet,
  wickManCountDistribution
} from './protocols.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  assert(PROTOCOL_IDS.length >= 4, 'the table has the named procedures');
  for (const id of PROTOCOL_IDS) {
    const def = PROTOCOL_DEFS[id];
    assert(def.label && def.motive, `${id} explains itself`);
    assert(Array.isArray(def.roles) && def.roles.length, `${id} binds roles`);
    assert(Array.isArray(def.initiation?.clauses) && def.initiation.clauses.length, `${id} has initiation clauses`);
    assert(Array.isArray(def.terminate), `${id} has a terminate table`);
    for (const role of def.roles) {
      assert(role.min >= 1, `${id}.${role.id} has a min`);
      for (const opt of role.mask) {
        assert(OPTION_DEFS[opt], `${id}.${role.id} mask names a real option (${opt})`);
      }
    }
  }
}

{
  const missing = initiationCheck('three_man_take', {});
  assert(!missing.ok, 'empty context cannot start a three-man take');
  assert(missing.refusedBy === 'target_unknown', `names the first failed clause (${missing.refusedBy})`);

  const ready = {
    targetZoneClass: ZONE.UNKNOWN,
    available: 3,
    utilityInHand: true
  };
  const ok = initiationCheck('three_man_take', ready);
  assert(ok.ok, `three-man take starts when the clauses hold (${ok.motive})`);
  assert(protocolInitiationSet(ready).has('three_man_take'), 'and the set agrees');

  const noNade = initiationCheck('three_man_take', { ...ready, utilityInHand: false });
  assert(!noNade.ok && noNade.refusedBy === 'utility_in_hand', 'no grenade is a named refusal');
}

{
  const dist = wickManCountDistribution({ rng: new Rng(7), trials: 40 });
  assert(dist.trials === 40, 'trial count is the callers');
  assert(Array.isArray(dist.counts), 'the distribution is a list');
  assert(dist.contacts >= 0 && dist.contacts <= 40, 'contacts cannot exceed trials');
  assert(Number.isFinite(dist.localShare) && dist.localShare >= 0 && dist.localShare <= 1, 'localShare is a share');
}

console.log('protocols: ok');
