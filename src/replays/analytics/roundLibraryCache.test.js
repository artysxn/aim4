// ---------------------------------------------------------------------------
// Cache round types, definition by definition.
//
// Same discipline as the Ancient and Mirage files: the round that is the call,
// and the round next door with only the discriminating clause changed.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { ROUND_LIBRARY } from './roundLibrary.js';
import { secondsAtClock } from './roundFacts.js';
import { fakeRound as round } from './roundFactsFake.js';

const defOf = (side, key) => {
  const hit = ROUND_LIBRARY.CCH[side].find((d) => d.key === key);
  assert.ok(hit, `${key} exists`);
  return hit;
};
const hits = (side, key, f) => defOf(side, key).match(f);

/** `n` bodies on the same ground for a window. */
const bodies = (n, names, { from = 0, to = 60, tag = 't' } = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, names, from, to }));

// ---------------------------------------------------------------------------
// A: rush, fake, execute, contact
// ---------------------------------------------------------------------------

{
  const smoke = (at) => [{ name: 'a1', type: 'smokegrenade', at, names: ['A Site'] }];
  const take = (mains, ins, { from = 0, to = 12 } = {}) => [
    ...bodies(mains, ['A main'], { from, to }),
    ...bodies(ins, ['A'], { from: to + 1, to: 60, tag: 'i' })
  ];

  assert.ok(
    hits('T', 'cch-a-rush', round('T', { stays: take(3, 2, { to: 12 }), nades: smoke(5) })),
    'a smoke, three through main and two onto A by 1:39'
  );
  assert.equal(
    hits('T', 'cch-a-rush', round('T', { stays: take(2, 2, { to: 12 }), nades: smoke(5) })),
    null,
    'two through main is not a rush'
  );
  assert.equal(
    hits('T', 'cch-a-rush', round('T', { stays: take(3, 2, { to: 12 }) })),
    null,
    'and no smoke at all is not either'
  );
  assert.equal(
    hits('T', 'cch-a-rush', round('T', { stays: take(3, 2, { to: 12 }), nades: smoke(30) })),
    null,
    'a smoke after 1:39 is a different call'
  );

  assert.ok(
    hits('T', 'cch-a-rush-fake', round('T', { stays: take(2, 1, { to: 12 }), nades: smoke(5) })),
    'two through main and one onto A is the fake'
  );
  assert.equal(
    hits('T', 'cch-a-rush-fake', round('T', { stays: take(3, 1, { to: 12 }), nades: smoke(5) })),
    null,
    'three through main is over the cap'
  );
  assert.ok(
    hits(
      'T',
      'cch-a-rush-fake',
      round('T', {
        stays: take(2, 1, { to: 12 }),
        nades: [{ type: 'decoy', spot: 'a1', at: 5, names: ['A Site'] }]
      })
    ),
    'a decoy in the a1 spot fakes it just as well'
  );
  assert.equal(
    hits(
      'T',
      'cch-a-rush',
      round('T', {
        stays: take(3, 2, { to: 12 }),
        nades: [{ type: 'decoy', spot: 'a1', at: 5, names: ['A Site'] }]
      })
    ),
    null,
    'but a decoy never stands in for the real smoke of a rush'
  );

  assert.ok(
    hits(
      'T',
      'cch-a-exec',
      round('T', { stays: take(2, 2, { from: 20, to: 30 }), nades: smoke(25) })
    ),
    'two and two after 1:39 is the execute'
  );
  assert.equal(
    hits(
      'T',
      'cch-a-exec',
      round('T', { stays: take(2, 1, { from: 20, to: 30 }), nades: smoke(25) })
    ),
    null,
    'one man onto A is not'
  );
}

{
  const holder = { id: 'ct1', names: ['A Heaven'] };
  const contact = (smokeAt, fightAt) =>
    round('T', {
      stays: [...bodies(2, ['A main'], { from: 20, to: 60 }), holder],
      enemies: ['ct1'],
      fights: [{ sec: fightAt, ours: 't0', enemy: 'ct1' }],
      nades: smokeAt === null ? [] : [{ name: 'a1', type: 'smokegrenade', at: smokeAt, names: [] }]
    });

  assert.ok(hits('T', 'cch-a-contact', contact(null, 30)), 'bodies and a duel with no smoke at all');
  assert.ok(hits('T', 'cch-a-contact', contact(35, 30)), 'a smoke landing 5s behind the duel');
  assert.equal(
    hits('T', 'cch-a-contact', contact(25, 30)),
    null,
    'a smoke in front of the duel makes it an execute, not a contact'
  );
  assert.equal(
    hits('T', 'cch-a-contact', contact(45, 30)),
    null,
    'and one arriving 15s later was not part of it'
  );
}

{
  const split = (extra) =>
    round('T', {
      stays: [
        { id: 't0', names: ['Highway'] },
        { id: 't1', names: ['A main'] },
        { id: 'ct1', names: ['A Site'] },
        ...extra
      ],
      enemies: ['ct1'],
      fights: [{ sec: 20, ours: 't0', enemy: 'ct1' }]
    });
  assert.ok(
    hits('T', 'cch-a-split', split([{ id: 't1', names: ['A Site'], from: 25, to: 60 }])),
    'a duel from one lane and an entry from the other'
  );
  assert.equal(
    hits('T', 'cch-a-split', split([])),
    null,
    'one man committing on his own is not a split'
  );
  assert.ok(
    hits(
      'T',
      'cch-a-split',
      round('T', {
        stays: [
          { id: 't0', names: ['Whitebox'] },
          { id: 't1', names: ['A door'] },
          { id: 't0', names: ['A Site'], from: 25, to: 60 },
          { id: 't1', names: ['A Site'], from: 26, to: 60 }
        ]
      })
    ),
    'or both of them simply walking on'
  );
}

// ---------------------------------------------------------------------------
// B
// ---------------------------------------------------------------------------

{
  const smoke = (at, name = 'tree') => [{ name, type: 'smokegrenade', at, names: ['B Site'] }];
  const take = (mains, ins, { from = 0, to = 13 } = {}) => [
    ...bodies(mains, ['B Main'], { from, to }),
    ...bodies(ins, ['B'], { from: to + 1, to: 60, tag: 'i' })
  ];

  assert.ok(
    hits('T', 'cch-b-rush', round('T', { stays: take(3, 2), nades: smoke(5) })),
    'three through B Main and two onto B by 1:38'
  );
  assert.ok(
    hits('T', 'cch-b-rush-fake', round('T', { stays: take(2, 1), nades: smoke(5) })),
    'two and one is the fake'
  );
  assert.equal(
    hits('T', 'cch-b-rush-fake', round('T', { stays: take(3, 2), nades: smoke(5) })),
    null,
    'and a real rush is never also the fake'
  );
  assert.ok(
    hits(
      'T',
      'cch-b-exec',
      round('T', { stays: take(3, 2, { from: 20, to: 30 }), nades: smoke(25) })
    ),
    'the same after 1:38 is the execute'
  );

  // blurk is a lurk smoke, so it never turns a contact into an execute.
  const holder = { id: 'ct1', names: ['B Checkers'] };
  const contact = (nades) =>
    round('T', {
      stays: [...bodies(2, ['B Main'], { from: 20, to: 60 }), holder],
      enemies: ['ct1'],
      fights: [{ sec: 30, ours: 't0', enemy: 'ct1' }],
      nades
    });
  assert.ok(hits('T', 'cch-b-contact', contact([])), 'bodies and a duel on checkers');
  assert.equal(
    hits('T', 'cch-b-contact', contact(smoke(25))),
    null,
    'a tree smoke in front of the duel is an execute'
  );
  assert.ok(
    hits('T', 'cch-b-contact', contact(smoke(25, 'blurk'))),
    'but a blurk smoke in front of it is still a contact'
  );
}

{
  const split = (followAt) =>
    round('T', {
      stays: [
        { id: 't0', names: ['Right mid'], from: 0, to: 9 },
        { id: 't0', names: ['Vents'], from: 10, to: 40 },
        { id: 't1', names: ['B Site'], from: followAt, to: 60 }
      ]
    });
  assert.ok(hits('T', 'cch-b-split', split(15)), 'vents out of right mid with a body onto B');
  assert.equal(hits('T', 'cch-b-split', split(30)), null, 'twenty seconds later is not the split');
  assert.equal(
    hits(
      'T',
      'cch-b-split',
      round('T', {
        stays: [
          { id: 't0', names: ['Vents'], from: 10, to: 40 },
          { id: 't1', names: ['B Site'], from: 15, to: 60 }
        ]
      })
    ),
    null,
    'and vents without coming out of right mid is not it either'
  );
}

// ---------------------------------------------------------------------------
// Mid
// ---------------------------------------------------------------------------

{
  const smoke = (at) => [{ type: 'smokegrenade', at, names: ['CT Mid'] }];
  const straight = (into) =>
    round('T', {
      stays: [...bodies(3, ['T Mid'], { to: 5 }), ...bodies(2, into, { from: 6, to: 11, tag: 'm' })],
      nades: smoke(3)
    });

  assert.ok(hits('T', 'cch-mid-rush', straight(['mid'])), 'three into T Mid and two into mid');
  assert.equal(
    hits(
      'T',
      'cch-mid-rush',
      round('T', {
        stays: [...bodies(3, ['T Mid'], { to: 5 }), ...bodies(2, ['mid'], { from: 6, to: 11, tag: 'm' })]
      })
    ),
    null,
    'without a CT Mid smoke it is not a rush'
  );
  assert.equal(
    hits(
      'T',
      'cch-mid-rush',
      round('T', {
        stays: [...bodies(2, ['T Mid'], { to: 5 }), ...bodies(2, ['mid'], { from: 6, to: 11, tag: 'm' })],
        nades: smoke(3)
      })
    ),
    null,
    'two into T Mid is not enough'
  );

  // The trade route: a duel into CT Mid the same man follows inside 8s.
  assert.ok(
    hits(
      'T',
      'cch-mid-rush',
      round('T', {
        stays: [
          ...bodies(3, ['T Mid'], { to: 5 }),
          { id: 't0', names: ['mid'], from: 8, to: 11 },
          { id: 'ct1', names: ['CT Mid'] }
        ],
        enemies: ['ct1'],
        fights: [{ sec: 4, ours: 't0', enemy: 'ct1' }],
        nades: smoke(3)
      })
    ),
    'or one man trading into CT Mid and following it in'
  );
  assert.equal(
    hits(
      'T',
      'cch-mid-rush',
      round('T', {
        stays: [
          ...bodies(3, ['T Mid'], { to: 5 }),
          { id: 't1', names: ['mid'], from: 8, to: 11 },
          { id: 'ct1', names: ['CT Mid'] }
        ],
        enemies: ['ct1'],
        fights: [{ sec: 4, ours: 't0', enemy: 'ct1' }],
        nades: smoke(3)
      })
    ),
    null,
    'it has to be the man who took the fight who goes in'
  );
}

{
  const retake = (nades, into = ['under boost']) =>
    round('T', { stays: bodies(2, into, { from: 20, to: 40, tag: 'm' }), nades });
  const full = [
    { type: 'smokegrenade', at: 15, names: ['CT Mid'] },
    { name: 'vents', type: 'molotov', at: 16, names: [] }
  ];
  assert.ok(hits('T', 'cch-mid-retake', retake(full)), 'smoke, molotov and two onto under boost');
  assert.equal(
    hits('T', 'cch-mid-retake', retake([full[0]])),
    null,
    'no molotov, no retake'
  );
  assert.equal(
    hits('T', 'cch-mid-retake', retake([full[1]])),
    null,
    'and no smoke either'
  );
  assert.equal(
    hits(
      'T',
      'cch-mid-retake',
      round('T', {
        stays: bodies(2, ['under boost'], { from: 20, to: 40, tag: 'm' }),
        nades: full.map((n) => ({ ...n, at: 5 }))
      })
    ),
    null,
    'utility spent before 1:43 belongs to a different call'
  );
}

{
  const spend = (at) => [
    { name: 'sandbags', type: 'molotov', at, names: [] },
    { type: 'smokegrenade', at: at + 1, names: ['CT Mid'] },
    { type: 'smokegrenade', at: at + 2, names: ['CT Mid'] },
    { type: 'flashbang', at: at + 3, names: ['T Mid'] },
    { type: 'flashbang', at: at + 4, names: ['CT Mid'] }
  ];
  const early = round('T', { nades: spend(3) });
  assert.ok(hits('T', 'cch-mid-fake', early), 'the whole spend before 1:43');
  assert.equal(hits('T', 'cch-mid-retake-fake', early), null, 'and never also the retake fake');

  const late = round('T', { nades: spend(20) });
  assert.ok(hits('T', 'cch-mid-retake-fake', late), 'the same spend after 1:43');
  assert.equal(hits('T', 'cch-mid-fake', late), null);

  assert.equal(
    hits('T', 'cch-mid-fake', round('T', { nades: spend(3).slice(0, 4) })),
    null,
    'one flash short is not the spend'
  );
}

{
  assert.ok(
    hits('T', 'cch-fast-boost', round('T', { stays: [{ id: 't0', names: ['boost'], from: 5, to: 20 }] })),
    'onto the boost by 1:43'
  );
  assert.equal(
    hits('T', 'cch-fast-boost', round('T', { stays: [{ id: 't0', names: ['boost'], from: 20, to: 40 }] })),
    null,
    'and not after it'
  );
}

{
  const peek = (fights) =>
    round('T', {
      stays: [
        { id: 't0', names: ['Mid Garage'] },
        { id: 't1', names: ['Mid Garage'] },
        { id: 'ct1', names: ['CT Mid'] }
      ],
      enemies: ['ct1'],
      fights
    });
  assert.ok(
    hits('T', 'cch-fast-mid-peek', peek([{ sec: 8, ours: 't0', enemy: 'ct1' }])),
    'one man peeking mid out of garage'
  );
  assert.equal(
    hits(
      'T',
      'cch-fast-mid-peek',
      peek([
        { sec: 8, ours: 't0', enemy: 'ct1' },
        { sec: 9, ours: 't1', enemy: 'ct1' }
      ])
    ),
    null,
    'two men is a take, not a peek'
  );
  assert.equal(
    hits('T', 'cch-fast-mid-peek', peek([{ sec: 30, ours: 't0', enemy: 'ct1' }])),
    null,
    'and after 1:43 it is not fast'
  );
}

// ---------------------------------------------------------------------------
// CT
// ---------------------------------------------------------------------------

{
  assert.ok(
    hits(
      'CT',
      'cch-ct-vents-boost',
      round('CT', {
        stays: [
          { id: 'c0', names: ['Checkers'], from: 0, to: 9 },
          { id: 'c0', names: ['Vents'], from: 10, to: 40 }
        ]
      })
    ),
    'checkers into vents'
  );
  assert.equal(
    hits('CT', 'cch-ct-vents-boost', round('CT', { stays: [{ id: 'c0', names: ['Vents'] }] })),
    null,
    'vents without coming off checkers is not the boost'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'cch-ct-awp-b',
      round('CT', { stays: [{ id: 'c0', names: ['B Checkers'] }], awp: ['c0'] })
    ),
    'the AWP on checkers'
  );
  assert.equal(
    hits('CT', 'cch-ct-awp-b', round('CT', { stays: [{ id: 'c0', names: ['B Checkers'] }] })),
    null,
    'a rifler there is not an AWP start'
  );
  assert.ok(
    hits(
      'CT',
      'cch-ct-awp-a',
      round('CT', { stays: [{ id: 'c0', names: ['A Site'] }], awp: ['c0'] })
    ),
    'and the same read on A'
  );
  assert.equal(
    hits(
      'CT',
      'cch-ct-awp-a',
      round('CT', { stays: [{ id: 'c0', names: ['B Checkers'] }], awp: ['c0'] })
    ),
    null,
    'each one is its own site'
  );
}

{
  const search = (extra = {}) =>
    round(
      'CT',
      {
        stays: [{ id: 'c0', names: ['A main'], from: 5, to: 20 }, ...(extra.stays || [])],
        nades: extra.nades || []
      },
      extra.enemySpec || {}
    );

  assert.ok(
    hits(
      'CT',
      'cch-ct-a-main-search',
      search({ stays: [{ id: 'c1', names: ['A main'], from: 6, to: 20 }] })
    ),
    'two CTs into A main with everyone alive'
  );
  assert.ok(
    hits(
      'CT',
      'cch-ct-a-main-search',
      search({ nades: [{ type: 'flashbang', at: 8, from: ['A main'], names: [] }] })
    ),
    'or one behind his own flash'
  );
  assert.equal(
    hits('CT', 'cch-ct-a-main-search', search()),
    null,
    'one man walking in quietly is not a search'
  );
  assert.equal(
    hits(
      'CT',
      'cch-ct-a-main-search',
      round('CT', {
        stays: [
          { id: 'c0', names: ['A main'], from: 5, to: 8 },
          { id: 'c1', names: ['A main'], from: 5, to: 8 }
        ]
      })
    ),
    null,
    'and neither is four seconds of it'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'cch-ct-door-push',
      round('CT', { stays: [{ id: 'c0', names: ['A door'], from: 5, to: 20 }] })
    ),
    'five seconds on door'
  );
  assert.equal(
    hits(
      'CT',
      'cch-ct-door-push',
      round('CT', { stays: [{ id: 'c0', names: ['A door'], from: 5, to: 7 }] })
    ),
    null,
    'three is walking past'
  );
}

{
  assert.ok(
    hits(
      'CT',
      'cch-ct-3-mid',
      round('CT', { stays: bodies(3, ['CT Mid'], { from: 5, to: 30, tag: 'c' }) })
    ),
    'three holding mid for ten seconds'
  );
  assert.ok(
    hits(
      'CT',
      'cch-ct-3-mid',
      round('CT', {
        stays: [
          ...bodies(3, ['CT Mid'], { from: 5, to: 9, tag: 'c' }),
          { id: 't1', names: ['T Mid'] }
        ],
        enemies: ['t1'],
        fights: [{ sec: 8, ours: 'c0', enemy: 't1' }]
      })
    ),
    'or fighting out of it instead of standing in it'
  );
  assert.equal(
    hits(
      'CT',
      'cch-ct-3-mid',
      round('CT', { stays: bodies(3, ['CT Mid'], { from: 5, to: 9, tag: 'c' }) })
    ),
    null,
    'five quiet seconds is a rotation through'
  );
  assert.equal(
    hits(
      'CT',
      'cch-ct-3-mid',
      round('CT', { stays: bodies(2, ['CT Mid'], { from: 5, to: 30, tag: 'c' }) })
    ),
    null,
    'and two men is a different setup'
  );
}

{
  const retake = (ctStays, enemyStays, fights = []) =>
    round('CT', { stays: ctStays, fights, enemies: ['t1'] }, { stays: enemyStays });

  assert.ok(
    hits(
      'CT',
      'cch-ct-mid-retake',
      retake(
        [{ id: 'c0', names: ['mid'], from: 20, to: 40 }],
        [{ id: 't1', names: ['under boost'], from: 10, to: 40 }]
      )
    ),
    'mid given up, a T steps in, a CT takes it back'
  );
  assert.equal(
    hits(
      'CT',
      'cch-ct-mid-retake',
      retake(
        [{ id: 'c0', names: ['mid'], from: 0, to: 40 }],
        [{ id: 't1', names: ['under boost'], from: 10, to: 40 }]
      )
    ),
    null,
    'a CT who never left mid has nothing to retake'
  );
  assert.equal(
    hits(
      'CT',
      'cch-ct-mid-retake',
      retake([], [{ id: 't1', names: ['under boost'], from: 10, to: 40 }])
    ),
    null,
    'and giving it up without going back is not a retake'
  );
}

console.log('roundLibraryCache.test.js ok');
