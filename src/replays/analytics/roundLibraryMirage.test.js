// ---------------------------------------------------------------------------
// Mirage round types, definition by definition.
//
// Same discipline as the Ancient file: every call is tested on the round that
// is it, and on the round next door with only the discriminating clause
// changed, because a wrong matcher and a round that did not happen both
// return null.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { ROUND_LIBRARY } from './roundLibrary.js';
import { secondsAtClock } from './roundFacts.js';
import { fakeRound } from './roundFactsFake.js';

const clock = (c) => secondsAtClock(c);
const round = fakeRound;

const defOf = (side, key) => {
  const hit = ROUND_LIBRARY.MIR[side].find((d) => d.key === key);
  assert.ok(hit, `${key} exists`);
  return hit;
};
const hits = (side, key, f) => defOf(side, key).match(f);

/** `n` bodies parked on the same ground for the whole round. */
const stack = (n, names, tag = 't') =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, names }));

// ---------------------------------------------------------------------------
// Mid headcount: a partition, read from the fullest down
// ---------------------------------------------------------------------------

{
  assert.ok(
    hits('T', 'mir-mid-rush', round('T', { stays: stack(2, ['Mid']).concat(stack(1, ['T Mid'], 'x')) })),
    'two into mid with a third behind them'
  );
  assert.equal(
    hits('T', 'mir-mid-rush', round('T', { stays: stack(2, ['Mid']) })),
    null,
    'two on their own is not a rush'
  );
  assert.ok(
    hits('T', 'mir-mid-rush', round('T', { stays: stack(3, ['Mid']) })),
    'three into mid needs no support'
  );
  assert.equal(
    hits(
      'T',
      'mir-mid-rush',
      round('T', { stays: stack(3, ['Mid']).map((s) => ({ ...s, from: 30 })) })
    ),
    null,
    'and after 1:35 it is not a rush at all'
  );
}

{
  const held = (n, from, to) => stack(n, ['T Mid']).map((s) => ({ ...s, from, to }));
  assert.ok(
    hits('T', 'mir-4mid', round('T', { stays: held(4, 0, 20) })),
    'four in mid for more than 4s'
  );
  assert.equal(
    hits('T', 'mir-4mid', round('T', { stays: held(4, 0, 3) })),
    null,
    'four seconds exactly is not more than four'
  );
  assert.ok(hits('T', 'mir-3mid', round('T', { stays: held(3, 0, 20) })), 'exactly three');
  assert.equal(
    hits('T', 'mir-3mid', round('T', { stays: held(4, 0, 20) })),
    null,
    'four is not three'
  );
  assert.ok(hits('T', 'mir-2mid', round('T', { stays: held(2, 0, 20) })), 'exactly two');
  assert.equal(
    hits('T', 'mir-2mid', round('T', { stays: held(3, 0, 20) })),
    null,
    'three is not two'
  );
  assert.equal(
    hits('T', 'mir-2mid', round('T', { stays: held(2, 30, 60) })),
    null,
    'and none of them count after 1:30'
  );
}

// ---------------------------------------------------------------------------
// Defaults: where the bodies went, and where they did not
// ---------------------------------------------------------------------------

{
  assert.ok(
    hits('T', 'mir-b-default', round('T', { stays: stack(2, ['T Aps']) })),
    'two down B and nobody at A'
  );
  assert.ok(
    hits(
      'T',
      'mir-b-default',
      round('T', {
        stays: [
          { id: 't0', names: ['Underground'] },
          { id: 't1', names: ['Ladder'] }
        ]
      })
    ),
    'spread across the B staging ground still counts'
  );
  assert.equal(
    hits(
      'T',
      'mir-b-default',
      round('T', { stays: [...stack(2, ['T Aps']), { id: 't9', names: ['T A'] }] })
    ),
    null,
    'one body at A breaks it'
  );

  assert.ok(
    hits('T', 'mir-a-default', round('T', { stays: stack(2, ['T A']) })),
    'two at A and nobody down B'
  );
  assert.equal(
    hits(
      'T',
      'mir-a-default',
      round('T', { stays: [...stack(2, ['T A']), { id: 't9', names: ['Short'] }] })
    ),
    null,
    'with one man down B, two at A is not enough'
  );
  assert.ok(
    hits(
      'T',
      'mir-a-default',
      round('T', { stays: [...stack(3, ['T A']), { id: 't9', names: ['Short'] }] })
    ),
    'three at A is'
  );
  assert.equal(
    hits(
      'T',
      'mir-a-default',
      round('T', {
        stays: [
          ...stack(3, ['T A']),
          { id: 't8', names: ['Short'] },
          { id: 't9', names: ['Ladder'] }
        ]
      })
    ),
    null,
    'two down B is a split, not an A default'
  );
}

// ---------------------------------------------------------------------------
// B
// ---------------------------------------------------------------------------

{
  const through = (n, from, to) => [
    ...Array.from({ length: n }, (_, i) => ({ id: `t${i}`, names: ['T Aps'], from, to: to - 1 })),
    ...Array.from({ length: n }, (_, i) => ({ id: `t${i}`, names: ['B Aps'], from: to, to: 60 }))
  ];
  const holder = { id: 'ct1', names: ['B Site'] };
  const duel = (sec) => [{ sec, ours: 't0', enemy: 'ct1' }];

  assert.ok(
    hits(
      'T',
      'mir-b-rush',
      round('T', { stays: [...through(3, 0, 10), holder], enemies: ['ct1'], fights: duel(12) })
    ),
    'three through aps, in, and trading by 1:35'
  );
  assert.equal(
    hits(
      'T',
      'mir-b-rush',
      round('T', { stays: [...through(2, 0, 10), holder], enemies: ['ct1'], fights: duel(12) })
    ),
    null,
    'two is a pop, not a rush'
  );
  assert.equal(
    hits(
      'T',
      'mir-b-rush',
      round('T', { stays: [...through(3, 0, 10), holder], enemies: ['ct1'] })
    ),
    null,
    'and a rush has to actually make contact'
  );

  // Pop and execute are the same late push either side of the kitchen smoke.
  const late = { stays: [...through(3, 21, 25), holder], enemies: ['ct1'] };
  const kitchen = (at) => [{ name: 'kitchen', type: 'smokegrenade', at, names: ['B Kitchen'] }];

  const popped = round('T', { ...late, fights: duel(30), nades: kitchen(40) });
  assert.ok(hits('T', 'mir-b-pop', popped), 'contact well before the kitchen smoke is a pop');
  assert.equal(hits('T', 'mir-b-exec', popped), null, 'and never also an execute');

  const executed = round('T', { ...late, fights: duel(39), nades: kitchen(40) });
  assert.ok(hits('T', 'mir-b-exec', executed), 'contact inside 3s of it is an execute');
  assert.equal(hits('T', 'mir-b-pop', executed), null, 'and never also a pop');

  const noSmoke = round('T', { ...late, fights: duel(30) });
  assert.ok(hits('T', 'mir-b-pop', noSmoke), 'no kitchen smoke at all still leaves a pop');
  assert.equal(hits('T', 'mir-b-exec', noSmoke), null, 'but nothing to execute behind');

  assert.equal(
    hits(
      'T',
      'mir-b-pop',
      round('T', { stays: [...through(3, 0, 5), holder], enemies: ['ct1'], fights: duel(8) })
    ),
    null,
    'and the whole thing has to be after 1:35'
  );
}

{
  const spend = (at) => [
    { type: 'smokegrenade', at, from: ['T Aps'], names: ['B Site'] },
    { type: 'flashbang', at: at + 1, from: ['T Aps'], names: ['B Site'] }
  ];
  assert.ok(
    hits('T', 'mir-b-fake', round('T', { stays: stack(2, ['T Aps']), nades: spend(10) })),
    'a smoke and a flash out of aps with two bodies and nobody in'
  );
  assert.equal(
    hits('T', 'mir-b-fake', round('T', { stays: stack(3, ['T Aps']), nades: spend(10) })),
    null,
    'three bodies in aps is a push'
  );
  assert.equal(
    hits(
      'T',
      'mir-b-fake',
      round('T', {
        stays: [
          ...stack(2, ['T Aps']),
          { id: 't5', names: ['B Site'], from: 15, to: 40 },
          { id: 't6', names: ['B Site'], from: 15, to: 40 }
        ],
        nades: spend(10)
      })
    ),
    null,
    'two men walking in inside 20s is not a fake'
  );
  assert.equal(
    hits(
      'T',
      'mir-b-fake',
      round('T', {
        stays: stack(2, ['T Aps']),
        nades: [{ type: 'smokegrenade', at: 10, from: ['T Aps'], names: ['B Site'] }]
      })
    ),
    null,
    'the flash is not optional'
  );
  assert.equal(
    hits(
      'T',
      'mir-b-fake',
      round('T', {
        stays: stack(2, ['T Aps']),
        nades: spend(10).map((n) => ({ ...n, from: ['Mid'] }))
      })
    ),
    null,
    'and it has to come out of aps'
  );
}

// ---------------------------------------------------------------------------
// A
// ---------------------------------------------------------------------------

{
  const ramp = (from, to) => [
    { id: 't0', names: ['A Ramp'], from, to: to - 1 },
    { id: 't1', names: ['A Ramp'], from, to: to - 1 },
    { id: 't0', names: ['Tetris'], from: to, to: 60 },
    { id: 't1', names: ['apEX'], from: to, to: 60 }
  ];
  const holder = { id: 'ct1', names: ['A Site'] };

  assert.ok(
    hits(
      'T',
      'mir-a-rush',
      round('T', {
        stays: [...ramp(0, 8), holder],
        enemies: ['ct1'],
        fights: [{ sec: 10, ours: 't0', enemy: 'ct1' }]
      })
    ),
    'two through ramp, in, and trading by 1:40'
  );
  assert.ok(
    hits(
      'T',
      'mir-a-pop',
      round('T', {
        stays: [...ramp(20, 25), holder],
        enemies: ['ct1'],
        fights: [{ sec: 30, ours: 't0', enemy: 'ct1' }]
      })
    ),
    'the same after 1:40 is a pop'
  );
  assert.equal(
    hits(
      'T',
      'mir-a-rush',
      round('T', {
        stays: [...ramp(20, 25), holder],
        enemies: ['ct1'],
        fights: [{ sec: 30, ours: 't0', enemy: 'ct1' }]
      })
    ),
    null,
    'and is not also a rush'
  );
}

{
  const palace = [
    { id: 't0', names: ['A Palace'] },
    { id: 't1', names: ['A Palace'] },
    { id: 'ct1', names: ['A Site'] }
  ];
  const duel = [{ sec: 20, ours: 't0', enemy: 'ct1' }];
  const util = (at) => [{ type: 'smokegrenade', at, names: ['A Site'] }];

  const contact = round('T', { stays: palace, enemies: ['ct1'], fights: duel });
  assert.ok(hits('T', 'mir-palace-contact', contact), 'a bare palace duel is a contact');
  assert.equal(hits('T', 'mir-palace-pop', contact), null);

  const popped = round('T', { stays: palace, enemies: ['ct1'], fights: duel, nades: util(18) });
  assert.ok(hits('T', 'mir-palace-pop', popped), 'utility 2s before it makes it a pop');
  assert.equal(hits('T', 'mir-palace-contact', popped), null);

  assert.ok(
    hits(
      'T',
      'mir-palace-contact',
      round('T', { stays: palace, enemies: ['ct1'], fights: duel, nades: util(5) })
    ),
    'utility 15s earlier set nothing up'
  );
  assert.ok(
    hits(
      'T',
      'mir-palace-contact',
      round('T', {
        stays: [
          { id: 't0', names: ['A Palace'], from: 0, to: 10 },
          { id: 't1', names: ['A Palace'], from: 0, to: 10 },
          { id: 't0', names: ['A Balc'], from: 11, to: 40 },
          { id: 't1', names: ['A Balc'], from: 11, to: 40 }
        ]
      })
    ),
    'both of them onto balcony with no duel at all is still a contact'
  );
  assert.equal(
    hits('T', 'mir-palace-contact', round('T', { stays: palace.slice(1), enemies: ['ct1'], fights: duel })),
    null,
    'one man through palace is not the call'
  );
}

{
  const smokes = (a, b) => [
    { name: 'jungle', type: 'smokegrenade', at: a, thrown: a - 2, names: ['A Site'] },
    { name: 'stairs', type: 'smokegrenade', at: b, thrown: b - 2, names: ['A Site'] }
  ];
  assert.ok(
    hits(
      'T',
      'mir-a-exec',
      round('T', { stays: stack(3, ['A Site']).map((s) => ({ ...s, from: 15 })), nades: smokes(10, 12) })
    ),
    'two named smokes and three onto the site inside 15s'
  );
  assert.equal(
    hits(
      'T',
      'mir-a-exec',
      round('T', { stays: stack(3, ['A Site']).map((s) => ({ ...s, from: 40 })), nades: smokes(10, 12) })
    ),
    null,
    'arriving 28s later is a different round'
  );
  assert.equal(
    hits(
      'T',
      'mir-a-exec',
      round('T', {
        stays: stack(3, ['A Site']).map((s) => ({ ...s, from: 15 })),
        nades: [smokes(10, 12)[0]]
      })
    ),
    null,
    'one smoke is not an execute'
  );

  assert.ok(
    hits(
      'T',
      'mir-a-fake',
      round('T', { stays: [{ id: 't0', names: ['A Site'], from: 15, to: 20 }], nades: smokes(10, 12) })
    ),
    'the same smokes with exactly one man in is the fake'
  );
  assert.equal(
    hits('T', 'mir-a-fake', round('T', { nades: smokes(10, 12) })),
    null,
    'nobody at all is not it either'
  );
  assert.equal(
    hits(
      'T',
      'mir-a-fake',
      round('T', {
        stays: [{ id: 't0', names: ['A Site'], from: 15, to: 20 }, ...stack(3, ['T A'], 'x')],
        nades: smokes(10, 12)
      })
    ),
    null,
    'three men in T A when the smokes go out is a real execute setup'
  );
}

// ---------------------------------------------------------------------------
// Splits: the same shape, sorted by when the first duel landed
// ---------------------------------------------------------------------------

{
  const lanes = (duelAt, siteAt) => ({
    stays: [
      { id: 't0', names: ['T A'] },
      { id: 't1', names: ['A Jungle'] },
      { id: 't2', names: ['A Site'], from: siteAt, to: 60 },
      { id: 'ct1', names: ['A Site'] }
    ],
    enemies: ['ct1'],
    fights: [{ sec: duelAt, ours: 't1', enemy: 'ct1' }]
  });

  const fast = round('T', lanes(20, 25));
  assert.ok(hits('T', 'mir-a-split-fast', fast), 'a duel before 1:27 is the fast split');
  assert.equal(hits('T', 'mir-a-split', fast), null);

  const slow = round('T', lanes(35, 40));
  assert.ok(hits('T', 'mir-a-split', slow), 'and after it the ordinary one');
  assert.equal(hits('T', 'mir-a-split-fast', slow), null);

  assert.equal(
    hits('T', 'mir-a-split', round('T', lanes(35, 60))),
    null,
    'a duel nobody followed onto the site inside 15s is not a split'
  );
  assert.equal(
    hits(
      'T',
      'mir-a-split',
      round('T', {
        stays: [
          { id: 't0', names: ['T A'] },
          { id: 't1', names: ['T A'] },
          { id: 't2', names: ['A Site'], from: 40, to: 60 },
          { id: 'ct1', names: ['A Site'] }
        ],
        enemies: ['ct1'],
        fights: [{ sec: 35, ours: 't1', enemy: 'ct1' }]
      })
    ),
    null,
    'and two men down one lane is not a split at all'
  );
}

{
  const lanes = (lane, duelAt, siteAt) => ({
    stays: [
      { id: 't0', names: ['B Aps'] },
      { id: 't1', names: [lane] },
      { id: 't2', names: ['B Site'], from: siteAt, to: 60 },
      { id: 'ct1', names: ['B Site'] }
    ],
    enemies: ['ct1'],
    fights: [{ sec: duelAt, ours: 't1', enemy: 'ct1' }]
  });

  const fast = round('T', lanes('Short', 20, 25));
  assert.ok(hits('T', 'mir-b-split-fast', fast), 'a duel before 1:30 is the fast B split');
  assert.equal(hits('T', 'mir-b-split', fast), null);

  const slow = round('T', lanes('Catwalk', 30, 35));
  assert.ok(hits('T', 'mir-b-split', slow), 'catwalk works as the second lane too');
  assert.equal(hits('T', 'mir-b-split-fast', slow), null);
}

{
  const boost = (secondManIn) =>
    round('T', {
      stays: [
        { id: 't0', names: ['Mid'], from: 0, to: 9 },
        { id: 't0', names: ['Window'], from: 10, to: 40 },
        { id: 't1', names: ['Mid'], from: secondManIn, to: secondManIn + 2 }
      ]
    });
  assert.ok(hits('T', 'mir-window-boost', boost(8)), 'a second man in mid just before the boost');
  assert.equal(
    hits('T', 'mir-window-boost', boost(0)),
    null,
    'and one who left mid ten seconds earlier is not boosting anyone'
  );
  assert.equal(
    hits(
      'T',
      'mir-window-boost',
      round('T', {
        stays: [
          { id: 't0', names: ['Mid'], from: 0, to: 9 },
          { id: 't0', names: ['Window'], from: 10, to: 40 }
        ]
      })
    ),
    null,
    'nobody can boost themselves'
  );
}

// ---------------------------------------------------------------------------
// CT
// ---------------------------------------------------------------------------

{
  const midFight = (secs, enemies) => ({
    stays: [
      { id: 'c0', names: ['Window'] },
      { id: 'c1', names: ['Con'] },
      { id: 't1', names: ['Mid'] },
      { id: 't2', names: ['T Mid'] }
    ],
    enemies: ['t1', 't2'],
    fights: secs.map((sec, i) => ({ sec, ours: `c${i}`, enemy: enemies[i] }))
  });

  const first = round('CT', midFight([10, 12], ['t1', 't1']));
  assert.ok(hits('CT', 'mir-ct-mid-1st', first), 'both CTs into one T by 1:40');
  assert.equal(hits('CT', 'mir-ct-mid-2nd', first), null);

  const second = round('CT', midFight([25, 27], ['t1', 't2']));
  assert.ok(hits('CT', 'mir-ct-mid-2nd', second), 'both into two different Ts after 1:40');
  assert.equal(
    hits('CT', 'mir-ct-mid-2nd', round('CT', midFight([25, 27], ['t1', 't1']))),
    null,
    'the second timing wants two Ts, not one'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-mid-1st',
      round('CT', {
        ...midFight([10, 12], ['t1', 't1']),
        fights: [{ sec: 10, ours: 'c0', enemy: 't1' }]
      })
    ),
    null,
    'one CT trading alone is not a mid fight'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-mid-1st',
      round('CT', {
        stays: [
          { id: 'c0', names: ['A Site'] },
          { id: 'c1', names: ['A Site'] },
          { id: 't1', names: ['Mid'] }
        ],
        enemies: ['t1'],
        fights: [
          { sec: 10, ours: 'c0', enemy: 't1' },
          { sec: 11, ours: 'c1', enemy: 't1' }
        ]
      })
    ),
    null,
    'and CTs shooting mid from A site are not holding mid'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'mir-ct-ramp-search',
      round('CT', { stays: [{ id: 'c0', names: ['A Ramp'], from: 5, to: 40 }] })
    ),
    'twenty seconds on ramp'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-ramp-search',
      round('CT', { stays: [{ id: 'c0', names: ['A Ramp'], from: 5, to: 15 }] })
    ),
    null,
    'ten is a look, not a search'
  );
  assert.ok(
    hits(
      'CT',
      'mir-ct-ramp-search',
      round('CT', {
        stays: [
          { id: 'c0', names: ['A Ramp'], from: 5, to: 15 },
          { id: 't1', names: ['T Outside A'] }
        ],
        enemies: ['t1'],
        fights: [{ sec: 10, ours: 'c0', enemy: 't1', kill: true, killedThem: true }]
      })
    ),
    'unless he kills someone outside from it'
  );
  assert.ok(
    hits(
      'CT',
      'mir-ct-ramp-search',
      round('CT', {
        stays: [
          { id: 'c0', names: ['A Ramp'], from: 5, to: 15 },
          { id: 'c0', names: ['T Outside A'], from: 16, to: 30 }
        ]
      })
    ),
    'or walks out there himself'
  );
}

{
  assert.ok(
    hits('CT', 'mir-ct-palace-search', round('CT', { stays: [{ id: 'c0', names: ['A Palace'] }] })),
    'a CT in palace'
  );
  assert.equal(hits('CT', 'mir-ct-palace-search', round('CT', {})), null);
}

{
  assert.ok(
    hits(
      'CT',
      'mir-ct-awp-b',
      round('CT', { stays: [{ id: 'c0', names: ['B Car'] }], awp: ['c0'] })
    ),
    'the AWP sitting on car before 1:30'
  );
  assert.equal(
    hits('CT', 'mir-ct-awp-b', round('CT', { stays: [{ id: 'c0', names: ['B Car'] }] })),
    null,
    'a rifler there is a different setup'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-awp-b',
      round('CT', { stays: [{ id: 'c0', names: ['B Car'], from: 30, to: 60 }], awp: ['c0'] })
    ),
    null,
    'and arriving after 1:30 is not a start'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'mir-ct-aps-search',
      round('CT', { stays: [{ id: 'c0', names: ['B Aps'], from: 5, to: 40 }] })
    ),
    'fifteen seconds in aps'
  );
  assert.ok(
    hits(
      'CT',
      'mir-ct-aps-search',
      round('CT', {
        stays: [
          { id: 'c0', names: ['B Aps'], from: 5, to: 10 },
          { id: 't1', names: ['B Aps'] }
        ],
        enemies: ['t1'],
        fights: [{ sec: 8, ours: 'c0', enemy: 't1' }]
      })
    ),
    'or a fight in there'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-aps-search',
      round('CT', { stays: [{ id: 'c0', names: ['B Aps'], from: 5, to: 10 }] })
    ),
    null,
    'a quiet five seconds is neither'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'mir-ct-boost',
      round('CT', { stays: [{ id: 'c0', names: ['Boost'], from: 5, to: 20 }] })
    ),
    'more than three seconds on the boost'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-boost',
      round('CT', { stays: [{ id: 'c0', names: ['Boost'], from: 5, to: 7 }] })
    ),
    null,
    'three is not more than three'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'mir-ct-under-push',
      round('CT', { stays: [{ id: 'c0', names: ['Underground'], from: 5, to: 20 }] })
    ),
    'sitting in underground'
  );
  assert.ok(
    hits(
      'CT',
      'mir-ct-under-push',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Underground'], from: 5, to: 6 },
          { id: 'c0', names: ['Short'], from: 7, to: 20 }
        ]
      })
    ),
    'rotating underground into short counts, because he came off underground'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-under-push',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Short'], from: 5, to: 7 },
          { id: 'c0', names: ['Ladder'], from: 8, to: 20 }
        ]
      })
    ),
    null,
    'short into ladder without ever being underground does not'
  );
  assert.equal(
    hits(
      'CT',
      'mir-ct-under-push',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Underground'], from: 5, to: 7 },
          { id: 'c1', names: ['Ladder'], from: 8, to: 10 }
        ]
      })
    ),
    null,
    'and two CTs passing through are not one man holding it'
  );
}

console.log('roundLibraryMirage.test.js ok');
