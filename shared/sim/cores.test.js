// Run: node shared/sim/cores.test.js

import { findCore, ownCore, enemyCoreFromBelief, ALONE_DISTANCE, isTradeable } from './cores.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const stacked = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 20, y: 0 },
    { id: 'c', x: 10, y: 10 },
    { id: 'd', x: 5, y: 5 },
    { id: 'e', x: 2000, y: 2000 }
  ];
  const core = findCore(stacked);
  assert(core.size >= 3, `four together is a core (${core.size})`);
  assert(core.lurkers.includes('e'), 'the far one is the lurker');
}

{
  const living = [
    { slot: 0, pos: { x: 0, y: 0 } },
    { slot: 1, pos: { x: 10, y: 0 } },
    { slot: 2, pos: { x: 0, y: 10 } },
    { slot: 3, pos: { x: 8, y: 8 } }
  ];
  const c = ownCore(living);
  assert(c.size >= 3, 'own core uses true positions');
}

{
  const belief = {
    particles: [
      {
        weight: 1,
        slots: [
          { anchor: 'banana' },
          { anchor: 'banana' },
          { anchor: 'banana' },
          { anchor: 'banana' },
          { anchor: 'apps' }
        ]
      }
    ]
  };
  const graph = {
    anchor: (id) =>
      id === 'banana'
        ? { world: { x: 0, y: 0, z: 0 } }
        : { world: { x: 1800, y: 0, z: 0 } }
  };
  const c = enemyCoreFromBelief(belief, graph);
  assert(c.size >= 3, 'enemy core is a belief read');
  assert(c.lurkers.length === 1, 'the apps body is the lurker they have not seen with the pack');
}

{
  assert(ALONE_DISTANCE === 350, 'trade window is coreRadius(2)');
  const me = { id: 'me', x: 0, y: 0 };
  assert(isTradeable(me, [{ id: 'you', x: 100, y: 0 }]), 'a nearby mate is tradeable');
  assert(!isTradeable(me, [{ id: 'you', x: 2000, y: 0 }]), 'a far mate is not');
}

console.log('cores: ok');
