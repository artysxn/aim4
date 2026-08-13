// Run: node shared/sim/observe.test.js
//
// The observation vector is a CONTRACT: fixed order, fixed width, versioned,
// normalized. The tests hold the contract rather than any particular value —
// a policy trained on v1 vectors must either get v1 vectors or a loud error.

import {
  OBSERVATION_BLOCKS,
  OBSERVATION_SIZE,
  OBSERVE_VERSION,
  buildObservation,
  weaponClassOf
} from './observe.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const sample = (over = {}) =>
  buildObservation({
    me: {
      x: 800,
      y: 2400,
      hp: 87,
      armor: 100,
      helmet: true,
      weaponClass: 'rifle',
      hasBomb: false,
      side: 'T'
    },
    round: {
      elapsed: 30,
      secondsLeft: 85,
      planted: false,
      bombSecondsLeft: 0,
      myEquipAvg: 4000,
      enemyEquipAvgBelieved: 4050
    },
    myAlive: 5,
    enemyAliveBelieved: 4,
    belief: {
      siteExpected: [2.5, 1.5],
      sitePEmpty: [0.1, 0.4],
      splitEntropy: 1.2,
      threatAtMe: 0.3
    },
    teammates: [
      { dx: 100, dy: -50, hp: 100 },
      { dx: -300, dy: 900, hp: 55 }
    ],
    recency: { sinceSeenSeconds: 2, sinceHeardSeconds: 0.5 },
    ...over
  });

// ---- the contract -------------------------------------------------------------

{
  assert(OBSERVE_VERSION === 1, 'the version is stamped');
  const width = OBSERVATION_BLOCKS.reduce((s, [, w]) => s + w, 0);
  assert(width === OBSERVATION_SIZE, 'the layout adds up');

  const v = sample();
  assert(v.length === OBSERVATION_SIZE, `the vector is the layout (${v.length})`);
  assert(v.every((x) => Number.isFinite(x)), 'every float is a float');
  assert(v.every((x) => x >= -1.5 && x <= 1.5), 'and roughly normalized');

  const again = sample();
  assert(JSON.stringify(v) === JSON.stringify(again), 'deterministic');
}

// ---- the values mean what they say ----------------------------------------------

{
  const t = sample();
  const ct = sample({
    me: {
      x: 800,
      y: 2400,
      hp: 87,
      armor: 100,
      helmet: true,
      weaponClass: 'rifle',
      hasBomb: false,
      side: 'CT'
    }
  });
  assert(t[11] === 1 && ct[11] === -1, 'the side flag flips');

  const hurt = sample({
    me: {
      x: 800,
      y: 2400,
      hp: 10,
      armor: 0,
      helmet: false,
      weaponClass: 'pistol',
      hasBomb: true,
      side: 'T'
    }
  });
  assert(hurt[2] < t[2], 'hp reads lower when lower');
  assert(hurt[10] === 1 && t[10] === 0, 'the bomb is carried in the vector');

  // Missing teammates pad with zeros, missing recency reads stale.
  const lonely = sample({ teammates: [], recency: undefined });
  assert(lonely.length === OBSERVATION_SIZE, 'padding keeps the width');
  const recencyStart = OBSERVATION_SIZE - 2;
  assert(lonely[recencyStart] === 1 && lonely[recencyStart + 1] === 1, 'no news reads stale');
}

// ---- weapon classes -------------------------------------------------------------

{
  assert(weaponClassOf('rifle') === 'rifle', 'a rifle is a rifle');
  assert(weaponClassOf('sniper') === 'sniper', 'the AWP has its own flag');
  assert(weaponClassOf('grenade') === 'other', 'everything else is other');
}

console.log('observe: ok');
