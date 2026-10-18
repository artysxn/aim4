// Run: node src/replays/eye/docMerge.test.js
//
// One point or two: points over the same rounds are merged however they are
// worded, points worded alike over different rounds are kept apart, a mangled
// copy of a round link is the same round, and T and CT points never merge.

import assert from 'node:assert/strict';
import { reviewOutline, roundKeys, roundOverlap, samePoint } from './docReview.js';

const R = (n, hash = '6d10b24dd9ebd9fe') => `CNh-Rrx-145-CCH-${String(n).padStart(2, '0')}_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~${hash}`;
const pt = (side, text, files) => ({ side, section: 'Pace', text, files });

// The same five rounds, written two ways.
const a = pt('T side', 'They hit B with a fast execute through main: 5 of 9 rounds.', [1, 2, 3, 4, 5].map((n) => R(n)));
const b = pt('T side', 'B main is taken quickly with utility, 5 of 9.', [1, 2, 3, 4, 5].map((n) => R(n)));
let [ka, kb] = roundKeys([a, b]);
assert.equal(roundOverlap(ka, kb), 1);
assert.equal(samePoint(a, b, ka, kb), 'same', 'same rounds, other words: one point');

// Alike in words, other rounds: two points.
const c = pt('T side', 'They hit B with a fast execute through main: 4 of 9 rounds.', [11, 12, 13, 14].map((n) => R(n)));
let [, kc] = roundKeys([a, c]);
assert.equal(samePoint(a, c, ka, kc), 'different');

// A copied link with a repeated segment, and one with a hash character dropped, are the same rounds.
const mangled = [R(1).replace('-CCH-01_rBR', '-CCH-01_rBR-01_rBR'), R(2).replace('~6d10b24dd9ebd9fe', '~6d10b24dd9ebd9f'), R(3), R(4), R(5)];
const d = pt('T side', 'B main is taken quickly with utility, 5 of 9.', mangled);
[ka, kb] = roundKeys([a, d]);
assert.equal(roundOverlap(ka, kb), 1, 'mangled links resolve to the rounds they copy');
// A neighbouring round of the same demo is not a mangled copy.
const [k6, k7] = roundKeys([pt('T', 'x', [R(6)]), pt('T', 'x', [R(7)])]);
assert.equal(roundOverlap(k6, k7), 0);

// Sides never merge.
const e = pt('CT side', 'They hit B with a fast execute through main: 5 of 9 rounds.', [1, 2, 3, 4, 5].map((n) => R(n)));
[ka, kb] = roundKeys([a, e]);
assert.equal(samePoint(a, e, ka, kb), null);

// In the review.
const review = reviewOutline([a, b, c], []);
assert.equal(review.issues.filter((x) => x.kind === 'duplicate').length, 1);
assert.match(review.issues.find((x) => x.kind === 'duplicate').text, /in other words, over the same rounds: merge them/);
assert.equal(review.issues.filter((x) => x.kind === 'same-words').length, 1);
assert.match(review.issues.find((x) => x.kind === 'same-words').text, /keep both/);

console.log('docMerge.test.js ok');
