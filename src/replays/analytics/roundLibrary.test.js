import assert from 'node:assert/strict';
import {
  DEFAULT_TYPE,
  ROUND_LIBRARY,
  classifyRoundTypes,
  hasRoundLibrary,
  requiredRegionNames,
  requiredUtilityNames,
  roundTypeRows,
  roundTypesFor
} from './roundLibrary.js';
import {
  burstWindow,
  clockAt,
  createRegionIndex,
  longestRun,
  plainRegionName,
  secondsAtClock
} from './roundFacts.js';
import { libraryMaps, roundListStats } from './roundListStats.js';
import { TELL_MIN_ROUNDS, TELL_MIN_SHARE, aggTells } from './antistratScan.js';

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

assert.equal(secondsAtClock('1:55'), 0, 'the round goes live at 1:55');
assert.equal(secondsAtClock('1:35'), 20, '1:35 is twenty seconds in');
assert.equal(secondsAtClock('1:20'), 35);
assert.equal(secondsAtClock('1.35'), 20, 'the dotted form parses too');
assert.equal(secondsAtClock('nope'), null);
assert.equal(clockAt(20), '1:35', 'and back again');
assert.equal(clockAt(0), '1:55');

// ---------------------------------------------------------------------------
// burstWindow: every group has to be satisfied inside ONE window
// ---------------------------------------------------------------------------

{
  const hit = burstWindow(
    [
      { need: 2, times: [10, 11] },
      { need: 1, times: [12] },
      { need: 2, times: [13, 14] }
    ],
    6
  );
  assert.ok(hit, 'a tight burst is found');
  assert.equal(hit.start, 10);
  assert.equal(hit.end, 14, 'the window reports the events, not the nominal span');
}

assert.equal(
  burstWindow(
    [
      { need: 2, times: [10, 11] },
      { need: 1, times: [40] }
    ],
    6
  ),
  null,
  'events spread past the span are not a burst'
);

assert.equal(
  burstWindow([{ need: 2, times: [10] }], 6),
  null,
  'a group that cannot reach its count fails outright'
);

{
  // Two clusters: only the second one has all three groups together.
  const hit = burstWindow(
    [
      { need: 1, times: [5, 30] },
      { need: 1, times: [31] },
      { need: 1, times: [32] }
    ],
    6
  );
  assert.equal(hit.start, 30, 'the earliest complete window wins, not the earliest event');
}

// ---------------------------------------------------------------------------
// longestRun
// ---------------------------------------------------------------------------

{
  const series = Array.from({ length: 30 }, (_, i) => ({ sec: i }));
  const held = new Set([2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const run = longestRun(series, 0, 25, (sec) => held.has(sec));
  assert.equal(run.seconds, 11, 'the longest unbroken stretch is measured, not the total');
  assert.equal(run.start, 10);
  const bounded = longestRun(series, 0, 12, (sec) => held.has(sec));
  assert.equal(bounded.seconds, 3, 'the window bounds the run');
}

// ---------------------------------------------------------------------------
// Catalogue shape
// ---------------------------------------------------------------------------

assert.ok(hasRoundLibrary('NUK'), 'Nuke has a library');
assert.ok(hasRoundLibrary('INF'), 'Inferno has a library');
assert.ok(hasRoundLibrary('DD2'), 'Dust2 has a library');
assert.ok(hasRoundLibrary('nuk'), 'the map code is case insensitive');
assert.equal(hasRoundLibrary('OVP'), false, 'maps without one say so');
assert.deepEqual(roundTypesFor('OVP', 'T'), [], 'and classify nothing');

for (const [code, sides] of Object.entries(ROUND_LIBRARY)) {
  for (const side of ['T', 'CT']) {
    const defs = sides[side];
    assert.ok(defs.length, `${code} ${side} has definitions`);
    const keys = new Set();
    for (const def of defs) {
      assert.ok(def.key && !keys.has(def.key), `${code} ${side} ${def.key} is unique`);
      keys.add(def.key);
      assert.ok(def.label, `${code} ${side} ${def.key} has a label`);
      assert.ok(def.desc, `${code} ${side} ${def.key} states its definition`);
      assert.equal(typeof def.match, 'function');
      assert.notEqual(def.key, DEFAULT_TYPE.key, 'Default is never a definition of its own');
    }
    for (const def of defs) {
      for (const key of def.excludes || []) {
        assert.ok(keys.has(key), `${code} ${side} ${def.key} excludes a real type`);
        assert.ok(
          defs.findIndex((d) => d.key === key) < defs.indexOf(def),
          `${code} ${side} ${def.key} is written after the type it defers to`
        );
      }
    }
    const rows = roundTypeRows(code, side);
    assert.equal(rows.length, defs.length + 1, 'the rows add Default');
    assert.equal(rows[rows.length - 1].key, DEFAULT_TYPE.key, 'Default sorts last');
  }
}

// Families are written strictest first, so the priority order is the array order.
{
  const order = ROUND_LIBRARY.NUK.T.map((d) => d.key);
  const before = (a, b) => order.indexOf(a) < order.indexOf(b);
  assert.ok(before('a-pop', 'a-execute'), 'A Pop is stricter than A Execute');
  assert.ok(before('a-fake', 'a-pop'), 'A Fake is read before the real ones');
  assert.ok(before('ramp-rush', 'ramp-pop'), 'Ramp rush outranks Ramp pop');
  assert.ok(before('ramp-pop', 'ramp-contact'), 'Ramp pop outranks Ramp contact');
  assert.ok(before('navi-smokes', 'navi-fake'), 'the real call is read before the fake');
  assert.ok(before('secret-wall', 'secret-wall-fake'));
  assert.ok(before('furia', 'furia-fake'));
  assert.ok(before('furia', 'secret-wall'), 'the widest wall is read first');
  assert.ok(before('furia', 'navi-smokes'));
}

// All six smoke-wall reads are one family: a FURIA round is a FURIA round, and
// never also a Secret wall or a Navi one.
{
  const walls = ROUND_LIBRARY.NUK.T.filter((d) =>
    ['furia', 'furia-fake', 'secret-wall', 'secret-wall-fake', 'navi-smokes', 'navi-fake'].includes(
      d.key
    )
  );
  assert.equal(walls.length, 6);
  for (const d of walls) assert.equal(d.group, 'wall', `${d.key} is in the wall family`);
}

// Dust2's A headcount is a partition, so those four share one family too.
{
  const counts = ROUND_LIBRARY.DD2.CT.filter((d) => d.group === 'a-count').map((d) => d.key);
  assert.deepEqual(
    counts,
    ['dd2-four-long', 'dd2-three-long', 'dd2-two-long', 'dd2-solo-long'],
    'read from the most CTs long down to the fewest'
  );
}

// Inferno's B pop defers to B execute; nothing else suppresses anything.
{
  const bPop = ROUND_LIBRARY.INF.T.find((d) => d.key === 'inf-b-pop');
  assert.deepEqual(bPop.excludes, ['inf-b-execute'], 'B pop is exclusive with B execute');
}

assert.ok(
  requiredUtilityNames('NUK').includes('navi1') && requiredUtilityNames('NUK').includes('gla1ve'),
  'the readiness note names the utility spots the library needs'
);
assert.ok(
  requiredUtilityNames('INF').includes('deepbanana') &&
    requiredUtilityNames('INF').includes('bblock'),
  'and does the same on Inferno'
);
assert.ok(
  !requiredUtilityNames('INF').includes('navi1'),
  'each map lists only its own vocabulary'
);
assert.deepEqual(requiredUtilityNames('OVP'), []);
assert.ok(requiredRegionNames('NUK').includes('A Anchor'));
assert.ok(requiredRegionNames('INF').includes('FalleN'));

// ---------------------------------------------------------------------------
// classifyRoundTypes: grouping, fallback, mark rounding
// ---------------------------------------------------------------------------

/** A stand-in library so the classifier is tested without a painted map. */
function fakeLibrary(defs) {
  const saved = ROUND_LIBRARY.TST;
  ROUND_LIBRARY.TST = { T: defs, CT: [] };
  return () => {
    if (saved) ROUND_LIBRARY.TST = saved;
    else delete ROUND_LIBRARY.TST;
  };
}

{
  const restore = fakeLibrary([
    { key: 'strict', label: 'Strict', desc: '', group: 'fam', match: () => ({ marks: { At: 1.234 } }) },
    { key: 'loose', label: 'Loose', desc: '', group: 'fam', match: () => ({ marks: { At: 9 } }) },
    { key: 'free', label: 'Free', desc: '', match: () => ({ marks: {} }) }
  ]);
  const tags = classifyRoundTypes({}, 'TST', 'T');
  assert.deepEqual(
    tags.map((t) => t.key),
    ['strict', 'free'],
    'one family member wins; ungrouped types tag alongside it'
  );
  assert.equal(tags[0].marks.At, 1.2, 'marks are kept to a tenth of a second');
  restore();
}

{
  // A round is as many calls as it earns: a fake early and an execute late are
  // one round and two tags, because they sit in different families.
  const restore = fakeLibrary([
    { key: 'early-fake', label: 'Early fake', desc: '', group: 'wall', match: () => ({ marks: {} }) },
    { key: 'late-exec', label: 'Late exec', desc: '', group: 'hit', match: () => ({ marks: {} }) }
  ]);
  assert.deepEqual(
    classifyRoundTypes({}, 'TST', 'T').map((t) => t.key),
    ['early-fake', 'late-exec'],
    'separate families both tag the same round'
  );
  restore();
}

{
  const restore = fakeLibrary([
    { key: 'exec', label: 'Exec', desc: '', match: () => ({ marks: {} }) },
    { key: 'pop', label: 'Pop', desc: '', excludes: ['exec'], match: () => ({ marks: {} }) }
  ]);
  assert.deepEqual(
    classifyRoundTypes({}, 'TST', 'T').map((t) => t.key),
    ['exec'],
    'an excluded type stays off once the type it defers to has matched'
  );
  restore();
}

{
  const restore = fakeLibrary([
    { key: 'exec', label: 'Exec', desc: '', match: () => null },
    { key: 'pop', label: 'Pop', desc: '', excludes: ['exec'], match: () => ({ marks: {} }) }
  ]);
  assert.deepEqual(
    classifyRoundTypes({}, 'TST', 'T').map((t) => t.key),
    ['pop'],
    'and tags freely when it did not'
  );
  restore();
}

{
  const restore = fakeLibrary([{ key: 'never', label: 'Never', desc: '', match: () => null }]);
  const tags = classifyRoundTypes({}, 'TST', 'T');
  assert.deepEqual(tags.map((t) => t.key), [DEFAULT_TYPE.key], 'a round that matches nothing is Default');
  restore();
}

{
  const restore = fakeLibrary([
    {
      key: 'boom',
      label: 'Boom',
      desc: '',
      match() {
        throw new Error('unpainted map');
      }
    }
  ]);
  assert.deepEqual(
    classifyRoundTypes({}, 'TST', 'T').map((t) => t.key),
    [DEFAULT_TYPE.key],
    'a definition that throws costs its own tag, not the round'
  );
  restore();
}

assert.deepEqual(classifyRoundTypes(null, 'NUK', 'T'), [], 'no facts, no tags');
assert.deepEqual(classifyRoundTypes({}, 'OVP', 'T'), [], 'no library, no tags');

// ---------------------------------------------------------------------------
// roundListStats: for, against, and the library average
// ---------------------------------------------------------------------------

/** One round row: who played which side, who won, and the tags on each side. */
const mkRound = ({ s1, w, t = [], ct = [] }) => ({
  s1,
  s2: s1 === 'T' ? 'CT' : 'T',
  w,
  rl: { v: 1, t: t.map((k) => ({ k, m: {} })), ct: ct.map((k) => ({ k, m: {} })) }
});

{
  const payload = {
    demos: [
      {
        map: 'NUK',
        name1: 'Vitality',
        name2: 'FaZe',
        rounds: [
          // Vitality on T runs an A Fake and wins.
          mkRound({ s1: 'T', w: 1, t: ['a-fake'], ct: ['two-ramp'] }),
          // Vitality on T runs an A Fake and loses.
          mkRound({ s1: 'T', w: 2, t: ['a-fake'], ct: ['default'] }),
          // Vitality on CT faces an A Fake and wins.
          mkRound({ s1: 'CT', w: 1, t: ['a-fake'], ct: ['lobby-crunch'] }),
          // Vitality on CT faces an A Fake and loses.
          mkRound({ s1: 'CT', w: 2, t: ['a-fake'], ct: ['lobby-crunch'] }),
          mkRound({ s1: 'CT', w: 1, t: ['default'], ct: ['lobby-crunch'] })
        ]
      },
      {
        // Another team's match: contributes to the average only.
        map: 'NUK',
        name1: 'Spirit',
        name2: 'G2',
        rounds: [
          mkRound({ s1: 'T', w: 1, t: ['default'], ct: ['default'] }),
          mkRound({ s1: 'T', w: 2, t: ['default'], ct: ['default'] }),
          mkRound({ s1: 'T', w: 1, t: ['default'], ct: ['default'] })
        ]
      },
      // A different map is not this map.
      { map: 'OVP', name1: 'Vitality', name2: 'FaZe', rounds: [mkRound({ s1: 'T', w: 1, t: ['a-fake'] })] }
    ]
  };

  const stats = roundListStats(payload, { mapCode: 'NUK', teamName: 'Vitality' });
  assert.ok(stats, 'Nuke has rows');
  assert.equal(stats.demos, 2, 'only Nuke matches count');
  assert.equal(stats.ourDemos, 1);

  const t = stats.sides.T;
  assert.equal(t.ourRounds, 2, 'Vitality played T twice');
  assert.equal(t.facedRounds, 3, 'and faced a T side three times');
  assert.equal(t.leagueRounds, 8, 'the average is over every Nuke round in the payload');

  const fake = t.types.find((x) => x.key === 'a-fake');
  assert.equal(fake.ours.rounds, 2);
  assert.equal(fake.ours.winrate, 50, 'they win half the A Fakes they run');
  assert.equal(fake.faced.rounds, 2);
  assert.equal(fake.faced.winrate, 50, 'and hold half the ones they face');
  assert.equal(fake.league.rounds, 4, 'the library has seen four');
  assert.equal(fake.ours.share, 100, 'every T round of theirs on this map was one');
  assert.equal(fake.league.share, 50);
  assert.equal(fake.index, 2, 'so they call it twice as often as the library does');

  // League winrate is the RUNNER's, not ours: four A Fakes, two won by the T side.
  assert.equal(fake.league.winrate, 50);

  const ct = stats.sides.CT;
  const crunch = ct.types.find((x) => x.key === 'lobby-crunch');
  assert.equal(crunch.ours.rounds, 3, 'Vitality crunched in all three of its CT rounds');
  assert.equal(crunch.ours.winrate, Math.round((2 / 3) * 1000) / 10);
  assert.equal(crunch.faced.rounds, 0, 'nobody crunched on them');
  assert.equal(crunch.faced.winrate, null, 'and an empty bucket has no winrate');

  const unused = ct.types.find((x) => x.key === 'awp-peek');
  assert.equal(unused.ours.rounds, 0, 'a call they never make still has a row');
  assert.equal(unused.index, null, 'with no index, because the library has not run it either');
}

assert.equal(
  roundListStats({ demos: [] }, { mapCode: 'OVP', teamName: 'Vitality' }),
  null,
  'a map with no library has no panel'
);

{
  // Rows without tags are excluded from the denominators, so a half-indexed
  // library reports shares of what it has actually read.
  const stats = roundListStats(
    {
      demos: [
        {
          map: 'NUK',
          name1: 'Vitality',
          name2: 'FaZe',
          rounds: [mkRound({ s1: 'T', w: 1, t: ['a-fake'] }), { s1: 'T', s2: 'CT', w: 1 }]
        }
      ]
    },
    { mapCode: 'NUK', teamName: 'Vitality' }
  );
  assert.equal(stats.sides.T.ourRounds, 1, 'an untagged round is not counted against the share');
  assert.equal(stats.sides.T.types.find((x) => x.key === 'a-fake').ours.share, 100);
}

// ---------------------------------------------------------------------------
// Region names: one name, two layers
//
// Ancient paints a B Ramp position inside a B Ramp zone and means different
// ground by each. Unqualified stays the union, because that is what nearly
// every definition wants; `pos:` and `zone:` are how the few that care ask.
// ---------------------------------------------------------------------------

{
  const rect = (x, y) => ({ type: 'rect', x, y, w: 10, h: 10 });
  const index = createRegionIndex(
    {
      positions: [
        { id: 'p1', name: 'B Ramp', pieces: [rect(0, 0)] },
        { id: 'p2', name: 'Lower', pieces: [rect(100, 100)] }
      ],
      zones: [{ id: 'z1', name: 'B Ramp', positionIds: ['p2'] }],
      areas: []
    },
    'ANC'
  );
  const at = (names, x, y) => index.inside(names, x, y, 0);

  assert.ok(at(['B Ramp'], 5, 5), 'the bare name still covers the position');
  assert.ok(at(['B Ramp'], 105, 105), 'and the zone of the same name');
  assert.ok(at(['pos:B Ramp'], 5, 5), 'pos: keeps the position');
  assert.equal(at(['pos:B Ramp'], 105, 105), false, 'and drops the zone');
  assert.ok(at(['zone:B Ramp'], 105, 105), 'zone: keeps the zone');
  assert.equal(at(['zone:B Ramp'], 5, 5), false, 'and drops the position');
  assert.ok(index.known(['pos:B Ramp']), 'a qualified name reads as painted');
  assert.equal(index.known(['pos:Nope']), false, 'and an unpainted one does not');
  assert.equal(at(['area:B Ramp'], 5, 5), false, 'neither layer is an area here');

  assert.equal(plainRegionName('pos:B Ramp'), 'B Ramp', 'readiness notes print the plain name');
  assert.equal(plainRegionName('B Ramp'), 'B Ramp');
  assert.equal(plainRegionName('11:55 spot'), '11:55 spot', 'an unknown prefix is part of the name');
}

// ---------------------------------------------------------------------------
// libraryMaps: which maps the team overview can show without a map picked
// ---------------------------------------------------------------------------

{
  const payload = {
    demos: [
      { map: 'NUK', name1: 'Vitality', name2: 'FaZe' },
      { map: 'ANU', name1: 'FaZe', name2: 'Vitality' },
      { map: 'ANU', name1: 'Vitality', name2: 'G2' },
      // No library on Mirage, and Spirit's Nuke is not Vitality's.
      { map: 'OVP', name1: 'Vitality', name2: 'FaZe' },
      { map: 'NUK', name1: 'Spirit', name2: 'G2' }
    ]
  };
  assert.deepEqual(libraryMaps(payload), ['ANU', 'NUK'], 'most played first, no Mirage');
  assert.deepEqual(
    libraryMaps(payload, 'Vitality'),
    ['ANU', 'NUK'],
    'and only maps that team has been on'
  );
  assert.deepEqual(libraryMaps(payload, 'Spirit'), ['NUK']);
  assert.deepEqual(libraryMaps(null), [], 'no payload, no maps');
}

// ---------------------------------------------------------------------------
// aggTells: utility that gives one call away
// ---------------------------------------------------------------------------

{
  /** One scanned round: the side played, its file, its grenades and its tags. */
  const mkFeat = (file, side, names, tags) => ({
    file,
    side,
    nades: names.map((name) => ({ name, type: 'smokegrenade', zone: '' })),
    tags: { T: [], CT: [], [side]: tags.map((k) => ({ k, m: {} })) }
  });

  const rounds = [
    // Blue is a B Execute in five of six rounds: a tell.
    ...[1, 2, 3, 4, 5].map((i) => mkFeat(`b${i}`, 'T', ['blue'], ['anu-b-exec'])),
    mkFeat('b6', 'T', ['blue'], ['anu-b-split']),
    // Palace is thrown as often but splits evenly: not a tell.
    ...[1, 2, 3].map((i) => mkFeat(`p${i}`, 'T', ['palace'], ['anu-a-rush'])),
    ...[4, 5, 6].map((i) => mkFeat(`p${i}`, 'T', ['palace'], ['anu-mid-take'])),
    // Camera is always a Mid take, but only four times: under the floor.
    ...[1, 2, 3, 4].map((i) => mkFeat(`c${i}`, 'T', ['camera'], ['anu-mid-take']))
  ];

  const out = aggTells(rounds, 'ANU');
  const tells = out.sides.T.tells;
  assert.equal(out.minRounds, TELL_MIN_ROUNDS);
  assert.equal(out.minShare, TELL_MIN_SHARE);
  assert.deepEqual(
    tells.map((t) => t.name),
    ['blue'],
    'only the grenade that is one call in 80%+ of five or more rounds'
  );
  const blue = tells[0];
  assert.equal(blue.rounds, 6);
  assert.equal(blue.hits, 5);
  assert.equal(blue.share, 83);
  assert.equal(blue.label, 'B Exec');
  assert.deepEqual(blue.hitFiles, ['b1', 'b2', 'b3', 'b4', 'b5'], 'the rounds behind the call');
  assert.equal(blue.files.length, 6, 'and every round it was thrown in');
  assert.deepEqual(blue.others, [{ label: 'B Split', rounds: 1 }]);
  assert.equal(out.sides.CT, undefined, 'a side with no rounds has no bag');
}

{
  // Default / Other can never be the call: doing nothing in particular is not
  // something to read off a grenade.
  const rounds = [1, 2, 3, 4, 5, 6].map((i) => ({
    file: `d${i}`,
    side: 'CT',
    nades: [{ name: 'heaven', type: 'smokegrenade', zone: '' }],
    tags: { T: [], CT: [{ k: 'default', m: {} }] }
  }));
  assert.equal(aggTells(rounds, 'ANU').sides.CT, undefined);
}

console.log('roundLibrary.test.js ok');
