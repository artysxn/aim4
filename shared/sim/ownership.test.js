// Run: node shared/sim/ownership.test.js
//
// SIM-PLAN 20.8. Zone ownership is a freeze-time partition, and the overcall
// protocol is who wins when two bots have ideas. The properties:
//
//   every named zone has exactly one owner
//   the same freeze produces the same assignment twice
//   a guest in a zone is not its owner
//   a time-sensitive overcall preempts; a relaxed one does not
//   a slot that is neither IGL nor owner may not overcall

import {
  IDENTITY,
  OVERCALL,
  assignZoneOwners,
  identityPreset,
  mayOvercall,
  overcall,
  ownerOf,
  roleInZone
} from './ownership.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ZONES = ['banana', 'apps', 'mid', 'a_site', 'b_site'];
const ROSTER = [
  { slot: 0, home: 'mid', role: 'igl' },
  { slot: 1, home: 'banana', role: 'entry' },
  { slot: 2, home: 'apps', role: 'support' },
  { slot: 3, home: 'a_site', role: 'anchor' },
  { slot: 4, home: 't_spawn', role: 'lurk' }
];
const IGL = 0;

function freeze() {
  return assignZoneOwners({ zones: ZONES, roster: ROSTER, iglSlot: IGL });
}

// ---- every zone has exactly one owner ---------------------------------------

{
  const a = freeze();
  assert(a.size === ZONES.length, 'one entry per named zone');
  const owners = new Set();
  for (const z of ZONES) {
    const slot = ownerOf(a, z);
    assert(Number.isInteger(slot), `${z} has an owner`);
    owners.add(slot);
    assert(a.get(z) === slot, 'ownerOf agrees with the map');
  }
  assert(owners.size >= 1, 'at least the IGL owns something');
  assert(ownerOf(a, 'banana') === 1, 'banana goes to the body whose home it is');
  assert(ownerOf(a, 'b_site') === IGL, 'a zone nobody posted goes to the IGL');
}

// ---- assignment is deterministic --------------------------------------------

{
  const a = freeze();
  const b = freeze();
  for (const z of ZONES) {
    assert(ownerOf(a, z) === ownerOf(b, z), `${z} is assigned the same slot twice`);
  }

  // Roster insertion order must not matter: slot order is the tiebreak.
  const shuffled = assignZoneOwners({
    zones: [...ZONES].reverse(),
    roster: [...ROSTER].reverse(),
    iglSlot: IGL
  });
  for (const z of ZONES) {
    assert(ownerOf(shuffled, z) === ownerOf(a, z), `${z} survives a shuffle`);
  }
}

{
  // Two bodies claiming the same home: lowest slot wins, unused still IGL.
  const tied = assignZoneOwners({
    zones: ['banana', 'mid'],
    roster: [
      { slot: 3, home: 'banana', role: 'entry' },
      { slot: 1, home: 'banana', role: 'entry' }
    ],
    iglSlot: 0
  });
  assert(ownerOf(tied, 'banana') === 1, 'the lower slot wins a tied home');
  assert(ownerOf(tied, 'mid') === 0, 'and the unclaimed zone is still the IGL');
}

// ---- guest is not owner -----------------------------------------------------

{
  const a = freeze();
  const bananaOwner = ownerOf(a, 'banana');
  const asOwner = roleInZone({ assignment: a, slot: bananaOwner, zone: 'banana' });
  assert(asOwner.status === 'owner', 'the assigned slot is the owner');
  assert(asOwner.maskHint == null, 'the owner is free inside the zone');

  const guestSlot = bananaOwner === 2 ? 3 : 2;
  const asGuest = roleInZone({ assignment: a, slot: guestSlot, zone: 'banana' });
  assert(asGuest.status === 'guest', 'anyone else is a guest');
  assert(asGuest.maskHint === 'support', 'guests default to Entry 2 / Support');
  assert(asGuest.status !== 'owner', 'a guest is not the owner');
}

// ---- overcall: time-sensitive preempts, relaxed does not --------------------

{
  const ownerSlot = 1;
  const ts = overcall({
    mode: OVERCALL.TIME_SENSITIVE,
    from: IGL,
    iglSlot: IGL,
    ownerSlot
  });
  assert(ts.preempt === true && ts.follow === true, 'time-sensitive overcall preempts');

  const fromOwner = overcall({
    mode: OVERCALL.TIME_SENSITIVE,
    from: ownerSlot,
    iglSlot: IGL,
    ownerSlot
  });
  assert(fromOwner.preempt === true, 'the owner may preempt too');

  const relaxed = overcall({
    mode: OVERCALL.RELAXED,
    from: IGL,
    iglSlot: IGL,
    ownerSlot
  });
  assert(relaxed.preempt === false, 'relaxed does not preempt');
  assert(relaxed.assemble === true, 'relaxed assembles');
  assert(relaxed.assembler === ownerSlot, 'the owner assembles when there is one');
}

// ---- a random slot may not overcall -----------------------------------------

{
  const ownerSlot = 1;
  const stranger = 4;
  assert(mayOvercall({ from: IGL, iglSlot: IGL, ownerSlot }), 'IGL always may');
  assert(mayOvercall({ from: ownerSlot, iglSlot: IGL, ownerSlot }), 'the owner may');
  assert(!mayOvercall({ from: stranger, iglSlot: IGL, ownerSlot }), 'a random slot may not overcall');

  const denied = overcall({
    mode: OVERCALL.TIME_SENSITIVE,
    from: stranger,
    iglSlot: IGL,
    ownerSlot
  });
  assert(denied.preempt === false, 'and a time-sensitive call from them does not preempt');
}

// ---- identity presets: the regional split -----------------------------------

{
  const iglEarly = identityPreset('igl-early');
  assert(iglEarly.earlyOwner === IDENTITY.IGL && iglEarly.midOwner === IDENTITY.PLAYERS, 'IGL first, players mid');
  const playersEarly = identityPreset('players-early');
  assert(playersEarly.earlyOwner === IDENTITY.PLAYERS && playersEarly.midOwner === IDENTITY.IGL, 'the other regional split');
  assert(iglEarly.earlySeconds === playersEarly.earlySeconds, 'the early window is the same length');
}

console.log('ownership: ok');
