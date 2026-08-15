// Run: node shared/sim/playbook.test.js
//
// The playbook is a library of winning tapes. What a unit test can hold:
// pickRound / pickCall vary under softmax, assignRoles prefers the AWPer
// seat, matchSituation turns around on a behind contact, and a miss is null.

import {
  assignRoles,
  closeMatches,
  dueUtility,
  indexPlaybook,
  matchSituation,
  nextWaypointAt,
  openingCandidates,
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
    utility: extra.utility || [],
    ...(extra.pathSeconds ? { pathSeconds: extra.pathSeconds } : {})
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
    plant: null,
    // A tape whose contact came at 90 s had a pro alive at 90 s: its reach
    // has to say so, or the join filter (rightly) refuses it at a late clock.
    roles: [
      role('banana', {
        waypoints: [
          [0, 't_spawn'],
          [95, 'banana']
        ]
      }),
      role('apps'),
      role('mid', { awp: true }),
      role('arch'),
      role('library')
    ]
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

// ---- 9.25 stage 1: the shortlists, unsampled -----------------------------

{
  // `openingCandidates` is `pickRound`'s scoring without the draw, so the
  // head can price the freeze instead of taking whatever distance handed it.
  const cands = openingCandidates(index, { side: 'T', call: 'default', econ: 4 });
  assert(cands.length > 1, 'a shortlist, not an answer');
  assert(cands.every((c) => c.entry && c.decision), 'each carries its tape and what that tape did');
  for (let i = 1; i < cands.length; i += 1) {
    assert(cands[i - 1].distance <= cands[i].distance, 'nearest first');
  }
  assert(cands[0].entry.call === 'default', 'the call is the prior, and it holds');
  // No rng was consumed getting here: the same call twice is the same list.
  const again = openingCandidates(index, { side: 'T', call: 'default', econ: 4 });
  assert(again.map((c) => c.entry.id).join() === cands.map((c) => c.entry.id).join(), 'pure');
}

{
  const shortlist = closeMatches(index, { side: 'T', clock: 12, contactRel: 'behind', call: 'default' });
  assert(shortlist.length >= 1, 'a contact behind has close matches');
  assert(shortlist[0].entry.id === 'behind-turn', 'the nearest is the tape that turned around at 12s');
  assert(shortlist[0].decision === 'turnaround', 'labelled by what it did, not by what it was called');
  // The cutoff is a distance, not a category. A contact at 'site' never
  // matches a tape whose contact was 'behind' on shape alone (1.2), but at
  // 80 s the late tape's own contact at 90 s is only 0.25 away, so 1.45 still
  // clears 1.5 and the head gets to decide. That is the design: the library
  // offers, the value head disposes.
  const near = closeMatches(index, { side: 'T', clock: 80, contactRel: 'site', call: 'default' });
  assert(near.length >= 1, 'a near-miss on shape is still an offer');
  assert(near[0].distance < 1.5 && near[0].distance > 1.2, `1.2 < d < 1.5 (${near[0].distance})`);

  // Move the clock away from every tape and there is no shortlist at all,
  // same as matchSituation returning null rather than a bad tape.
  const far = closeMatches(index, { side: 'T', clock: 50, contactRel: 'site', call: 'default' });
  assert(far.length === 0, 'and past the cutoff there is no shortlist at all, same as matchSituation');
}

// ---- a re-call cannot join a tape that is already over ---------------------

{
  // Two tapes with the same opening shape; one's pro died at 20 s, the other
  // holds to 85 s (a defensive tape: last waypoint early, path long — the
  // sidecar's pathSeconds stamp carries the reach). At a 60 s join clock the
  // spent tape is not an answer, however well its shape matches.
  const joinIndex = indexPlaybook([
    entry('died-early', {
      firstContact: { t: 55, rel: 'front' },
      plant: null,
      roles: [
        role('banana', {
          waypoints: [
            [0, 't_spawn'],
            [20, 'banana']
          ]
        })
      ]
    }),
    entry('held-long', {
      firstContact: { t: 55, rel: 'front' },
      plant: null,
      roles: [
        role('banana', {
          waypoints: [
            [0, 't_spawn'],
            [12, 'banana']
          ],
          pathSeconds: 85
        })
      ]
    })
  ]);
  for (let seed = 1; seed <= 20; seed += 1) {
    const hit = matchSituation(joinIndex, {
      side: 'T',
      clock: 60,
      alive: 4,
      enemyAlive: 4,
      contactRel: 'front',
      call: 'default',
      rng: new Rng(seed)
    });
    assert(hit, 'a tape with reach at the join clock is offered');
    assert(hit.entry.id === 'held-long', `and never the spent one (${hit.entry.id})`);
  }
  assert(
    tapeEndSeconds(role('banana', { pathSeconds: 85 })) === 85,
    'the sidecar stamp is the reach when it outlives the schedule'
  );
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

{
  // The follower steers at where the tape is GOING. Steering at the passed
  // waypoint is what had every versus round camping spawn: at each waypoint
  // change the chase error jumped to the full segment and the 1.5s fall-off
  // test kicked the whole team local before it left the first anchor.
  const r = role('boost', {
    waypoints: [
      [0, 'tspawn'],
      [4.5, 't_garage'],
      [9, 'boost']
    ]
  });
  assert(nextWaypointAt(r, 0).anchor === 't_garage', 'at freeze the target is already the way out');
  assert(nextWaypointAt(r, 0).t === 4.5, 'and carries when the tape wants you there');
  assert(nextWaypointAt(r, 4.4).anchor === 't_garage', 'until that moment passes');
  assert(nextWaypointAt(r, 4.5).anchor === 'boost', 'then the next leg begins');
  // A spent schedule keeps pointing at its end rather than going null: the
  // contract outlives the walk to it.
  assert(nextWaypointAt(r, 60).anchor === 'boost', 'past the end, the target is the end');
  assert(nextWaypointAt(role('x', { waypoints: [] }), 0) === null, 'no waypoints, no target');
}

console.log('playbook: ok');
