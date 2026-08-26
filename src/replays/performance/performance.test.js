// Run: node src/replays/performance/performance.test.js

import assert from 'node:assert/strict';
import {
  CARD_METRICS,
  findPlayerByUsername,
  lastDemoIds,
  smoothSeries,
  curvePath,
  kprOf,
  stripAt
} from './performanceMath.js';
import {
  primaryGunFromRow,
  gunMapFromRows,
  gunMapForPlayer,
  demoSetStamp,
  gunLabel,
  aggregateGuns
} from './gunStats.js';
import { DELTA_BANDS, deltaLevel, deltaMarkHtml, withDeltaHtml } from './deltaMark.js';
import {
  TEAM_COLS,
  mapRoundTableHtml,
  teamMapRoundBlocksHtml,
  teamMapTotalHtml
} from './mapRoundTables.js';

assert.equal(stripAt('@artysan'), 'artysan');
assert.equal(findPlayerByUsername([{ id: '1', name: 'artysan', maps: ['DD2'] }], 'artysan').id, '1');
assert.equal(findPlayerByUsername([{ id: '1', name: 'artysan', maps: ['DD2'] }], '@artysan').id, '1');
assert.equal(findPlayerByUsername([{ id: '1', name: 's1mple', maps: [] }], 'artysan'), null);

const payload = {
  demos: [
    {
      id: 'd1',
      uploadedAt: 100,
      players: [{ id: 'p1', name: 'artysan', team: 1 }],
      rounds: []
    },
    {
      id: 'd2',
      uploadedAt: 200,
      players: [{ id: 'p1', name: 'artysan', team: 1 }],
      rounds: []
    },
    {
      id: 'd3',
      uploadedAt: 300,
      players: [{ id: 'p1', name: 'artysan', team: 1 }],
      rounds: []
    }
  ]
};
assert.deepEqual([...lastDemoIds(payload, 'p1', 2)], ['d3', 'd2']);
assert.equal(lastDemoIds(payload, 'p1', 0).size, 3);

assert.deepEqual(smoothSeries([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5]);
assert.equal(curvePath([{ x: 0, y: 0 }, { x: 10, y: 10 }]), 'M0.0 0.0 L10.0 10.0');
assert.match(curvePath([{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 10 }]), /^M0\.0 10\.0 C/);
assert.equal(kprOf({ kills: 15, rounds: 10 }), 1.5);

assert.equal(primaryGunFromRow({ hg: { p1: 'ak47' } }, 'p1'), 'ak47');
assert.equal(primaryGunFromRow({ hg: {}, kt: [{ a: 'p1', g: 1, w: 'awp' }] }, 'p1'), '');
assert.equal(primaryGunFromRow({ kt: [{ a: 'p1', g: 1, w: 'ak47' }] }, 'p1'), '');
assert.equal(gunLabel('ak47'), 'AK-47');

const rows = [
  { f: 'r1', d: 'd1', hg: { p1: 'ak47' } },
  { f: 'r2', d: 'd1', hg: { p1: 'awp' } }
];
const files = gunMapFromRows(rows, 'p1');
assert.equal(files.r1, 'ak47');
assert.equal(files.r2, 'awp');
assert.equal(
  gunMapFromRows([{ f: 'r3', kt: [{ a: 'p1', g: 1, w: 'deagle' }] }], 'p1').r3,
  undefined
);

const store = {
  data: {},
  getItem(k) {
    return this.data[k] || null;
  },
  setItem(k, v) {
    this.data[k] = v;
  }
};
const first = gunMapForPlayer(rows, 'p1', ['d1'], store);
const second = gunMapForPlayer([{ f: 'r9', hg: { p1: 'deagle' } }], 'p1', ['d1'], store);
assert.deepEqual(first, second, 'same demo stamp reuses cache');

const emptyStore = {
  data: {},
  getItem(k) {
    return this.data[k] || null;
  },
  setItem(k, v) {
    this.data[k] = v;
  }
};
gunMapForPlayer([{ f: 'r0' }], 'p1', ['d-empty'], emptyStore);
assert.equal(emptyStore.data['aim4:perf:guns:v4'], undefined, 'empty maps are not cached');
assert.equal(demoSetStamp(['b', 'a']), demoSetStamp(['a', 'b']));

const gunRows = [
  {
    f: 'r1',
    d: 'd1',
    m: 'DD2',
    n: 1,
    w: 1,
    s1: 'T',
    s2: 'CT',
    e1: 4,
    e2: 4,
    ok: '',
    od: '',
    p: { p1: [2, 1, 0, 100, 10, 5, 1, 0, 0, 1] },
    kt: [
      { a: 'p1', v: 'x', g: 1, w: 'ak47' },
      { a: 'p1', v: 'y', g: 1, w: 'ak47' }
    ],
    sw: { p1: 4 }
  }
];
const players = new Map([['d1:p1', { name: 'artysan', team: 1 }]]);
const demos = new Map([['d1', { id: 'd1', uploadedAt: 1, players: [{ id: 'p1', team: 1 }] }]]);
const guns = aggregateGuns(gunRows, 'p1', players, demos, { r1: 'ak47' });
assert.equal(guns.length, 1);
assert.equal(guns[0].gun, 'ak47');
assert.equal(guns[0].kills, 2);
assert.equal(guns[0].rounds, 1);
assert.ok(Number.isFinite(guns[0].rating), 'guns rating is Rating 3.0 from aggregatePlayers');
assert.equal(guns[0].a4r, undefined);
assert.equal(guns[0].opkRate, null, 'a gun with no opening duel has no rate, not 0%');

// Opening duels are counted per gun: this is the number the AWP row exists for.
{
  const opened = aggregateGuns(
    [
      { ...gunRows[0], ok: 'p1' },
      { ...gunRows[0], f: 'r2', n: 2, od: 'p1' }
    ],
    'p1',
    players,
    demos,
    { r1: 'awp', r2: 'awp' }
  );
  assert.equal(opened[0].openKills, 1);
  assert.equal(opened[0].openDeaths, 1);
  assert.equal(opened[0].opkRate, 50);
}

// The seventh card. Opening duels sit on the same band as the team page's.
{
  const opk = CARD_METRICS.find((m) => m.key === 'opkRate');
  assert.equal(CARD_METRICS.length, 7, 'seven summary cards');
  assert.equal(CARD_METRICS[6], opk, 'OPK is the last of them');
  assert.equal(opk.label, 'OPK');
  assert.equal(opk.fmt, 'pct');
  assert.equal(opk.band, 'winrate');
  assert.equal(opk.read({ opkRate: 62 }), 62);
}

assert.equal(deltaLevel(1.0, 1.0, DELTA_BANDS.rating), 0);
assert.equal(deltaLevel(1.04, 1.0, DELTA_BANDS.rating), 0);
assert.equal(deltaLevel(1.05, 1.0, DELTA_BANDS.rating), 1);
assert.equal(deltaLevel(1.16, 1.0, DELTA_BANDS.rating), 1);
assert.equal(deltaLevel(1.17, 1.0, DELTA_BANDS.rating), 2);
assert.equal(deltaLevel(0.83, 1.0, DELTA_BANDS.rating), -2);
assert.equal(deltaLevel(1.13, 1.0, DELTA_BANDS.rating), 1);

assert.equal(deltaLevel(0.5, 0, DELTA_BANDS.swing), 0);
assert.equal(deltaLevel(1.0, 0, DELTA_BANDS.swing), 1);
assert.equal(deltaLevel(2.29, 0, DELTA_BANDS.swing), 1);
assert.equal(deltaLevel(2.3, 0, DELTA_BANDS.swing), 2);
assert.equal(deltaLevel(-2.67, 0, DELTA_BANDS.swing), -2);

assert.equal(deltaLevel(0.79, 0.76, DELTA_BANDS.kpr), 0);
assert.equal(deltaLevel(0.79, 0.75, DELTA_BANDS.kpr), 1);
assert.equal(deltaLevel(0.79, 0.67, DELTA_BANDS.kpr), 2);

assert.equal(deltaLevel(55, 53.5, DELTA_BANDS.pct), 0);
assert.equal(deltaLevel(55, 53.4, DELTA_BANDS.pct), 1);
assert.equal(deltaLevel(55, 50.9, DELTA_BANDS.pct), 2);

assert.equal(deltaLevel(54, 52, DELTA_BANDS.winrate), 0);
assert.equal(deltaLevel(54.1, 52, DELTA_BANDS.winrate), 1);
assert.equal(deltaLevel(60, 52, DELTA_BANDS.winrate), 2);
assert.equal(deltaLevel(44, 52, DELTA_BANDS.winrate), -2);

assert.ok(deltaMarkHtml(0).includes('pf-delta'));
assert.ok(!deltaMarkHtml(0).includes('<img'));
assert.ok(deltaMarkHtml(1).includes('is-up'));
assert.ok(deltaMarkHtml(-2).includes('is-down'));
assert.notEqual(deltaMarkHtml(1), deltaMarkHtml(2));
assert.ok(deltaMarkHtml(2).includes('pf-delta'));
assert.ok(deltaMarkHtml(1).includes('<img'));
assert.ok(deltaMarkHtml(2).includes('data:image/svg+xml'));
assert.ok(withDeltaHtml('1.04', 1.04, 1.0, DELTA_BANDS.rating).includes('pf-num-val'));
assert.ok(withDeltaHtml('1.04', 1.04, 1.0, DELTA_BANDS.rating).includes('pf-delta'));
assert.equal(
  withDeltaHtml('1.04', 1.04, 1.0, DELTA_BANDS.rating).includes('<img'),
  false,
  'on-average values still reserve the arrow slot'
);

{
  const esc = (s) => String(s);
  const html = mapRoundTableHtml(
    [
      { key: 'low', label: 'Low', ran: { rating: 0.8, swing: 0, winrate: 40, rounds: 2, files: [] }, faced: { rating: null, swing: null, winrate: null, rounds: 0, files: [] } },
      { key: 'high', label: 'High', ran: { rating: 1.4, swing: 1, winrate: 70, rounds: 2, files: [] }, faced: { rating: null, swing: null, winrate: null, rounds: 0, files: [] } },
      { key: 'empty', label: 'Empty', ran: { rating: null, swing: null, winrate: null, rounds: 0, files: [] }, faced: { rating: null, swing: null, winrate: null, rounds: 0, files: [] } }
    ],
    'T',
    3,
    esc
  );
  const names = [...html.matchAll(/pf-rt-text">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(names, ['High', 'Low', 'Empty'], 'round types sort by rating');
  assert.ok(html.includes('pf-empty'), 'empty cells are gray dashes');
  // Four numbers a lane now: the opening duel joined rating, swing and winrate.
  assert.equal([...html.matchAll(/>OPK</g)].length, 2, 'OPK on both lanes');
  assert.ok(html.includes('<col span="8"'), 'eight numeric columns');
  assert.ok(!html.includes('\u2014'), 'maps table does not use an em dash');
}

// ---- the team's version of the same block ---------------------------------
{
  const esc = (s) => String(s);
  const cell = (o) => ({
    rounds: 0,
    wins: 0,
    winrate: null,
    opkRate: null,
    conv5v4: null,
    conv4v5: null,
    files: [],
    ...o
  });
  const byMap = {
    NUK: {
      total: cell({ rounds: 12, winrate: 58.3, opkRate: 55, conv5v4: 70, conv4v5: 30 }),
      T: [
        { key: 'rare', label: 'Rare', ran: cell({ rounds: 2, winrate: 50 }), faced: cell({}) },
        {
          key: 'bread',
          label: 'Bread',
          ran: cell({ rounds: 9, winrate: 44.4, opkRate: 60, conv5v4: 80, conv4v5: 25 }),
          faced: cell({})
        }
      ],
      CT: [{ key: 'ct', label: 'Ct call', ran: cell({ rounds: 3 }), faced: cell({}) }]
    }
  };
  const html = teamMapRoundBlocksHtml(byMap, ['NUK'], esc);
  const names = [...html.matchAll(/pf-rt-text">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Bread', 'Rare', 'Ct call'], 'a team leads with the calls it runs');
  for (const col of TEAM_COLS) {
    assert.ok(html.includes(`>${col.label}<`), `${col.label} column`);
  }
  assert.ok(!html.includes('>Rtg<'), "a team's table drops the player columns");
  assert.ok(html.includes('44%'), 'the winrate of the call it runs most');
  assert.ok(html.includes('80%'), 'and what it does with the man advantage');
  assert.ok(html.includes('Nuke'), 'the map is named');
  assert.ok(html.includes('12</b> Rounds'), 'the map line carries its own record');
  assert.ok(html.includes('58%</b> WR'));
  assert.ok(!html.includes('\u2014'), 'no em dash here either');
  // Both tables pad to the taller side, so the pair ends level.
  assert.equal([...html.matchAll(/pf-mt-pad/g)].length, 1);
}

// A map with nothing played has no record line to show.
assert.equal(teamMapTotalHtml({ rounds: 0 }, (s) => s), '');
assert.ok(
  teamMapTotalHtml({ rounds: 4, winrate: 25, opkRate: null }, (s) => s).includes('pf-empty'),
  'a call with no opening duel leaves the dash rather than a zero'
);

console.log('performance.test.js ok');
