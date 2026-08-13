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
  assert(OBSERVE_VERSION === 3, 'the version is stamped');
  const width = OBSERVATION_BLOCKS.reduce((s, [, w]) => s + w, 0);
  assert(width === OBSERVATION_SIZE, 'the layout adds up');

  const v = sample();
  assert(v.length === OBSERVATION_SIZE, `the vector is the layout (${v.length})`);
  assert(v.every((x) => Number.isFinite(x)), 'every float is a float');
  assert(v.every((x) => x >= -1.5 && x <= 1.5), 'and roughly normalized');

  const again = sample();
  assert(JSON.stringify(v) === JSON.stringify(again), 'deterministic');
}

// ---- the doctrine block (20.4) --------------------------------------------------

{
  // A caller without a doctrine frame is a valid caller: a scripted controller
  // and a test both have none, and the block must read as "no doctrine" rather
  // than throwing or producing NaN.
  const bare = sample();
  assert(bare.every((x) => Number.isFinite(x)), 'the block tolerates an absent frame');

  const withFrame = sample({
    doctrine: {
      zone: { safe: 6, risk: 2, buffer: 4, unknown: 8 },
      utility: { ourHeavy: 3, ourLight: 2, theirHeavy: 1, theirLight: 0, heavyBalance: 2 },
      threat: [{ site: 'a', expected: 2.5, pEmpty: 0.1, secondsToConvert: 12 }],
      timing: [{ zone: 'banana', ourEta: 4, theirEta: 9, edge: 5 }]
    }
  });
  assert(withFrame.length === OBSERVATION_SIZE, 'the frame does not change the width');
  assert(
    JSON.stringify(withFrame) !== JSON.stringify(bare),
    'and a doctrine read actually reaches the vector'
  );
  assert(withFrame.every((x) => x >= -1.5 && x <= 1.5), 'still normalized');

  // The zone classes are a distribution over the map, so they sum to one.
  let start = 0;
  for (const [name, w] of OBSERVATION_BLOCKS) {
    if (name === 'doctrine') break;
    start += w;
  }
  const classes = withFrame.slice(start, start + 4);
  assert(Math.abs(classes.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'zone classes are a share');

  // A side ahead on heavy utility reads positive; behind reads negative. That
  // sign is the number chapter 11 says decides late rounds.
  const behind = sample({
    doctrine: { utility: { ourHeavy: 0, ourLight: 0, theirHeavy: 3, heavyBalance: -3 } }
  });
  assert(withFrame[start + 7] > 0 && behind[start + 7] < 0, 'the heavy balance is signed');
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
  // Offset from the layout, not from the end: blocks get appended, and a test
  // that counts backwards from the tail breaks every time one does.
  let recencyStart = 0;
  for (const [name, w] of OBSERVATION_BLOCKS) {
    if (name === 'recency') break;
    recencyStart += w;
  }
  assert(lonely[recencyStart] === 1 && lonely[recencyStart + 1] === 1, 'no news reads stale');
}

// ---- the visualization block (19.12) -------------------------------------------

{
  const bare = sample();
  const vizStart = (() => {
    let s = 0;
    for (const [name, w] of OBSERVATION_BLOCKS) {
      if (name === 'viz') return s;
      s += w;
    }
    return s;
  })();
  assert(
    bare.slice(vizStart).every((x) => x === 0),
    'an absent viz frame is sixteen zeros'
  );

  const withViz = sample({
    viz: {
      awpThreat: 0.8,
      rifleThreat: 0.2,
      uncoveredMass: 0.4,
      voi: 0.15,
      secondsAffordable: 4,
      breadth: 0.6,
      pairDx: 400,
      pairDy: -200,
      pairWindow: 2,
      requestToMe: 1,
      requestFromMe: 0,
      layout0: 0.55,
      layout1: 0.3,
      novelty: true,
      vizSpend: 0.4,
      assigned: true
    }
  });
  assert(withViz.length === OBSERVATION_SIZE, 'viz does not change the width');
  assert(withViz[vizStart] > bare[vizStart], 'awpThreat reaches the vector');
  assert(withViz[vizStart + 13] === 1 && withViz[vizStart + 15] === 1, 'flags are 0/1');
  assert(withViz.every((x) => x >= -1.5 && x <= 1.5), 'viz stays normalized');
}

// ---- weapon classes -------------------------------------------------------------

{
  assert(weaponClassOf('rifle') === 'rifle', 'a rifle is a rifle');
  assert(weaponClassOf('sniper') === 'sniper', 'the AWP has its own flag');
  assert(weaponClassOf('grenade') === 'other', 'everything else is other');
}

console.log('observe: ok');
