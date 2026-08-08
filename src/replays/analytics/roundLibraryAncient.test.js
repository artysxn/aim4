// ---------------------------------------------------------------------------
// Ancient round types, definition by definition.
//
// Every matcher here is hand-written against the facts API, and a matcher that
// is subtly wrong returns null, which is exactly what a round that did not
// happen returns. So each call is tested twice: once on a round that is the
// call, and once on the round next door that is deliberately NOT it, with only
// the discriminating clause changed.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { ROUND_LIBRARY } from './roundLibrary.js';
import { SMOKE_SECONDS, secondsAtClock } from './roundFacts.js';
import { fakeRound } from './roundFactsFake.js';

const clock = (c) => secondsAtClock(c);
const round = fakeRound;


const defOf = (side, key) => {
  const hit = ROUND_LIBRARY.ANC[side].find((d) => d.key === key);
  assert.ok(hit, `${key} exists`);
  return hit;
};
const hits = (side, key, f) => defOf(side, key).match(f);

/** Four bodies on the ramp for the whole round. */
const rampStack = (n, names = ['B Ramp']) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, names }));

// ---------------------------------------------------------------------------
// B Ramp family
// ---------------------------------------------------------------------------

{
  const stays = [
    ...rampStack(4),
    // Two of them step onto the site inside 1:33, which is the commit.
    { id: 't0', names: ['B + Backsite'], from: 15, to: 60 },
    { id: 't1', names: ['pos:B Ramp'], from: 16, to: 60 },
    { id: 'ct1', names: ['B + Backsite'] },
    { id: 'ct2', names: ['B Cave'] }
  ];
  const duels = [
    { sec: 8, ours: 't0', enemy: 'ct1' },
    { sec: 9, ours: 't1', enemy: 'ct2' }
  ];
  assert.ok(
    hits('T', 'anc-b-rush', round('T', { stays, enemies: ['ct1', 'ct2'], fights: duels })),
    'four on ramp trading with both holders by 1:40, two in by 1:33, is a B Rush'
  );
  assert.equal(
    hits('T', 'anc-b-rush', round('T', { stays, enemies: ['ct1', 'ct2'], fights: [duels[0]] })),
    null,
    'one man trading is not a rush'
  );
  assert.equal(
    hits(
      'T',
      'anc-b-rush',
      round('T', {
        stays: [...rampStack(4), { id: 'ct1', names: ['B + Backsite'] }, { id: 'ct2', names: ['B Cave'] }],
        enemies: ['ct1', 'ct2'],
        fights: duels
      })
    ),
    null,
    'and trading from the ramp without anyone going in is not either'
  );
  assert.equal(
    hits(
      'T',
      'anc-b-rush',
      round('T', {
        stays,
        enemies: ['ct1', 'ct2'],
        fights: duels.map((x) => ({ ...x, sec: 20 }))
      })
    ),
    null,
    'and neither is the same trade after 1:40'
  );
}

{
  // B AWP search: it has to be the FIRST contact that carries the AWP.
  const stays = [...rampStack(2), { id: 'ct1', names: ['B + Backsite'] }];
  const base = { stays, enemies: ['ct1'] };
  assert.ok(
    hits(
      'T',
      'anc-b-awp',
      round('T', { ...base, awp: ['t0'], fights: [{ sec: 10, ours: 't0', enemy: 'ct1' }] })
    ),
    'the AWPer opening on a B holder is a search'
  );
  assert.equal(
    hits(
      'T',
      'anc-b-awp',
      round('T', {
        ...base,
        awp: ['t0'],
        fights: [
          { sec: 8, ours: 't1', enemy: 'ct1' },
          { sec: 10, ours: 't0', enemy: 'ct1' }
        ]
      })
    ),
    null,
    'a rifler opening first is a different round however the AWP ends it'
  );
  assert.equal(
    hits(
      'T',
      'anc-b-awp',
      round('T', { ...base, awp: ['t0'], fights: [{ sec: 30, ours: 't0', enemy: 'ct1' }] })
    ),
    null,
    'and the contact has to come by 1:28'
  );
}

{
  // Pop and Execute are the same push either side of the execute smokes.
  const stays = [...rampStack(3), { id: 'ct1', names: ['B + Backsite'] }];
  const duels = [
    { sec: 20, ours: 't0', enemy: 'ct1' },
    { sec: 21, ours: 't1', enemy: 'ct1' }
  ];
  const smokeAt = (at) => [{ name: 'short', type: 'smokegrenade', at, names: ['B + Backsite'] }];

  const early = round('T', { stays, enemies: ['ct1'], fights: duels, nades: smokeAt(40) });
  assert.ok(hits('T', 'anc-b-pop', early), 'trading before the short smoke is a Pop');
  assert.equal(hits('T', 'anc-b-exec', early), null, 'and never also an Execute');

  const late = round('T', { stays, enemies: ['ct1'], fights: duels, nades: smokeAt(18) });
  assert.ok(hits('T', 'anc-b-exec', late), 'trading after it is an Execute');
  assert.equal(hits('T', 'anc-b-pop', late), null, 'and never also a Pop');

  assert.ok(
    hits('T', 'anc-b-pop', round('T', { stays, enemies: ['ct1'], fights: duels })),
    'no execute smoke at all still leaves a Pop'
  );
  assert.equal(
    hits('T', 'anc-b-exec', round('T', { stays, enemies: ['ct1'], fights: duels })),
    null,
    'but not an Execute'
  );

  assert.equal(
    hits(
      'T',
      'anc-b-pop',
      round('T', { stays, enemies: ['ct1'], fights: [duels[0]], nades: smokeAt(40) })
    ),
    null,
    'one man trading is not a push'
  );
  assert.equal(
    hits(
      'T',
      'anc-b-pop',
      round('T', { stays: stays.slice(1), enemies: ['ct1'], fights: duels, nades: smokeAt(40) })
    ),
    null,
    'and neither is two men doing it off a two-man ramp'
  );

  // "Into B" is the SITE or the B Ramp position, and the ramp zone the stack is
  // standing in is neither. A trade with nobody stepping up is not a push.
  assert.equal(
    hits(
      'T',
      'anc-b-pop',
      round('T', {
        stays,
        enemies: ['ct1'],
        fights: duels.map((x) => ({ ...x, kill: true, killedThem: true })),
        nades: smokeAt(40)
      })
    ),
    null,
    'a trade nobody followed up on is not a push'
  );
  assert.ok(
    hits(
      'T',
      'anc-b-pop',
      round('T', {
        stays: [...stays, { id: 't0', names: ['pos:B Ramp'], from: 30, to: 60 }],
        enemies: ['ct1'],
        fights: duels.map((x) => ({ ...x, kill: true, killedThem: true })),
        nades: smokeAt(40)
      })
    ),
    'stepping onto the B Ramp position after the trade is'
  );
}

{
  // B Split: which ground the fight happened on sets the follow-up window.
  const smoke = [{ name: 'bcave', type: 'smokegrenade', at: 5, names: ['B + Backsite'] }];
  const cave = round('T', {
    stays: [
      { id: 't0', names: ['B Cave'], from: 0, to: 40 },
      { id: 't1', names: ['B Ramp'], from: 0, to: 40 },
      { id: 't2', names: ['B + Backsite'], from: 21, to: 40 },
      { id: 'ct1', names: ['B Cave'] }
    ],
    enemies: ['ct1'],
    nades: smoke,
    fights: [{ sec: 10, ours: 't0', enemy: 'ct1' }]
  });
  assert.ok(hits('T', 'anc-b-split', cave), 'a cave fight gets 12s for the follow-up');

  const ramp = (arriveAt) =>
    round('T', {
      stays: [
        { id: 't0', names: ['B Cave'], from: 0, to: 40 },
        { id: 't1', names: ['B Ramp'], from: 0, to: 40 },
        { id: 't2', names: ['B + Backsite'], from: arriveAt, to: 40 },
        { id: 'ct1', names: ['B Ramp'] }
      ],
      enemies: ['ct1'],
      nades: smoke,
      fights: [{ sec: 10, ours: 't0', enemy: 'ct1' }]
    });
  assert.ok(hits('T', 'anc-b-split', ramp(17)), 'a ramp fight gets 8s');
  assert.equal(hits('T', 'anc-b-split', ramp(21)), null, 'and not a second longer');
  assert.equal(
    hits(
      'T',
      'anc-b-split',
      round('T', {
        stays: [
          { id: 't0', names: ['B Cave'] },
          { id: 't1', names: ['B Ramp'] },
          { id: 'ct1', names: ['B Cave'] }
        ],
        enemies: ['ct1'],
        fights: [{ sec: 10, ours: 't0', enemy: 'ct1' }]
      })
    ),
    null,
    'a split with no smoke on the site is not the call'
  );
}

{
  // B Fake: two bodies, a spend, and neither of them goes in.
  const stays = [
    { id: 't0', names: ['B Ramp'] },
    { id: 't1', names: ['B Street'] }
  ];
  const spend = [{ name: 'bcave', type: 'smokegrenade', at: 10, player: 't0', names: ['B Cave'] }];
  assert.ok(hits('T', 'anc-b-fake', round('T', { stays, nades: spend })), 'two men and a smoke');
  assert.equal(
    hits(
      'T',
      'anc-b-fake',
      round('T', {
        stays: [...stays, { id: 't0', names: ['B + Backsite'], from: 20, to: 40 }],
        nades: spend
      })
    ),
    null,
    'a faker who walks in has not faked anything'
  );
  assert.equal(
    hits('T', 'anc-b-fake', round('T', { stays: rampStack(3), nades: spend })),
    null,
    'three bodies is a push, not a fake'
  );
  assert.ok(
    hits(
      'T',
      'anc-b-fake',
      round('T', {
        stays,
        nades: [
          { type: 'flashbang', at: 10, player: 't0', names: ['B + Backsite'] },
          { type: 'flashbang', at: 11, player: 't1', names: ['B + Backsite'] }
        ]
      })
    ),
    'two flashes onto the site count as the spend'
  );
}

{
  // The lurk smoke is one call or the other, never both and never neither.
  const smoke = [{ name: 'blurk', type: 'smokegrenade', at: 10, names: ['B Ramp'] }];
  const quiet = round('T', { stays: [{ id: 't0', names: ['T Spawn'] }], nades: smoke });
  assert.ok(hits('T', 'anc-b-lurk-fake', quiet), 'nothing behind the smoke is the fake');
  assert.equal(hits('T', 'anc-b-lurk', quiet), null);

  const live = round('T', {
    stays: [{ id: 't0', names: ['B + Backsite'], from: 12, to: 30 }],
    nades: smoke
  });
  assert.ok(hits('T', 'anc-b-lurk', live), 'a body into B while it is up is the real thing');
  assert.equal(hits('T', 'anc-b-lurk-fake', live), null);

  const traded = round('T', {
    stays: [
      { id: 't0', names: ['T Spawn'] },
      { id: 'ct1', names: ['NiKo'] }
    ],
    enemies: ['ct1'],
    nades: smoke,
    fights: [{ sec: 15, ours: 't0', enemy: 'ct1', kill: true, killedThem: true }]
  });
  assert.ok(hits('T', 'anc-b-lurk', traded), 'so is a kill on that ground');

  const after = round('T', {
    stays: [{ id: 't0', names: ['B + Backsite'], from: 10 + SMOKE_SECONDS + 2, to: 60 }],
    nades: smoke
  });
  assert.ok(hits('T', 'anc-b-lurk-fake', after), 'walking in once it has faded is still a fake');
}

// ---------------------------------------------------------------------------
// Mid
// ---------------------------------------------------------------------------

{
  const cross = (at) => [
    { id: 't0', names: ['Elbow'], from: 0, to: at - 1 },
    { id: 't0', names: ['Mid 1'], from: at, to: 60 }
  ];
  assert.ok(
    hits('T', 'anc-mid-rush', round('T', { stays: cross(clock('1:48')) })),
    'elbow into Mid 1 by 1:46 is a rush'
  );
  assert.equal(
    hits('T', 'anc-mid-rush', round('T', { stays: cross(clock('1:44')) })),
    null,
    'after 1:46 it is not'
  );

  const late = { stays: cross(clock('1:44')) };
  assert.ok(
    hits(
      'T',
      'anc-mid-pop',
      round('T', late, {
        nades: [{ name: 'elbow', type: 'smokegrenade', at: clock('1:46'), names: ['Elbow'] }]
      })
    ),
    'the same crossing into a live CT elbow smoke is a pop'
  );
  assert.equal(
    hits('T', 'anc-mid-pop', round('T', late)),
    null,
    'without the CT smoke there is nothing to pop through'
  );
  assert.equal(
    hits(
      'T',
      'anc-mid-pop',
      round(
        'T',
        { stays: cross(40) },
        { nades: [{ name: 'elbow', type: 'smokegrenade', at: 0, names: ['Elbow'] }] }
      )
    ),
    null,
    'and a smoke that has already faded does not count'
  );
}

{
  // Mid split, both endings.
  const base = [
    { id: 't0', names: ['Elbow'], from: 0, to: 14 },
    { id: 't0', names: ['Mid 1'], from: 15, to: 60 },
    { id: 't1', names: ['Street'], from: 0, to: 14 },
    { id: 't1', names: ['Heaven'], from: 15, to: 60 }
  ];
  assert.ok(
    hits(
      'T',
      'anc-mid-split',
      round('T', {
        stays: [...base, { id: 'ct1', names: ['CT Mid'] }],
        enemies: ['ct1'],
        fights: [{ sec: 18, ours: 't0', enemy: 'ct1' }]
      })
    ),
    'a duel into CT Mid closes the split'
  );
  assert.ok(
    hits(
      'T',
      'anc-mid-split',
      round('T', {
        stays: [
          ...base,
          { id: 't2', names: ['CT Mid'], from: 20, to: 40 },
          { id: 't3', names: ['CT Mid'], from: 20, to: 40 }
        ]
      })
    ),
    'so does two bodies past Mid 1 by 1:30'
  );
  assert.equal(
    hits(
      'T',
      'anc-mid-split',
      round('T', {
        stays: [
          ...base,
          { id: 't2', names: ['CT Mid', 'Mid 1'], from: 20, to: 40 },
          { id: 't3', names: ['CT Mid', 'Mid 1'], from: 20, to: 40 }
        ]
      })
    ),
    null,
    'two bodies standing IN Mid 1 have not got past it'
  );
  assert.equal(
    hits(
      'T',
      'anc-mid-split',
      round('T', {
        stays: [
          { id: 't0', names: ['Elbow'], from: 0, to: 14 },
          { id: 't0', names: ['Mid 1'], from: 15, to: 60 },
          { id: 't1', names: ['Street'], from: 0, to: 39 },
          { id: 't1', names: ['Heaven'], from: 40, to: 60 },
          { id: 't2', names: ['CT Mid'], from: 20, to: 40 },
          { id: 't3', names: ['CT Mid'], from: 20, to: 40 }
        ]
      })
    ),
    null,
    'heaven 25s later is not the same call'
  );
}

{
  const mid = (extra = []) =>
    round('T', {
      stays: [{ id: 't0', names: ['T Spawn'] }, ...extra],
      nades: [
        { name: 'window', type: 'smokegrenade', at: 4, names: ['Window'] },
        { name: 'jungle', type: 'molotov', at: 6, names: ['Jungle'] },
        { type: 'flashbang', at: 10, from: ['T Spawn'], names: ['Mid 1'] },
        { type: 'flashbang', at: 12, from: ['Elbow'], names: ['Mid 1'] }
      ]
    });
  assert.ok(hits('T', 'anc-mid-fake', mid()), 'smoke, molotov, two flashes and nobody goes');
  assert.equal(
    hits(
      'T',
      'anc-mid-fake',
      mid([
        { id: 't1', names: ['Elbow'], from: 0, to: 8 },
        { id: 't1', names: ['Mid 1'], from: 9, to: 40 }
      ])
    ),
    null,
    'a body into Mid 1 by 1:41 is a take, not a fake'
  );
  assert.equal(
    hits('T', 'anc-mid-fake', mid([{ id: 't1', names: ['Heaven'], from: 10, to: 40 }])),
    null,
    'and so is heaven by 1:37'
  );
}

// ---------------------------------------------------------------------------
// A
// ---------------------------------------------------------------------------

{
  const aSmoke = (at) => ({ name: '', type: 'smokegrenade', at, thrown: at, names: ['A Donut'] });
  const stack = [
    { id: 't0', names: ['A Main'] },
    { id: 't1', names: ['A Main'] },
    { id: 't2', names: ['A Main'] },
    { id: 'ct1', names: ['A Site'] }
  ];
  const commit = [
    { sec: 25, ours: 't0', enemy: 'ct1' },
    { sec: 26, ours: 't1', enemy: 'ct1' }
  ];
  assert.ok(
    hits(
      'T',
      'anc-a-rush',
      round('T', { stays: stack, enemies: ['ct1'], nades: [aSmoke(10)], fights: commit })
    ),
    'a smoke by 1:39 with three in A Main and two committing is a rush'
  );
  assert.equal(
    hits(
      'T',
      'anc-a-rush',
      round('T', { stays: stack, enemies: ['ct1'], nades: [aSmoke(30)], fights: commit })
    ),
    null,
    'a smoke thrown after 1:39 is a different call'
  );
  assert.ok(
    hits(
      'T',
      'anc-a-exec',
      round('T', {
        stays: stack,
        enemies: ['ct1'],
        nades: [aSmoke(10), aSmoke(12)],
        fights: commit
      })
    ),
    'two smokes make it an execute'
  );
  assert.equal(
    hits(
      'T',
      'anc-a-exec',
      round('T', { stays: stack, enemies: ['ct1'], nades: [aSmoke(10)], fights: commit })
    ),
    null,
    'one does not'
  );

  assert.ok(
    hits(
      'T',
      'anc-a-fake-fast',
      round('T', { stays: [{ id: 't0', names: ['A Main'] }], nades: [aSmoke(10)] })
    ),
    'the same early smoke with one body is the fast fake'
  );
  assert.equal(
    hits('T', 'anc-a-fake-fast', round('T', { stays: stack, nades: [aSmoke(10)] })),
    null,
    'three bodies is not'
  );

  assert.ok(
    hits(
      'T',
      'anc-a-fake-late',
      round('T', {
        stays: [{ id: 't0', names: ['A Main'], from: 30, to: 60 }],
        nades: [aSmoke(20)]
      })
    ),
    'a smoke after 1:39 with one body behind it is the late fake'
  );
  assert.equal(
    hits(
      'T',
      'anc-a-fake-late',
      round('T', {
        stays: [{ id: 't0', names: ['CT Donut'], from: 25, to: 60 }],
        nades: [aSmoke(20)]
      })
    ),
    null,
    'a body in CT Donut inside the first 10s of the smoke breaks it'
  );
}

{
  assert.ok(
    hits(
      'T',
      'anc-a-split',
      round('T', {
        stays: [
          { id: 't0', names: ['A Main'] },
          { id: 't1', names: ['CT Spawn'] },
          { id: 'ct1', names: ['A Site'] }
        ],
        enemies: ['ct1'],
        fights: [{ sec: 20, ours: 't1', enemy: 'ct1' }]
      })
    ),
    'A Main plus CT Spawn duelling the site is a split'
  );
  assert.equal(
    hits(
      'T',
      'anc-a-split',
      round('T', {
        stays: [
          { id: 't0', names: ['A Main'] },
          { id: 't1', names: ['A Main'] },
          { id: 'ct1', names: ['A Site'] }
        ],
        enemies: ['ct1'],
        fights: [{ sec: 20, ours: 't1', enemy: 'ct1' }]
      })
    ),
    null,
    'two men down the same lane is not'
  );
}

{
  const window = (arriveAt) =>
    round('T', {
      stays: [
        { id: 't0', names: ['Redroom'], from: 10, to: 12 },
        { id: 't0', names: ['CT Spawn'], from: arriveAt, to: 60 }
      ]
    });
  assert.ok(hits('T', 'anc-window-take', window(20)), 'Redroom into CT Spawn inside 15s');
  assert.equal(hits('T', 'anc-window-take', window(30)), null, 'and not outside it');
}

{
  assert.ok(
    hits(
      'T',
      'anc-b-cave-take',
      round('T', {
        stays: [
          { id: 't0', names: ['Street'], from: 0, to: 10 },
          { id: 't0', names: ['CT Cave'], from: 11, to: 40 }
        ]
      })
    ),
    'street into CT Cave by 1:38'
  );
  assert.ok(
    hits(
      'T',
      'anc-b-cave-take',
      round('T', {
        stays: [
          { id: 't0', names: ['Street'] },
          { id: 'ct1', names: ['CT Cave'] }
        ],
        enemies: ['ct1'],
        fights: [{ sec: 12, ours: 't0', enemy: 'ct1' }]
      })
    ),
    'or a fight into it'
  );
  assert.equal(
    hits(
      'T',
      'anc-b-cave-take',
      round('T', {
        stays: [
          { id: 't0', names: ['Street'], from: 0, to: 30 },
          { id: 't0', names: ['CT Cave'], from: 31, to: 60 }
        ]
      })
    ),
    null,
    'after 1:38 it is not fast'
  );
}

// ---------------------------------------------------------------------------
// CT mid headcount: a partition, read strictest first
// ---------------------------------------------------------------------------

const ctMid = (stays) => round('CT', { stays });

{
  const retake = ctMid([
    { id: 'c0', names: ['CT Mid'], from: 0, to: 5 },
    { id: 'c1', names: ['CT Mid'], from: 25, to: 60 },
    { id: 'c2', names: ['CT Mid'], from: 25, to: 60 }
  ]);
  assert.ok(hits('CT', 'anc-ct-mid-retake', retake), 'one man early, two back into mid after 1:35');
  assert.equal(
    hits(
      'CT',
      'anc-ct-mid-retake',
      round('CT', {
        stays: [
          { id: 'c0', names: ['CT Mid'], from: 0, to: 5 },
          { id: 'c1', names: ['CT Mid'], from: 25, to: 60 },
          { id: 'c2', names: ['CT Mid'], from: 25, to: 60 }
        ],
        deaths: { c0: 20 }
      })
    ),
    null,
    'a mid retaken over the body of the man who held it is a different round'
  );
  assert.equal(
    hits(
      'CT',
      'anc-ct-mid-retake',
      ctMid([
        { id: 'c0', names: ['CT Mid'], from: 0, to: 5 },
        { id: 'c1', names: ['CT Mid'], from: 25, to: 60 },
        { id: 'c2', names: ['CT Window'], from: 25, to: 60 }
      ])
    ),
    null,
    'and the two coming back have to be in CT Mid itself'
  );

  const pop = ctMid([
    { id: 'c0', names: ['CT Mid'], from: 0, to: 10 },
    { id: 'c1', names: ['CT Mid'], from: 0, to: 10 },
    { id: 'c0', names: ['CT Mid'], from: 25, to: 60 },
    { id: 'c1', names: ['CT Mid'], from: 25, to: 60 },
    { id: 'c2', names: ['CT Donut'], from: 25, to: 60 }
  ]);
  assert.equal(hits('CT', 'anc-ct-mid-retake', pop), null, 'two men early is not a retake');
  assert.ok(hits('CT', 'anc-ct-3-mid-pop', pop), 'but three arriving late is a pop');

  const three = ctMid([
    { id: 'c0', names: ['CT Mid'], from: 0, to: 60 },
    { id: 'c1', names: ['CT Mid'], from: 0, to: 60 },
    { id: 'c2', names: ['CT Window'], from: 0, to: 60 }
  ]);
  assert.equal(hits('CT', 'anc-ct-3-mid-pop', three), null, 'a trio that was there all along');
  assert.ok(hits('CT', 'anc-ct-3-mid', three), 'is the three mid fight');
  assert.equal(
    hits(
      'CT',
      'anc-ct-3-mid',
      ctMid([
        { id: 'c0', names: ['CT Mid'], from: 0, to: 60 },
        { id: 'c1', names: ['CT Mid'], from: 0, to: 60 },
        { id: 'c2', names: ['CT Window'], from: 10, to: 13 }
      ])
    ),
    null,
    'three men together for 4s is a walk-through'
  );

  const two = ctMid([
    { id: 'c0', names: ['CT Mid'], from: 0, to: 60 },
    { id: 'c1', names: ['CT Window'], from: 0, to: 14 },
    { id: 'c1', names: ['Mid 2'], from: 15, to: 60 }
  ]);
  assert.ok(hits('CT', 'anc-ct-2-mid', two), 'the two-man shape and the step up, both by 1:35');
  assert.equal(
    hits(
      'CT',
      'anc-ct-2-mid',
      ctMid([
        { id: 'c0', names: ['CT Mid'], from: 0, to: 60 },
        { id: 'c1', names: ['CT Window'], from: 0, to: 60 }
      ])
    ),
    null,
    'holding and never stepping up is not the call'
  );
  assert.equal(
    hits(
      'CT',
      'anc-ct-2-mid',
      ctMid([
        { id: 'c0', names: ['CT Mid'], from: 0, to: 60 },
        { id: 'c1', names: ['CT Window'], from: 0, to: 24 },
        { id: 'c1', names: ['Ledge'], from: 25, to: 60 }
      ])
    ),
    null,
    'and a step up after 1:35 is too late'
  );
  assert.equal(
    hits(
      'CT',
      'anc-ct-2-mid',
      ctMid([
        { id: 'c0', names: ['CT Mid'], from: 0, to: 60 },
        { id: 'c1', names: ['CT Mid'], from: 0, to: 60 },
        { id: 'c2', names: ['CT Mid'], from: 0, to: 60 },
        { id: 'c3', names: ['Mid 2'], from: 10, to: 60 }
      ])
    ),
    null,
    'three in mid is not the two-man shape'
  );
}

// ---------------------------------------------------------------------------
// CT utility and street
// ---------------------------------------------------------------------------

{
  const molo = (name, at) => ({ name, type: 'molotov', at, names: ['CT Mid'] });
  assert.ok(
    hits('CT', 'anc-ct-double-molo-mid', round('CT', { nades: [molo('elbowmolo', 5), molo('deepmid', 8)] })),
    'two of the three mid molotovs'
  );
  assert.equal(
    hits('CT', 'anc-ct-double-molo-mid', round('CT', { nades: [molo('elbowmolo', 5)] })),
    null,
    'one is not two'
  );

  assert.ok(
    hits(
      'CT',
      'anc-ct-smoke-mid',
      round('CT', { nades: [{ name: 'elbow', type: 'smokegrenade', at: clock('1:46'), names: [] }] })
    ),
    'an elbow smoke by 1:44'
  );
  assert.equal(
    hits(
      'CT',
      'anc-ct-smoke-mid',
      round('CT', { nades: [{ name: 'elbow', type: 'smokegrenade', at: clock('1:40'), names: [] }] })
    ),
    null,
    'and not one after it'
  );

  const he = (at) => ({ name: 'street', type: 'hegrenade', at, names: [] });
  assert.ok(
    hits('CT', 'anc-ct-double-he-lane', round('CT', { nades: [he(5), he(8)] })),
    'two street HEs by 1:44'
  );
  assert.equal(hits('CT', 'anc-ct-double-he-lane', round('CT', { nades: [he(5), he(20)] })), null);

  const ramp = (at) => ({ type: 'hegrenade', at, names: ['B Ramp'] });
  assert.ok(
    hits('CT', 'anc-ct-double-he-ramp', round('CT', { nades: [ramp(5), ramp(9)] })),
    'two HEs into the ramp'
  );
}

{
  const breakIt = (stays) =>
    round('CT', {
      stays,
      nades: [{ type: 'hegrenade', at: clock('1:40'), names: ['Window'] }]
    });
  assert.ok(hits('CT', 'anc-ct-window-break', breakIt([])), 'an HE into window with nobody up');
  assert.equal(
    hits('CT', 'anc-ct-window-break', breakIt([{ id: 'c0', names: ['Ledge'], from: 5, to: 10 }])),
    null,
    'a CT already on the ledge means the window was not the plan'
  );
  assert.equal(
    hits(
      'CT',
      'anc-ct-window-break',
      round('CT', { nades: [{ type: 'hegrenade', at: clock('1:20'), names: ['Window'] }] })
    ),
    null,
    'and the HE has to land inside 1:50 to 1:30'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'anc-ct-runboost',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Mid 3'], from: 0, to: 10 },
          { id: 'c1', names: ['Mid 3'], from: 0, to: 10 },
          { id: 'c1', names: ['runboost'], from: 11, to: 30 }
        ]
      })
    ),
    'two onto Mid 3 and one up on the boost by 1:41'
  );
  assert.equal(
    hits(
      'CT',
      'anc-ct-runboost',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Mid 3'], from: 0, to: 10 },
          { id: 'c1', names: ['Mid 3'], from: 0, to: 10 },
          { id: 'c1', names: ['runboost'], from: 20, to: 30 }
        ]
      })
    ),
    null,
    'a boost after 1:41 is a different round'
  );
}

{
  const take = (from, to) => [
    { id: 'c0', names: ['Heaven'], from, to },
    { id: 'c1', names: ['Street'], from, to },
    { id: 'c2', names: ['B Ramp'], from, to }
  ];
  const fast = round('CT', { stays: take(5, 15) });
  assert.ok(hits('CT', 'anc-ct-street-fast', fast), 'three on the street ground before 1:33');
  assert.equal(hits('CT', 'anc-ct-street-late', fast), null, 'and it is not also the late one');

  const late = round('CT', { stays: take(30, 45) });
  assert.ok(hits('CT', 'anc-ct-street-late', late), 'the same take after 1:33');
  assert.equal(hits('CT', 'anc-ct-street-fast', late), null);

  assert.equal(
    hits('CT', 'anc-ct-street-fast', round('CT', { stays: take(5, 6) })),
    null,
    'two seconds is walking past, not taking it'
  );
}

{
  const door = [{ name: 'door', type: 'smokegrenade', at: 8, names: ['B Door'] }];
  assert.ok(
    hits(
      'CT',
      'anc-ct-door-fight',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Street'], from: 10, to: 20 },
          { id: 'c0', names: ['Bucket'], from: 21, to: 40 }
        ],
        nades: door
      })
    ),
    'a door smoke that a CT actually walks behind'
  );
  assert.ok(
    hits(
      'CT',
      'anc-ct-door-fight',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Heaven'], from: 10, to: 40 },
          { id: 't1', names: ['B Street'] }
        ],
        enemies: ['t1'],
        nades: door,
        fights: [{ sec: 15, ours: 'c0', enemy: 't1' }]
      })
    ),
    'or fights behind'
  );

  const fake = round('CT', { stays: [{ id: 'c0', names: ['B CT'] }], nades: door });
  assert.ok(hits('CT', 'anc-ct-door-fake', fake), 'a door smoke nobody follows is the fake');
  assert.equal(hits('CT', 'anc-ct-door-fight', fake), null);
}

{
  assert.ok(
    hits(
      'CT',
      'anc-ct-2a-main',
      round('CT', {
        stays: [
          { id: 'c0', names: ['A Main'], from: 0, to: 30 },
          { id: 'c1', names: ['A'], from: 0, to: 30 }
        ]
      })
    ),
    'two CTs sitting A Main for more than 5s'
  );
  assert.equal(
    hits(
      'CT',
      'anc-ct-2a-main',
      round('CT', {
        stays: [
          { id: 'c0', names: ['A Main'], from: 0, to: 3 },
          { id: 'c1', names: ['A Main'], from: 0, to: 3 }
        ]
      })
    ),
    null,
    'four seconds is a rotation through'
  );
  assert.ok(
    hits(
      'CT',
      'anc-ct-2a-main',
      round('CT', {
        stays: [
          { id: 'c0', names: ['A Main'], from: 0, to: 3 },
          { id: 'c1', names: ['A Main'], from: 0, to: 3 },
          { id: 't1', names: ['A Site'] }
        ],
        enemies: ['t1'],
        fights: [{ sec: 2, ours: 'c0', enemy: 't1' }]
      })
    ),
    'unless they took a fight there'
  );
}

console.log('roundLibraryAncient.test.js ok');
