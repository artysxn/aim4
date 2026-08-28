// Run: node src/replays/analytics/playerScout.test.js
//
// The player report's two halves: the rule that decides what is a default and
// what is a variation, and the document that rule ends up written into.

import assert from 'node:assert/strict';
import {
  buildTimeIndex,
  callUtility,
  clusterTimings,
  defaultName,
  groupOpenings,
  openingSignature,
  playerActions,
  recurringActions
} from './playerScoutScan.js';
import { buildPlayerDocHtml, notePicks } from './playerScoutConfig.js';

const ME = 'me';

/** A round's 1s samples: `spec` is [position, seconds] pairs, in order. */
function series(spec) {
  const out = [];
  let t = 0;
  for (const [pos, secs] of spec) {
    for (let i = 0; i < secs; i++) {
      out.push({ tick: t * 64, elapsed: t, pts: [{ id: ME, x: 100 + t, y: 200, pos, awp: false }] });
      t += 1;
    }
  }
  return out;
}

/** A grenade of his, thrown at `elapsed` seconds after freeze. */
function nade(type, name, elapsed) {
  return {
    player: ME,
    type,
    name,
    zone: name,
    clock: 115 - elapsed,
    at: elapsed,
    x: 1,
    y: 2,
    fx: 3,
    fy: 4
  };
}

// ---- actions ---------------------------------------------------------------
{
  const r = {
    nades: [nade('smokegrenade', 'Jungle', 12)],
    series: series([
      ['T Spawn', 5], // walked out of by 5s: the buy, not a call
      ['Ramp', 2], // clipped through: transit, not a position
      ['Top Mid', 6],
      ['Mid', 4]
    ])
  };
  const acts = playerActions(r, ME);
  const keys = acts.map((a) => a.key);
  assert.deepEqual(keys, ['go|top mid', 'nade|smokegrenade|jungle', 'go|mid'], 'in time order');
  assert.equal(acts[0].t, 7, 'Top Mid starts once the two transit samples are past');
  assert.equal(acts[1].label, 'Smoke Jungle');
  assert.ok(
    !keys.includes('go|t spawn'),
    'the ground he spawns on is the buy, and never an action'
  );
  assert.ok(!keys.includes('go|ramp'), 'two samples is transit, not a position');
}
{
  // A CT who spawns on his site and stays is holding it, not spawning on it.
  const r = { nades: [], series: series([['B Site', 30]]) };
  assert.deepEqual(
    playerActions(r, ME).map((a) => a.key),
    ['go|b site']
  );
}

// ---- timings ---------------------------------------------------------------
{
  const hits = [
    { file: 'a', t: 10 },
    { file: 'b', t: 12 },
    { file: 'c', t: 14 },
    { file: 'd', t: 60 },
    { file: 'e', t: 61 }
  ];
  const clusters = clusterTimings(hits, 5);
  assert.equal(clusters.length, 2, 'early habit and late habit are two habits');
  assert.equal(clusters[0].rounds, 3);
  assert.equal(clusters[0].t, 12);
  assert.equal(clusters[1].rounds, 2);
}

// ---- openings --------------------------------------------------------------
// Twelve rounds: five run an A default, four a B default, two a mid variation,
// and one where he does something nobody repeats.
const go = (spot, t) => ({
  kind: 'go',
  key: `go|${spot.toLowerCase()}`,
  label: `Go ${spot}`,
  spot,
  type: '',
  t
});
const smoke = (spot, t) => ({
  kind: 'nade',
  key: `nade|smokegrenade|${spot.toLowerCase()}`,
  label: `Smoke ${spot}`,
  spot,
  type: 'smokegrenade',
  t
});

const rounds = [];
/** A grenade event on the round, as roundFeatures hands it over. */
const throwOf = (player, type, name, elapsed) => ({
  player,
  type,
  name,
  zone: name,
  clock: 115 - elapsed
});
const push = (file, hitSite, won, actions, call, nades = []) =>
  rounds.push({
    file,
    won,
    opponent: 'X',
    side: 'T',
    hitSite,
    tags: { T: [{ k: call, m: {} }] },
    nades,
    actions
  });

for (let i = 0; i < 5; i++) {
  // A default: A Lobby off the buy, smoke Jungle at ~1:38. Jitter within 5s.
  const j = i % 2 ? 1 : -1;
  push(`a${i}`, 'a', i < 3, [go('A Lobby', 6 + j), smoke('Jungle', 17 + j)], 'a-exec', [
    throwOf('me', 'smokegrenade', 'Jungle', 17 + j),
    // The AWPer smokes Stairs on every A default, and molotovs Con on most.
    throwOf('mate1', 'smokegrenade', 'Stairs', 15),
    ...(i < 4 ? [throwOf('mate1', 'molotov', 'Con', 62)] : [])
  ]);
}
for (let i = 0; i < 4; i++) {
  push(`b${i}`, 'b', i < 2, [go('B Apps', 7), smoke('B Site', 16)], 'b-exec');
}
for (let i = 0; i < 2; i++) {
  push(`m${i}`, 'a', true, [go('Top Mid', 8), smoke('Connector', 15)], 'mid-take');
}
// The odd one out, plus something at 60s that is past the opening entirely.
push('x0', null, false, [go('B Apps', 7), go('Fork', 12), smoke('Site', 60)], 'default');

const index = buildTimeIndex(rounds);
const { basis, defaults, variations, unread } = groupOpenings(rounds, index);

assert.equal(basis, 12);
assert.equal(unread.length, 0);
assert.equal(defaults.length, 2, 'a side has more than one default');
assert.equal(defaults[0].count, 5);
assert.equal(defaults[1].count, 4);
assert.equal(defaults[0].share, 42);
assert.equal(defaults[0].label, 'Go A Lobby 1:50, Smoke Jungle 1:39');
assert.equal(defaults[0].winrate, 60);
assert.deepEqual(defaults[0].site, { a: 100, b: 0, basis: 5 });
assert.equal(defaultName(defaults[0]), 'A default');
assert.equal(defaultName(defaults[1]), 'B default');
assert.deepEqual(defaults[0].teamCalls, [{ key: 'a-exec', count: 5 }]);
assert.ok(defaults[0].example, 'a default names the round it is written from');

// What the five of them throw on this call, over every round of it.
{
  const util = defaults[0].utility;
  const mine = util.rows.filter((r) => r.player === 'me');
  const his = util.rows.filter((r) => r.player === 'mate1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].label, 'Smoke Jungle');
  assert.equal(mine[0].share, 100);
  assert.equal(his.length, 2, "the teammate's own two throws are on the call too");
  assert.deepEqual(
    his.map((r) => [r.label, r.share, r.clock]),
    [
      ['Smoke Stairs', 100, '1:40'],
      // Read over the whole round, not the opening: the late molotov counts.
      ['Molo Con', 80, '0:53']
    ]
  );
  assert.equal(util.hidden, 0);
}
// A throw in under a quarter of a call's rounds is not part of the call.
{
  const thin = [
    { file: 'r1', nades: [throwOf('me', 'flashbang', 'Mid', 10)] },
    { file: 'r2', nades: [] },
    { file: 'r3', nades: [] },
    { file: 'r4', nades: [] },
    { file: 'r5', nades: [] }
  ];
  assert.equal(callUtility(thin).rows.length, 0, '1 of 5 is 20%, under the bar');
  assert.equal(callUtility(thin, 20).rows.length, 1);
}

assert.equal(variations.length, 2, 'the mid rounds and the odd one out');
assert.equal(variations[0].count, 2);
assert.equal(variations[1].count, 1);
assert.ok(
  variations.every((v) => v.count / basis <= 0.2),
  'nothing over 20% is left in the variations'
);

// Two defaults can share a round, and the round is counted once.
{
  const shared = [];
  const add = (file, actions) =>
    shared.push({ file, won: true, opponent: 'X', side: 'T', hitSite: 'a', tags: null, nades: [], actions });
  // Six rounds run an A default, six a mid default, four run both, and four are
  // one-offs. Twenty rounds, so an opening needs five to qualify.
  for (let i = 0; i < 6; i++) add(`a${i}`, [go('A Lobby', 6), smoke('Jungle', 16)]);
  for (let i = 0; i < 6; i++) add(`m${i}`, [go('T Garage', 8), smoke('Connector', 18)]);
  for (let i = 0; i < 4; i++) {
    add(`both${i}`, [go('A Lobby', 6), smoke('Jungle', 16), go('T Garage', 8), smoke('Connector', 18)]);
  }
  for (let i = 0; i < 4; i++) add(`odd${i}`, [go(`Spot${i}`, 9)]);

  const out = groupOpenings(shared, buildTimeIndex(shared));
  assert.equal(out.basis, 20);
  assert.equal(out.defaults.length, 2);
  assert.deepEqual(
    out.defaults.map((d) => d.count),
    [10, 10],
    'each default counts every round that runs it, shared rounds included'
  );
  assert.ok(out.defaults.every((d) => d.actions.length === 2), 'a default is described by its core');
  assert.equal(out.defaultRounds, 16, 'the union counts a shared round once');
  assert.equal(out.variations.length, 4, 'only the one-offs are variations');
  assert.ok(
    out.defaults.every((d) => d.files.filter((f) => f.startsWith('both')).length === 4),
    'the four rounds running both appear under both'
  );
}

// Past the opening clock is not part of the signature.
{
  const sig = openingSignature(rounds.at(-1), index);
  assert.equal(sig.ids.length, 2, 'the 60s smoke is not in the opening');
  assert.ok(sig.ids.every((id) => !id.startsWith('nade|smokegrenade|site')));
}
// The same shape a few seconds apart is the same shape.
assert.equal(
  openingSignature(rounds[0], index).sig,
  openingSignature(rounds[1], index).sig,
  'jitter inside the tolerance does not split a default'
);

// Recurring actions read the whole round, so the late smoke still counts if
// it repeats. Here it happens once in twelve, so it does not.
const recurring = recurringActions(rounds, index);
assert.ok(recurring.some((c) => c.key === 'go|a lobby' && c.share === 42));
assert.ok(!recurring.some((c) => c.key === 'nade|smokegrenade|site'));

// A round with nothing readable is neither a default nor a variation.
{
  const blind = [
    { file: 'blind', won: false, opponent: '', side: 'T', tags: null, nades: [], actions: [] }
  ];
  const out = groupOpenings(blind, buildTimeIndex(blind));
  assert.equal(out.unread.length, 1);
  assert.equal(out.defaults.length + out.variations.length, 0);
}

// ---- the document ----------------------------------------------------------
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const results = {
  mapCode: 'MIR',
  playerName: 'ropz',
  teamName: 'FaZe',
  roles: { T: 'Lurk', CT: 'A anchor' },
  mates: { me: { name: 'ropz', T: 'Lurk', CT: 'A anchor' }, mate1: { name: 'broky', T: 'AWP', CT: 'AWP' } },
  focusIds: ['faze'],
  tFullBuy: ['a0'],
  ctFullBuy: [],
  sides: {
    T: {
      side: 'T',
      rounds: 12,
      files: rounds.map((r) => r.file),
      winrate: 50,
      fullRounds: 12,
      basis: 12,
      unread: 0,
      utility: recurring.filter((c) => c.kind === 'nade'),
      moves: recurring.filter((c) => c.kind === 'go'),
      defaults: {
        count: 9,
        share: 75,
        winrate: 55,
        files: ['a0', 'b0'],
        patterns: defaults.map((d) => ({ ...d, name: defaultName(d) })),
        hidden: 0
      },
      nonDefaults: { count: 3, share: 25, winrate: 66, files: ['m0', 'm1', 'x0'] },
      variations: variations.slice(0, 1),
      moreVariations: [
        { label: 'Go B Apps 1:48, Go Fork 1:43', count: 1, share: 8, winrate: 0, files: ['x0'], site: null }
      ],
      heat: [1, 2, 3, 4],
      paths: [0, 1, 2, 3, 4, 5, 6]
    },
    CT: null
  }
};

const notes = new Map([
  [
    'default|T|0',
    {
      self: 'Go A Lobby, <a href="/team/utility-archive?map=MIR&amp;u=abcd">Smoke Jungle</a>',
      mates: [{ id: 'mate1', name: 'broky', note: 'Smoke Stairs, push out A main' }]
    }
  ],
  ['default|T|1', { self: 'Go B Apps, Smoke B', mates: [] }],
  ['var|T|0', { self: 'Go Top Mid, Smoke Connector', mates: [] }]
]);

const html = buildPlayerDocHtml(
  {
    playerName: 'ropz',
    playerId: 'me',
    teamName: 'FaZe',
    mapCode: 'MIR',
    roles: results.roles,
    mates: results.mates,
    matches: [{ label: 'FaZe vs NAVI (1.8.2026)' }],
    categories: [
      'overview',
      'maps',
      'defaultUtility',
      'defaultMoves',
      'defaultRound',
      'callUtility',
      'variations',
      'teamContext'
    ],
    results,
    notes
  },
  esc
);

assert.match(html, /<h1 style="font-size: 25px">Player: ropz on Mirage<\/h1>/);
assert.match(html, /<h1 style="font-size: 25px">T side<\/h1>/);
assert.match(html, /<h1 style="font-size: 25px">CT side<\/h1>/);
assert.match(html, /<h2 style="font-size: 19px">Default rounds, written out<\/h2>/);
assert.match(html, /<h2 style="font-size: 19px">Non-default rounds<\/h2>/);
// Both defaults are written, each named for the site its rounds go to.
assert.match(html, /A default: Go A Lobby/);
assert.match(html, /B default: Go B Apps/);
assert.match(html, /goes A 100%, B 0%/);
assert.match(html, /2 defaults:/);
// The note's own anchor survives: it is inserted, not escaped a second time.
assert.match(html, /<a href="\/team\/utility-archive\?map=MIR&amp;u=abcd">Smoke Jungle<\/a>/);
// The teammate line, under the role the roles editor gives him.
assert.match(html, /<strong>broky \(AWP\)<\/strong>: Smoke Stairs, push out A main/);
assert.match(html, /<strong>Team call<\/strong>/);
// What each body throws on the call, him first, then the rest.
assert.match(html, /<th>Player<\/th><th>Utility<\/th><th>Usually at<\/th><th>Rate<\/th>/);
assert.match(html, /<td>ropz \(Lurk\)<\/td><td>Smoke Jungle<\/td>/);
assert.match(html, /<td>broky \(AWP\)<\/td><td>Smoke Stairs<\/td>/);
assert.match(html, /<td><\/td><td>Molo Con<\/td>/, 'a second row for the same body repeats no name');
// The tail is listed rather than dropped.
assert.match(html, /<h3>The rest<\/h3>/);
assert.match(html, /Go B Apps 1:48, Go Fork 1:43/);
// Widgets ride along as inert divs for docEmbeds to mount.
assert.match(html, /data-kind="heat"/);
assert.match(html, /data-kind="nade-paths"/);
// The definition the whole report rests on is stated in it.
assert.match(html, /to 1:35 and matched within 5s/);
assert.match(html, /runs in over 20%/);

// Team lines only when that category is on.
const noTeam = buildPlayerDocHtml(
  { playerName: 'ropz', mapCode: 'MIR', matches: [], categories: ['variations'], results, notes },
  esc
);
assert.ok(!noTeam.includes('Team call'), 'teamContext off drops the team lines');
assert.ok(noTeam.includes('Go Top Mid'), 'his own line stays');

// ---- which rounds get written ----------------------------------------------
assert.deepEqual(notePicks(results), [
  { key: 'default|T|0', file: defaults[0].example, side: 'T' },
  { key: 'default|T|1', file: defaults[1].example, side: 'T' },
  { key: 'var|T|0', file: variations[0].example, side: 'T' }
]);

console.log('playerScout.test.js ok');
