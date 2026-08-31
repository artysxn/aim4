// ---------------------------------------------------------------------------
// lib/aimRanks.test.js
//   node --test src/lib/aimRanks.test.js
//
// The ladder is a claim about the shape of a population, so the tests are
// about shape: that the shares are the designed ones and add up, that the
// quoted "top X%" boundaries are the ones the design names, and that cutting a
// board by them puts the right people on the right rungs however many people
// there are.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HIGHEST,
  LOWEST,
  MEDIAN,
  RANKS,
  RANK_COUNT,
  assignRanks,
  rankAtPercentile,
  rankByKey
} from './aimRanks.js';

test('the shares are the design, and they add to a hundred', () => {
  const total = RANKS.reduce((a, r) => a + r.share, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `shares total ${total}`);
  assert.equal(RANK_COUNT, 22);
  assert.equal(LOWEST.name, 'Iron 1');
  assert.equal(HIGHEST.name, 'Legend');
});

test('every rank quotes the top percentage the design gives it', () => {
  // The number a player reads next to the rank. Any drift here is a promise
  // the ladder stopped keeping.
  const want = {
    'Iron 1': 100, 'Iron 2': 99.5, 'Iron 3': 98.5,
    'Bronze 1': 96, 'Bronze 2': 93, 'Bronze 3': 89,
    'Silver 1': 84, 'Silver 2': 78, 'Silver 3': 70,
    'Gold 1': 60.5, 'Gold 2': 50, 'Gold 3': 40,
    'Platinum 1': 31, 'Platinum 2': 23.5, 'Platinum 3': 17,
    'Diamond 1': 12, 'Diamond 2': 9, 'Diamond 3': 6.8,
    Challenger: 5, Master: 2.4, Champion: 0.7, Legend: 0.1
  };
  for (const r of RANKS) assert.equal(r.top, want[r.name], `${r.name} top%`);
});

test('the bands tile the whole range with no gap and no overlap', () => {
  assert.equal(RANKS[0].from, 0);
  assert.equal(RANKS[RANKS.length - 1].to, 100);
  for (let i = 1; i < RANKS.length; i++) {
    assert.equal(RANKS[i].from, RANKS[i - 1].to, `${RANKS[i].name} starts where the last ended`);
  }
});

test('the peak of the curve is where the design puts it', () => {
  // Gold 1 is the single most populated rank, and half of everyone sits
  // between Silver 1 and Gold 2.
  const biggest = [...RANKS].sort((a, b) => b.share - a.share)[0];
  assert.equal(biggest.name, 'Gold 1');
  const middle = RANKS.filter((r) => r.from >= 16 && r.to <= 60);
  assert.equal(middle.reduce((a, r) => a + r.share, 0), 44);
  assert.equal(MEDIAN.name, 'Gold 2', 'the median player is Gold 2');
});

test('a percentile lands on the rank whose band holds it', () => {
  assert.equal(rankAtPercentile(0).name, 'Iron 1', 'the very bottom');
  assert.equal(rankAtPercentile(1).name, 'Legend', 'the very top');
  assert.equal(rankAtPercentile(0.5).name, 'Gold 2', 'a boundary takes the higher rank');
  assert.equal(rankAtPercentile(0.499).name, 'Gold 1');
  assert.equal(rankAtPercentile(0.95).name, 'Challenger', 'top 5%');
  assert.equal(rankAtPercentile(0.999).name, 'Legend', 'top 0.1%');
  assert.equal(rankAtPercentile(0.9989).name, 'Champion', 'and just under it is not');
  assert.equal(rankAtPercentile(NaN), null);
});

test('three players get the bottom, the middle and the top', () => {
  const ranks = assignRanks([10, 30, 20]);
  assert.deepEqual(ranks.map((r) => r.name), ['Iron 1', 'Legend', 'Gold 2']);
});

test('two players are the bottom and the top, and one is neither', () => {
  assert.deepEqual(assignRanks([5, 9]).map((r) => r.name), ['Iron 1', 'Legend']);
  // Alone, you are at once the best and the worst player on the board.
  assert.deepEqual(assignRanks([1200]).map((r) => r.name), ['Gold 2']);
  assert.deepEqual(assignRanks([]), []);
});

test('a full board follows the designed shares', () => {
  // Ten thousand players, all different: each rank should hold about the
  // share the ladder gives it.
  const values = Array.from({ length: 10000 }, (_, i) => i);
  const ranks = assignRanks(values);
  const held = new Map();
  for (const r of ranks) held.set(r.name, (held.get(r.name) || 0) + 1);
  for (const r of RANKS) {
    const pct = (100 * (held.get(r.name) || 0)) / values.length;
    assert.ok(
      Math.abs(pct - r.share) < 0.2,
      `${r.name} holds ${pct.toFixed(2)}% of the board, design says ${r.share}%`
    );
  }
});

test('the top of a big board is the top of the ladder', () => {
  const values = Array.from({ length: 1000 }, (_, i) => i);
  const ranks = assignRanks(values);
  assert.equal(ranks[999].name, 'Legend', 'best of a thousand');
  assert.equal(ranks[0].name, 'Iron 1', 'worst of a thousand');
  // One in a thousand is Legend, which is exactly what 0.1% means.
  assert.equal(ranks.filter((r) => r.name === 'Legend').length, 1);
});

test('a lower score can be the better one', () => {
  // Reaction time: 180 ms beats 400 ms.
  const ranks = assignRanks([180, 290, 400], { higherIsBetter: false });
  assert.deepEqual(ranks.map((r) => r.name), ['Legend', 'Gold 2', 'Iron 1']);
});

test('a tie is one rank, not an order of arrival', () => {
  const ranks = assignRanks([10, 20, 20, 30]);
  assert.equal(ranks[1].name, ranks[2].name, 'the tied pair share a rank');
  assert.equal(ranks[1].name, 'Gold 2', 'taken at the middle of the run');
  assert.equal(ranks[0].name, 'Iron 1');
  assert.equal(ranks[3].name, 'Legend');

  // A board where nobody is separated is one rank, not a ladder.
  const flat = assignRanks([7, 7, 7, 7, 7]);
  assert.equal(new Set(flat.map((r) => r.name)).size, 1);
  assert.equal(flat[0].name, 'Gold 2');
});

test('entries with no score are ranked as nothing, and do not shift the rest', () => {
  const ranks = assignRanks([10, null, 20, undefined, 30, NaN]);
  assert.equal(ranks[1], null);
  assert.equal(ranks[3], null);
  assert.equal(ranks[5], null);
  assert.deepEqual(
    [ranks[0].name, ranks[2].name, ranks[4].name],
    ['Iron 1', 'Gold 2', 'Legend'],
    'the three real scores are still bottom, middle and top'
  );
});

test('a rank can be read back from its key', () => {
  for (const r of RANKS) assert.equal(rankByKey(r.key), r);
  assert.equal(rankByKey('nonsense'), null);
});

console.log('aimRanks.test.js: ladder shape, boundaries, ties and small boards all pass');
