import assert from 'node:assert/strict';
import { canSpectateSlot, deathFollowShouldSnap, nextCamMode, nextFollowSlot, specKeyForSeat } from './view3dFollow.js';

const players = [
  { id: 'a', slot: 0 },
  { id: 'b', slot: 1 },
  { id: 'c', slot: 2 },
  { id: 'd', slot: 5 }
];

{
  const live = [1, 2, 5];
  const kills = [{ tick: 100, attacker: 'c', victim: 'a' }];
  assert.equal(
    nextFollowSlot(0, live, { players, kills, tick: 100 }),
    2,
    'a live killer is the follow target'
  );
}

{
  const live = [1, 2, 5];
  assert.equal(
    nextFollowSlot(0, live, { players, kills: [], tick: 100 }),
    1,
    'no kill event falls to the next live slot'
  );
}

{
  const live = [1, 5];
  const kills = [{ tick: 100, attacker: 'c', victim: 'a' }];
  assert.equal(
    nextFollowSlot(0, live, { players, kills, tick: 100 }),
    1,
    'a dead killer falls to the next live slot'
  );
}

{
  const live = [1, 2];
  const kills = [{ tick: 100, attacker: 'a', victim: 'a' }];
  assert.equal(
    nextFollowSlot(0, live, { players, kills, tick: 100 }),
    1,
    'suicide keeps the next-live fallback'
  );
}

{
  const live = [1, 2];
  const kills = [{ tick: 100, attacker: '', victim: 'a' }];
  assert.equal(
    nextFollowSlot(0, live, { players, kills, tick: 100 }),
    1,
    'world / bomb with no attacker keeps the next-live fallback'
  );
}

{
  const live = [0, 1, 2];
  assert.equal(nextFollowSlot(5, live, { players, kills: [], tick: 50 }), 0, 'wraps to the first live slot');
}

{
  assert.equal(deathFollowShouldSnap(null, 100, 64), true, 'first frame snaps');
  assert.equal(deathFollowShouldSnap(100, 101, 64), false, 'a playback tick holds');
  assert.equal(deathFollowShouldSnap(100, 80, 64), true, 'a rewind snaps');
  assert.equal(deathFollowShouldSnap(100, 100 + 16, 64), false, 'a quarter second is still motion');
  assert.equal(deathFollowShouldSnap(100, 100 + 17, 64), true, 'a bigger jump is a seek');
}

{
  assert.equal(nextCamMode('walk', 1), 'fly');
  assert.equal(nextCamMode('fly', 1), 'pov');
  assert.equal(nextCamMode('pov', 1), 'third');
  assert.equal(nextCamMode('third', 1), 'walk');
  assert.equal(nextCamMode('walk', -1), 'third');
  assert.equal(nextCamMode('unknown', 1), 'fly', 'an unknown mode starts the cycle');
}

{
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => specKeyForSeat('left', i)),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => specKeyForSeat('right', i)),
    [6, 7, 8, 9, 0]
  );
}

{
  assert.equal(canSpectateSlot([{ alive: true }, { alive: false }], 0), true);
  assert.equal(canSpectateSlot([{ alive: true }, { alive: false }], 1), false);
  assert.equal(canSpectateSlot([], 0), false);
}

console.log('view3dFollow.test.js: ok');
