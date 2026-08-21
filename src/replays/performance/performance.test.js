// Run: node src/replays/performance/performance.test.js

import assert from 'node:assert/strict';
import {
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
assert.equal(gunLabel('ak47'), 'AK-47');

const rows = [
  { f: 'r1', d: 'd1', hg: { p1: 'ak47' } },
  { f: 'r2', d: 'd1', hg: { p1: 'awp' } }
];
const files = gunMapFromRows(rows, 'p1');
assert.equal(files.r1, 'ak47');
assert.equal(files.r2, 'awp');

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
assert.ok(guns[0].used > 0);

console.log('performance.test.js ok');
