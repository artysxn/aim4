// Run: node src/replays/analytics/reportProse.test.js

import assert from 'node:assert/strict';
import {
  article,
  capitalize,
  clockText,
  countWord,
  fill,
  frequencyWord,
  joinList,
  nadeName,
  narrateSequence,
  noun,
  paragraph,
  phrase,
  plural,
  sentence,
  variantIndex,
  withArticle
} from './reportProse.js';

// Lists: no serial comma, and the "+" joiner the summaries use for utility.
assert.equal(joinList([]), '');
assert.equal(joinList(['a']), 'a');
assert.equal(joinList(['a', 'b']), 'a and b');
assert.equal(joinList(['a', 'b', 'c']), 'a, b and c');
assert.equal(joinList(['a', 'b', 'c'], 'or'), 'a, b or c');
assert.equal(joinList(['Yekindar', 'Top Con', 'Backsite'], '+'), 'Yekindar + Top Con + Backsite');
assert.equal(joinList(['a', '', null, 'b']), 'a and b');

// Counts agree with their nouns.
assert.equal(plural(1, 'round'), '1 round');
assert.equal(plural(3, 'round'), '3 rounds');
assert.equal(plural(2, 'flash', 'flashes'), '2 flashes');
assert.equal(noun(1, 'match', 'matches'), 'match');
assert.equal(noun(0, 'match', 'matches'), 'matches');
assert.equal(countWord(1), 'once');
assert.equal(countWord(2), 'twice');
assert.equal(countWord(5), '5 times');

// Articles read letters by their names.
assert.equal(article('A Split'), 'an');
assert.equal(article('B Split'), 'a');
assert.equal(article('AWP'), 'an');
assert.equal(article('HE'), 'an');
assert.equal(article('CT'), 'a');
assert.equal(article('M4'), 'an');
assert.equal(article('apple'), 'an');
assert.equal(article('flash'), 'a');
assert.equal(article('one-way smoke'), 'a');
assert.equal(article('hour'), 'an');
assert.equal(article('8 second hold'), 'an');
assert.equal(withArticle('A pop'), 'an A pop');
assert.equal(withArticle('slow default'), 'a slow default');

// Sentences close once and start upper case.
assert.equal(sentence('they never rush A'), 'They never rush A.');
assert.equal(sentence('Done!'), 'Done!');
assert.equal(sentence('  two  spaces , here '), 'Two spaces, here.');
assert.equal(paragraph(['one', '', 'two.']), 'One. Two.');
assert.equal(capitalize('b pop'), 'B pop');

// Clocks count down.
assert.equal(clockText(92), '1:32');
assert.equal(clockText(5), '0:05');
assert.equal(clockText(NaN), '');

// The tell words.
assert.equal(frequencyWord(6, 6), 'Always');
assert.equal(frequencyWord(5, 6), 'Mostly');
assert.equal(frequencyWord(3, 6), '');

assert.equal(nadeName('Top Con', 'flashbang'), 'Top Con flash');
assert.equal(nadeName('Blue', 'molotov'), 'Blue molo');
assert.equal(nadeName('Pillar', 'hegrenade'), 'Pillar nade');

// Templates: unknown placeholders stay visible.
assert.equal(fill('{a} and {b}', { a: 1 }), '1 and {b}');

// The variant pick is stable for the same seed and spreads across seeds.
const table = { k: ['one', 'two', 'three', 'four'] };
assert.equal(phrase(table, 'k', 'Smash'), phrase(table, 'k', 'Smash'));
const picks = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => variantIndex('k', s, 4)));
assert.ok(picks.size > 1);
assert.equal(phrase(table, 'missing', 's'), '');

// The "once / again / lastly" narration.
assert.equal(
  narrateSequence(
    ['unawareness', 'poor spacing discipline', 'unawareness', 'bad judgement', 'unlucky', 'bad judgement'],
    { last: 'in the last round checked' }
  ),
  'unawareness once, then poor spacing discipline, then unawareness again, then bad judgement once, then unlucky, and lastly bad judgement again in the last round checked'
);
assert.equal(narrateSequence(['unlucky']), 'unlucky');
assert.equal(
  narrateSequence(['unawareness', 'unlucky', 'unlucky', 'unlucky']),
  'unawareness, then unlucky three times in a row'
);
assert.equal(narrateSequence(['a', 'b']), 'a, then b');

console.log('reportProse.test.js ok');
